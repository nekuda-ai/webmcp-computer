import {
  BROWSER_BUDGET_MS,
  BROWSER_IDLE_MS,
  BUDGET_WINDOW_MS,
  CLOUD_BUDGET_MS,
  CLOUD_IDLE_MS,
  isLimitErrorCode,
  type LimitError,
} from "../../../shared/session-limits";
import { useKernelStore } from "./store";

export type HumanActivityOptions = {
  now?: number;
  idleMs?: number;
  visibility?: DocumentVisibilityState;
};

function documentVisibility(): DocumentVisibilityState {
  if (typeof document === "undefined") return "visible";
  return document.visibilityState ?? "visible";
}

/**
 * Whether a human is plausibly present: the kernel saw pointer/keyboard/tool
 * activity within `idleMs` and the tab is visible. Paid remote resources
 * (Browser Run, cloud container) are only kept alive while this holds.
 */
export function isHumanActive(options: HumanActivityOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const idleMs = options.idleMs ?? BROWSER_IDLE_MS;
  const visibility = options.visibility ?? documentVisibility();
  if (visibility !== "visible") return false;
  const state = useKernelStore.getState();
  if (state.machineConflict) return false;
  return now - state.lastActivityAt < idleMs;
}

/** Notify when activity, visibility, or machine ownership may make a heartbeat eligible. */
export function subscribeHumanActivity(listener: () => void): () => void {
  const unsubscribeStore = useKernelStore.subscribe((state, previous) => {
    if (state.lastActivityAt !== previous.lastActivityAt || state.machineConflict !== previous.machineConflict) {
      listener();
    }
  });
  if (typeof document === "undefined") return unsubscribeStore;
  document.addEventListener("visibilitychange", listener);
  return () => {
    unsubscribeStore();
    document.removeEventListener("visibilitychange", listener);
  };
}

// Human-readable wording for the shared limit contract. Both the browser session and
// cloud exec map Worker `{ error, code, retryAfterMs }` bodies through here so the
// human in the window and the agent reading a tool error see the same explanation.

export type LimitResource = "browser" | "cloud";

function hours(ms: number): string {
  return `${Math.round(ms / 3_600_000)} h`;
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return `${value} minute${value === 1 ? "" : "s"}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
  const totalMinutes = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Extract a `LimitError` from a Worker JSON body when it carries a known code. */
export function limitErrorFromPayload(payload: unknown): LimitError | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const { error, code, retryAfterMs } = payload as Partial<LimitError>;
  if (!isLimitErrorCode(code)) return undefined;
  return {
    error: typeof error === "string" ? error : code,
    code,
    ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

export function describeLimitError(error: LimitError, resource: LimitResource): string {
  const budgetMs = resource === "browser" ? BROWSER_BUDGET_MS : CLOUD_BUDGET_MS;
  const idleMs = resource === "browser" ? BROWSER_IDLE_MS : CLOUD_IDLE_MS;
  switch (error.code) {
    case "EBUDGET": {
      const reset = error.retryAfterMs === undefined
        ? `within ${hours(BUDGET_WINDOW_MS)}`
        : `in ${formatDuration(error.retryAfterMs)}`;
      return `${resource} time budget (${hours(budgetMs)} per ${hours(BUDGET_WINDOW_MS)}) is used up; resets ${reset}`;
    }
    case "EIDLE":
      return resource === "browser"
        ? `browser stopped after ${minutes(idleMs)} of inactivity; open it again to continue`
        : `cloud container stopped after ${minutes(idleMs)} of inactivity; run the command again to continue`;
    case "ECAPACITY":
      return resource === "browser"
        ? "browser service is at capacity right now; try again in a minute"
        : "cloud is busy or at capacity right now; try again in a minute or keep working locally";
    case "EOWNER":
      return `${resource} session belongs to another machine; start a new one`;
  }
}
