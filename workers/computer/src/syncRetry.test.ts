import { describe, expect, test } from "bun:test";
import { AlarmSlots, type AlarmStorage } from "./alarms";
import { DurableSyncRetryScheduler, settleSyncRetryAlarm, syncRetryAlarmSlot } from "./syncRetry";

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
