import { describe, expect, test } from "bun:test";
import { BUDGET_WINDOW_MS } from "../../../shared/session-limits";
import { BrowserLease, type LeaseStorage } from "./lease";
import { OrphanedSessionError, UpstreamError, type SessionTarget, type Upstream } from "./upstream";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUDGET = 2 * HOUR;
const IDLE = 5 * MINUTE;
const SESSION_A = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_B = "223e4567-e89b-42d3-a456-426614174000";

export function memoryLeaseStorage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; },
    async deleteAlarm() { alarm = null; },
  } as LeaseStorage;
  return { storage, alarm: () => alarm };
}

function target(id = "target-1"): SessionTarget {
  return {
    id,
    type: "page",
    devtoolsFrontendUrl: "https://live.browser.run/ui/view?wss=fresh",
    webSocketDebuggerUrl: "wss://live.browser.run/api/devtools/page?jwt=fresh",
  };
}

export function fakeUpstream(options: { sessions?: string[]; createError?: Error; closeFailures?: number } = {}) {
  const sessions = options.sessions ?? [SESSION_A, SESSION_B];
  const calls: string[] = [];
  let closeFailures = options.closeFailures ?? 0;
  const upstream: Upstream = {
    async create(url) {
      calls.push(`create:${url}`);
      if (options.createError) throw options.createError;
      const sessionId = sessions.shift();
      if (!sessionId) throw new Error("test: no session left");
      return {
        sessionId,
        liveViewUrl: "https://live.browser.run/ui/view?wss=fresh",
        tabWsUrl: "wss://live.browser.run/api/devtools/page?jwt=fresh",
        targetId: "target-1",
        keepAliveMs: 600_000,
      };
    },
    async list(sessionId) {
      calls.push(`list:${sessionId}`);
      return [{ id: "worker" }, target()];
    },
    async close(sessionId) {
      calls.push(`close:${sessionId}`);
      if (closeFailures > 0) {
        closeFailures -= 1;
        throw new UpstreamError(500, "close failed");
      }
      return { status: "closing" };
    },
  };
  return { upstream, calls };
}

function leaseFixture(upstreamOptions: Parameters<typeof fakeUpstream>[0] = {}) {
  const memory = memoryLeaseStorage();
  const fake = fakeUpstream(upstreamOptions);
  let now = 0;
  const lease = new BrowserLease(memory.storage, fake.upstream, { now: () => now, budgetMs: BUDGET, idleMs: IDLE });
  return { lease, calls: fake.calls, alarm: memory.alarm, advance(ms: number) { now += ms; } };
}

describe("browser lease", () => {
  test("creates one session, arms the idle alarm, and reports budget", async () => {
    const fixture = leaseFixture();
    const created = await fixture.lease.create("https://example.com/");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.sessionId).toBe(SESSION_A);
    expect(created.value.keepAliveMs).toBe(600_000);
    expect(created.value.idleTimeoutMs).toBe(IDLE);
    expect(created.value.budget).toEqual({ remainingMs: BUDGET, usedMs: 0, windowResetsAt: BUDGET_WINDOW_MS });
    expect(fixture.alarm()).toBe(IDLE);
  });

  test("a second create replaces the machine's Chrome instead of doubling it", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://one.example/");
    fixture.advance(MINUTE);
    const second = await fixture.lease.create("https://two.example/");
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.sessionId).toBe(SESSION_B);
    expect(fixture.calls).toEqual(["create:https://one.example/", `close:${SESSION_A}`, "create:https://two.example/"]);
    expect(second.value.budget.usedMs).toBe(MINUTE);
  });

  test("serializes concurrent creates so only one Chrome remains held", async () => {
    const fixture = leaseFixture();
    const [first, second] = await Promise.all([
      fixture.lease.create("https://one.example/"),
      fixture.lease.create("https://two.example/"),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fixture.calls).toEqual([
      "create:https://one.example/",
      `close:${SESSION_A}`,
      "create:https://two.example/",
    ]);
    const oldSession = await fixture.lease.heartbeat(SESSION_A);
    expect(oldSession.ok).toBe(false);
    const heldSession = await fixture.lease.heartbeat(SESSION_B);
    expect(heldSession.ok).toBe(true);
  });

  test("does not orphan the old Chrome when replacement close fails", async () => {
    const fixture = leaseFixture({ closeFailures: 1 });
    await fixture.lease.create("https://one.example/");
    fixture.advance(MINUTE);
    const second = await fixture.lease.create("https://two.example/");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.status).toBe(500);
    expect(fixture.calls).toEqual(["create:https://one.example/", `close:${SESSION_A}`]);
    expect(fixture.alarm()).toBe(MINUTE + 30_000);

    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm()).toBe("stopped-requested");
    expect(fixture.calls.filter((call) => call === `close:${SESSION_A}`)).toHaveLength(2);
    expect(fixture.alarm()).toBeNull();
  });

  test("heartbeats keep the alarm moving; silence deletes the Chrome server-side", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");
    fixture.advance(4 * MINUTE);
    const beat = await fixture.lease.heartbeat(SESSION_A);
    expect(beat.ok).toBe(true);
    expect(fixture.alarm()).toBe(9 * MINUTE);

    fixture.advance(4 * MINUTE);
    expect(await fixture.lease.onAlarm()).toBe("kept");
    expect(fixture.calls).not.toContain(`close:${SESSION_A}`);

    fixture.advance(MINUTE);
    expect(await fixture.lease.onAlarm()).toBe("stopped-idle");
    expect(fixture.calls).toContain(`close:${SESSION_A}`);
    expect(fixture.alarm()).toBeNull();

    const late = await fixture.lease.heartbeat(SESSION_A);
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error("unreachable");
    expect(late.status).toBe(404);
    expect(late.error).toEqual({ error: "browser session is no longer held; start a new one", code: "EIDLE" });
    expect(await fixture.lease.onAlarm()).toBe("none");
  });

  test("actions on a session id this machine does not hold are refused as EOWNER", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");
    for (const result of [
      await fixture.lease.heartbeat(SESSION_B),
      await fixture.lease.refresh(SESSION_B),
      await fixture.lease.close(SESSION_B),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.status).toBe(403);
      expect(result.error).toEqual({ error: "browser session belongs to another machine", code: "EOWNER" });
    }
    expect(fixture.calls).toEqual(["create:https://example.com/"]);
  });

  test("a live Chrome keeps fixed windows, current-window charges, and real idle time across rollover", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");

    fixture.advance(2 * BUDGET_WINDOW_MS + 30 * MINUTE);
    expect(await fixture.lease.onAlarm()).toBe("stopped-idle");
    const renewed = await fixture.lease.create("https://example.com/");
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error("unreachable");
    expect(renewed.value.budget).toEqual({
      remainingMs: BUDGET - 30 * MINUTE,
      usedMs: 30 * MINUTE,
      windowResetsAt: 3 * BUDGET_WINDOW_MS,
    });
  });

  test("the hard budget stops a live Chrome and refuses new ones until the window resets", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");
    fixture.advance(BUDGET);
    expect(await fixture.lease.onAlarm()).toBe("stopped-budget");
    const refused = await fixture.lease.create("https://example.com/");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.status).toBe(429);
    expect("code" in refused.error && refused.error.code).toBe("EBUDGET");
    expect(fixture.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);

    fixture.advance(BUDGET_WINDOW_MS - BUDGET);
    const renewed = await fixture.lease.create("https://example.com/");
    expect(renewed.ok).toBe(true);
  });

  test("a heartbeat that lands after the budget ran out stops the Chrome immediately", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");
    fixture.advance(BUDGET + 1);
    const beat = await fixture.lease.heartbeat(SESSION_A);
    expect(beat.ok).toBe(false);
    if (beat.ok) throw new Error("unreachable");
    expect(beat.status).toBe(429);
    expect("code" in beat.error && beat.error.code).toBe("EBUDGET");
    expect(fixture.calls).toContain(`close:${SESSION_A}`);
  });

  test("close books the time and is idempotent", async () => {
    const fixture = leaseFixture();
    await fixture.lease.create("https://example.com/");
    fixture.advance(10 * MINUTE);
    const closed = await fixture.lease.close(SESSION_A);
    if (!closed.ok) throw new Error("unreachable");
    expect(closed.value).toEqual({
      status: "closing",
      budget: { remainingMs: BUDGET - 10 * MINUTE, usedMs: 10 * MINUTE, windowResetsAt: BUDGET_WINDOW_MS },
    });
    expect(fixture.alarm()).toBeNull();
    const again = await fixture.lease.close(SESSION_A);
    expect(again.ok).toBe(true);
    expect(fixture.calls.filter((call) => call.startsWith("close:"))).toHaveLength(1);
  });

  test("a failed explicit close stays leased and retries until Browser Run confirms it", async () => {
    const fixture = leaseFixture({ closeFailures: 1 });
    await fixture.lease.create("https://example.com/");
    fixture.advance(MINUTE);
    const close = await fixture.lease.close(SESSION_A);
    expect(close.ok).toBe(false);
    if (close.ok) throw new Error("unreachable");
    expect(close.status).toBe(500);
    expect(fixture.alarm()).toBe(MINUTE + 30_000);

    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm()).toBe("stopped-requested");
    const afterRetry = await fixture.lease.close(SESSION_A);
    if (!afterRetry.ok) throw new Error("unreachable");
    expect(afterRetry.value.budget.usedMs).toBe(MINUTE + 30_000);
  });

  test("keeps charging and retries when failed session setup cannot roll back Chrome", async () => {
    const fixture = leaseFixture({
      createError: new OrphanedSessionError(SESSION_A, new UpstreamError(500, "tab creation failed")),
    });
    const created = await fixture.lease.create("https://example.com/");
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.status).toBe(500);
    expect(fixture.alarm()).toBe(30_000);

    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm()).toBe("stopped-requested");
    expect(fixture.calls).toEqual(["create:https://example.com/", `close:${SESSION_A}`]);
  });

  test("a failed upstream create stops charging at once and names Browser Run capacity", async () => {
    const capacity = leaseFixture({ createError: new UpstreamError(429, "Too many browsers", 15_000) });
    const refused = await capacity.lease.create("https://example.com/");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.status).toBe(503);
    expect(refused.error).toEqual({ error: "browser service is at capacity right now", code: "ECAPACITY", retryAfterMs: 15_000 });
    capacity.advance(HOUR);
    const later = await capacity.lease.create("https://example.com/");
    expect(later.ok).toBe(false);
    if (later.ok) throw new Error("unreachable");
    // Only the failed attempt's instant was charged, not the hour in between.
    expect(capacity.alarm()).toBeNull();

    const outage = leaseFixture({ createError: new UpstreamError(503, "quota exceeded") });
    const failed = await outage.lease.create("https://example.com/");
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.status).toBe(503);
    expect(failed.error).toEqual({ error: "quota exceeded" });
  });

  test("the alarm retries a failed upstream close before giving up", async () => {
    const fixture = leaseFixture({ closeFailures: 1 });
    await fixture.lease.create("https://example.com/");
    fixture.advance(IDLE + 1);
    expect(await fixture.lease.onAlarm()).toBe("retry");
    expect(fixture.alarm()).toBe(IDLE + 1 + 30_000);
    fixture.advance(30_000);
    expect(await fixture.lease.onAlarm()).toBe("stopped-idle");
    expect(fixture.calls.filter((call) => call === `close:${SESSION_A}`)).toHaveLength(2);
  });
});
