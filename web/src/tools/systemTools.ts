import { defineTool } from "@nekuda/webmcp-sdk";
import { isTextFile, normalizePath, stat } from "../kernel/fs";
import { APP_IDS, type AppId, type WindowRect } from "../kernel/types";
import { useKernelStore } from "../kernel/store";
import { runAgentAction } from "./agentAction";
import { readManual, requireManualTopic } from "../kernel/manual";
import { searchOSDetailed } from "../kernel/osSearch";
import { loadSettings, setSetting, SETTING_KEYS } from "../kernel/settings";
import {
  clampWindowRect,
  currentViewport,
  workareaForViewport,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "../kernel/windowGeometry";
import { ACT_ANNOTATIONS, ASK_ANNOTATIONS, TRANSACT_ANNOTATIONS } from "./taxonomy";
import { presentSpotlight } from "../kernel/spotlightPresentation";
import { requireFinite } from "../shared";
import { takeOverMachine } from "../kernel/machineLock";

type AppInput = {
  appId: string;
  path?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  focus?: boolean;
};
type PidInput = { pid: number };
type MoveInput = { pid: number; x: number; y: number };
type ResizeInput = { pid: number; width: number; height: number };
type EmptyInput = Record<string, never>;
type ManualInput = { topic?: string };
type OSSearchInput = { query: string; limit?: number; show?: boolean };
type SettingsSetInput = { key: string; value: unknown };

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const OPENABLE_APP_IDS = APP_IDS.filter((appId) => appId !== "ui" && appId !== "browser");

function requireAppId(value: string): AppId {
  const appId = OPENABLE_APP_IDS.find((candidate) => candidate === value);
  if (!appId) {
    throw new Error(`webmcp-computer: unknown app '${value}'; expected ${OPENABLE_APP_IDS.join(", ")}`);
  }
  return appId;
}

function requirePid(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error("webmcp-computer: pid must be an integer");
  }
  if (value === 1) {
    throw new Error("webmcp-computer: pid 1 is the screensaver; window pids start at 2");
  }
  if (value < 2) throw new Error("webmcp-computer: pid must be an integer PID starting at 2");
  return value;
}

function requireEmptyInput(input: EmptyInput | null | undefined): void {
  if (input == null) return;
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 0
  ) {
    throw new Error("webmcp-computer: input must be an empty object");
  }
}

function workareaSize(): { width: number; height: number } {
  const viewportWidth = typeof window === "undefined" ? DEFAULT_VIEWPORT_WIDTH : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? DEFAULT_VIEWPORT_HEIGHT : window.innerHeight;
  return workareaForViewport({ width: viewportWidth, height: viewportHeight });
}

function requireProcess(pid: number) {
  const process = useKernelStore.getState().processes.find((entry) => entry.pid === pid);
  if (!process) throw new Error(`webmcp-computer: process PID ${pid} not found`);
  return process;
}

export const appOpenTool = defineTool<AppInput>({
  stableKey: "webmcp_computer.app_open",
  name: "app_open",
  title: "Open app",
  description:
    "Open a built-in WebMCP Computer app in a visible window. Optionally set x, y, width, height, and focus (default true); focus=false preserves current focus and places a new window below the focused window. Geometry uses the same work-area clamping as window_move and window_resize. Settings, Notes, and Preview are singletons: reopening one applies supplied placement to its existing window and returns reused: true. Files, Terminal, and Editor create new windows. For editor, path may select a ~-rooted text file. Agent-made App windows open through ui_open. Returns PID, app ID, optional path, applied rect, and reused.",
  inputSchema: {
    type: "object",
    properties: {
      appId: {
        type: "string",
        enum: OPENABLE_APP_IDS,
        description: "WebMCP Computer app identifier to open.",
      },
      path: {
        type: "string",
        description: "Optional ~-rooted file path. Valid only when appId is editor.",
      },
      x: { type: "number", description: "Optional work-area horizontal position in CSS pixels." },
      y: { type: "number", description: "Optional work-area vertical position in CSS pixels." },
      width: { type: "number", description: "Optional window width in CSS pixels." },
      height: { type: "number", description: "Optional window height in CSS pixels." },
      focus: {
        type: "boolean",
        description: "Whether to focus the opened or reused window; false places a new window below current focus.",
      },
    },
    required: ["appId"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({
    appId: rawAppId,
    path: rawPath,
    x: rawX,
    y: rawY,
    width: rawWidth,
    height: rawHeight,
    focus: rawFocus,
  }) {
    return runAgentAction(
      "app_open",
      {
        appId: rawAppId,
        ...(rawPath === undefined ? {} : { path: rawPath }),
        ...(rawX === undefined ? {} : { x: rawX }),
        ...(rawY === undefined ? {} : { y: rawY }),
        ...(rawWidth === undefined ? {} : { width: rawWidth }),
        ...(rawHeight === undefined ? {} : { height: rawHeight }),
        ...(rawFocus === undefined ? {} : { focus: rawFocus }),
      },
      async () => {
        const appId = requireAppId(rawAppId);
        if (appId === "ui") {
          throw new Error("webmcp-computer: agent-made App windows open through ui_open");
        }
        if (rawPath !== undefined && appId !== "editor") {
          throw new Error("webmcp-computer: path is only valid when opening editor");
        }
        const path = rawPath === undefined ? undefined : normalizePath(rawPath);
        if (path !== undefined) {
          const file = await stat(path);
          if (file.kind !== "file") throw new Error(`webmcp-computer: is a directory: ${path}`);
          if (!isTextFile(path)) {
            throw new Error(`webmcp-computer: not a text file: ${path} (${file.size} bytes)`);
          }
        }
        if (rawFocus !== undefined && typeof rawFocus !== "boolean") {
          throw new Error("webmcp-computer: focus must be a boolean");
        }
        const placement: Partial<WindowRect> = {};
        if (rawX !== undefined) placement.x = requireFinite(rawX, "x");
        if (rawY !== undefined) placement.y = requireFinite(rawY, "y");
        if (rawWidth !== undefined) placement.width = requireFinite(rawWidth, "width");
        if (rawHeight !== undefined) placement.height = requireFinite(rawHeight, "height");
        const existing = useKernelStore.getState().processes.find(
          (process) => process.appId === appId,
        );
        const process = useKernelStore.getState().spawn(appId, {
          ...(path === undefined ? {} : { path }),
          ...(Object.keys(placement).length === 0 ? {} : { placement }),
          ...(rawFocus === undefined ? {} : { focus: rawFocus }),
          viewport: currentViewport(),
        });
        return {
          pid: process.pid,
          appId: process.appId,
          ...(process.path === undefined ? {} : { path: process.path }),
          rect: { ...process.windowRect },
          reused: existing?.pid === process.pid,
        };
      },
    );
  },
});

export const appCloseTool = defineTool<PidInput>({
  stableKey: "webmcp_computer.app_close",
  name: "app_close",
  title: "Close app",
  description:
    "Close one visible WebMCP Computer app window by process PID. Use a PID returned by app_open or app_list. Returns the closed PID and app ID; throws if that process does not exist.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 2, description: "Process PID of the window to close." },
    },
    required: ["pid"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ pid: rawPid }) {
    const closingProcess = useKernelStore
      .getState()
      .processes.find((entry) => entry.pid === rawPid);
    return runAgentAction(
      "app_close",
      {
        pid: rawPid,
        ...(closingProcess === undefined
          ? {}
          : { appId: closingProcess.appId, rect: closingProcess.windowRect }),
      },
      () => {
        const pid = requirePid(rawPid);
        const process = requireProcess(pid);
        const closed = useKernelStore.getState().kill(pid);
        if (!closed) throw new Error(`webmcp-computer: process PID ${pid} not found`);
        return { closed: true, pid: closed.pid, appId: process.appId };
      },
    );
  },
});

export const appListTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.app_list",
  name: "app_list",
  title: "List open apps",
  description:
    "List every running WebMCP Computer app window and its PID, rectangle, z-index, focus state, and minimized state. Use before targeting a window by PID. Returns an explicit note when no apps are open.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    return runAgentAction("app_list", {}, () => {
      requireEmptyInput(input);
      const state = useKernelStore.getState();
      const minimizedPids = new Set(state.minimizedPids);
      const processes = state.processes.map((process) => ({
        ...process,
        minimized: minimizedPids.has(process.pid),
      }));
      return {
        processes,
        note: processes.length === 0 ? "No app windows are open." : undefined,
      };
    });
  },
});

export const windowFocusTool = defineTool<PidInput>({
  stableKey: "webmcp_computer.window_focus",
  name: "window_focus",
  title: "Focus window",
  description:
    "Bring a running WebMCP Computer window to the front and give it focus by PID. Use app_list to discover PIDs. Returns the focused process record with its new z-index.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 2, description: "Process PID of the window to focus." },
    },
    required: ["pid"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ pid: rawPid }) {
    return runAgentAction("window_focus", { pid: rawPid }, () => {
      const pid = requirePid(rawPid);
      requireProcess(pid);
      const process = useKernelStore.getState().focus(pid);
      if (!process) throw new Error(`webmcp-computer: process PID ${pid} not found`);
      return process;
    });
  },
});

export const windowMoveTool = defineTool<MoveInput>({
  stableKey: "webmcp_computer.window_move",
  name: "window_move",
  title: "Move window",
  description:
    "Move a visible WebMCP Computer window by PID to coordinates relative to the desktop work area, whose origin sits just below the 38px menu bar. Targets are clamped to keep the left-side close control and at least 60px of the titlebar reachable. Use app_list to inspect current rectangles. Returns the updated process record and visibly repositions the window.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 2, description: "Process PID of the window to move." },
      x: { type: "number", description: "Target horizontal position in work-area CSS pixels." },
      y: { type: "number", description: "Target vertical position in work-area CSS pixels." },
    },
    required: ["pid", "x", "y"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ pid: rawPid, x: rawX, y: rawY }) {
    return runAgentAction("window_move", { pid: rawPid, x: rawX, y: rawY }, () => {
      const pid = requirePid(rawPid);
      const targetX = requireFinite(rawX, "x");
      const targetY = requireFinite(rawY, "y");
      const current = requireProcess(pid);
      const viewportWidth = typeof window === "undefined" ? DEFAULT_VIEWPORT_WIDTH : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? DEFAULT_VIEWPORT_HEIGHT : window.innerHeight;
      const rect = clampWindowRect(
        { ...current.windowRect, x: targetX, y: targetY },
        { width: viewportWidth, height: viewportHeight },
      );
      const process = useKernelStore.getState().move(pid, rect.x, rect.y);
      if (!process) throw new Error(`webmcp-computer: process PID ${pid} not found`);
      return process;
    });
  },
});

export const windowResizeTool = defineTool<ResizeInput>({
  stableKey: "webmcp_computer.window_resize",
  name: "window_resize",
  title: "Resize window",
  description:
    "Resize a visible WebMCP Computer window by PID in CSS pixels. Width and height are clamped between the 300 by 210 minimum and the desktop work-area size. Returns the updated process record and visibly resizes the window.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 2, description: "Process PID of the window to resize." },
      width: { type: "number", description: "Target width in CSS pixels." },
      height: { type: "number", description: "Target height in CSS pixels." },
    },
    required: ["pid", "width", "height"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ pid: rawPid, width: rawWidth, height: rawHeight }) {
    return runAgentAction(
      "window_resize",
      { pid: rawPid, width: rawWidth, height: rawHeight },
      () => {
        const pid = requirePid(rawPid);
        const targetWidth = requireFinite(rawWidth, "width");
        const targetHeight = requireFinite(rawHeight, "height");
        const workarea = workareaSize();
        const width = Math.min(workarea.width, Math.max(MIN_WINDOW_WIDTH, targetWidth));
        const height = Math.min(workarea.height, Math.max(MIN_WINDOW_HEIGHT, targetHeight));
        requireProcess(pid);
        const process = useKernelStore.getState().resize(pid, width, height);
        if (!process) throw new Error(`webmcp-computer: process PID ${pid} not found`);
        return process;
      },
    );
  },
});

export const sysStatusTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.sys_status",
  name: "sys_status",
  title: "System status",
  description:
    "Read current WebMCP Computer hostname, uptime in seconds, running process count, active filesystem backend and status, and the ~/skills manual path. Use for a concise health check.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    return runAgentAction("sys_status", {}, () => {
      requireEmptyInput(input);
      const state = useKernelStore.getState();
      const backend = state.fileSystemBackend === "cloud"
        ? "cloud"
        : state.fileSystemBackend === null ? null : `local (${state.fileSystemBackend})`;
      return {
        hostname: state.settings.hostname,
        uptime_s: Math.max(0, Math.floor((Date.now() - state.bootedAt) / 1_000)),
        processes: state.processes.length,
        fs_backend: backend,
        fs_status: state.fileSystemStatus === "ready" ? backend : state.fileSystemStatus,
        skills: "~/skills",
      };
    });
  },
});

export const osManualTool = defineTool<ManualInput>({
  stableKey: "webmcp_computer.os_manual",
  name: "os_manual",
  title: "Read WebMCP Computer manual",
  description:
    "Start here when operating WebMCP Computer. Read its agent manual verbatim from ~/skills. Omit topic for the README and topic list, or request filesystem, terminal, windows, apps, preview, browser, cloud, or conventions.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["filesystem", "terminal", "windows", "apps", "preview", "browser", "cloud", "conventions"],
        description: "Optional manual topic; omit for ~/skills/README.md.",
      },
    },
    additionalProperties: false,
  },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    const rawTopic = input?.topic;
    return runAgentAction("os_manual", { ...(rawTopic === undefined ? {} : { topic: rawTopic }) }, async () => {
      const topic = rawTopic === undefined ? undefined : requireManualTopic(rawTopic);
      return await readManual(topic);
    });
  },
});

export const osSearchTool = defineTool<OSSearchInput>({
  stableKey: "webmcp_computer.os_search",
  name: "os_search",
  title: "Search WebMCP Computer",
  description:
    "Search files by name and the first 256 KB of content plus apps, settings, running processes, and shell commands. Returns ranked rows ordered exact name, name prefix, then content, each with its acting verb and arguments. By default show=true displays those rows in Spotlight for about 3 seconds without taking focus; any human keypress or click dismisses it. Pass show=false for silent data-only search. Unreadable subtrees are skipped and reported in warnings.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Case-insensitive search text." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum rows; defaults to 20." },
      show: {
        type: "boolean",
        description: "Display results in passive Spotlight for about 3 seconds; defaults to true.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
  intent: "answer",
  execute({ query, limit, show: rawShow }) {
    return runAgentAction("os_search", {
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(rawShow === undefined ? {} : { show: rawShow }),
    }, async () => {
      if (rawShow !== undefined && typeof rawShow !== "boolean") {
        throw new Error("webmcp-computer: show must be a boolean");
      }
      const output = await searchOSDetailed(query, limit);
      if (rawShow !== false) presentSpotlight({ query, ...output });
      return { query, ...output };
    });
  },
});

export const settingsGetTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.settings_get",
  name: "settings_get",
  title: "Read settings",
  description:
    "Read all persisted WebMCP Computer settings from ~/.config/settings.json: theme, accent, CRT scanlines, verb hints, hostname, idle screensaver minutes, and cloud-kernel reboot preference.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    return runAgentAction("settings_get", {}, async () => {
      requireEmptyInput(input);
      return await loadSettings();
    });
  },
});

export const settingsSetTool = defineTool<SettingsSetInput>({
  stableKey: "webmcp_computer.settings_set",
  name: "settings_set",
  title: "Change setting",
  description:
    "Validate and persist one WebMCP Computer setting to ~/.config/settings.json, then apply it visibly. Keys: theme, accent, crt, verb_hints, hostname, screensaver_minutes, cloud_kernel. cloud_kernel is mirrored for boot and returns a reboot-required note. Returns the full updated settings object.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", enum: [...SETTING_KEYS], description: "Setting key to change." },
      value: { description: "New value; type and allowed values depend on key." },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ key, value }) {
    return runAgentAction("settings_set", { key, value }, async () => await setSetting(key, value, "agent"));
  },
});

export const machineTakeOverTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.machine_take_over",
  name: "machine_take_over",
  title: "Take over machine control",
  description:
    "Consequentially take machine ownership from another WebMCP Computer tab. This is the agent equivalent of the visible Take over control and is callable while this tab is blocked. The previous owner's local in-flight actions are rejected and cancellable transports are aborted. Remote work already accepted or completed may still finish and cannot be undone. Returns whether ownership changed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: TRANSACT_ANNOTATIONS,
  intent: "transact",
  execute(input) {
    return runAgentAction("machine_take_over", {}, async () => {
      requireEmptyInput(input);
      return { taken_over: await takeOverMachine() };
    }, { allowWhileBlocked: true });
  },
});

export const screensaverWakeTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.screensaver_wake",
  name: "screensaver_wake",
  title: "Wake screensaver",
  description:
    "Wake WebMCP Computer from its boot screensaver and reveal the desktop. Use when the idle screen is visible. Returns whether the screensaver was active before this call.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute(input) {
    const wasActive = useKernelStore.getState().screensaverActive;
    return runAgentAction("screensaver_wake", {}, () => {
      requireEmptyInput(input);
      return {
        awake: true,
        wasActive,
      };
    });
  },
});

export const systemTools = [
  appOpenTool,
  appCloseTool,
  appListTool,
  windowFocusTool,
  windowMoveTool,
  windowResizeTool,
  sysStatusTool,
  machineTakeOverTool,
  screensaverWakeTool,
  osManualTool,
  osSearchTool,
  settingsGetTool,
  settingsSetTool,
] as const;
