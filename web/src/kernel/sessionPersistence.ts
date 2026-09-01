import { assertPidSafety, useKernelStore } from "./store";
import {
  deserializeSession,
  serializeSession,
  SESSION_STORAGE_KEY,
  type SessionSnapshot,
} from "./sessionSnapshot";

const SESSION_SAVE_DELAY_MS = 120;
const PERSISTENCE_WARNING = "VerbOS session persistence unavailable; cross-refresh persistence disabled";

type RestoreLatch = { invoked: boolean };

const restoreLatch = (import.meta.hot?.data.sessionRestoreLatch as RestoreLatch | undefined) ?? {
  invoked: false,
};
if (import.meta.hot) import.meta.hot.data.sessionRestoreLatch = restoreLatch;

let persistenceDegraded = false;
let persistenceWarningEmitted = false;

function degradePersistence(error: unknown): void {
  persistenceDegraded = true;
  if (persistenceWarningEmitted) return;
  persistenceWarningEmitted = true;
  console.warn(PERSISTENCE_WARNING, error);
  useKernelStore.getState().osEvent("system", "session_persistence_degraded");
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  try {
    return window.sessionStorage;
  } catch (error) {
    degradePersistence(error);
    return undefined;
  }
}

function snapshot(): SessionSnapshot {
  const state = useKernelStore.getState();
  return {
    version: 1,
    processes: state.processes.map((process) => ({
      ...process,
      windowRect: { ...process.windowRect },
    })),
    minimizedPids: [...state.minimizedPids],
    nextPid: state.nextPid,
    nextSpawnCount: state.nextSpawnCount,
    lastSpawnOrigin: state.lastSpawnOrigin === null ? null : { ...state.lastSpawnOrigin },
    stickyNotes: state.stickyNotes.map((note) => ({ ...note })),
  };
}

export function restoreSessionFromStorage(storage?: Storage): boolean {
  if (restoreLatch.invoked) {
    if (import.meta.env.DEV) console.warn("VerbOS session restore already ran; ignoring duplicate invocation");
    return false;
  }
  restoreLatch.invoked = true;
  const target = persistenceDegraded ? undefined : resolveStorage(storage);
  let serialized: string | null = null;
  if (target) {
    try {
      serialized = target.getItem(SESSION_STORAGE_KEY);
    } catch (error) {
      degradePersistence(error);
    }
  }
  const restored = deserializeSession(serialized);
  if (!restored) {
    const state = useKernelStore.getState();
    assertPidSafety(state.processes, state.commandProcesses, state.nextPid);
    return false;
  }
  useKernelStore.getState().restoreSession(restored);
  return restored.processes.length > 0;
}

export function resetSessionRestoreLatchForTests(): void {
  restoreLatch.invoked = false;
  persistenceDegraded = false;
  persistenceWarningEmitted = false;
}

export function startSessionPersistence(storage?: Storage): () => void {
  const target = persistenceDegraded ? undefined : resolveStorage(storage);
  let lastProcesses = useKernelStore.getState().processes;
  let lastMinimizedPids = useKernelStore.getState().minimizedPids;
  let lastStickyNotes = useKernelStore.getState().stickyNotes;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = undefined;
    if (persistenceDegraded || !target) return;
    const payload = serializeSession(snapshot());
    try {
      target.setItem(SESSION_STORAGE_KEY, payload);
    } catch (error) {
      degradePersistence(error);
    }
  };
  const unsubscribe = useKernelStore.subscribe((state) => {
    if (state.processes === lastProcesses && state.minimizedPids === lastMinimizedPids &&
      state.stickyNotes === lastStickyNotes) return;
    lastProcesses = state.processes;
    lastMinimizedPids = state.minimizedPids;
    lastStickyNotes = state.stickyNotes;
    if (persistenceDegraded || !target) return;
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(save, SESSION_SAVE_DELAY_MS);
  });
  globalThis.addEventListener("pagehide", save);
  save();
  return () => {
    unsubscribe();
    globalThis.removeEventListener("pagehide", save);
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}
