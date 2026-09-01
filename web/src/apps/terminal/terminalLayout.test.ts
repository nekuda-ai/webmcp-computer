import { describe, expect, test } from "bun:test";
import {
  TERMINAL_CELL_HEIGHT,
  TERMINAL_VERTICAL_RESERVE,
  terminalGridSize,
} from "./terminalLayout";

describe("terminal layout", () => {
  test("leaves a full prompt row visible at minimum window height", () => {
    const bodyHeight = 210 - 38;
    const grid = terminalGridSize(300, bodyHeight);

    expect(grid).toEqual({ cols: 34, rows: 6 });
    expect(grid.rows * TERMINAL_CELL_HEIGHT).toBeLessThanOrEqual(
      bodyHeight - TERMINAL_VERTICAL_RESERVE,
    );
  });
});
