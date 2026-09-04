import type { SyncRetryIntent } from "@cloudflare/computer";
import type { AlarmSlots } from "./alarms";
import { RUNTIME_LEASE_ALARM } from "./runtimeLease";
import { settleSyncRetryAlarm, syncRetryAlarmSlot } from "./syncRetry";

const DURABLE_RETRY_DELAY_MS = 30_000;

type SyncRetryStatus = "idle" | "complete" | "pending" | "exhausted" | "lost";

type WorkspaceAlarmOptions = {
  alarms: AlarmSlots;
  backend: string;
  now: number;
  getPendingSync(): Promise<SyncRetryIntent | undefined>;
  retryPendingSync(): Promise<{ status: SyncRetryStatus }>;
  handleRuntimeLease(): Promise<unknown>;
  onSyncResult?(result: { status: SyncRetryStatus }): void;
  onSyncError?(error: unknown): void;
};

/**
 * Coordinates the workspace's single Durable Object alarm.
 *
 * Pending container changes must reach the Durable Object filesystem before cleanup can
 * destroy the only remaining copy. Sync therefore runs first when deadlines coincide,
 * and a due runtime lease follows the durable sync deadline until no intent remains.
 */
export async function coordinateWorkspaceAlarm(options: WorkspaceAlarmOptions): Promise<void> {
  const { alarms, backend, now } = options;
  const syncSlot = syncRetryAlarmSlot(backend);

  try {
    const due = new Set(await alarms.due(now));
    if (due.has(syncSlot)) {
      try {
        const result = await options.retryPendingSync();
        await settleSyncRetryAlarm(alarms, backend, result.status);
        options.onSyncResult?.(result);
      } catch (error) {
        // Do not depend on the platform's finite failed-alarm retries. Persist a fresh
        // deadline so transient SDK/backend failures continue to make progress.
        await alarms.set(syncSlot, now + DURABLE_RETRY_DELAY_MS);
        options.onSyncError?.(error);
      }
    }

    if (due.has(RUNTIME_LEASE_ALARM)) {
      const pendingSync = await options.getPendingSync();
      if (pendingSync !== undefined) {
        const retryAt = await alarms.get(syncSlot);
        await alarms.set(
          RUNTIME_LEASE_ALARM,
          retryAt !== undefined && retryAt > now ? retryAt : now + DURABLE_RETRY_DELAY_MS,
        );
      } else {
        await options.handleRuntimeLease();
      }
    }
  } finally {
    // Every path, including an unexpected lease/storage exception, restores the earliest
    // durable deadline rather than relying on the alarm invocation that just fired.
    await alarms.rearm();
  }
}
