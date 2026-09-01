import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  resetSessionRestoreLatchForTests,
  restoreSessionFromStorage,
  startSessionPersistence,
} from "./sessionPersistence";
import { serializeSession, SESSION_STORAGE_KEY, type SessionSnapshot } from "./sessionSnapshot";
import * as kernelStore from "./store";
import { resetKernelStore, useKernelStore } from "./store";

function memoryStorage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("session restore entry", () => {
  beforeEach(() => {
    resetKernelStore();
    resetSessionRestoreLatchForTests();
  });

  test("runs once and never reuses a PID already returned this load", () => {
    const returned = useKernelStore.getState().spawn("files");
    useKernelStore.getState().kill(returned.pid);
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [
        {
          pid: returned.pid,
          appId: "editor",
          path: "~/desktop/brief.md",
          windowRect: { x: 120, y: 130, width: 560, height: 390 },
          zIndex: 0,
          focused: false,
        },
        {
          pid: 4,
          appId: "terminal",
          cwd: "~/site",
          windowRect: { x: 180, y: 190, width: 600, height: 350 },
          zIndex: 1,
          focused: true,
        },
      ],
      minimizedPids: [],
      nextPid: 5,
      nextSpawnCount: 2,
      lastSpawnOrigin: { x: 180, y: 190 },
      stickyNotes: [],
    };
    const storage = memoryStorage({
      [SESSION_STORAGE_KEY]: serializeSession(snapshot),
    });

    expect(restoreSessionFromStorage(storage)).toBe(true);
    const afterFirstRestore = useKernelStore.getState();
    expect(restoreSessionFromStorage(storage)).toBe(false);
    const afterSecondRestore = useKernelStore.getState();
    const pids = afterSecondRestore.processes.map(({ pid }) => pid);

    expect(afterSecondRestore.processes).toEqual(afterFirstRestore.processes);
    expect(afterSecondRestore.nextPid).toBe(afterFirstRestore.nextPid);
    expect(pids).not.toContain(returned.pid);
    expect(new Set(pids).size).toBe(pids.length);
    expect(afterSecondRestore.nextPid).toBeGreaterThan(Math.max(...pids));
  });

  test("degrades a throwing restore read without skipping PID safety", () => {
    let reads = 0;
    const storage = memoryStorage({});
    storage.getItem = () => {
      reads += 1;
      throw new Error("storage disabled");
    };
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    const pidSafety = spyOn(kernelStore, "assertPidSafety");

    expect(restoreSessionFromStorage(storage)).toBe(false);
    expect(restoreSessionFromStorage(storage)).toBe(false);
    const spawned = useKernelStore.getState().spawn("editor");

    expect(reads).toBe(1);
    expect(pidSafety).toHaveBeenCalledTimes(1);
    expect(spawned.appId).toBe("editor");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(useKernelStore.getState().events).toEqual([
      expect.objectContaining({ source: "system", verb: "session_persistence_degraded" }),
    ]);

    pidSafety.mockRestore();
    warning.mockRestore();
  });

  test("degrades a throwing save once and keeps later saves harmless", async () => {
    let writes = 0;
    const storage = memoryStorage({});
    storage.setItem = () => {
      writes += 1;
      throw new Error("quota exceeded");
    };
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);

    const stop = startSessionPersistence(storage);
    const spawned = useKernelStore.getState().spawn("terminal");
    await Bun.sleep(150);
    expect(() => globalThis.dispatchEvent(new Event("pagehide"))).not.toThrow();

    expect(writes).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(useKernelStore.getState().processes).toEqual([
      expect.objectContaining({ pid: spawned.pid, appId: "terminal" }),
    ]);
    expect(useKernelStore.getState().events).toEqual([
      expect.objectContaining({ source: "system", verb: "session_persistence_degraded" }),
    ]);

    stop();
    warning.mockRestore();
  });

  test("persists a minimized-only state change", async () => {
    const storage = memoryStorage({});
    const first = useKernelStore.getState().spawn("editor");
    useKernelStore.getState().spawn("terminal");
    const stop = startSessionPersistence(storage);

    useKernelStore.getState().minimize(first.pid);
    await Bun.sleep(150);

    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "null")).toEqual(
      expect.objectContaining({ minimizedPids: [first.pid] }),
    );
    stop();
  });
});
