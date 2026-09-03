// The runtime lease is the single authority over "is this workspace's container allowed
// to run right now". Every exec acquires it (budget check), every exec end releases it
// (starts the idle clock), and the DO alarm judges it (idle-stop or hard budget stop).
import {
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
import type { AlarmSlots } from "./alarms";

export const RUNTIME_LEASE_ALARM = "runtime-lease";
const LEASE_KEY = "webmcp-computer:runtime-lease";

export type LeaseStorage = Pick<DurableObjectStorage, "delete" | "get" | "put">;

type RuntimeLeaseState = BudgetLedgerState & {
  /** At most one exec may use a workspace container at a time. */
  execActive?: boolean;
  /** This exec opened the run, but container startup has not succeeded yet. */
  provisional?: boolean;
};

export type LeaseAcquireResult =
  | { ok: true; budget: BudgetSnapshot }
  | { ok: false; error: LimitError; budget: BudgetSnapshot };

export type LeaseAlarmOutcome = "none" | "kept" | "stopped-idle" | "stopped-budget";

export type RuntimeLeaseOptions = {
  budgetMs: number;
  idleMs: number;
  now?: () => number;
};

export class RuntimeLease {
  readonly #storage: LeaseStorage;
  readonly #alarms: AlarmSlots;
  readonly #budgetMs: number;
  readonly #idleMs: number;
  readonly #now: () => number;

  constructor(storage: LeaseStorage, alarms: AlarmSlots, options: RuntimeLeaseOptions) {
    this.#storage = storage;
    this.#alarms = alarms;
    this.#budgetMs = options.budgetMs;
    this.#idleMs = options.idleMs;
    this.#now = options.now ?? (() => Date.now());
  }

  async #load(now: number): Promise<RuntimeLeaseState> {
    return (await this.#storage.get<RuntimeLeaseState>(LEASE_KEY)) ?? freshBudgetLedger(now);
  }

  async #save(state: RuntimeLeaseState): Promise<void> {
    await this.#storage.put(LEASE_KEY, state);
  }

  async #schedule(state: BudgetLedgerState, now: number): Promise<void> {
    const verdict = judgeRun(state, this.#budgetMs, this.#idleMs, now);
    if (verdict.action === "stop") {
      // Already overdue: fire as soon as the runtime lets us.
      await this.#alarms.set(RUNTIME_LEASE_ALARM, now);
      return;
    }
    await this.#alarms.set(RUNTIME_LEASE_ALARM, verdict.checkAt);
  }

  /** Charge budget for a run that must not be idle-stopped for `busyForMs`. */
  async acquire(busyForMs: number): Promise<LeaseAcquireResult> {
    const now = this.#now();
    const state = await this.#load(now);
    if (state.execActive) {
      return {
        ok: false,
        error: {
          error: "another cloud command is already running in this workspace",
          code: "ECAPACITY",
          retryAfterMs: 1_000,
        },
        budget: budgetSnapshot(state, this.#budgetMs, now),
      };
    }
    const provisional = state.runningSince === undefined;
    const result = startRun(state, this.#budgetMs, now, { busyForMs });
    if (!result.ok) {
      await this.#save(result.state);
      return { ok: false, error: result.error, budget: result.snapshot };
    }
    const acquired: RuntimeLeaseState = { ...result.state, execActive: true, provisional };
    await this.#save(acquired);
    await this.#schedule(acquired, now);
    return { ok: true, budget: result.snapshot };
  }

  /** Container startup succeeded; an exec failure from here still leaves a running container. */
  async started(): Promise<void> {
    const now = this.#now();
    const state = await this.#load(now);
    if (!state.execActive || !state.provisional) return;
    const { provisional: _provisional, ...started } = state;
    await this.#save(started);
  }

  /** The exec finished: start the idle clock. Returns the budget after this activity. */
  async release(): Promise<BudgetSnapshot> {
    const now = this.#now();
    const { execActive: _execActive, provisional: _provisional, ...ledger } = await this.#load(now);
    const state = touchRun(ledger, now, { clearBusy: true });
    await this.#save(state);
    await this.#schedule(state, now);
    return budgetSnapshot(state, this.#budgetMs, now);
  }

  /** Container startup failed. End a newly opened run, but preserve an existing warm run. */
  async abandon(): Promise<BudgetSnapshot> {
    const now = this.#now();
    const { execActive: _execActive, provisional, ...ledger } = await this.#load(now);
    if (provisional) {
      const state = endRun(ledger, this.#budgetMs, now);
      await this.#save(state);
      await this.#alarms.clear(RUNTIME_LEASE_ALARM);
      return budgetSnapshot(state, this.#budgetMs, now);
    }
    const state = touchRun(ledger, now, { clearBusy: true });
    await this.#save(state);
    await this.#schedule(state, now);
    return budgetSnapshot(state, this.#budgetMs, now);
  }

  async budget(): Promise<BudgetSnapshot> {
    const now = this.#now();
    return budgetSnapshot(await this.#load(now), this.#budgetMs, now);
  }

  /**
   * Alarm handler. `stop` must make the container not running; it is awaited before the
   * run is booked so a failing stop keeps charging (and keeps the alarm armed).
   */
  async onAlarm(stop: () => Promise<void>): Promise<LeaseAlarmOutcome> {
    const now = this.#now();
    const state = await this.#load(now);
    const verdict = judgeRun(state, this.#budgetMs, this.#idleMs, now);
    if (state.runningSince === undefined) {
      await this.#alarms.clear(RUNTIME_LEASE_ALARM);
      return "none";
    }
    if (verdict.action === "keep") {
      await this.#alarms.set(RUNTIME_LEASE_ALARM, verdict.checkAt);
      return "kept";
    }
    await stop();
    const { execActive: _execActive, provisional: _provisional, ...ledger } = state;
    await this.#save(endRun(ledger, this.#budgetMs, now));
    await this.#alarms.clear(RUNTIME_LEASE_ALARM);
    return verdict.reason === "idle" ? "stopped-idle" : "stopped-budget";
  }
}
