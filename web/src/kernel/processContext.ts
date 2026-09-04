import { FileSystemError, isTextFile, joinPath, stat } from "./fs";
import { useKernelStore } from "./store";
import { APP_IDS } from "./types";
import { resolveShellPath } from "./shell/paths";
import type {
  ShellExecutionSource,
  ShellProcess,
  ShellProcessContext,
} from "./shell/types";
import {
  assertMachineMutationAdmission,
  type MachineMutationAdmission,
} from "./ownershipAdmission";

function windowProcess(pid: number): ShellProcess | undefined {
  const state = useKernelStore.getState();
  const process = state.processes.find((entry) => entry.pid === pid);
  return process === undefined
    ? undefined
    : {
      pid: process.pid,
      kind: "window",
      command: process.appId,
      appId: process.appId,
      minimized: state.minimizedPids.includes(process.pid),
    };
}

function commandProcess(pid: number): ShellProcess | undefined {
  const process = useKernelStore.getState().commandProcesses.find((entry) => entry.pid === pid);
  return process === undefined
    ? undefined
    : { pid: process.pid, kind: "command", command: process.command, cwd: process.cwd };
}

export function listKernelProcesses(): ShellProcess[] {
  const state = useKernelStore.getState();
  return [
    { pid: 1, kind: "command", command: "[screensaver]" },
    ...state.processes.map((process) => ({
      pid: process.pid,
      kind: "window" as const,
      command: process.appId,
      appId: process.appId,
      minimized: state.minimizedPids.includes(process.pid),
    })),
    ...state.commandProcesses.map((process) => ({
      pid: process.pid,
      kind: "command" as const,
      command: process.command,
      cwd: process.cwd,
    })),
  ];
}

export function killKernelProcess(pid: number): ShellProcess | undefined {
  if (pid < 2) return undefined;
  const state = useKernelStore.getState();
  const window = windowProcess(pid);
  if (window) {
    state.kill(pid);
    return window;
  }
  const command = commandProcess(pid);
  if (command) {
    state.killCommand(pid);
    return command;
  }
  return undefined;
}

async function openTarget(
  target: string,
  cwd: string,
  source: ShellExecutionSource,
  admission: MachineMutationAdmission,
): Promise<ShellProcess> {
  const state = useKernelStore.getState();
  const appId = APP_IDS.find((candidate) => candidate === target);
  let process;
  if (appId) {
    if (appId === "ui") throw new Error("webmcp-computer: agent-made App windows open through ui_open");
    assertMachineMutationAdmission(admission);
    process = state.spawn(appId);
  } else {
    const path = resolveShellPath(cwd, target);
    const targetStat = await stat(path);
    assertMachineMutationAdmission(admission);
    if (targetStat.kind === "file") {
      if (!isTextFile(path)) throw new Error(`webmcp-computer: not a text file: ${path} (${targetStat.size} bytes)`);
      process = state.spawn("editor", { path });
    } else {
      process = state.spawn("files", { path });
    }
  }
  state.osEvent(source, "app_open", {
    appId: process.appId,
    pid: process.pid,
    ...(process.path === undefined ? {} : { path: process.path }),
  });
  return { pid: process.pid, kind: "window", command: process.appId, appId: process.appId };
}

async function serveTarget(
  target: string,
  cwd: string,
  source: ShellExecutionSource,
  admission: MachineMutationAdmission,
) {
  const root = resolveShellPath(cwd, target);
  const targetStat = await stat(root);
  if (targetStat.kind !== "directory") throw new Error(`webmcp-computer: not a directory: ${root}`);
  try {
    const entry = await stat(joinPath(root, "index.html"));
    if (entry.kind !== "file") throw new Error(`webmcp-computer: preview root has no index.html: ${root}`);
  } catch (error) {
    if (error instanceof FileSystemError && error.code === "ENOENT") {
      throw new Error(`webmcp-computer: preview root has no index.html: ${root}`);
    }
    throw error;
  }
  assertMachineMutationAdmission(admission);
  const state = useKernelStore.getState();
  const existing = state.processes.find((process) => process.appId === "preview");
  const process = existing ?? state.spawn("preview", { path: root });
  if (existing) {
    state.setProcessPath(existing.pid, root);
    state.focus(existing.pid);
  }
  state.osEvent(source, "serve", { path: root, appId: "preview", pid: process.pid });
  return {
    pid: process.pid,
    kind: "window" as const,
    command: process.appId,
    appId: process.appId,
    root,
    reused: existing !== undefined,
  };
}

export const kernelProcessContext: ShellProcessContext = {
  start(command, cwd) {
    const process = useKernelStore.getState().startCommand(command, cwd);
    return { pid: process.pid, signal: process.signal };
  },
  finish(pid) {
    useKernelStore.getState().finishCommand(pid);
  },
  list: listKernelProcesses,
  kill: killKernelProcess,
  open: openTarget,
  serve: serveTarget,
  events() {
    return useKernelStore.getState().events;
  },
};
