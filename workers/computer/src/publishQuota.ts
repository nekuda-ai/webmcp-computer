import {
  BUDGET_WINDOW_MS,
  PUBLISH_QUOTA_LIMIT,
  type LimitError,
} from "../../../shared/session-limits";

const PUBLISH_QUOTA_KEY = "webmcp-computer:publish-quota";

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

type PublishQuotaState = {
  windowStartedAt: number;
  pending: string[];
  accepted: string[];
};

type PublishQuotaOptions = {
  now?: () => number;
  reservationId?: () => string;
};

/**
 * Durable, per-workspace publish ledger. Reservations count toward the limit immediately,
 * so concurrent uploads cannot oversubscribe it. A completed R2 upload is committed before
 * its successful response; a failed upload releases its reservation.
 */
export class PublishQuota {
  readonly #storage: PublishQuotaStorage;
  readonly #now: () => number;
  readonly #reservationId: () => string;
  #operation: Promise<void> = Promise.resolve();

  constructor(storage: PublishQuotaStorage, options: PublishQuotaOptions = {}) {
    this.#storage = storage;
    this.#now = options.now ?? (() => Date.now());
    this.#reservationId = options.reservationId ?? (() => crypto.randomUUID());
  }

  #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(now: number): Promise<PublishQuotaState> {
    const stored = await this.#storage.get<PublishQuotaState>(PUBLISH_QUOTA_KEY);
    if (stored === undefined || now - stored.windowStartedAt >= BUDGET_WINDOW_MS) {
      return { windowStartedAt: now, pending: [], accepted: [] };
    }
    return stored;
  }

  reserve(): Promise<PublishQuotaResult> {
    return this.#withLock(async () => {
      const now = this.#now();
      const state = await this.#load(now);
      if (state.pending.length + state.accepted.length >= PUBLISH_QUOTA_LIMIT) {
        return {
          ok: false,
          error: {
            error: `anonymous publish limit of ${PUBLISH_QUOTA_LIMIT} per 24-hour accounting window is exhausted`,
            code: "EPUBLISHQUOTA",
            retryAfterMs: Math.max(0, state.windowStartedAt + BUDGET_WINDOW_MS - now),
          },
        };
      }
      const reservationId = this.#reservationId();
      if (state.pending.includes(reservationId) || state.accepted.includes(reservationId)) {
        throw new Error("publish quota generated a duplicate reservation id");
      }
      state.pending.push(reservationId);
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
      return {
        ok: true,
        reservationId,
        windowResetsAt: state.windowStartedAt + BUDGET_WINDOW_MS,
      };
    });
  }

  commit(reservationId: string): Promise<void> {
    return this.#withLock(async () => {
      const state = await this.#storage.get<PublishQuotaState>(PUBLISH_QUOTA_KEY);
      if (state === undefined || state.accepted.includes(reservationId)) return;
      const index = state.pending.indexOf(reservationId);
      // A request reserved in the preceding window may finish after a later reserve rolled
      // the ledger. It still belongs to that preceding window and can complete successfully.
      if (index === -1) return;
      state.pending.splice(index, 1);
      state.accepted.push(reservationId);
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
    });
  }

  release(reservationId: string): Promise<void> {
    return this.#withLock(async () => {
      const state = await this.#storage.get<PublishQuotaState>(PUBLISH_QUOTA_KEY);
      if (state === undefined) return;
      const index = state.pending.indexOf(reservationId);
      // Never refund a committed publish when a caller retries cleanup after an ambiguous RPC.
      if (index === -1) return;
      state.pending.splice(index, 1);
      await this.#storage.put(PUBLISH_QUOTA_KEY, state);
    });
  }
}
