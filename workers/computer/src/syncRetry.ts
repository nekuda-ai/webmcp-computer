import type { SyncRetryIntent, SyncRetryScheduler } from "@cloudflare/computer";
import type { AlarmSlots } from "./alarms";

const SYNC_RETRY_KEY_PREFIX = "webmcp-computer:sync-retry:";

export type SyncRetryStorage = Pick<DurableObjectStorage, "delete" | "get" | "put">;

export function syncRetryAlarmSlot(backend: string): string {
  return `sync-retry:${backend}`;
}

/**
 * The SDK leaves exhausted retry intent for diagnostics, but that must not leave its
 * already-due alarm slot armed forever. Pending results schedule themselves; every terminal
 * or idle result releases the slot.
 */
export async function settleSyncRetryAlarm(
  alarms: AlarmSlots,
  backend: string,
  status: "idle" | "complete" | "pending" | "exhausted" | "lost",
): Promise<void> {
  if (status !== "pending") await alarms.clear(syncRetryAlarmSlot(backend));
}

export class DurableSyncRetryScheduler implements SyncRetryScheduler {
  readonly #storage: SyncRetryStorage;
  readonly #alarms: AlarmSlots;

  constructor(storage: SyncRetryStorage, alarms: AlarmSlots) {
    this.#storage = storage;
    this.#alarms = alarms;
  }

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    return await this.#storage.get<SyncRetryIntent>(`${SYNC_RETRY_KEY_PREFIX}${backend}`);
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    await this.#storage.put(`${SYNC_RETRY_KEY_PREFIX}${intent.backend}`, intent);
    await this.#alarms.set(syncRetryAlarmSlot(intent.backend), intent.notBefore);
  }

  async clear(backend: string): Promise<void> {
    await this.#storage.delete(`${SYNC_RETRY_KEY_PREFIX}${backend}`);
    await this.#alarms.clear(syncRetryAlarmSlot(backend));
  }
}
