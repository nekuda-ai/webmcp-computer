import { useKernelStore } from "../kernel/store";
import type { AppId, ProcessRecord } from "../kernel/types";

export function resolveAppTarget(appId: AppId, rawPid?: unknown): ProcessRecord {
  const processes = useKernelStore.getState().processes;
  if (rawPid !== undefined) {
    if (!Number.isInteger(rawPid) || (rawPid as number) < 2) {
      throw new Error("webmcp-computer: pid must be an integer PID starting at 2");
    }
    const process = processes.find(({ pid }) => pid === rawPid);
    if (!process) throw new Error(`webmcp-computer: process PID ${String(rawPid)} not found`);
    if (process.appId !== appId) {
      throw new Error(`webmcp-computer: process PID ${String(rawPid)} is not ${appId}`);
    }
    return process;
  }

  const process = processes
    .filter((candidate) => candidate.appId === appId)
    .sort((left, right) => right.zIndex - left.zIndex)[0];
  if (!process) throw new Error(`webmcp-computer: no ${appId} window is open`);
  return process;
}

export function focusAppTarget(appId: AppId, rawPid?: unknown): ProcessRecord {
  const target = resolveAppTarget(appId, rawPid);
  return useKernelStore.getState().focus(target.pid) ?? target;
}
