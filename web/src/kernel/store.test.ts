import { beforeEach, describe, expect, test } from "bun:test";
import { latestAgentEvent, MAX_OS_EVENTS, resetKernelStore, useKernelStore } from "./store";
import type { SessionSnapshot } from "./sessionSnapshot";

describe("kernel process table", () => {
  beforeEach(() => resetKernelStore());

  test("spawns incrementing PIDs and focuses newest process", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");
    const processes = useKernelStore.getState().processes;

    expect(files.pid).toBe(2);
    expect(editor.pid).toBe(3);
    expect(processes.find((process) => process.pid === files.pid)?.focused).toBe(false);
    expect(processes.find((process) => process.pid === editor.pid)?.focused).toBe(true);
    expect(editor.zIndex).toBeGreaterThan(files.zIndex);
  });

  test("spawns an unfocused process below the focused window", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");
    const terminal = useKernelStore.getState().spawn("terminal", { focus: false });
    const processes = useKernelStore.getState().processes;

    expect(processes.find(({ pid }) => pid === files.pid)?.zIndex).toBe(0);
    expect(processes.find(({ pid }) => pid === terminal.pid)).toEqual(expect.objectContaining({
      focused: false,
      zIndex: 1,
    }));
    expect(processes.find(({ pid }) => pid === editor.pid)).toEqual(expect.objectContaining({
      focused: true,
      zIndex: 2,
    }));
  });

  test("focus raises a process and clears previous focus", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");
    const focused = useKernelStore.getState().focus(files.pid);
    const currentEditor = useKernelStore
      .getState()
      .processes.find((entry) => entry.pid === editor.pid);

    expect(focused?.focused).toBe(true);
    expect(focused?.zIndex).toBeGreaterThan(currentEditor?.zIndex ?? -1);
    expect(currentEditor?.focused).toBe(false);
  });

  test("focus preserves unaffected process identity and no-op state identity", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");
    useKernelStore.getState().spawn("terminal");
    const beforeFocus = useKernelStore.getState().processes;
    const filesBefore = beforeFocus.find(({ pid }) => pid === files.pid);

    useKernelStore.getState().focus(editor.pid);
    const afterFocus = useKernelStore.getState().processes;
    expect(afterFocus.find(({ pid }) => pid === files.pid)).toBe(filesBefore);

    const processReferences = [...afterFocus];
    useKernelStore.getState().focus(editor.pid);
    expect(useKernelStore.getState().processes).toBe(afterFocus);
    expect(useKernelStore.getState().processes).toEqual(processReferences);
  });

  test("keeps z-indices normalized through 300 spawn and focus cycles", () => {
    const files = useKernelStore.getState().spawn("files");
    useKernelStore.getState().spawn("editor");

    for (let index = 0; index < 300; index += 1) {
      useKernelStore.getState().spawn("editor");
      useKernelStore.getState().focus(files.pid);
    }

    const zIndices = useKernelStore
      .getState()
      .processes.map(({ zIndex }) => zIndex)
      .sort((left, right) => left - right);
    expect(zIndices).toEqual(Array.from({ length: 302 }, (_, index) => index));
  });

  test("kill removes process and focuses top remaining window", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");
    useKernelStore.getState().kill(editor.pid);

    expect(useKernelStore.getState().processes).toEqual([
      expect.objectContaining({ pid: files.pid, focused: true }),
    ]);
  });

  test("minimize hides one process until focus restores it", () => {
    const files = useKernelStore.getState().spawn("files");
    const editor = useKernelStore.getState().spawn("editor");

    expect(useKernelStore.getState().minimize(editor.pid)).toEqual(
      expect.objectContaining({ pid: editor.pid, focused: false }),
    );
    expect(useKernelStore.getState().minimizedPids).toEqual([editor.pid]);
    expect(useKernelStore.getState().processes.find(({ pid }) => pid === files.pid)?.focused).toBe(true);

    expect(useKernelStore.getState().focus(editor.pid)).toEqual(
      expect.objectContaining({ pid: editor.pid, focused: true }),
    );
    expect(useKernelStore.getState().minimizedPids).toEqual([]);

    useKernelStore.getState().minimize(editor.pid);
    useKernelStore.getState().kill(editor.pid);
    expect(useKernelStore.getState().minimizedPids).toEqual([]);
  });

  test("move and resize update one process rectangle", () => {
    const process = useKernelStore.getState().spawn("terminal");
    useKernelStore.getState().move(process.pid, 120, 160);
    useKernelStore.getState().resize(process.pid, 720, 460);

    expect(useKernelStore.getState().processes[0]?.windowRect).toEqual({
      x: 120,
      y: 160,
      width: 720,
      height: 460,
    });
  });

  test("re-clamps all windows when viewport shrinks", () => {
    const process = useKernelStore.getState().spawn("preview", {
      initialRect: { x: 1100, y: 600, width: 900, height: 700 },
    });
    useKernelStore.getState().clampWindows(500, 400);

    expect(useKernelStore.getState().processes.find(({ pid }) => pid === process.pid)?.windowRect).toEqual({
      x: 440,
      y: 324,
      width: 500,
      height: 362,
    });
  });

  test("clamps restored windows and preserves live processes by renumbering saved collisions", () => {
    const live = useKernelStore.getState().spawn("files", {
      viewport: { width: 1280, height: 720 },
    });
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [{
        pid: live.pid,
        appId: "editor",
        path: "~/desktop/brief.md",
        windowRect: { x: 5_000, y: 5_000, width: 2_000, height: 2_000 },
        zIndex: 0,
        focused: true,
      }],
      minimizedPids: [live.pid],
      nextPid: 3,
      nextSpawnCount: 1,
      lastSpawnOrigin: { x: 5_000, y: 5_000 },
      stickyNotes: [],
    };

    useKernelStore.getState().restoreSession(snapshot);

    const processes = useKernelStore.getState().processes;
    expect(processes).toHaveLength(2);
    expect(processes.find(({ pid }) => pid === live.pid)).toEqual(expect.objectContaining({
      appId: "files",
      focused: true,
      zIndex: 1,
    }));
    expect(processes.find(({ appId }) => appId === "editor")).toEqual(expect.objectContaining({
      pid: 3,
      focused: false,
      zIndex: 0,
      windowRect: { x: 1_220, y: 644, width: 1_280, height: 682 },
    }));
    expect(useKernelStore.getState().nextPid).toBe(4);
    expect(useKernelStore.getState().minimizedPids).toEqual([3]);
  });

  test("re-applying one session snapshot is idempotent and keeps PIDs safe", () => {
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [
        {
          pid: 2,
          appId: "editor",
          path: "~/desktop/brief.md",
          windowRect: { x: 120, y: 130, width: 560, height: 390 },
          zIndex: 0,
          focused: false,
        },
        {
          pid: 3,
          appId: "terminal",
          cwd: "~/site",
          windowRect: { x: 180, y: 190, width: 600, height: 350 },
          zIndex: 1,
          focused: true,
        },
      ],
      minimizedPids: [],
      nextPid: 4,
      nextSpawnCount: 2,
      lastSpawnOrigin: { x: 180, y: 190 },
      stickyNotes: [],
    };

    useKernelStore.getState().restoreSession(snapshot);
    const afterFirstRestore = useKernelStore.getState();
    useKernelStore.getState().restoreSession(snapshot);
    const afterSecondRestore = useKernelStore.getState();
    const pids = afterSecondRestore.processes.map(({ pid }) => pid);

    expect(afterSecondRestore.processes).toEqual(afterFirstRestore.processes);
    expect(afterSecondRestore.nextSpawnCount).toBe(afterFirstRestore.nextSpawnCount);
    expect(new Set(pids).size).toBe(pids.length);
    expect(afterSecondRestore.nextPid).toBeGreaterThan(Math.max(...pids));
    expect(afterSecondRestore.events).toEqual([
      expect.objectContaining({
        source: "system",
        verb: "restore_suppressed_duplicate",
        args: { appId: "editor", pid: 2, x: 120, y: 130 },
      }),
      expect.objectContaining({
        source: "system",
        verb: "restore_suppressed_duplicate",
        args: { appId: "terminal", pid: 3, x: 180, y: 190 },
      }),
    ]);
  });

  test("logs duplicate suppression from the partial-overlap identity merge", () => {
    const live = useKernelStore.getState().spawn("editor", {
      initialRect: { x: 120, y: 130, width: 560, height: 390 },
      path: "~/desktop/brief.md",
    });
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [
        {
          ...live,
          pid: 40,
          windowRect: { ...live.windowRect },
        },
        {
          pid: 41,
          appId: "terminal",
          cwd: "~/site",
          windowRect: { x: 180, y: 190, width: 600, height: 350 },
          zIndex: 1,
          focused: false,
        },
      ],
      minimizedPids: [],
      nextPid: 42,
      nextSpawnCount: 2,
      lastSpawnOrigin: { x: 180, y: 190 },
      stickyNotes: [],
    };

    useKernelStore.getState().restoreSession(snapshot);

    const state = useKernelStore.getState();
    expect(state.processes).toEqual([
      expect.objectContaining({ pid: 41, appId: "terminal", focused: false, zIndex: 0 }),
      expect.objectContaining({ pid: live.pid, appId: "editor", focused: true, zIndex: 1 }),
    ]);
    expect(state.events).toEqual([
      expect.objectContaining({
        source: "system",
        verb: "restore_suppressed_duplicate",
        args: { appId: "editor", pid: 40, x: 120, y: 130 },
      }),
    ]);
  });

  test("logs each saved singleton suppressed by a live instance", () => {
    const live = useKernelStore.getState().spawn("settings", {
      initialRect: { x: 60, y: 70, width: 420, height: 330 },
    });
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [{
        pid: 40,
        appId: "settings",
        windowRect: { x: 200, y: 210, width: 420, height: 330 },
        zIndex: 0,
        focused: true,
      }],
      minimizedPids: [],
      nextPid: 41,
      nextSpawnCount: 1,
      lastSpawnOrigin: { x: 200, y: 210 },
      stickyNotes: [],
    };

    useKernelStore.getState().restoreSession(snapshot);

    const state = useKernelStore.getState();
    expect(state.processes).toEqual([live]);
    expect(state.events).toEqual([
      expect.objectContaining({
        source: "system",
        verb: "restore_suppressed_singleton",
        args: { appId: "settings", pid: 40, x: 200, y: 210 },
      }),
    ]);
  });

  test("uses a monotonic cascade offset after windows close", () => {
    const viewport = { width: 1280, height: 720 };
    useKernelStore.getState().spawn("files", { viewport });
    const editor = useKernelStore.getState().spawn("editor", { viewport });
    useKernelStore.getState().kill(editor.pid);
    const terminal = useKernelStore.getState().spawn("terminal", { viewport });

    expect(terminal.windowRect).toEqual({
      x: 102,
      y: 130,
      width: 600,
      height: 350,
    });
  });

  test("reuses singleton placement without focusing when requested", () => {
    const settings = useKernelStore.getState().spawn("settings");
    const editor = useKernelStore.getState().spawn("editor");
    const reused = useKernelStore.getState().spawn("settings", {
      placement: { x: 240, y: 160, width: 500, height: 400 },
      focus: false,
      viewport: { width: 1280, height: 720 },
    });

    expect(reused).toEqual(expect.objectContaining({
      pid: settings.pid,
      focused: false,
      windowRect: { x: 240, y: 160, width: 500, height: 400 },
    }));
    expect(useKernelStore.getState().processes.find(({ pid }) => pid === editor.pid)?.focused).toBe(true);
  });

  test("reuses singleton apps while multi-instance apps keep spawning", () => {
    const settings = useKernelStore.getState().spawn("settings");
    const reused = useKernelStore.getState().spawn("settings");
    const firstEditor = useKernelStore.getState().spawn("editor");
    const secondEditor = useKernelStore.getState().spawn("editor");

    expect(reused.pid).toBe(settings.pid);
    expect(useKernelStore.getState().processes.filter(({ appId }) => appId === "settings")).toHaveLength(1);
    expect(secondEditor.pid).not.toBe(firstEditor.pid);
    expect(useKernelStore.getState().processes.filter(({ appId }) => appId === "editor")).toHaveLength(2);
  });

  test("shares monotonic PIDs with transient commands and aborts killed commands", () => {
    const command = useKernelStore.getState().startCommand("ls | wc -l", "~");
    const terminal = useKernelStore.getState().spawn("terminal");

    expect(command.pid).toBe(2);
    expect(terminal.pid).toBe(3);
    expect(command.signal.aborted).toBe(false);
    expect(useKernelStore.getState().killCommand(command.pid)).toEqual(command);
    expect(command.signal.aborted).toBe(true);
    expect(useKernelStore.getState().commandProcesses).toEqual([]);
  });

  test("sticks, moves, and unsticks a note on the desktop", () => {
    const stuck = useKernelStore.getState().setNoteSticky("~/notes/welcome.md", true);
    expect(stuck).toEqual(expect.objectContaining({ path: "~/notes/welcome.md" }));
    expect(useKernelStore.getState().setNoteSticky("~/notes/welcome.md", true)).toEqual(stuck);
    expect(useKernelStore.getState().moveStickyNote("~/notes/welcome.md", -20, 9999)).toEqual({
      path: "~/notes/welcome.md",
      x: 0,
      y: 502,
    });
    expect(useKernelStore.getState().setNoteSticky("~/notes/welcome.md", false)).toBeDefined();
    expect(useKernelStore.getState().stickyNotes).toEqual([]);
  });
});

describe("kernel event log", () => {
  beforeEach(() => resetKernelStore());

  test("caps events at 2000 newest entries", () => {
    for (let index = 0; index < MAX_OS_EVENTS + 12; index += 1) {
      useKernelStore.getState().osEvent("human", "test_event", { index });
    }

    const events = useKernelStore.getState().events;
    expect(events).toHaveLength(MAX_OS_EVENTS);
    expect(events[0]?.args.index).toBe(12);
    expect(events.at(-1)?.args.index).toBe(MAX_OS_EVENTS + 11);
  });

  test("agent presence ignores app-originated bridge events", () => {
    const agent = useKernelStore.getState().osEvent("agent", "fs_write");
    useKernelStore.getState().osEvent("app", "ui_call", { pid: 2, tool: "fs_write" });
    expect(latestAgentEvent(useKernelStore.getState().events)).toBe(agent);
  });

  test("keeps annotated publish payload visible after its event is trimmed from the ring", () => {
    const publish = useKernelStore.getState().osEvent("agent", "os_publish", { path: "~/site" });
    for (let index = 0; index < MAX_OS_EVENTS; index += 1) {
      useKernelStore.getState().osEvent("system", "test_event", { index });
    }
    expect(useKernelStore.getState().events).not.toContain(publish);

    const annotated = useKernelStore.getState().annotateEvent(publish, {
      url: "https://computer.test/s/aaaaaaaa/",
    });
    useKernelStore.getState().settleEvent(annotated, true);
    expect(useKernelStore.getState().agentPresenceEvent).toEqual(expect.objectContaining({
      verb: "os_publish",
      ok: true,
      args: {
        path: "~/site",
        url: "https://computer.test/s/aaaaaaaa/",
      },
    }));
  });
});

describe("M5 screensaver activity", () => {
  test("records activity and can return to screensaver after wake", () => {
    resetKernelStore();
    const state = useKernelStore.getState();
    expect(state.wakeScreensaver()).toBe(true);
    expect(useKernelStore.getState().screensaverActive).toBe(false);
    const before = useKernelStore.getState().lastActivityAt;
    useKernelStore.getState().recordActivity();
    expect(useKernelStore.getState().lastActivityAt).toBeGreaterThanOrEqual(before);
    useKernelStore.getState().activateScreensaver();
    expect(useKernelStore.getState().screensaverActive).toBe(true);
  });
});
