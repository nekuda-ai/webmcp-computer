import { describe, expect, test } from "bun:test";
import { DurableSyncRetryScheduler, type SyncRetryStorage } from "./syncRetry";

function memoryStorage(initialAlarm: number | null = null) {
  const values = new Map<string, unknown>();
  let alarm = initialAlarm;
  const alarms: number[] = [];
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; alarms.push(value); },
    async deleteAlarm() { alarm = null; },
  } as SyncRetryStorage;
  return { alarms, getAlarm: () => alarm, storage, values };
}

describe("durable sync retry scheduler", () => {
  test("persists pending retry and schedules earliest wake-up", async () => {
    const memory = memoryStorage(5_000);
    const scheduler = new DurableSyncRetryScheduler(memory.storage);
    const intent = { backend: "container", runtimeId: "runtime-1", attempt: 1, notBefore: 2_000 };
    await scheduler.schedule(intent);
    expect(await scheduler.get("container")).toEqual(intent);
    expect(memory.alarms).toEqual([2_000]);

    await scheduler.schedule({ ...intent, attempt: 2, notBefore: 4_000 });
    expect(memory.alarms).toEqual([2_000]);
  });

  test("clears completed intent and alarm", async () => {
    const memory = memoryStorage();
    const scheduler = new DurableSyncRetryScheduler(memory.storage);
    await scheduler.schedule({ backend: "container", attempt: 1, notBefore: 2_000 });
    await scheduler.clear("container");
    expect(await scheduler.get("container")).toBeUndefined();
    expect(memory.getAlarm()).toBeNull();
  });
});
