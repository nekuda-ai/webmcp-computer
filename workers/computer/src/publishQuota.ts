import {
  BUDGET_WINDOW_MS,
  PUBLISH_QUOTA_LIMIT,
  type LimitError,
} from "../../../shared/session-limits";

const PUBLISH_QUOTA_KEY = "webmcp-computer:publish-quota";
/** Pre-upload reservations stop blocking capacity if their caller disappears. */
export const PUBLISH_RESERVATION_TTL_MS = 5 * 60 * 1_000;

export type PublishQuotaStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type PublishQuotaReservation = {
  ok: true;
  reservationId: string;
  windowResetsAt: number;
};

export type PublishQuotaResult =
  | PublishQuotaReservation
  | { ok: false; error: LimitError };

type PendingReservation = {
  id: string;
  expiresAt: number;
};

type PublishQuotaState = {
  windowStartedAt: number;
  /** Safe to expire: begin() has not confirmed that an R2 write may start. */
  pending: PendingReservation[];
  /** Never expires within its window: an R2 write may be in progress or public. */
  active: string[];
  accepted: string[];
};

type PublishQuotaOptions = {
  now?: () => number;
};

/**
 * Durable, per-workspace publish ledger. Caller IDs make reserve retries idempotent.
 * Pending reservations expire after a short pre-upload reconciliation window; begin()
 * converts one to a non-expiring active reservation before any R2 put is attempted.
 */
export class PublishQuota {
  readonly #storage: PublishQuotaStorage;
  readonly #now: () => number;
  #operation: Promise<void> = Promise.resolve();

  constructor(storage: PublishQuotaStorage, options: PublishQuotaOptions = {}) {
    this.#storage = storage;
    this.#now = options.now ?? (() => Date.now());
  }

  #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(now: number): Promise<PublishQuotaState> {
    const stored = await this.#storage.get<Partial<PublishQuotaState> & { windowStartedAt?: number }>(PUBLISH_QUOTA_KEY);
    if (
      stored === undefined ||
      typeof stored.windowStartedAt !== "number" ||
      now - stored.windowStartedAt >= BUDGET_WINDOW_MS
    ) {
      return { windowStartedAt: now, pending: [], active: [], accepted: [] };
    }
    const rawPending = Array.isArray(stored.pending) ? stored.pending as unknown[] : [];
    // The first quota release briefly stored pending IDs as strings. Treat any such state as
    // active rather than refunding it during a rolling follow-up deployment.
    const legacyActive = rawPending.filter((value): value is string => typeof value === "string");
    const pending = rawPending.filter((value): value is PendingReservation => (
      value !== null && typeof value === "object" && typeof (value as PendingReservation).id === "string" &&
      typeof (value as PendingReservation).expiresAt === "number" && (value as PendingReservation).expiresAt > now
    ));
    return {
      windowStartedAt: stored.windowStartedAt,
      pending,
      active: [
        ...(Array.isArray(stored.active) ? stored.active.filter((value): value is string => typeof value === "string") : []),
        ...legacyActive,
      ],
      accepted: Array.isArray(stored.accepted)
        ? stored.accepted.filter((value): value is string => typeof value === "string")
        : [],
    };
  }

  reserve(reservationId: string): Promise<PublishQuotaResult> {
    return this.#withLock(async () => {
      const now = this.#now();
      const state = await this.#load(now);
      const windowResetsAt = state.windowStartedAt + BUDGET_WINDOW_MS;
      if (
        state.pending.some(({ id }) => id === reservationId) ||
        state.active.includes(reservationId) ||
        state.accepted.includes(reservationId)
      ) {
        return { ok: true, reservationId, windowResetsAt };
      }
      if (state.pending.length + state.active.length + state.accepted.length >= PUBLISH_QUOTA_LIMIT) {
        const nextPendingExpiry = Math.min(
          ...state.pending.map(({ expiresAt }) => expiresAt),
          windowResetsAt,
        );
        return {
          ok: false,
          error: {
            error: `anonymous publish limit of ${PUBLISH_QUOTA_LIMIT} per 24-hour accounting window is exhausted`,
            code: "EPUBLISHQUOTA",
            retryAfterMs: Math.max(0, nextPendingExpiry - now),
          },
        };
      }
      state.pending.push({ id: reservationId, expiresAt: now + PUBLISH_RESERVATION_TTL_MS });
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
      return { ok: true, reservationId, windowResetsAt };
    });
  }

  /** Mark that this request may attempt R2 writes. Active reservations never expire early. */
  begin(reservationId: string): Promise<void> {
    return this.#withLock(async () => {
      const now = this.#now();
      const state = await this.#load(now);
      if (state.active.includes(reservationId) || state.accepted.includes(reservationId)) return;
      const index = state.pending.findIndex(({ id }) => id === reservationId);
      if (index === -1) throw new Error("publish quota reservation expired before upload began");
      state.pending.splice(index, 1);
      state.active.push(reservationId);
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
    });
  }

  commit(reservationId: string): Promise<void> {
    return this.#withLock(async () => {
      const state = await this.#load(this.#now());
      if (state.accepted.includes(reservationId)) return;
      const activeIndex = state.active.indexOf(reservationId);
      const pendingIndex = state.pending.findIndex(({ id }) => id === reservationId);
      // A request assigned to the preceding window may finish after another reserve rolled
      // the ledger. It still consumed its preceding-window slot, so there is nothing to save.
      if (activeIndex === -1 && pendingIndex === -1) return;
      if (activeIndex !== -1) state.active.splice(activeIndex, 1);
      if (pendingIndex !== -1) state.pending.splice(pendingIndex, 1);
      state.accepted.push(reservationId);
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
    });
  }

  /** Release only when the caller knows that no R2 put was attempted. */
  release(reservationId: string): Promise<void> {
    return this.#withLock(async () => {
      const state = await this.#load(this.#now());
      if (state.accepted.includes(reservationId)) return;
      const pendingIndex = state.pending.findIndex(({ id }) => id === reservationId);
      const activeIndex = state.active.indexOf(reservationId);
      if (pendingIndex !== -1) state.pending.splice(pendingIndex, 1);
      if (activeIndex !== -1) state.active.splice(activeIndex, 1);
      if (pendingIndex !== -1 || activeIndex !== -1) {
        await this.#storage.put(PUBLISH_QUOTA_KEY, state);
      }
    });
  }
}
