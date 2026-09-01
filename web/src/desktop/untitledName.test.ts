import { describe, expect, test } from "bun:test";
import { nextUntitledName } from "./untitledName";

describe("desktop untitled naming", () => {
  test("uses untitled first, then the lowest available -2 suffix", () => {
    expect(nextUntitledName([])).toBe("untitled");
    expect(nextUntitledName(["untitled"])).toBe("untitled-2");
    expect(nextUntitledName(["untitled", "untitled-2", "untitled-4"])).toBe("untitled-3");
  });
});
