import type { SyncRetryIntent } from "@cloudflare/computer";
import type { AlarmSlots } from "./alarms";
import { RUNTIME_LEASE_ALARM } from "./runtimeLease";
import { settleSyncRetryAlarm, syncRetryAlarmSlot } from "./syncRetry";

const DURABLE_RETRY_DELAY_MS = 30_000;

type SyncRetryStatus = "idle" | "complete" | "pending" | "exhausted" | "lost";
type RuntimeCleanupReason = "none" | "wait" | "idle" | "budget";

type TerminalSyncFailure = {
  reason: "runtime-budget";
  status: "pending" | "exhausted" | "error";
  intent: SyncRetryIntent;
  error?: unknown;
};

type WorkspaceAlarmOptions = {
  alarms: AlarmSlots;
  backend: string;
  now: number;
  getPendingSync(): Promise<SyncRetryIntent | undefined>;
  retryPendingSync(): Promise<{ status: SyncRetryStatus }>;
  runtimeCleanupReason(): Promise<RuntimeCleanupReason>;
  runtimeHardBudgetDeadline?(): Promise<number>;
  handleRuntimeLease(): Promise<unknown>;
  onSyncResult?(result: { status: SyncRetryStatus }): void;
  onSyncError?(error: unknown): void;
  onTerminalSyncFailure?(failure: TerminalSyncFailure): void;
};

/**
 * Coordinates the workspace's single Durable Object alarm.
 *
 * Idle cleanup yields to pending container-to-DO sync. SDK exhaustion is retried at a
 * bounded cadence while paid runtime budget remains. The hard runtime budget has higher
 * precedence: it forces one last pull attempt, retains the intent for diagnosis, disarms
 * further sync wakeups, and then allows destruction of the only unsynced copy.
 */
export async function coordinateWorkspaceAlarm(options: WorkspaceAlarmOptions): Promise<void> {
  const { alarms, backend, now } = options;
  const syncSlot = syncRetryAlarmSlot(backend);

  try {
    const due = new Set(await alarms.due(now));
    const runtimeDue = due.has(RUNTIME_LEASE_ALARM);
    const cleanupReason = runtimeDue ? await options.runtimeCleanupReason() : "none";
    const hardBudgetDeadline = runtimeDue
      ? await options.runtimeHardBudgetDeadline?.() ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;
    const hardBudgetDue = cleanupReason === "budget";
    let pendingSync = hardBudgetDue ? await options.getPendingSync() : undefined;
    const shouldRetry = due.has(syncSlot) || (hardBudgetDue && pendingSync !== undefined);
    let finalStatus: SyncRetryStatus | "error" | undefined;
    let finalError: unknown;

    if (shouldRetry) {
      try {
        const result = await options.retryPendingSync();
        finalStatus = result.status;
        options.onSyncResult?.(result);
        if (result.status === "exhausted" && !hardBudgetDue) {
          // SDK 0.2.1 retains its max-attempt intent and retries the same cursor on
          // every later call. Rearm it without rewriting that diagnostic evidence.
          await alarms.set(syncSlot, now + DURABLE_RETRY_DELAY_MS);
        } else {
          await settleSyncRetryAlarm(alarms, backend, result.status);
        }
      } catch (error) {
        finalStatus = "error";
        finalError = error;
        options.onSyncError?.(error);
        if (!hardBudgetDue) {
          // Do not depend on the platform's finite failed-alarm retries. Persist a fresh
          // deadline so transient SDK/backend failures continue to make progress.
          await alarms.set(syncSlot, now + DURABLE_RETRY_DELAY_MS);
        }
      }
    }

    if (runtimeDue) {
      pendingSync = await options.getPendingSync();
      if (pendingSync !== undefined && !hardBudgetDue) {
        const retryAt = await alarms.get(syncSlot);
        const nextSyncAttempt = retryAt !== undefined && retryAt > now
          ? retryAt
          : now + DURABLE_RETRY_DELAY_MS;
        await alarms.set(RUNTIME_LEASE_ALARM, Math.min(nextSyncAttempt, hardBudgetDeadline));
      } else {
        if (pendingSync !== undefined && hardBudgetDue) {
          // Budget is the terminal cost/safety boundary. Keep diagnostic intent but do
          // not let it schedule paid runtime forever after the final best-effort pull.
          await alarms.clear(syncSlot);
          try {
            options.onTerminalSyncFailure?.({
              reason: "runtime-budget",
              status: finalStatus === "error" ? "error" :
                finalStatus === "exhausted" ? "exhausted" : "pending",
              intent: pendingSync,
              ...(finalError === undefined ? {} : { error: finalError }),
            });
          } catch {
            // Observability must never prevent the hard paid-runtime cleanup boundary.
          }
        }
        await options.handleRuntimeLease();
      }
    }
  } finally {
    // Every path, including an unexpected lease/storage exception, restores the earliest
    // durable deadline rather than relying on the alarm invocation that just fired.
    await alarms.rearm();
  }
}
