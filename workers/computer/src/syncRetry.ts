import type { SyncRetryIntent, SyncRetryScheduler } from "@cloudflare/computer";

const SYNC_RETRY_KEY_PREFIX = "webmcp-computer:sync-retry:";

export type SyncRetryStorage = Pick<
  DurableObjectStorage,
  "delete" | "deleteAlarm" | "get" | "getAlarm" | "put" | "setAlarm"
>;

export class DurableSyncRetryScheduler implements SyncRetryScheduler {
  readonly #storage: SyncRetryStorage;

  constructor(storage: SyncRetryStorage) {
    this.#storage = storage;
  }

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    return await this.#storage.get<SyncRetryIntent>(`${SYNC_RETRY_KEY_PREFIX}${backend}`);
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    await this.#storage.put(`${SYNC_RETRY_KEY_PREFIX}${intent.backend}`, intent);
    const alarm = await this.#storage.getAlarm();
    if (alarm === null || alarm > intent.notBefore) await this.#storage.setAlarm(intent.notBefore);
  }

  async clear(backend: string): Promise<void> {
    await this.#storage.delete(`${SYNC_RETRY_KEY_PREFIX}${backend}`);
    await this.#storage.deleteAlarm();
  }
}
