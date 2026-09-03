// Wire contract for anonymous-visitor resource budgets. The site, both Workers, and the
// browser client import these values so every surface shows and enforces the same numbers.
// Change them together with a redeploy of both Workers.

/** Fixed accounting window over which a machine's paid-resource budgets accrue. */
export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Total remote Chrome (Browser Run) time one machine may hold per window. */
export const BROWSER_BUDGET_MS = 2 * 60 * 60 * 1_000;

/** Total cloud container running time one machine may consume per window. */
export const CLOUD_BUDGET_MS = 2 * 60 * 60 * 1_000;

/** Remote Chrome is deleted when the machine sends no heartbeat for this long. */
export const BROWSER_IDLE_MS = 5 * 60 * 1_000;

/** The cloud container is stopped when no exec starts or finishes for this long. */
export const CLOUD_IDLE_MS = 5 * 60 * 1_000;

/** Client heartbeat cadence while the human is active and the tab is visible. */
export const BROWSER_HEARTBEAT_MS = 60 * 1_000;

/** Browser Run's documented maximum inactivity timeout for a session. */
export const BROWSER_RUN_KEEP_ALIVE_MS = 10 * 60 * 1_000;

export type LimitErrorCode =
  /** Budget for this window is exhausted; `retryAfterMs` says when it resets. */
  | "EBUDGET"
  /** The resource was released after inactivity; start it again to continue. */
  | "EIDLE"
  /** The caller does not own the referenced session. */
  | "EOWNER"
  /** The platform has no free capacity right now; retry shortly. */
  | "ECAPACITY";

export type LimitError = {
  error: string;
  code: LimitErrorCode;
  retryAfterMs?: number;
};

export type BudgetSnapshot = {
  /** Milliseconds of budget left in the current window. */
  remainingMs: number;
  /** Milliseconds since window start; informational. */
  usedMs: number;
  /** Absolute epoch milliseconds when the window resets. */
  windowResetsAt: number;
};

export function isLimitErrorCode(value: unknown): value is LimitErrorCode {
  return value === "EBUDGET" || value === "EIDLE" || value === "EOWNER" || value === "ECAPACITY";
}

/**
 * Pure budget ledger shared by both Workers. A "run" is an open interval during which
 * the paid resource is considered running; the ledger charges elapsed run time against
 * the window budget and reports when the run must stop.
 */
export type BudgetLedgerState = {
  windowStartedAt: number;
  usedMs: number;
  runningSince?: number;
  lastActivityAt: number;
  /** Alarms must not treat the resource as idle before this instant. */
  busyUntil?: number;
};

export function freshBudgetLedger(now: number): BudgetLedgerState {
  return { windowStartedAt: now, usedMs: 0, lastActivityAt: now };
}

function rolled(state: BudgetLedgerState, now: number): BudgetLedgerState {
  if (now - state.windowStartedAt < BUDGET_WINDOW_MS) return state;
  return {
    windowStartedAt: now,
    usedMs: 0,
    lastActivityAt: now,
    ...(state.runningSince === undefined ? {} : { runningSince: now }),
    ...(state.busyUntil === undefined ? {} : { busyUntil: state.busyUntil }),
  };
}

export function budgetSnapshot(state: BudgetLedgerState, budgetMs: number, now: number): BudgetSnapshot {
  const current = rolled(state, now);
  const running = current.runningSince === undefined ? 0 : Math.max(0, now - current.runningSince);
  const usedMs = Math.min(budgetMs, current.usedMs + running);
  return {
    remainingMs: Math.max(0, budgetMs - usedMs),
    usedMs,
    windowResetsAt: current.windowStartedAt + BUDGET_WINDOW_MS,
  };
}

export type StartRunResult =
  | { ok: true; state: BudgetLedgerState; snapshot: BudgetSnapshot }
  | { ok: false; state: BudgetLedgerState; error: LimitError; snapshot: BudgetSnapshot };

/** Begin or extend a run. Fails with EBUDGET when the window budget is exhausted. */
export function startRun(
  state: BudgetLedgerState,
  budgetMs: number,
  now: number,
  options: { busyForMs?: number } = {},
): StartRunResult {
  const current = rolled(state, now);
  const snapshot = budgetSnapshot(current, budgetMs, now);
  if (snapshot.remainingMs <= 0) {
    return {
      ok: false,
      state: current,
      snapshot,
      error: {
        error: "resource budget for this machine is exhausted for now",
        code: "EBUDGET",
        retryAfterMs: Math.max(0, snapshot.windowResetsAt - now),
      },
    };
  }
  const busyUntil = options.busyForMs === undefined ? undefined : now + options.busyForMs;
  const next: BudgetLedgerState = {
    ...current,
    runningSince: current.runningSince ?? now,
    lastActivityAt: now,
    ...(busyUntil === undefined
      ? (current.busyUntil === undefined ? {} : { busyUntil: current.busyUntil })
      : { busyUntil: Math.max(busyUntil, current.busyUntil ?? 0) }),
  };
  return { ok: true, state: next, snapshot: budgetSnapshot(next, budgetMs, now) };
}

/** Record activity on an open run without changing its budget accounting. */
export function touchRun(state: BudgetLedgerState, now: number, options: { clearBusy?: boolean } = {}): BudgetLedgerState {
  const current = rolled(state, now);
  const { busyUntil: _busy, ...rest } = current;
  return {
    ...rest,
    lastActivityAt: now,
    ...(options.clearBusy || current.busyUntil === undefined ? {} : { busyUntil: current.busyUntil }),
  };
}

/** Close the run and charge its elapsed time to the window. */
export function endRun(state: BudgetLedgerState, budgetMs: number, now: number): BudgetLedgerState {
  const current = rolled(state, now);
  if (current.runningSince === undefined) return current;
  const { runningSince, busyUntil: _busy, ...rest } = current;
  return {
    ...rest,
    usedMs: Math.min(budgetMs, current.usedMs + Math.max(0, now - runningSince)),
    lastActivityAt: now,
  };
}

export type RunVerdict =
  | { action: "keep"; checkAt: number }
  | { action: "stop"; reason: "idle" | "budget" };

/**
 * What an alarm should do with an open run: stop it when idle past `idleMs` (never while
 * marked busy) or when the window budget is exhausted; otherwise say when to look again.
 */
export function judgeRun(state: BudgetLedgerState, budgetMs: number, idleMs: number, now: number): RunVerdict {
  const current = rolled(state, now);
  if (current.runningSince === undefined) return { action: "keep", checkAt: Number.POSITIVE_INFINITY };
  const snapshot = budgetSnapshot(current, budgetMs, now);
  if (snapshot.remainingMs <= 0) return { action: "stop", reason: "budget" };
  const busyUntil = current.busyUntil ?? 0;
  const idleAt = Math.max(current.lastActivityAt, busyUntil) + idleMs;
  if (now >= idleAt) return { action: "stop", reason: "idle" };
  return { action: "keep", checkAt: Math.min(idleAt, now + snapshot.remainingMs) };
}
