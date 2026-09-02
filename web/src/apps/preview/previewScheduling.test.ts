import { describe, expect, test } from "bun:test";
import {
  createPreviewFrameCommitGate,
  createPreviewReloadScheduler,
} from "./previewScheduling";

type Scheduled = { callback: () => void; cancelled: boolean; delayMs: number };

function controlledSchedule() {
  const scheduled: Scheduled[] = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, cancelled: false, delayMs };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runNext(delayMs?: number) {
      const next = scheduled.find((entry) =>
        !entry.cancelled && (delayMs === undefined || entry.delayMs === delayMs)
      );
      if (!next) throw new Error(`test: no scheduled callback for ${String(delayMs)}ms`);
      next.cancelled = true;
      next.callback();
    },
    async runWhenScheduled(delayMs: number) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const next = scheduled.find((entry) => !entry.cancelled && entry.delayMs === delayMs);
        if (next) {
          next.cancelled = true;
          next.callback();
          return;
        }
        await Promise.resolve();
      }
      throw new Error(`test: no scheduled callback for ${delayMs}ms`);
    },
    pendingDelays() {
      return scheduled.filter(({ cancelled }) => !cancelled).map(({ delayMs }) => delayMs);
    },
  };
}

describe("Preview scheduling", () => {
  test("debounces a burst into one rebuild and permits a later rebuild", async () => {
    const timers = controlledSchedule();
    let rebuilds = 0;
    const scheduler = createPreviewReloadScheduler(async () => {
      rebuilds += 1;
    }, timers.schedule);

    const burst = Array.from({ length: 10 }, () => scheduler.request(200));
    expect(rebuilds).toBe(0);
    timers.runNext(200);
    await Promise.all(burst);
    expect(rebuilds).toBe(1);

    const followUp = scheduler.request(200);
    timers.runNext(200);
    await followUp;
    expect(rebuilds).toBe(2);
    scheduler.dispose();
  });

  test("defers an in-flight commit until settle plus a macrotask and coalesces", async () => {
    const timers = controlledSchedule();
    let inFlight = 1;
    let settle: (() => void) | undefined;
    const quiescence = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const commits: string[] = [];
    const gate = createPreviewFrameCommitGate({
      getInFlightCount: () => inFlight,
      waitForQuiescence: () => quiescence,
      maxWaitMs: 2_000,
      schedule: timers.schedule,
    });

    gate.request(() => commits.push("first"));
    gate.request(() => commits.push("second"));
    expect(commits).toEqual([]);
    inFlight = 0;
    settle?.();
    expect(commits).toEqual([]);
    await timers.runWhenScheduled(0);
    await Promise.resolve();
    expect(commits).toEqual(["second"]);
    gate.dispose();
  });

  test("commits after the deferral cap when an invocation stays in flight", async () => {
    const timers = controlledSchedule();
    const commits: string[] = [];
    const gate = createPreviewFrameCommitGate({
      getInFlightCount: () => 1,
      waitForQuiescence: () => new Promise<void>(() => {}),
      hasInFlightSiteTool: () => false,
      maxWaitMs: 2_000,
      siteToolScope: "webmcp-computer://site/",
      schedule: timers.schedule,
    });

    gate.request(() => commits.push("capped"));
    expect(commits).toEqual([]);
    timers.runNext(2_000);
    await timers.runWhenScheduled(0);
    await Promise.resolve();
    expect(commits).toEqual(["capped"]);
    gate.dispose();
  });

  test("uses the site-tool timeout for the preview scope and commits after settle", async () => {
    const timers = controlledSchedule();
    let inFlight = 1;
    let settle: (() => void) | undefined;
    const quiescence = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const commits: string[] = [];
    const gate = createPreviewFrameCommitGate({
      getInFlightCount: () => inFlight,
      waitForQuiescence: () => quiescence,
      hasInFlightSiteTool: (scope) => scope === "webmcp-computer://site/",
      maxWaitMs: 2_000,
      siteToolMaxWaitMs: 10_000,
      siteToolScope: "webmcp-computer://site/",
      schedule: timers.schedule,
    });

    gate.request(() => commits.push("settled"));
    expect(commits).toEqual([]);
    expect(timers.pendingDelays()).toEqual([10_000]);

    inFlight = 0;
    settle?.();
    await timers.runWhenScheduled(0);
    await Promise.resolve();
    expect(commits).toEqual(["settled"]);
    gate.dispose();
  });
});
