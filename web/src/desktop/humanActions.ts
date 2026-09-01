import { browserSessionState, restartBrowserSession } from "../apps/browser/session";
import { useKernelStore } from "../kernel/store";
import type { AppId, ProcessRecord } from "../kernel/types";

export function openHumanApp(appId: AppId): ProcessRecord {
  if (appId === "browser" && browserSessionState().status === "ended") {
    void restartBrowserSession().catch(() => undefined);
  }
  const state = useKernelStore.getState();
  const process = state.spawn(appId);
  state.osEvent(
    "human",
    appId === "browser" ? "browser_open" : "app_open",
    { appId, pid: process.pid },
  );
  return process;
}

export function focusHumanWindow(pid: number): ProcessRecord | undefined {
  const state = useKernelStore.getState();
  const before = state.processes.find((process) => process.pid === pid);
  if (!before) return undefined;
  const wasMinimized = state.minimizedPids.includes(pid);
  if (before.focused && !wasMinimized) return before;
  const process = state.focus(pid);
  if (process) state.osEvent("human", "window_focus", { pid });
  return process;
}

export function minimizeHumanWindow(pid: number): ProcessRecord | undefined {
  const state = useKernelStore.getState();
  const before = state.processes.find((process) => process.pid === pid);
  if (!before || state.minimizedPids.includes(pid)) return before;
  const process = state.minimize(pid);
  if (process) state.osEvent("human", "window_minimize", { pid, appId: process.appId });
  return process;
}

export function closeHumanWindow(pid: number): ProcessRecord | undefined {
  const state = useKernelStore.getState();
  const process = state.kill(pid);
  if (process) {
    state.osEvent("human", "app_close", {
      pid,
      appId: process.appId,
      rect: process.windowRect,
    });
  }
  return process;
}
