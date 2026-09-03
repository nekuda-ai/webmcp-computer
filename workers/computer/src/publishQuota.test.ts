import { describe, expect, test } from "bun:test";
import { BUDGET_WINDOW_MS, PUBLISH_QUOTA_LIMIT } from "../../../shared/session-limits";
import { PublishQuota, type PublishQuotaStorage } from "./publishQuota";

function quotaFixture(start = 1_000) {
  const values = new Map<string, unknown>();
  let now = start;
  let nextId = 0;
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) {
      // Match Durable Object storage serialization instead of retaining caller references.
      values.set(key, structuredClone(value));
    },
  } satisfies PublishQuotaStorage;
  const createQuota = () => new PublishQuota(storage, {
    now: () => now,
    reservationId: () => `reservation-${nextId++}`,
  });
  return {
    quota: createQuota(),
    restart: createQuota,
    advance(ms: number) { now += ms; },
  };
}

async function reserveAccepted(quota: PublishQuota): Promise<string> {
  const result = await quota.reserve();
  if (!result.ok) throw new Error("expected publish reservation");
  return result.reservationId;
}

describe("publish quota", () => {
  test("allows exactly twenty committed publishes and reports the fixed-window retry", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await fixture.quota.commit(await reserveAccepted(fixture.quota));
    }

    fixture.advance(12_345);
    const refused = await fixture.quota.reserve();
    expect(refused).toEqual({
      ok: false,
      error: {
        error: `anonymous publish limit of ${PUBLISH_QUOTA_LIMIT} per 24-hour accounting window is exhausted`,
        code: "EPUBLISHQUOTA",
        retryAfterMs: BUDGET_WINDOW_MS - 12_345,
      },
    });
  });

  test("persists committed usage across Durable Object restarts", async () => {
    const fixture = quotaFixture();
    await fixture.quota.commit(await reserveAccepted(fixture.quota));
    const restarted = fixture.restart();
    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await restarted.commit(await reserveAccepted(restarted));
    }
    expect((await restarted.reserve()).ok).toBe(false);
  });

  test("counts in-flight reservations so concurrent requests cannot oversubscribe", async () => {
    const fixture = quotaFixture();
    const attempts = await Promise.all(
      Array.from({ length: PUBLISH_QUOTA_LIMIT + 12 }, () => fixture.quota.reserve()),
    );

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(PUBLISH_QUOTA_LIMIT);
    expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(12);
  });

  test("releases failed uploads but never refunds a committed publish", async () => {
    const fixture = quotaFixture();
    const failed = await reserveAccepted(fixture.quota);
    await fixture.quota.release(failed);

    const accepted = await reserveAccepted(fixture.quota);
    await fixture.quota.commit(accepted);
    await fixture.quota.release(accepted);

    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await fixture.quota.commit(await reserveAccepted(fixture.quota));
    }
    expect((await fixture.quota.reserve()).ok).toBe(false);
  });

  test("rolls to a fresh window exactly twenty-four hours after first reservation", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await fixture.quota.commit(await reserveAccepted(fixture.quota));
    }
    fixture.advance(BUDGET_WINDOW_MS - 1);
    expect((await fixture.quota.reserve()).ok).toBe(false);
    fixture.advance(1);
    expect((await fixture.quota.reserve()).ok).toBe(true);
  });
});
