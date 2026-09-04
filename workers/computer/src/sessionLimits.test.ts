import { describe, expect, test } from "bun:test";
import {
  BUDGET_WINDOW_MS,
  budgetSnapshot,
  endRun,
  freshBudgetLedger,
  judgeRun,
  startRun,
  touchRun,
} from "../../../shared/session-limits";

const HOUR = 60 * 60 * 1_000;
const MINUTE = 60 * 1_000;
const BUDGET = 2 * HOUR;
const IDLE = 5 * MINUTE;

describe("budget ledger", () => {
  test("a fresh ledger has the full budget and no open run", () => {
    const state = freshBudgetLedger(1_000);
    expect(budgetSnapshot(state, BUDGET, 1_000)).toEqual({
      remainingMs: BUDGET,
      usedMs: 0,
      windowResetsAt: 1_000 + BUDGET_WINDOW_MS,
    });
    expect(judgeRun(state, BUDGET, IDLE, 1_000)).toEqual({ action: "keep", checkAt: Number.POSITIVE_INFINITY });
  });

  test("startRun opens a run and charges elapsed time while it stays open", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    expect(started.state.runningSince).toBe(0);
    expect(budgetSnapshot(started.state, BUDGET, 30 * MINUTE).remainingMs).toBe(BUDGET - 30 * MINUTE);
    const again = startRun(started.state, BUDGET, 10 * MINUTE);
    if (!again.ok) throw new Error("unreachable");
    expect(again.state.runningSince).toBe(0);
    expect(again.state.lastActivityAt).toBe(10 * MINUTE);
  });

  test("endRun books the run into usedMs and closes it", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0);
    if (!started.ok) throw new Error("unreachable");
    const ended = endRun(started.state, BUDGET, 45 * MINUTE);
    expect(ended.runningSince).toBeUndefined();
    expect(ended.usedMs).toBe(45 * MINUTE);
    expect(budgetSnapshot(ended, BUDGET, HOUR).remainingMs).toBe(BUDGET - 45 * MINUTE);
  });

  test("startRun refuses with EBUDGET once the window budget is exhausted", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0);
    if (!started.ok) throw new Error("unreachable");
    const exhausted = endRun(started.state, BUDGET, BUDGET);
    const refused = startRun(exhausted, BUDGET, BUDGET + MINUTE);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("EBUDGET");
    expect(refused.error.retryAfterMs).toBe(BUDGET_WINDOW_MS - BUDGET - MINUTE);
    expect(refused.snapshot.remainingMs).toBe(0);
  });

  test("the window rolls over and restores the budget", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0);
    if (!started.ok) throw new Error("unreachable");
    const exhausted = endRun(started.state, BUDGET, BUDGET);
    const later = startRun(exhausted, BUDGET, BUDGET_WINDOW_MS + 1);
    expect(later.ok).toBe(true);
    if (!later.ok) throw new Error("unreachable");
    expect(later.state.usedMs).toBe(0);
    expect(later.state.windowStartedAt).toBe(BUDGET_WINDOW_MS);
  });

  test("judgeRun stops an idle run only after the idle window and never while busy", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0, { busyForMs: 8 * MINUTE });
    if (!started.ok) throw new Error("unreachable");
    expect(judgeRun(started.state, BUDGET, IDLE, 6 * MINUTE)).toEqual({ action: "keep", checkAt: 13 * MINUTE });
    expect(judgeRun(started.state, BUDGET, IDLE, 13 * MINUTE)).toEqual({ action: "stop", reason: "idle" });
    const touched = touchRun(started.state, 7 * MINUTE, { clearBusy: true });
    expect(touched.busyUntil).toBeUndefined();
    expect(judgeRun(touched, BUDGET, IDLE, 11 * MINUTE)).toEqual({ action: "keep", checkAt: 12 * MINUTE });
    expect(judgeRun(touched, BUDGET, IDLE, 12 * MINUTE)).toEqual({ action: "stop", reason: "idle" });
  });

  test("judgeRun stops a run the moment its budget runs out, even mid-activity", () => {
    const started = startRun(freshBudgetLedger(0), BUDGET, 0, { busyForMs: 10 * MINUTE });
    if (!started.ok) throw new Error("unreachable");
    const active = touchRun(started.state, BUDGET - MINUTE);
    expect(judgeRun(active, BUDGET, IDLE, BUDGET - MINUTE)).toEqual({ action: "keep", checkAt: BUDGET });
    expect(judgeRun(active, BUDGET, IDLE, BUDGET)).toEqual({ action: "stop", reason: "budget" });
  });
});
