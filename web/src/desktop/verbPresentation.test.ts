import { describe, expect, test } from "bun:test";
import { formatVerbCall } from "./verbPresentation";

describe("verb presentation", () => {
  test("formats toast arguments like VerbHint chips", () => {
    expect(formatVerbCall("window_move", { pid: 6, x: 20, y: 30 })).toBe("PID 6 · window_move");
    expect(formatVerbCall("fs_write", { path: "~/site/index.html", content: "..." })).toBe(
      "~/site/index.html · fs_write",
    );
    expect(formatVerbCall("settings_set", { key: "theme", value: "dark" })).toBe(
      "theme: dark · settings_set",
    );
  });

  test("supports explicit chip arguments and verbs without arguments", () => {
    expect(formatVerbCall("term_exec", "PID 4")).toBe("PID 4 · term_exec");
    expect(formatVerbCall("app_list", {})).toBe("app_list");
  });

  test("omits the separator for blank and whitespace-only details", () => {
    expect(formatVerbCall("editor_open_file", "")).toBe("editor_open_file");
    expect(formatVerbCall("editor_open_file", "   ")).toBe("editor_open_file");
  });
});
