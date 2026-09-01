import { describe, expect, test } from "bun:test";
import { cascadeWindowRect, clampWindowRect } from "./windowGeometry";

describe("window geometry", () => {
  test("keeps left close controls reachable", () => {
    expect(clampWindowRect(
      { x: -999, y: -10, width: 560, height: 390 },
      { width: 1280, height: 720 },
    )).toEqual({ x: 0, y: 0, width: 560, height: 390 });
  });

  test("re-clamps position and size after viewport shrink", () => {
    expect(clampWindowRect(
      { x: 1100, y: 600, width: 900, height: 700 },
      { width: 500, height: 400 },
    )).toEqual({ x: 440, y: 324, width: 500, height: 362 });
  });

  test("cascades 24px from the last origin and wraps near the work-area origin", () => {
    expect(cascadeWindowRect(
      { width: 420, height: 300 },
      { x: 54, y: 82 },
      { width: 1280, height: 720 },
    )).toEqual({ x: 78, y: 106, width: 420, height: 300 });
    expect(cascadeWindowRect(
      { width: 420, height: 300 },
      { x: 900, y: 500 },
      { width: 1280, height: 720 },
    )).toEqual({ x: 54, y: 82, width: 420, height: 300 });
  });
});
