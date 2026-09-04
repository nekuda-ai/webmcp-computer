import { describe, expect, test } from "bun:test";
import { BUDGET_WINDOW_MS } from "../../../shared/session-limits";
import { AlarmSlots, type AlarmStorage } from "./alarms";
import { DurableSyncRetryScheduler, settleSyncRetryAlarm, syncRetryAlarmSlot } from "./syncRetry";
import { coordinateWorkspaceAlarm, DurableTerminalSyncAttempts } from "./workspaceAlarm";
import { RUNTIME_LEASE_ALARM, RuntimeLease } from "./runtimeLease";

export function memoryAlarmStorage(initialAlarm: number | null = null) {
  const values = new Map<string, unknown>();
  let alarm = initialAlarm;
  const alarms: Array<number | null> = [];
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; alarms.push(value); },
    async deleteAlarm() { alarm = null; alarms.push(null); },
  } as AlarmStorage;
  return { alarms, getAlarm: () => alarm, storage, values };
}

describe("alarm slots", () => {
  test("arms the earliest named deadline and reports which slots are due", async () => {
    const memory = memoryAlarmStorage();
    const slots = new AlarmSlots(memory.storage);
    await slots.set("lease", 5_000);
    await slots.set("sync", 2_000);
    expect(memory.getAlarm()).toBe(2_000);
    expect(await slots.due(500)).toEqual([]);
    expect(await slots.due(2_000)).toEqual(["sync"]);
    expect(await slots.due(6_000)).toEqual(["lease", "sync"]);

    await slots.clear("sync");
    expect(memory.getAlarm()).toBe(5_000);
    await slots.set("lease", Number.POSITIVE_INFINITY);
    expect(memory.getAlarm()).toBeNull();
    expect(memory.values.size).toBe(0);
  });
});

describe("workspace alarm coordination", () => {
  test("completes a due sync before allowing coincident runtime cleanup", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const syncSlot = syncRetryAlarmSlot("container");
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 1, notBefore: 1_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const events: string[] = [];

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        events.push("sync");
        await scheduler.clear("container");
        return { status: "complete" };
      },
      async runtimeCleanupReason() { return "idle" as const; },
      async handleRuntimeLease() {
        events.push("cleanup");
        await alarms.clear(RUNTIME_LEASE_ALARM);
      },
    });

    expect(events).toEqual(["sync", "cleanup"]);
    expect(await alarms.get(syncSlot)).toBeUndefined();
    expect(memory.getAlarm()).toBeNull();
  });

  test("defers runtime cleanup to a later pending sync deadline and through another retry", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const syncSlot = syncRetryAlarmSlot("container");
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 1, notBefore: 5_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const events: string[] = [];
    let retryCount = 0;
    const options = (now: number) => ({
      alarms,
      backend: "container",
      now,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        events.push(`sync:${now}`);
        retryCount += 1;
        if (retryCount === 1) {
          await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 2, notBefore: 9_000 });
          return { status: "pending" as const };
        }
        await scheduler.clear("container");
        return { status: "complete" as const };
      },
      async runtimeCleanupReason() { return "idle" as const; },
      async handleRuntimeLease() {
        events.push(`cleanup:${now}`);
        await alarms.clear(RUNTIME_LEASE_ALARM);
      },
    });

    await coordinateWorkspaceAlarm(options(1_000));
    expect(events).toEqual([]);
    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(5_000);
    expect(memory.getAlarm()).toBe(5_000);

    await coordinateWorkspaceAlarm(options(5_000));
    expect(events).toEqual(["sync:5000"]);
    expect(await alarms.get(syncSlot)).toBe(9_000);
    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(9_000);

    await coordinateWorkspaceAlarm(options(9_000));
    expect(events).toEqual(["sync:5000", "sync:9000", "cleanup:9000"]);
    expect(memory.getAlarm()).toBeNull();
  });

  test("never defers idle cleanup past the hard runtime budget deadline", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    await scheduler.schedule({ backend: "container", attempt: 1, notBefore: 50_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() { return { status: "pending" }; },
      async runtimeCleanupReason() { return "idle"; },
      async runtimeHardBudgetDeadline() { return 10_000; },
      async handleRuntimeLease() { throw new Error("cleanup must remain deferred"); },
    });

    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(10_000);
    expect(memory.getAlarm()).toBe(10_000);
  });

  test("rearms the multiplexed alarm even when an unexpected handler error escapes", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    // The platform consumes the alarm before invoking alarm(); durable slots remain.
    await memory.storage.deleteAlarm();

    await expect(coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      async getPendingSync() { return undefined; },
      async retryPendingSync() { return { status: "idle" }; },
      async runtimeCleanupReason() { return "idle" as const; },
      async handleRuntimeLease() { throw new Error("unexpected cleanup error"); },
    })).rejects.toThrow("unexpected cleanup error");

    expect(memory.getAlarm()).toBe(1_000);
    expect(memory.alarms.slice(-2)).toEqual([null, 1_000]);
  });

  test("durably rearms an unexpected sync failure instead of consuming finite platform retries", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    await scheduler.schedule({ backend: "container", attempt: 1, notBefore: 1_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const errors: unknown[] = [];
    let cleanupCalls = 0;

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() { throw new Error("transport failed"); },
      async runtimeCleanupReason() { return "idle" as const; },
      async handleRuntimeLease() { cleanupCalls += 1; },
      onSyncError(error) { errors.push(error); },
    });

    expect(errors).toHaveLength(1);
    expect(cleanupCalls).toBe(0);
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBe(31_000);
    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(31_000);
    expect(memory.getAlarm()).toBe(31_000);
  });

  test("starts another bounded SDK retry cycle after exhaustion and eventually syncs", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 12, notBefore: 1_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const events: string[] = [];
    let retries = 0;
    const options = (now: number) => ({
      alarms,
      backend: "container",
      now,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        retries += 1;
        events.push(`sync:${now}:${retries}`);
        if (retries === 1) return { status: "exhausted" as const };
        await scheduler.clear("container");
        return { status: "complete" as const };
      },
      async runtimeCleanupReason() { return "idle" as const; },
      async handleRuntimeLease() {
        events.push(`cleanup:${now}`);
        await alarms.clear(RUNTIME_LEASE_ALARM);
      },
    });

    await coordinateWorkspaceAlarm(options(1_000));
    expect(events).toEqual(["sync:1000:1"]);
    expect(await scheduler.get("container")).toEqual({
      backend: "container",
      runtimeId: "runtime-1",
      attempt: 12,
      notBefore: 1_000,
    });
    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(31_000);

    await coordinateWorkspaceAlarm(options(31_000));
    expect(events).toEqual(["sync:1000:1", "sync:31000:2", "cleanup:31000"]);
    expect(await scheduler.get("container")).toBeUndefined();
    expect(memory.getAlarm()).toBeNull();
  });

  test("hard-budget cleanup retries destruction without repeating terminal sync after reconstruction", async () => {
    const memory = memoryAlarmStorage();
    let now = 0;
    let destroyAttempts = 0;
    let syncAttempts = 0;
    const makeCoordinator = () => {
      const alarms = new AlarmSlots(memory.storage);
      const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
      const lease = new RuntimeLease(memory.storage, alarms, {
        budgetMs: 2 * 60 * 60_000,
        idleMs: 5 * 60_000,
        now: () => now,
      });
      const terminalSyncAttempts = new DurableTerminalSyncAttempts(memory.storage);
      return { alarms, scheduler, lease, terminalSyncAttempts };
    };

    let reconstructed = makeCoordinator();
    await reconstructed.lease.acquire(60_000);
    await reconstructed.scheduler.schedule({
      backend: "container",
      runtimeId: "runtime-1",
      attempt: 12,
      notBefore: 2 * 60 * 60_000,
    });
    now = 2 * 60 * 60_000;

    const runAlarm = async () => {
      reconstructed = makeCoordinator();
      await coordinateWorkspaceAlarm({
        alarms: reconstructed.alarms,
        backend: "container",
        now,
        terminalSyncAttempts: reconstructed.terminalSyncAttempts,
        getPendingSync: () => reconstructed.scheduler.get("container"),
        async retryPendingSync() {
          syncAttempts += 1;
          return { status: "exhausted" as const };
        },
        runtimeCleanupReason: () => reconstructed.lease.cleanupReason(),
        runtimeHardBudgetDeadline: () => reconstructed.lease.hardBudgetDeadline(),
        handleRuntimeLease: () => reconstructed.lease.onAlarm(async () => {
          destroyAttempts += 1;
          if (destroyAttempts < 3) throw new Error("destroy failed");
        }),
      });
    };

    await runAlarm();
    expect(syncAttempts).toBe(1);
    expect(destroyAttempts).toBe(1);
    expect(await reconstructed.terminalSyncAttempts.attempted("container")).toBe(true);

    now += 30_000;
    await runAlarm();
    expect(syncAttempts).toBe(1);
    expect(destroyAttempts).toBe(2);

    now += 30_000;
    await runAlarm();
    expect(syncAttempts).toBe(1);
    expect(destroyAttempts).toBe(3);
    expect(await reconstructed.scheduler.get("container")).toEqual(expect.objectContaining({ attempt: 12 }));
    expect(await reconstructed.alarms.get(syncRetryAlarmSlot("container"))).toBeUndefined();
    expect(await reconstructed.terminalSyncAttempts.attempted("container")).toBe(false);
    expect(memory.getAlarm()).toBeNull();
  });

  test("a new-window acquire cannot inherit a previous terminal cleanup decision", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const terminalSyncAttempts = new DurableTerminalSyncAttempts(memory.storage);
    let now = 0;
    const lease = new RuntimeLease(memory.storage, alarms, {
      budgetMs: 2 * 60 * 60_000,
      idleMs: 5 * 60_000,
      now: () => now,
    });

    await lease.acquire(60_000);
    await lease.started();
    await lease.release();
    await scheduler.schedule({
      backend: "container",
      runtimeId: "old-runtime",
      attempt: 12,
      notBefore: 2 * 60 * 60_000,
    });
    now = 2 * 60 * 60_000;
    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now,
      terminalSyncAttempts,
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() { return { status: "exhausted" as const }; },
      runtimeCleanupReason: () => lease.cleanupReason(),
      runtimeHardBudgetDeadline: () => lease.hardBudgetDeadline(),
      handleRuntimeLease: () => lease.onAlarm(async () => { throw new Error("destroy failed"); }),
    });
    expect(await terminalSyncAttempts.attempted("container")).toBe(true);

    now = BUDGET_WINDOW_MS + 60_000;
    const blocked = await lease.acquire(60_000, async () => {
      throw new Error("marker clear failed");
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.error.code).toBe("ECAPACITY");
    expect(await terminalSyncAttempts.attempted("container")).toBe(true);

    const acquired = await lease.acquire(60_000, () => terminalSyncAttempts.clear("container"));
    expect(acquired.ok).toBe(true);
    expect(await terminalSyncAttempts.attempted("container")).toBe(false);
    await lease.release();
    await scheduler.schedule({
      backend: "container",
      runtimeId: "new-runtime",
      attempt: 1,
      notBefore: now + 5 * 60_000,
    });

    now += 5 * 60_000;
    const events: string[] = [];
    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now,
      terminalSyncAttempts,
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        events.push("sync-new-work");
        await scheduler.clear("container");
        return { status: "complete" as const };
      },
      runtimeCleanupReason: () => lease.cleanupReason(),
      runtimeHardBudgetDeadline: () => lease.hardBudgetDeadline(),
      handleRuntimeLease: () => lease.onAlarm(async () => { events.push("cleanup"); }),
    });

    expect(events).toEqual(["sync-new-work", "cleanup"]);
    expect(await scheduler.get("container")).toBeUndefined();
  });

  test("clears the terminal marker after a successful final sync and cleanup", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const terminalSyncAttempts = new DurableTerminalSyncAttempts(memory.storage);
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 2, notBefore: 1_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    let syncAttempts = 0;

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts,
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        syncAttempts += 1;
        await scheduler.clear("container");
        return { status: "complete" as const };
      },
      async runtimeCleanupReason() { return "budget" as const; },
      async handleRuntimeLease() { return "stopped-budget" as const; },
    });

    expect(syncAttempts).toBe(1);
    expect(await scheduler.get("container")).toBeUndefined();
    expect(await terminalSyncAttempts.attempted("container")).toBe(false);
  });

  test("retains diagnostic intent but clears the marker after failed final sync and successful cleanup", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const terminalSyncAttempts = new DurableTerminalSyncAttempts(memory.storage);
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 2, notBefore: 1_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const terminal: unknown[] = [];

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts,
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() { throw new Error("sync failed"); },
      async runtimeCleanupReason() { return "budget" as const; },
      async handleRuntimeLease() { return "stopped-budget" as const; },
      onTerminalSyncFailure(failure) { terminal.push(failure); },
    });

    expect(terminal).toEqual([expect.objectContaining({ status: "error", error: expect.any(Error) })]);
    expect(await scheduler.get("container")).toEqual(expect.objectContaining({ attempt: 2 }));
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBeUndefined();
    expect(await terminalSyncAttempts.attempted("container")).toBe(false);
  });

  test("terminal-marker storage failures never prevent hard-budget destruction", async () => {
    for (const failure of ["read", "mark", "clear"] as const) {
      const memory = memoryAlarmStorage();
      const alarms = new AlarmSlots(memory.storage);
      const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
      await scheduler.schedule({ backend: "container", attempt: 1, notBefore: 1_000 });
      await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
      let cleanupCalls = 0;
      let syncAttempts = 0;
      const markerErrors: unknown[] = [];
      const terminalSyncAttempts = {
        async attempted() {
          if (failure === "read") throw new Error("marker read failed");
          return false;
        },
        async mark() {
          if (failure === "mark") throw new Error("marker mark failed");
        },
        async clear() {
          if (failure === "clear") throw new Error("marker clear failed");
        },
      };

      await coordinateWorkspaceAlarm({
        alarms,
        backend: "container",
        now: 1_000,
        terminalSyncAttempts,
        getPendingSync: () => scheduler.get("container"),
        async retryPendingSync() {
          syncAttempts += 1;
          return { status: "exhausted" as const };
        },
        async runtimeCleanupReason() { return "budget" as const; },
        async handleRuntimeLease() {
          cleanupCalls += 1;
          return "stopped-budget" as const;
        },
        onTerminalMarkerError(error) { markerErrors.push(error); },
      });

      expect(cleanupCalls).toBe(1);
      expect(markerErrors).toHaveLength(1);
      expect(syncAttempts).toBe(failure === "clear" ? 1 : 0);
    }
  });

  test("hard budget forces one final retry and cleanup even while exhausted intent remains", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    await scheduler.schedule({ backend: "container", runtimeId: "runtime-1", attempt: 12, notBefore: 60_000 });
    await alarms.set(RUNTIME_LEASE_ALARM, 1_000);
    const events: string[] = [];
    const terminal: unknown[] = [];
    let retries = 0;

    await coordinateWorkspaceAlarm({
      alarms,
      backend: "container",
      now: 1_000,
      terminalSyncAttempts: new DurableTerminalSyncAttempts(memory.storage),
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        retries += 1;
        events.push(`sync:${retries}`);
        return { status: "exhausted" as const };
      },
      async runtimeCleanupReason() { return "budget" as const; },
      async handleRuntimeLease() {
        events.push("cleanup");
        await alarms.clear(RUNTIME_LEASE_ALARM);
      },
      onTerminalSyncFailure(event) { terminal.push(event); },
    });

    expect(events).toEqual(["sync:1", "cleanup"]);
    expect(terminal).toEqual([expect.objectContaining({
      reason: "runtime-budget",
      status: "exhausted",
      intent: expect.objectContaining({ attempt: 12 }),
    })]);
    expect(await scheduler.get("container")).toEqual(expect.objectContaining({ attempt: 12 }));
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBeUndefined();
    expect(memory.getAlarm()).toBeNull();
  });
});

describe("durable sync retry scheduler", () => {
  test("persists pending retry and moves only its own deadline", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    await alarms.set("lease", 3_000);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    const intent = { backend: "container", runtimeId: "runtime-1", attempt: 1, notBefore: 2_000 };
    await scheduler.schedule(intent);
    expect(await scheduler.get("container")).toEqual(intent);
    expect(memory.getAlarm()).toBe(2_000);

    await scheduler.schedule({ ...intent, attempt: 2, notBefore: 4_000 });
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBe(4_000);
    expect(memory.getAlarm()).toBe(3_000);
  });

  test("releases terminal and idle alarm slots without disturbing pending retries", async () => {
    for (const status of ["idle", "complete", "exhausted", "lost"] as const) {
      const memory = memoryAlarmStorage();
      const alarms = new AlarmSlots(memory.storage);
      await alarms.set(syncRetryAlarmSlot("container"), 1_000);
      await settleSyncRetryAlarm(alarms, "container", status);
      expect(await alarms.get(syncRetryAlarmSlot("container"))).toBeUndefined();
      expect(memory.getAlarm()).toBeNull();
    }

    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    await alarms.set(syncRetryAlarmSlot("container"), 2_000);
    await settleSyncRetryAlarm(alarms, "container", "pending");
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBe(2_000);
  });

  test("clears completed intent and releases the alarm when nothing else waits", async () => {
    const memory = memoryAlarmStorage();
    const alarms = new AlarmSlots(memory.storage);
    const scheduler = new DurableSyncRetryScheduler(memory.storage, alarms);
    await scheduler.schedule({ backend: "container", attempt: 1, notBefore: 2_000 });
    await scheduler.clear("container");
    expect(await scheduler.get("container")).toBeUndefined();
    expect(memory.getAlarm()).toBeNull();
  });
});
