import { describe, expect, test } from "bun:test";
import { BUDGET_WINDOW_MS, PUBLISH_QUOTA_LIMIT } from "../../../shared/session-limits";
import {
  PublishQuota,
  PUBLISH_RESERVATION_TTL_MS,
  type PublishQuotaStorage,
} from "./publishQuota";

function quotaFixture(start = 1_000) {
  const values = new Map<string, unknown>();
  let now = start;
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) {
      // Match Durable Object storage serialization instead of retaining caller references.
      values.set(key, structuredClone(value));
    },
  } satisfies PublishQuotaStorage;
  const createQuota = () => new PublishQuota(storage, { now: () => now });
  return {
    quota: createQuota(),
    restart: createQuota,
    values,
    advance(ms: number) { now += ms; },
  };
}

async function reserve(quota: PublishQuota, reservationId: string): Promise<void> {
  const result = await quota.reserve(reservationId);
  if (!result.ok) throw new Error("expected publish reservation");
}

async function accept(quota: PublishQuota, reservationId: string): Promise<void> {
  await reserve(quota, reservationId);
  await quota.begin(reservationId);
  await quota.commit(reservationId);
}

describe("publish quota", () => {
  test("allows exactly twenty committed publishes and reports the fixed-window retry", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `reservation-${index}`);
    }

    fixture.advance(12_345);
    const refused = await fixture.quota.reserve("one-too-many");
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
    await accept(fixture.quota, "before-restart");
    const restarted = fixture.restart();
    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(restarted, `after-restart-${index}`);
    }
    expect((await restarted.reserve("one-too-many")).ok).toBe(false);
  });

  test("conservatively upgrades pending state written by the first quota release", async () => {
    const fixture = quotaFixture();
    fixture.values.set("webmcp-computer:publish-quota", {
      windowStartedAt: 1_000,
      pending: ["legacy-in-flight"],
      accepted: [],
    });

    const reservation = await fixture.quota.reserve("legacy-in-flight");
    expect(reservation.ok).toBe(true);
    await fixture.quota.begin("legacy-in-flight");
    await fixture.quota.commit("legacy-in-flight");
    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `accepted-${index}`);
    }
    expect((await fixture.quota.reserve("bypass-attempt")).ok).toBe(false);
  });

  test("recovers a reserve whose durable write succeeded but RPC result was lost", async () => {
    const values = new Map<string, unknown>();
    let loseFirstResult = true;
    const quota = new PublishQuota({
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put(key: string, value: unknown) {
        values.set(key, structuredClone(value));
        if (loseFirstResult) {
          loseFirstResult = false;
          throw new Error("test: reserve result lost after durable write");
        }
      },
    }, { now: () => 1_000 });

    await expect(quota.reserve("same-request")).rejects.toThrow("reserve result lost");
    expect(await quota.reserve("same-request")).toEqual({
      ok: true,
      reservationId: "same-request",
      windowResetsAt: 1_000 + BUDGET_WINDOW_MS,
    });
    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(quota, `other-${index}`);
    }
    expect((await quota.reserve("one-too-many")).ok).toBe(false);
  });

  test("makes reserve idempotent for pending, active, and committed caller IDs", async () => {
    const fixture = quotaFixture();
    const first = await fixture.quota.reserve("same-request");
    expect(await fixture.quota.reserve("same-request")).toEqual(first);
    await fixture.quota.begin("same-request");
    expect(await fixture.quota.reserve("same-request")).toEqual(first);
    await fixture.quota.commit("same-request");
    expect(await fixture.quota.reserve("same-request")).toEqual(first);

    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `other-${index}`);
    }
    expect((await fixture.quota.reserve("new-request")).ok).toBe(false);
    expect(await fixture.quota.reserve("same-request")).toEqual(first);
  });

  test("counts in-flight reservations so concurrent requests cannot oversubscribe", async () => {
    const fixture = quotaFixture();
    const attempts = await Promise.all(
      Array.from(
        { length: PUBLISH_QUOTA_LIMIT + 12 },
        (_, index) => fixture.quota.reserve(`concurrent-${index}`),
      ),
    );

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(PUBLISH_QUOTA_LIMIT);
    expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(12);
  });

  test("expires abandoned pre-upload reservations and advertises their earlier retry", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await reserve(fixture.quota, `abandoned-${index}`);
    }
    fixture.advance(1_000);
    const refused = await fixture.quota.reserve("blocked");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.retryAfterMs).toBe(PUBLISH_RESERVATION_TTL_MS - 1_000);

    fixture.advance(PUBLISH_RESERVATION_TTL_MS - 1_000);
    expect((await fixture.quota.reserve("replacement")).ok).toBe(true);
  });

  test("an active reservation with an ambiguous commit still occupies its slot", async () => {
    const fixture = quotaFixture();
    await reserve(fixture.quota, "ambiguous-commit");
    await fixture.quota.begin("ambiguous-commit");
    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `accepted-${index}`);
    }

    expect((await fixture.quota.reserve("bypass-attempt")).ok).toBe(false);
  });

  test("never expires active uploads, preventing a slow in-progress bypass", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      const id = `uploading-${index}`;
      await reserve(fixture.quota, id);
      await fixture.quota.begin(id);
    }

    fixture.advance(PUBLISH_RESERVATION_TTL_MS + 1);
    expect((await fixture.quota.reserve("bypass-attempt")).ok).toBe(false);
  });

  test("releases only explicitly reconciled pre-write work and never committed work", async () => {
    const fixture = quotaFixture();
    await reserve(fixture.quota, "pre-write-failure");
    await fixture.quota.release("pre-write-failure");

    await accept(fixture.quota, "accepted");
    await fixture.quota.release("accepted");

    for (let index = 1; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `accepted-${index}`);
    }
    expect((await fixture.quota.reserve("one-too-many")).ok).toBe(false);
  });

  test("rolls to a fresh window exactly twenty-four hours after first reservation", async () => {
    const fixture = quotaFixture();
    for (let index = 0; index < PUBLISH_QUOTA_LIMIT; index += 1) {
      await accept(fixture.quota, `reservation-${index}`);
    }
    fixture.advance(BUDGET_WINDOW_MS - 1);
    expect((await fixture.quota.reserve("too-early")).ok).toBe(false);
    fixture.advance(1);
    expect((await fixture.quota.reserve("next-window")).ok).toBe(true);
  });
});
