import { describe, expect, test } from "bun:test";
import { AlarmSlots } from "./alarms";
import { RUNTIME_LEASE_ALARM, RuntimeLease } from "./runtimeLease";
import { memoryAlarmStorage } from "./syncRetry.test";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUDGET = 2 * HOUR;
const IDLE = 5 * MINUTE;

function leaseFixture(start = 0) {
  const memory = memoryAlarmStorage();
  const alarms = new AlarmSlots(memory.storage);
  let now = start;
  const stops: number[] = [];
  const lease = new RuntimeLease(memory.storage, alarms, { budgetMs: BUDGET, idleMs: IDLE, now: () => now });
  return {
    alarms,
    lease,
    memory,
    stops,
    advance(ms: number) { now += ms; },
    stop: async () => { stops.push(now); },
  };
}

describe("runtime lease", () => {
  test("acquire arms an idle alarm that respects the exec busy window", async () => {
    const fixture = leaseFixture();
    const acquired = await fixture.lease.acquire(8 * MINUTE);
    expect(acquired.ok).toBe(true);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBe(13 * MINUTE);

    fixture.advance(2 * MINUTE);
    await fixture.lease.release();
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBe(7 * MINUTE);
  });

  test("refuses overlapping execs in the same workspace", async () => {
    const fixture = leaseFixture();
    expect((await fixture.lease.acquire(8 * MINUTE)).ok).toBe(true);
    const concurrent = await fixture.lease.acquire(MINUTE);
    expect(concurrent.ok).toBe(false);
    if (concurrent.ok) throw new Error("unreachable");
    expect(concurrent.error).toEqual({
      error: "another cloud command is already running in this workspace",
      code: "ECAPACITY",
      retryAfterMs: 1_000,
    });
  });

  test("the alarm stops an idle container once and books its running time", async () => {
    const fixture = leaseFixture();
    await fixture.lease.acquire(MINUTE);
    fixture.advance(MINUTE);
    await fixture.lease.release();

    fixture.advance(2 * MINUTE);
    expect(await fixture.lease.onAlarm(fixture.stop)).toBe("kept");
    expect(fixture.stops).toEqual([]);

    fixture.advance(3 * MINUTE);
    expect(await fixture.lease.onAlarm(fixture.stop)).toBe("stopped-idle");
    expect(fixture.stops).toEqual([6 * MINUTE]);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBeUndefined();
    expect((await fixture.lease.budget()).usedMs).toBe(6 * MINUTE);

    expect(await fixture.lease.onAlarm(fixture.stop)).toBe("none");
    expect(fixture.stops).toHaveLength(1);
  });

  test("durably retries repeated stop failures, keeps charging, and eventually books success", async () => {
    const fixture = leaseFixture();
    await fixture.lease.acquire(MINUTE);
    fixture.advance(10 * MINUTE);
    let attempts = 0;
    const stop = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("destroy failed");
      fixture.stops.push(attempts);
    };

    expect(await fixture.lease.onAlarm(stop)).toBe("cleanup-retry");
    expect((await fixture.lease.budget()).usedMs).toBe(10 * MINUTE);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBe(10 * MINUTE + 30_000);

    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm(stop)).toBe("cleanup-retry");
    expect((await fixture.lease.budget()).usedMs).toBe(10 * MINUTE + 30_000);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBe(11 * MINUTE);

    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm(stop)).toBe("stopped-idle");
    expect(fixture.stops).toEqual([3]);
    expect((await fixture.lease.budget()).usedMs).toBe(11 * MINUTE);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBeUndefined();
  });

  test("the hard budget stops a busy container and refuses new execs until the window resets", async () => {
    const fixture = leaseFixture();
    await fixture.lease.acquire(10 * MINUTE);
    fixture.advance(BUDGET);
    expect(await fixture.lease.onAlarm(fixture.stop)).toBe("stopped-budget");
    const refused = await fixture.lease.acquire(MINUTE);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("EBUDGET");
    expect(refused.budget.remainingMs).toBe(0);

    fixture.advance(22 * HOUR + MINUTE);
    const renewed = await fixture.lease.acquire(MINUTE);
    expect(renewed.ok).toBe(true);
    expect(renewed.budget.remainingMs).toBe(BUDGET);
  });

  test("abandon stops charging immediately when the container never ran", async () => {
    const fixture = leaseFixture();
    await fixture.lease.acquire(MINUTE);
    fixture.advance(30_000);
    const budget = await fixture.lease.abandon();
    expect(budget.usedMs).toBe(30_000);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBeUndefined();
    fixture.advance(HOUR);
    expect((await fixture.lease.budget()).usedMs).toBe(30_000);
  });

  test("abandoning a failed exec preserves an already-running warm container lease", async () => {
    const fixture = leaseFixture();
    await fixture.lease.acquire(MINUTE);
    await fixture.lease.started();
    fixture.advance(MINUTE);
    await fixture.lease.release();

    fixture.advance(MINUTE);
    await fixture.lease.acquire(MINUTE);
    fixture.advance(30_000);
    const budget = await fixture.lease.abandon();
    expect(budget.usedMs).toBe(2 * MINUTE + 30_000);
    expect(await fixture.alarms.get(RUNTIME_LEASE_ALARM)).toBe(7 * MINUTE + 30_000);
  });
});
