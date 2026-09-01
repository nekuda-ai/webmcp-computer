import { describe, expect, test } from "bun:test";
import type { ProcessRecord } from "../kernel/types";
import { dockTargetForApp } from "./Dock";

function editor(pid: number, zIndex: number): ProcessRecord {
  return {
    pid,
    appId: "editor",
    windowRect: { x: 0, y: 0, width: 560, height: 390 },
    zIndex,
    focused: false,
  };
}

describe("Dock window targeting", () => {
  test("prefers the frontmost visible app window over a newer minimized window", () => {
    const visible = editor(2, 1);
    const minimized = editor(3, 2);

    expect(dockTargetForApp([visible, minimized], [minimized.pid], "editor")).toBe(visible);
  });

  test("restores the frontmost minimized window when every app window is minimized", () => {
    const older = editor(2, 1);
    const newer = editor(3, 2);

    expect(dockTargetForApp([older, newer], [older.pid, newer.pid], "editor")).toBe(newer);
  });
});
