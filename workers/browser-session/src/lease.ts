// One BrowserLease per machine (workspace id). It owns exactly one upstream Chrome at a
// time, charges the machine's Browser Run budget while that Chrome exists, and deletes it
// server-side when heartbeats stop, so an abandoned tab never costs more than BROWSER_IDLE_MS.
import {
  BROWSER_BUDGET_MS,
  BROWSER_IDLE_MS,
  budgetSnapshot,
  endRun,
  freshBudgetLedger,
  judgeRun,
  startRun,
  touchRun,
  type BudgetLedgerState,
  type BudgetSnapshot,
  type LimitError,
} from "../../../shared/session-limits";
import {
  OrphanedSessionError,
  sessionPayload,
  UpstreamError,
  type SessionDescriptor,
  type Upstream,
} from "./upstream";

const LEASE_KEY = "webmcp-computer:browser-lease";
const CLOSE_RETRY_MS = 30_000;

export type LeaseStorage = Pick<
  DurableObjectStorage,
  "delete" | "deleteAlarm" | "get" | "getAlarm" | "put" | "setAlarm"
>;

type LeaseState = {
  ledger: BudgetLedgerState;
  session?: { id: string; targetId: string; startedAt: number; closeAttempts: number };
};

export type LeaseFailure = { ok: false; status: number; error: LimitError | { error: string } };
export type LeaseResult<T> = { ok: true; value: T } | LeaseFailure;

export type SessionGrant = SessionDescriptor & { idleTimeoutMs: number; budget: BudgetSnapshot };
export type HeartbeatGrant = { idleTimeoutMs: number; budget: BudgetSnapshot };
export type CloseResult = { status: string; budget: BudgetSnapshot };
export type LeaseAlarmOutcome = "none" | "kept" | "stopped-requested" | "stopped-idle" | "stopped-budget" | "retry";

export type BrowserLeaseLike = {
  create(url: string): Promise<LeaseResult<SessionGrant>>;
  heartbeat(sessionId: string): Promise<LeaseResult<HeartbeatGrant>>;
  refresh(sessionId: string): Promise<LeaseResult<SessionGrant>>;
  close(sessionId: string): Promise<LeaseResult<CloseResult>>;
};

export type BrowserLeaseOptions = {
  now?: () => number;
  budgetMs?: number;
  idleMs?: number;
};

function noSession(): LeaseFailure {
  return {
    ok: false,
    status: 404,
    error: { error: "browser session is no longer held; start a new one", code: "EIDLE" },
  };
}

function notOwner(): LeaseFailure {
  return { ok: false, status: 403, error: { error: "browser session belongs to another machine", code: "EOWNER" } };
}

function fromUpstream(error: unknown): LeaseFailure {
  if (error instanceof UpstreamError) {
    if (error.status === 429) {
      return {
        ok: false,
        status: 503,
        error: {
          error: "browser service is at capacity right now",
          code: "ECAPACITY",
          retryAfterMs: error.retryAfterMs ?? 20_000,
        },
      };
    }
    return { ok: false, status: error.status, error: { error: error.message } };
  }
  throw error;
}

export class BrowserLease implements BrowserLeaseLike {
  readonly #storage: LeaseStorage;
  readonly #upstream: Upstream;
  readonly #now: () => number;
  readonly #budgetMs: number;
  readonly #idleMs: number;
  #operation: Promise<void> = Promise.resolve();

  constructor(storage: LeaseStorage, upstream: Upstream, options: BrowserLeaseOptions = {}) {
    this.#storage = storage;
    this.#upstream = upstream;
    this.#now = options.now ?? (() => Date.now());
    this.#budgetMs = options.budgetMs ?? BROWSER_BUDGET_MS;
    this.#idleMs = options.idleMs ?? BROWSER_IDLE_MS;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  create(url: string): Promise<LeaseResult<SessionGrant>> {
    return this.#exclusive(() => this.#create(url));
  }

  heartbeat(sessionId: string): Promise<LeaseResult<HeartbeatGrant>> {
    return this.#exclusive(() => this.#heartbeat(sessionId));
  }

  refresh(sessionId: string): Promise<LeaseResult<SessionGrant>> {
    return this.#exclusive(() => this.#refresh(sessionId));
  }

  close(sessionId: string): Promise<LeaseResult<CloseResult>> {
    return this.#exclusive(() => this.#close(sessionId));
  }

  onAlarm(): Promise<LeaseAlarmOutcome> {
    return this.#exclusive(() => this.#onAlarm());
  }

  async #load(now: number): Promise<LeaseState> {
    return (await this.#storage.get<LeaseState>(LEASE_KEY)) ?? { ledger: freshBudgetLedger(now) };
  }

  async #save(state: LeaseState): Promise<void> {
    await this.#storage.put(LEASE_KEY, state);
  }

  async #arm(state: LeaseState, now: number): Promise<void> {
    if (!state.session) {
      await this.#storage.deleteAlarm();
      return;
    }
    const verdict = judgeRun(state.ledger, this.#budgetMs, this.#idleMs, now);
    await this.#storage.setAlarm(verdict.action === "stop" ? now : verdict.checkAt);
  }

  #budget(state: LeaseState, now: number): BudgetSnapshot {
    return budgetSnapshot(state.ledger, this.#budgetMs, now);
  }

  /** Delete the upstream Chrome and book its time. Returns the state without a session. */
  async #stop(state: LeaseState, now: number): Promise<{ state: LeaseState; status: string }> {
    let status = "closed";
    if (state.session) {
      try {
        status = (await this.#upstream.close(state.session.id)).status;
      } catch (error) {
        // A missing upstream session is already closed. Any other failure must keep the
        // lease on the books so it cannot be replaced by a second, unaccounted Chrome.
        if (!(error instanceof UpstreamError) || (error.status !== 404 && error.status !== 410)) throw error;
      }
    }
    const { session: _session, ...rest } = state;
    return { state: { ...rest, ledger: endRun(state.ledger, this.#budgetMs, now) }, status };
  }

  async #retryClose(state: LeaseState, now: number): Promise<void> {
    if (!state.session) return;
    const retrying: LeaseState = {
      ...state,
      session: { ...state.session, closeAttempts: state.session.closeAttempts + 1 },
    };
    await this.#save(retrying);
    await this.#storage.setAlarm(now + CLOSE_RETRY_MS);
  }

  async #create(url: string): Promise<LeaseResult<SessionGrant>> {
    const now = this.#now();
    let state = await this.#load(now);
    // One Chrome per machine: replace only after Browser Run confirms the old one is gone.
    // On a close outage, refusing a new session is cheaper and safer than orphaning the old.
    if (state.session) {
      try {
        state = (await this.#stop(state, now)).state;
      } catch (error) {
        await this.#retryClose(state, now);
        return fromUpstream(error);
      }
    }

    const started = startRun(state.ledger, this.#budgetMs, now);
    if (!started.ok) {
      await this.#save({ ...state, ledger: started.state });
      await this.#arm({ ...state, ledger: started.state }, now);
      return { ok: false, status: 429, error: started.error };
    }

    let descriptor: SessionDescriptor;
    try {
      descriptor = await this.#upstream.create(url);
    } catch (error) {
      if (error instanceof OrphanedSessionError) {
        const held: LeaseState = {
          ledger: started.state,
          session: { id: error.sessionId, targetId: "unknown", startedAt: now, closeAttempts: 0 },
        };
        await this.#retryClose(held, now);
        return fromUpstream(error.failure);
      }
      const failure = fromUpstream(error);
      const abandoned = { ...state, ledger: endRun(started.state, this.#budgetMs, now) };
      await this.#save(abandoned);
      await this.#arm(abandoned, now);
      return failure;
    }

    const next: LeaseState = {
      ledger: started.state,
      session: { id: descriptor.sessionId, targetId: descriptor.targetId, startedAt: now, closeAttempts: 0 },
    };
    await this.#save(next);
    await this.#arm(next, now);
    return { ok: true, value: { ...descriptor, idleTimeoutMs: this.#idleMs, budget: this.#budget(next, now) } };
  }

  async #touch(sessionId: string): Promise<LeaseResult<{ state: LeaseState; now: number }>> {
    const now = this.#now();
    const state = await this.#load(now);
    if (!state.session) return noSession();
    if (state.session.id !== sessionId) return notOwner();
    const touched: LeaseState = { ...state, ledger: touchRun(state.ledger, now) };
    if (this.#budget(touched, now).remainingMs <= 0) {
      let stopped = touched;
      try {
        stopped = (await this.#stop(touched, now)).state;
        await this.#save(stopped);
        await this.#arm(stopped, now);
      } catch {
        // The browser may still be running. Keep charging it and retry the close from
        // the alarm; the caller still receives the budget refusal immediately.
        await this.#retryClose(touched, now);
      }
      const snapshot = this.#budget(stopped, now);
      return {
        ok: false,
        status: 429,
        error: {
          error: "browser time budget for this machine is used up for now",
          code: "EBUDGET",
          retryAfterMs: Math.max(0, snapshot.windowResetsAt - now),
        },
      };
    }
    await this.#save(touched);
    await this.#arm(touched, now);
    return { ok: true, value: { state: touched, now } };
  }

  async #heartbeat(sessionId: string): Promise<LeaseResult<HeartbeatGrant>> {
    const touched = await this.#touch(sessionId);
    if (!touched.ok) return touched;
    return { ok: true, value: { idleTimeoutMs: this.#idleMs, budget: this.#budget(touched.value.state, touched.value.now) } };
  }

  async #refresh(sessionId: string): Promise<LeaseResult<SessionGrant>> {
    const touched = await this.#touch(sessionId);
    if (!touched.ok) return touched;
    try {
      const targets = await this.#upstream.list(sessionId);
      const target = targets.find(({ type }) => type === "page") ?? targets[0];
      if (!target) throw new Error("browser service returned no page target");
      return {
        ok: true,
        value: {
          ...sessionPayload(sessionId, target),
          idleTimeoutMs: this.#idleMs,
          budget: this.#budget(touched.value.state, touched.value.now),
        },
      };
    } catch (error) {
      if (error instanceof UpstreamError) return fromUpstream(error);
      return { ok: false, status: 502, error: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async #close(sessionId: string): Promise<LeaseResult<CloseResult>> {
    const now = this.#now();
    const state = await this.#load(now);
    if (!state.session) return { ok: true, value: { status: "closed", budget: this.#budget(state, now) } };
    if (state.session.id !== sessionId) return notOwner();
    try {
      const stopped = await this.#stop(state, now);
      await this.#save(stopped.state);
      await this.#arm(stopped.state, now);
      return { ok: true, value: { status: stopped.status, budget: this.#budget(stopped.state, now) } };
    } catch (error) {
      await this.#retryClose(state, now);
      return fromUpstream(error);
    }
  }

  async #onAlarm(): Promise<LeaseAlarmOutcome> {
    const now = this.#now();
    const state = await this.#load(now);
    if (!state.session) {
      await this.#storage.deleteAlarm();
      return "none";
    }
    const verdict = judgeRun(state.ledger, this.#budgetMs, this.#idleMs, now);
    const closeRequested = state.session.closeAttempts > 0;
    if (verdict.action === "keep" && !closeRequested) {
      await this.#storage.setAlarm(verdict.checkAt);
      return "kept";
    }
    try {
      await this.#upstream.close(state.session.id);
    } catch (error) {
      if (!(error instanceof UpstreamError) || (error.status !== 404 && error.status !== 410)) {
        // Keep the session on the books until Browser Run confirms it is gone. Its own
        // keep_alive eventually expires it; a later 404 then lets us close the ledger.
        await this.#retryClose(state, now);
        return "retry";
      }
    }
    const { session: _session, ...rest } = state;
    const stopped: LeaseState = { ...rest, ledger: endRun(state.ledger, this.#budgetMs, now) };
    await this.#save(stopped);
    await this.#storage.deleteAlarm();
    if (verdict.action === "keep") return "stopped-requested";
    return verdict.reason === "idle" ? "stopped-idle" : "stopped-budget";
  }
}
