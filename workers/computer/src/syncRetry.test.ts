import { describe, expect, test } from "bun:test";
import { AlarmSlots, type AlarmStorage } from "./alarms";
import { DurableSyncRetryScheduler, settleSyncRetryAlarm, syncRetryAlarmSlot } from "./syncRetry";
import { coordinateWorkspaceAlarm } from "./workspaceAlarm";
import { RUNTIME_LEASE_ALARM } from "./runtimeLease";

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
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() {
        events.push("sync");
        await scheduler.clear("container");
        return { status: "complete" };
      },
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
      async getPendingSync() { return undefined; },
      async retryPendingSync() { return { status: "idle" }; },
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
      getPendingSync: () => scheduler.get("container"),
      async retryPendingSync() { throw new Error("transport failed"); },
      async handleRuntimeLease() { cleanupCalls += 1; },
      onSyncError(error) { errors.push(error); },
    });

    expect(errors).toHaveLength(1);
    expect(cleanupCalls).toBe(0);
    expect(await alarms.get(syncRetryAlarmSlot("container"))).toBe(31_000);
    expect(await alarms.get(RUNTIME_LEASE_ALARM)).toBe(31_000);
    expect(memory.getAlarm()).toBe(31_000);
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
