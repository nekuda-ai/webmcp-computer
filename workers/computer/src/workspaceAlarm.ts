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

export type TerminalSyncAttemptStorage = Pick<DurableObjectStorage, "delete" | "get" | "put">;

export type TerminalSyncAttempts = {
  attempted(backend: string): Promise<boolean>;
  mark(backend: string): Promise<void>;
  clear(backend: string): Promise<void>;
};

const TERMINAL_SYNC_ATTEMPT_KEY_PREFIX = "webmcp-computer:terminal-sync-attempt:";

/** Durable guard that limits each backend's hard-budget cleanup path to one final sync. */
export class DurableTerminalSyncAttempts implements TerminalSyncAttempts {
  readonly #storage: TerminalSyncAttemptStorage;

  constructor(storage: TerminalSyncAttemptStorage) {
    this.#storage = storage;
  }

  async attempted(backend: string): Promise<boolean> {
    return await this.#storage.get<boolean>(`${TERMINAL_SYNC_ATTEMPT_KEY_PREFIX}${backend}`) === true;
  }

  async mark(backend: string): Promise<void> {
    await this.#storage.put(`${TERMINAL_SYNC_ATTEMPT_KEY_PREFIX}${backend}`, true);
  }

  async clear(backend: string): Promise<void> {
    await this.#storage.delete(`${TERMINAL_SYNC_ATTEMPT_KEY_PREFIX}${backend}`);
  }
}

type WorkspaceAlarmOptions = {
  alarms: AlarmSlots;
  backend: string;
  now: number;
  terminalSyncAttempts: TerminalSyncAttempts;
  getPendingSync(): Promise<SyncRetryIntent | undefined>;
  retryPendingSync(): Promise<{ status: SyncRetryStatus }>;
  runtimeCleanupReason(): Promise<RuntimeCleanupReason>;
  runtimeHardBudgetDeadline?(): Promise<number>;
  handleRuntimeLease(): Promise<unknown>;
  onSyncResult?(result: { status: SyncRetryStatus }): void;
  onSyncError?(error: unknown): void;
  onTerminalSyncFailure?(failure: TerminalSyncFailure): void;
  onTerminalMarkerError?(error: unknown): void;
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
    let terminalAttemptedBeforeAlarm = false;
    let skipSyncForTerminalCleanup = false;
    let madeTerminalDecision = false;
    let pendingSync: SyncRetryIntent | undefined;
    let finalStatus: SyncRetryStatus | "error" | undefined;
    let finalError: unknown;

    if (runtimeDue) {
      try {
        terminalAttemptedBeforeAlarm = await options.terminalSyncAttempts.attempted(backend);
        skipSyncForTerminalCleanup = terminalAttemptedBeforeAlarm;
      } catch (error) {
        // Unknown marker state must favor stopping paid runtime over possibly repeating
        // an already-attempted terminal sync.
        skipSyncForTerminalCleanup = true;
        finalStatus = "error";
        finalError = error;
        options.onTerminalMarkerError?.(error);
      }
    }

    if (hardBudgetDue) {
      try {
        pendingSync = await options.getPendingSync();
      } catch (error) {
        // Durable diagnostic reads are useful, but never a prerequisite for destruction.
        skipSyncForTerminalCleanup = true;
        finalStatus = "error";
        finalError = error;
        options.onSyncError?.(error);
      }
    }

    let makeFinalSyncAttempt = false;
    if (hardBudgetDue && pendingSync !== undefined && !skipSyncForTerminalCleanup) {
      try {
        // Persist before calling the SDK so a restart or failed destroy cannot repeat it.
        await options.terminalSyncAttempts.mark(backend);
        makeFinalSyncAttempt = true;
        madeTerminalDecision = true;
      } catch (error) {
        skipSyncForTerminalCleanup = true;
        madeTerminalDecision = true;
        finalStatus = "error";
        finalError = error;
        options.onTerminalMarkerError?.(error);
      }
    }

    const shouldRetry = makeFinalSyncAttempt || (due.has(syncSlot) && !skipSyncForTerminalCleanup);
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
      try {
        pendingSync = await options.getPendingSync();
      } catch (error) {
        if (!hardBudgetDue && !skipSyncForTerminalCleanup) throw error;
        finalStatus = "error";
        finalError = error;
        options.onSyncError?.(error);
      }

      const terminalCleanup = hardBudgetDue || skipSyncForTerminalCleanup;
      if (pendingSync !== undefined && !terminalCleanup) {
        const retryAt = await alarms.get(syncSlot);
        const nextSyncAttempt = retryAt !== undefined && retryAt > now
          ? retryAt
          : now + DURABLE_RETRY_DELAY_MS;
        await alarms.set(RUNTIME_LEASE_ALARM, Math.min(nextSyncAttempt, hardBudgetDeadline));
      } else {
        if (terminalCleanup) {
          // Retain the SDK's intent as diagnostic evidence, but disarm its paid wakeup.
          try {
            await alarms.clear(syncSlot);
          } catch (error) {
            options.onSyncError?.(error);
          }
        }
        if (pendingSync !== undefined && hardBudgetDue && !terminalAttemptedBeforeAlarm && madeTerminalDecision) {
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
        const outcome = await options.handleRuntimeLease();
        const cleanupFinished = outcome === "none" || outcome === "stopped-idle" || outcome === "stopped-budget";
        if (cleanupFinished && (terminalAttemptedBeforeAlarm || makeFinalSyncAttempt)) {
          try {
            await options.terminalSyncAttempts.clear(backend);
          } catch (error) {
            // The runtime is already stopped. A stale marker is safer than restoring an
            // alarm or letting a storage failure turn cleanup into an endless paid retry.
            options.onTerminalMarkerError?.(error);
          }
        }
      }
    }
  } finally {
    // Every path, including an unexpected lease/storage exception, restores the earliest
    // durable deadline rather than relying on the alarm invocation that just fired.
    await alarms.rearm();
  }
}
