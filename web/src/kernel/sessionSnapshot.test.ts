import { describe, expect, test } from "bun:test";
import { deserializeSession, serializeSession, type SessionSnapshot } from "./sessionSnapshot";

describe("durable session snapshot", () => {
  test("round-trips process geometry, focus, minimized PIDs, app paths, and terminal cwd", () => {
    const snapshot: SessionSnapshot = {
      version: 1,
      processes: [
        {
          pid: 2,
          appId: "editor",
          path: "~/desktop/brief.md",
          windowRect: { x: 120, y: 96, width: 560, height: 390 },
          zIndex: 0,
          focused: false,
        },
        {
          pid: 3,
          appId: "terminal",
          cwd: "~/site",
          windowRect: { x: 144, y: 120, width: 600, height: 350 },
          zIndex: 1,
          focused: true,
        },
        {
          pid: 4,
          appId: "ui",
          path: "~/apps/trail-map.html",
          windowRect: { x: 168, y: 144, width: 520, height: 420 },
          zIndex: 2,
          focused: false,
        },
      ],
      minimizedPids: [2],
      nextPid: 5,
      nextSpawnCount: 3,
      lastSpawnOrigin: { x: 144, y: 120 },
      stickyNotes: [{ path: "~/notes/welcome.md", x: 900, y: 80 }],
    };

    expect(deserializeSession(serializeSession(snapshot))).toEqual(snapshot);
  });

  test("ignores malformed or unsupported snapshots", () => {
    expect(deserializeSession("not json")).toBeNull();
    expect(deserializeSession(JSON.stringify({ version: 2, processes: [] }))).toBeNull();
    expect(deserializeSession(JSON.stringify({
      version: 1,
      processes: [],
      minimizedPids: ["2"],
      nextPid: 2,
      nextSpawnCount: 0,
      lastSpawnOrigin: null,
      stickyNotes: [],
    }))).toBeNull();
  });

  test("defaults minimized PIDs for legacy version-one snapshots", () => {
    expect(deserializeSession(JSON.stringify({
      version: 1,
      processes: [],
      nextPid: 2,
      nextSpawnCount: 0,
      lastSpawnOrigin: null,
      stickyNotes: [],
    }))).toEqual({
      version: 1,
      processes: [],
      minimizedPids: [],
      nextPid: 2,
      nextSpawnCount: 0,
      lastSpawnOrigin: null,
      stickyNotes: [],
    });
  });
});
