import { describe, expect, test } from "bun:test";
import { createTerminalOutputSanitizer } from "./terminalOutputSanitizer";

describe("terminal command output sanitizer", () => {
  test("removes control sequences split across chunks", () => {
    const sanitizer = createTerminalOutputSanitizer();

    expect(sanitizer.push("before\x1b[31")).toBe("before");
    expect(sanitizer.push("mred\x1b]0;spoofed")).toBe("red");
    expect(sanitizer.push(" title\x07after\x1bPhidden")).toBe("after");
    expect(sanitizer.push(" payload\x1b\\safe\x00\x7f")).toBe("safe");
  });

  test("passes plain unicode, tabs, and newlines unchanged", () => {
    const sanitizer = createTerminalOutputSanitizer();
    const plain = "Aurora 🙂 עברית\ttrail\nnext";

    expect(sanitizer.push(plain)).toBe(plain);
  });
});
