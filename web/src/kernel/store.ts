import { create } from "zustand";
import { DEFAULT_SETTINGS, isSingletonApp } from "./types";
import type {
  AppId,
  CommandProcessRecord,
  EventSource,
  OSEvent,
  ProcessRecord,
  ToolRegistrationStatus,
  ToolRegistryGroup,
  VerbOSSettings,
  FileSystemBackend,
  FileSystemStatus,
  WindowRect,
  StickyNoteRecord,
} from "./types";
import {
  cascadeWindowRect,
  clampWindowRect,
  currentViewport,
  type ViewportSize,
} from "./windowGeometry";
import type { SessionSnapshot } from "./sessionSnapshot";
import { clampStickyPosition, defaultStickyPosition } from "./stickyNotes";

export const MAX_OS_EVENTS = 2_000;

type KernelData = {
  processes: ProcessRecord[];
  minimizedPids: number[];
  commandProcesses: CommandProcessRecord[];
  events: OSEvent[];
  agentPresenceEvent: OSEvent | null;
  screensaverActive: boolean;
  bootedAt: number;
  nextPid: number;
  nextSpawnCount: number;
  lastSpawnOrigin: Pick<WindowRect, "x" | "y"> | null;
  toolRegistrationStatuses: ToolRegistrationStatus[] | null;
  fileSystemStatus: FileSystemStatus;
  fileSystemBackend: FileSystemBackend | null;
  fileSystemError: string | null;
  fileSystemRepairs: string[];
  fileSystemWarnings: string[];
  notesPreviewEnabledByPid: Record<number, boolean>;
  stickyNotes: StickyNoteRecord[];
  settings: VerbOSSettings;
  settingsLoaded: boolean;
  toolRegistryGroups: ToolRegistryGroup[];
  lastActivityAt: number;
  machineConflict: boolean;
};

type KernelActions = {
  spawn: (appId: AppId, options?: {
    initialRect?: WindowRect;
    path?: string;
    placement?: Partial<WindowRect>;
    focus?: boolean;
    viewport?: ViewportSize;
  }) => ProcessRecord;
  startCommand: (command: string, cwd: string) => CommandProcessRecord;
  finishCommand: (pid: number) => void;
  killCommand: (pid: number) => CommandProcessRecord | undefined;
  kill: (pid: number) => ProcessRecord | undefined;
  minimize: (pid: number) => ProcessRecord | undefined;
  focus: (pid: number) => ProcessRecord | undefined;
  setProcessPath: (pid: number, path: string) => ProcessRecord | undefined;
  setProcessCwd: (pid: number, cwd: string) => ProcessRecord | undefined;
  move: (pid: number, x: number, y: number) => ProcessRecord | undefined;
  resize: (pid: number, width: number, height: number) => ProcessRecord | undefined;
  clampWindows: (viewportWidth: number, viewportHeight: number) => void;
  osEvent: (source: EventSource, verb: string, args?: Record<string, unknown>) => OSEvent;
  settleEvent: (event: OSEvent, ok: boolean, reason?: string) => void;
  annotateEvent: (event: OSEvent, args: Record<string, unknown>) => OSEvent;
  wakeScreensaver: () => boolean;
  setToolRegistrationStatuses: (statuses: readonly ToolRegistrationStatus[]) => void;
  setFileSystemState: (
    status: FileSystemStatus,
    backend?: FileSystemBackend,
    error?: string,
  ) => void;
  setFileSystemCheck: (report: { repaired: readonly string[]; warnings: readonly string[] }) => void;
  setNotesPreviewEnabled: (pid: number, enabled: boolean) => void;
  setNoteSticky: (path: string, sticky: boolean) => StickyNoteRecord | undefined;
  moveStickyNote: (path: string, x: number, y: number) => StickyNoteRecord | undefined;
  setSettings: (settings: VerbOSSettings) => void;
  setToolRegistryGroup: (group: ToolRegistryGroup) => void;
  removeToolRegistryGroup: (id: string) => void;
  recordActivity: () => void;
  activateScreensaver: () => void;
  setMachineConflict: (conflict: boolean) => void;
  restoreSession: (snapshot: SessionSnapshot) => void;
};

export type KernelState = KernelData & KernelActions;

const createInitialData = (): KernelData => ({
  processes: [],
  minimizedPids: [],
  commandProcesses: [],
  events: [],
  agentPresenceEvent: null,
  screensaverActive: true,
  bootedAt: Date.now(),
  nextPid: 2,
  nextSpawnCount: 0,
  lastSpawnOrigin: null,
  toolRegistrationStatuses: null,
  fileSystemStatus: "idle",
  fileSystemBackend: null,
  fileSystemError: null,
  fileSystemRepairs: [],
  fileSystemWarnings: [],
  notesPreviewEnabledByPid: {},
  stickyNotes: [],
  settings: { ...DEFAULT_SETTINGS },
  settingsLoaded: false,
  toolRegistryGroups: [],
  lastActivityAt: Date.now(),
  machineConflict: false,
});

const APP_SIZES: Record<AppId, Pick<WindowRect, "width" | "height">> = {
  files: { width: 420, height: 300 },
  editor: { width: 560, height: 390 },
  terminal: { width: 600, height: 350 },
  notes: { width: 380, height: 300 },
  preview: { width: 720, height: 500 },
  settings: { width: 420, height: 330 },
  browser: { width: 960, height: 640 },
  ui: { width: 520, height: 420 },
};

const commandControllers = new Map<number, AbortController>();
const appliedSessionSnapshots = new Set<string>();

function processMergeIdentity(process: ProcessRecord): string {
  const { x, y, width, height } = process.windowRect;
  return JSON.stringify([
    process.appId,
    process.path ?? null,
    process.cwd ?? null,
    x,
    y,
    width,
    height,
  ]);
}

function sessionMergeIdentity(snapshot: SessionSnapshot): string {
  return JSON.stringify([
    snapshot.version,
    snapshot.processes.map((process) => [
      process.pid,
      processMergeIdentity(process),
      process.zIndex,
      process.focused,
    ]),
    snapshot.minimizedPids,
    snapshot.nextPid,
    snapshot.nextSpawnCount,
    snapshot.lastSpawnOrigin,
    snapshot.stickyNotes.map(({ path, x, y }) => [path, x, y]),
  ]);
}

export function assertPidSafety(
  processes: readonly ProcessRecord[],
  commandProcesses: readonly CommandProcessRecord[],
  nextPid: number,
): void {
  const pids = [...processes, ...commandProcesses].map(({ pid }) => pid);
  if (new Set(pids).size !== pids.length) {
    throw new Error("verbos: duplicate PID after session restore");
  }
  const highestPid = pids.reduce((highest, pid) => Math.max(highest, pid), 1);
  if (nextPid <= highestPid) {
    throw new Error(`verbos: next PID ${nextPid} is not above live PID ${highestPid}`);
  }
}

function normalizeZIndices(processes: ProcessRecord[]): ProcessRecord[] {
  const zIndexByPid = new Map(
    [...processes]
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((process, zIndex) => [process.pid, zIndex]),
  );
  let changed = false;
  const normalized = processes.map((process) => {
    const zIndex = zIndexByPid.get(process.pid) ?? 0;
    if (process.zIndex === zIndex) return process;
    changed = true;
    return { ...process, zIndex };
  });
  return changed ? normalized : processes;
}

function setFocusedProcess(processes: ProcessRecord[], focusedPid?: number): ProcessRecord[] {
  let changed = false;
  const focused = processes.map((process) => {
    const nextFocused = process.pid === focusedPid;
    if (process.focused === nextFocused) return process;
    changed = true;
    return { ...process, focused: nextFocused };
  });
  return changed ? focused : processes;
}

function sameWindowRect(left: WindowRect, right: WindowRect): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function restoreSuppressionArgs(process: ProcessRecord): Record<string, unknown> {
  const { x, y } = process.windowRect;
  return { appId: process.appId, pid: process.pid, x, y };
}

export const useKernelStore = create<KernelState>()((set, get) => ({
  ...createInitialData(),

  spawn(appId, options) {
    const state = get();
    const shouldFocus = options?.focus ?? true;
    const viewport = options?.viewport ?? currentViewport();
    const existing = isSingletonApp(appId)
      ? state.processes.find((process) => process.appId === appId)
      : undefined;
    if (existing) {
      const placedRect = options?.initialRect ?? (options?.placement === undefined
        ? existing.windowRect
        : clampWindowRect({ ...existing.windowRect, ...options.placement }, viewport));
      const updated = state.processes.map((entry) => {
        if (entry.pid !== existing.pid) return entry;
        const path = options?.path;
        const windowRect = sameWindowRect(entry.windowRect, placedRect)
          ? entry.windowRect
          : placedRect;
        const zIndex = shouldFocus && !entry.focused ? state.processes.length : entry.zIndex;
        if ((path === undefined || path === entry.path) &&
          windowRect === entry.windowRect && zIndex === entry.zIndex) {
          return entry;
        }
        return {
          ...entry,
          ...(path === undefined ? {} : { path }),
          windowRect,
          zIndex,
        };
      });
      const normalized = shouldFocus ? normalizeZIndices(updated) : updated;
      const processes = shouldFocus
        ? setFocusedProcess(normalized, existing.pid)
        : normalized;
      const focused = processes.find((entry) => entry.pid === existing.pid);
      if (!focused) throw new Error(`verbos: singleton ${appId} disappeared while focusing`);
      set({
        processes,
        minimizedPids: state.minimizedPids.filter((pid) => pid !== existing.pid),
      });
      return focused;
    }
    const baseRect = options?.initialRect ?? cascadeWindowRect(
      APP_SIZES[appId],
      state.lastSpawnOrigin,
      viewport,
    );
    const windowRect = options?.placement === undefined
      ? baseRect
      : clampWindowRect({ ...baseRect, ...options.placement }, viewport);
    const process: ProcessRecord = {
      pid: state.nextPid,
      appId,
      ...(options?.path === undefined ? {} : { path: options.path }),
      windowRect,
      zIndex: shouldFocus
        ? state.processes.length
        : state.processes.find(({ focused }) => focused)?.zIndex ?? state.processes.length,
      focused: shouldFocus,
    };
    const shiftedProcesses = state.processes.map((entry) => {
      const zIndex = !shouldFocus && entry.zIndex >= process.zIndex
        ? entry.zIndex + 1
        : entry.zIndex;
      const focused = shouldFocus ? false : entry.focused;
      if (zIndex === entry.zIndex && focused === entry.focused) return entry;
      return { ...entry, zIndex, focused };
    });
    const processes = normalizeZIndices([
      ...shiftedProcesses,
      process,
    ]);
    const spawned = processes.find(({ pid }) => pid === process.pid);
    if (!spawned) throw new Error(`verbos: ${appId} disappeared while spawning`);

    set({
      processes,
      nextPid: state.nextPid + 1,
      nextSpawnCount: state.nextSpawnCount + 1,
      lastSpawnOrigin: { x: windowRect.x, y: windowRect.y },
    });
    return spawned;
  },

  startCommand(command, cwd) {
    const state = get();
    const controller = new AbortController();
    const process: CommandProcessRecord = {
      pid: state.nextPid,
      command,
      cwd,
      startedAt: Date.now(),
      signal: controller.signal,
    };
    commandControllers.set(process.pid, controller);
    set({
      commandProcesses: [...state.commandProcesses, process],
      nextPid: state.nextPid + 1,
    });
    return process;
  },

  finishCommand(pid) {
    commandControllers.delete(pid);
    set((state) => ({
      commandProcesses: state.commandProcesses.filter((process) => process.pid !== pid),
    }));
  },

  killCommand(pid) {
    const process = get().commandProcesses.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    commandControllers.get(pid)?.abort();
    commandControllers.delete(pid);
    set((state) => ({
      commandProcesses: state.commandProcesses.filter((entry) => entry.pid !== pid),
    }));
    return process;
  },

  kill(pid) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;

    const remaining = normalizeZIndices(
      state.processes.filter((entry) => entry.pid !== pid),
    );
    const minimizedPids = state.minimizedPids.filter((entryPid) => entryPid !== pid);
    const nextFocused = remaining
      .filter((entry) => !minimizedPids.includes(entry.pid))
      .reduce<ProcessRecord | undefined>(
      (top, entry) => (!top || entry.zIndex > top.zIndex ? entry : top),
      undefined,
    );
    set({
      processes: setFocusedProcess(remaining, nextFocused?.pid),
      minimizedPids,
      notesPreviewEnabledByPid: Object.fromEntries(
        Object.entries(state.notesPreviewEnabledByPid).filter(([entryPid]) => Number(entryPid) !== pid),
      ),
    });
    return process;
  },

  minimize(pid) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    if (state.minimizedPids.includes(pid)) return process;
    const nextFocused = process.focused
      ? state.processes
        .filter((entry) => entry.pid !== pid && !state.minimizedPids.includes(entry.pid))
        .reduce<ProcessRecord | undefined>(
          (top, entry) => (!top || entry.zIndex > top.zIndex ? entry : top),
          undefined,
        )
      : undefined;
    const processes = process.focused
      ? setFocusedProcess(state.processes, nextFocused?.pid)
      : state.processes;
    set({ processes, minimizedPids: [...state.minimizedPids, pid] });
    return processes.find((entry) => entry.pid === pid);
  },

  focus(pid) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    const wasMinimized = state.minimizedPids.includes(pid);
    if (process.focused && !wasMinimized) return process;

    const raised = state.processes.map((entry) =>
      entry.pid === pid ? { ...entry, zIndex: state.processes.length } : entry
    );
    const processes = setFocusedProcess(normalizeZIndices(raised), pid);
    const focused = processes.find((entry) => entry.pid === pid);
    if (!focused) return undefined;
    set({
      processes,
      minimizedPids: state.minimizedPids.filter((entryPid) => entryPid !== pid),
    });
    return focused;
  },

  setProcessPath(pid, path) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    const updated = { ...process, path };
    set({
      processes: state.processes.map((entry) => (entry.pid === pid ? updated : entry)),
    });
    return updated;
  },

  setProcessCwd(pid, cwd) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    if (process.cwd === cwd) return process;
    const updated = { ...process, cwd };
    set({ processes: state.processes.map((entry) => (entry.pid === pid ? updated : entry)) });
    return updated;
  },

  move(pid, x, y) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    const moved = { ...process, windowRect: { ...process.windowRect, x, y } };
    set({
      processes: state.processes.map((entry) => (entry.pid === pid ? moved : entry)),
    });
    return moved;
  },

  resize(pid, width, height) {
    const state = get();
    const process = state.processes.find((entry) => entry.pid === pid);
    if (!process) return undefined;
    const resized = {
      ...process,
      windowRect: { ...process.windowRect, width, height },
    };
    set({
      processes: state.processes.map((entry) => (entry.pid === pid ? resized : entry)),
    });
    return resized;
  },

  clampWindows(viewportWidth, viewportHeight) {
    set((state) => ({
      processes: state.processes.map((process) => ({
        ...process,
        windowRect: clampWindowRect(process.windowRect, {
          width: viewportWidth,
          height: viewportHeight,
        }),
      })),
    }));
  },

  osEvent(source, verb, args = {}) {
    const event: OSEvent = { source, verb, args, ts: Date.now() };
    set((state) => ({
      events: [...state.events, event].slice(-MAX_OS_EVENTS),
      ...(source === "agent" ? { agentPresenceEvent: event } : {}),
    }));
    return event;
  },

  settleEvent(event, ok, reason) {
    const settled = { ...event, ok, ...(reason === undefined ? {} : { reason }) };
    set((state) => ({
      events: state.events.map((entry) =>
        entry === event
          ? settled
          : entry,
      ),
      ...(state.agentPresenceEvent === event ? { agentPresenceEvent: settled } : {}),
    }));
  },

  annotateEvent(event, args) {
    const annotated = { ...event, args: { ...event.args, ...args } };
    set((state) => ({
      events: state.events.map((entry) =>
        entry === event
          ? annotated
          : entry
      ),
      ...(state.agentPresenceEvent === event ? { agentPresenceEvent: annotated } : {}),
    }));
    return annotated;
  },

  wakeScreensaver() {
    const wasActive = get().screensaverActive;
    if (wasActive) set({ screensaverActive: false });
    return wasActive;
  },

  setToolRegistrationStatuses(statuses) {
    set({ toolRegistrationStatuses: statuses.map((status) => ({ ...status })) });
  },

  setFileSystemState(status, backend, error) {
    set({
      fileSystemStatus: status,
      fileSystemBackend: backend ?? null,
      fileSystemError: error ?? null,
    });
  },

  setFileSystemCheck(report) {
    set({
      fileSystemRepairs: [...report.repaired],
      fileSystemWarnings: [...report.warnings],
    });
  },

  setNotesPreviewEnabled(pid, enabled) {
    set((state) => ({
      notesPreviewEnabledByPid: { ...state.notesPreviewEnabledByPid, [pid]: enabled },
    }));
  },

  setNoteSticky(path, sticky) {
    const state = get();
    const existing = state.stickyNotes.find((note) => note.path === path);
    if (!sticky) {
      if (!existing) return undefined;
      set({ stickyNotes: state.stickyNotes.filter((note) => note.path !== path) });
      return existing;
    }
    if (existing) return existing;
    const position = defaultStickyPosition(state.stickyNotes.length, currentViewport());
    const note = { path, ...position };
    set({ stickyNotes: [...state.stickyNotes, note] });
    return note;
  },

  moveStickyNote(path, x, y) {
    const state = get();
    const existing = state.stickyNotes.find((note) => note.path === path);
    if (!existing) return undefined;
    const moved = { ...existing, ...clampStickyPosition({ x, y }, currentViewport()) };
    set({ stickyNotes: state.stickyNotes.map((note) => note.path === path ? moved : note) });
    return moved;
  },

  setSettings(settings) {
    set({ settings: { ...settings }, settingsLoaded: true });
  },

  setToolRegistryGroup(group) {
    set((state) => ({
      toolRegistryGroups: [
        ...state.toolRegistryGroups.filter(({ id }) => id !== group.id),
        { ...group, tools: [...group.tools] },
      ],
    }));
  },

  removeToolRegistryGroup(id) {
    set((state) => ({
      toolRegistryGroups: state.toolRegistryGroups.filter((group) => group.id !== id),
    }));
  },

  recordActivity() {
    set({ lastActivityAt: Date.now() });
  },

  activateScreensaver() {
    set({ screensaverActive: true });
  },

  setMachineConflict(conflict) {
    set({ machineConflict: conflict });
  },

  restoreSession(snapshot) {
    const state = get();
    const snapshotIdentity = sessionMergeIdentity(snapshot);
    const savedProcesses = snapshot.processes.map((process) => ({
      ...process,
      windowRect: clampWindowRect(process.windowRect, currentViewport()),
    }));
    if (appliedSessionSnapshots.has(snapshotIdentity)) {
      assertPidSafety(state.processes, state.commandProcesses, state.nextPid);
      for (const process of savedProcesses) {
        state.osEvent(
          "system",
          "restore_suppressed_duplicate",
          restoreSuppressionArgs(process),
        );
      }
      return;
    }
    const occupiedPids = new Set([
      ...state.processes.map(({ pid }) => pid),
      ...state.commandProcesses.map(({ pid }) => pid),
    ]);
    const highestReservedPid = [...occupiedPids, ...snapshot.processes.map(({ pid }) => pid)]
      .reduce((highest, pid) => Math.max(highest, pid), 1);
    let availablePid = Math.max(state.nextPid, snapshot.nextPid, highestReservedPid + 1);
    const unmatchedCurrentIdentities = new Map<string, number>();
    for (const process of state.processes) {
      const identity = processMergeIdentity(process);
      unmatchedCurrentIdentities.set(identity, (unmatchedCurrentIdentities.get(identity) ?? 0) + 1);
    }
    const suppressedDuplicates: ProcessRecord[] = [];
    const suppressedSingletons: ProcessRecord[] = [];
    const restoredPidBySavedPid = new Map<number, number>();
    const restored = normalizeZIndices(savedProcesses
      .filter((saved) => {
        const identity = processMergeIdentity(saved);
        const matches = unmatchedCurrentIdentities.get(identity) ?? 0;
        if (matches === 0) return true;
        unmatchedCurrentIdentities.set(identity, matches - 1);
        suppressedDuplicates.push(saved);
        return false;
      })
      .filter((saved) => {
        if (!isSingletonApp(saved.appId) ||
          !state.processes.some((current) => current.appId === saved.appId)) return true;
        suppressedSingletons.push(saved);
        return false;
      })
      .map((saved) => {
        let pid = saved.pid;
        if (pid < state.nextPid || occupiedPids.has(pid)) {
          while (occupiedPids.has(availablePid)) availablePid += 1;
          pid = availablePid;
          availablePid += 1;
        }
        occupiedPids.add(pid);
        restoredPidBySavedPid.set(saved.pid, pid);
        return {
          ...saved,
          pid,
        };
      }));
    const currentHasFocus = state.processes.some(({ focused }) => focused);
    const processes = normalizeZIndices([
      ...restored.map((process) => ({
        ...process,
        focused: currentHasFocus ? false : process.focused,
      })),
      ...normalizeZIndices(state.processes).map((process) => restored.length === 0
        ? process
        : { ...process, zIndex: process.zIndex + restored.length }),
    ]);
    const highestPid = [...processes, ...state.commandProcesses]
      .reduce((highest, process) => Math.max(highest, process.pid), 1);
    const nextPid = Math.max(snapshot.nextPid, state.nextPid, highestPid + 1);
    const stickyNotes = new Map(
      [...snapshot.stickyNotes, ...state.stickyNotes]
        .map((note) => [note.path, { ...note }] as const),
    );
    const minimizedPids = [...new Set([
      ...state.minimizedPids.filter((pid) => processes.some((process) => process.pid === pid)),
      ...snapshot.minimizedPids.flatMap((pid) => {
        const restoredPid = restoredPidBySavedPid.get(pid);
        return restoredPid === undefined ? [] : [restoredPid];
      }),
    ])];
    assertPidSafety(processes, state.commandProcesses, nextPid);
    for (const process of suppressedDuplicates) {
      state.osEvent(
        "system",
        "restore_suppressed_duplicate",
        restoreSuppressionArgs(process),
      );
    }
    for (const process of suppressedSingletons) {
      state.osEvent(
        "system",
        "restore_suppressed_singleton",
        restoreSuppressionArgs(process),
      );
    }
    appliedSessionSnapshots.add(snapshotIdentity);
    set({
      processes,
      minimizedPids,
      nextPid,
      nextSpawnCount: snapshot.nextSpawnCount + state.nextSpawnCount,
      lastSpawnOrigin: state.nextSpawnCount > 0
        ? state.lastSpawnOrigin
        : snapshot.lastSpawnOrigin === null ? null : { ...snapshot.lastSpawnOrigin },
      stickyNotes: [...stickyNotes.values()],
      screensaverActive: processes.length === 0 ? get().screensaverActive : false,
    });
  },
}));

export function resetKernelStore(): void {
  for (const controller of commandControllers.values()) controller.abort();
  commandControllers.clear();
  appliedSessionSnapshots.clear();
  useKernelStore.setState(createInitialData());
}

export function latestAgentEvent(events: readonly OSEvent[]): OSEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.source === "agent") return event;
  }
  return undefined;
}
