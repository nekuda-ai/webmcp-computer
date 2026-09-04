import {
  BROWSER_BUDGET_MS,
  BROWSER_IDLE_MS,
  BUDGET_WINDOW_MS,
  CLOUD_BUDGET_MS,
  CLOUD_IDLE_MS,
  isLimitErrorCode,
  type LimitError,
} from "../../../shared/session-limits";
import { machineHeartbeatEligible } from "./machineOwnership";
import { useKernelStore } from "./store";

export type HumanActivityContextOptions = {
  visibility?: DocumentVisibilityState;
  focused?: boolean;
};

export type HumanActivityOptions = HumanActivityContextOptions & {
  now?: number;
  idleMs?: number;
};

function documentVisibility(): DocumentVisibilityState {
  if (typeof document === "undefined") return "visible";
  return document.visibilityState ?? "visible";
}

function documentFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus();
}

/** Whether this visible, focused tab currently owns the machine. */
export function isHumanActivityContext(
  options: HumanActivityContextOptions = {},
): boolean {
  const visibility = options.visibility ?? documentVisibility();
  const focused = options.focused ?? documentFocused();
  return visibility === "visible" && focused &&
    machineHeartbeatEligible(useKernelStore.getState().machineOwnership);
}

/**
 * Whether a human is plausibly present: the kernel saw a trusted local interaction
 * within `idleMs`, and the owning tab remains visible and focused. General activity
 * such as agent calls may wake the screensaver but never qualifies paid-resource
 * heartbeats. Remote-page trusted activity is checked separately over CDP.
 */
export function isHumanActive(options: HumanActivityOptions = {}): boolean {
  if (!isHumanActivityContext(options)) return false;
  const now = options.now ?? Date.now();
  const idleMs = options.idleMs ?? BROWSER_IDLE_MS;
  const { lastHumanActivityAt } = useKernelStore.getState();
  return lastHumanActivityAt > 0 && now - lastHumanActivityAt < idleMs;
}

export type LiveViewFocusInteractionOptions = {
  activeElement: unknown;
  visibility: DocumentVisibilityState;
  focused: boolean;
  trusted: boolean;
};

/**
 * Cross-origin iframe input cannot be observed by the parent. Its trusted transition of
 * focus into the live viewer records one bounded local timestamp; continued input is
 * checked independently by the Browser session's remote CDP activity probe.
 */
export function isLiveViewFocusInteraction(
  iframe: unknown,
  options: LiveViewFocusInteractionOptions,
): boolean {
  return options.trusted && options.visibility === "visible" && options.focused &&
    options.activeElement === iframe;
}

/** Notify when activity, visibility, or machine ownership may make a heartbeat eligible. */
export function subscribeHumanActivity(listener: () => void): () => void {
  const unsubscribeStore = useKernelStore.subscribe((state, previous) => {
    if (
      state.lastHumanActivityAt !== previous.lastHumanActivityAt ||
      state.machineOwnership !== previous.machineOwnership
    ) {
      listener();
    }
  });
  if (typeof document === "undefined") return unsubscribeStore;
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    unsubscribeStore();
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
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
    case "EPUBLISHQUOTA":
      return error.retryAfterMs === undefined
        ? "site publishing limit is used up; try again after the accounting window resets"
        : `site publishing limit is used up; try again in ${formatDuration(error.retryAfterMs)}`;
  }
}
