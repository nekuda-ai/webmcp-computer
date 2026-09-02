import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_SUMMARY_MAX_CHARS,
  formatEventSummary,
  formatVerbCall,
  TOAST_SUMMARY_MAX_CHARS,
} from "./verbPresentation";

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

  test("summarizes long commands without exposing their bodies", () => {
    const summary = formatEventSummary({
      verb: "cloud_exec",
      args: {
        command: `printf ${"A".repeat(100)}`,
        cwd: "/workspace/site",
        appId: "terminal",
      },
      ok: true,
    }, TOAST_SUMMARY_MAX_CHARS);

    expect(summary).toBe(
      "cloud_exec · /workspace/site · printf … (+101 chars) · succeeded",
    );
    expect(summary.length).toBeLessThanOrEqual(TOAST_SUMMARY_MAX_CHARS);
    expect(summary).not.toContain("AAAA");
  });

  test("keeps short commands readable and makes failures single-line", () => {
    expect(formatEventSummary({
      verb: "term_exec",
      args: { command: "npm run build", term_pid: 4 },
      ok: true,
    }, TOAST_SUMMARY_MAX_CHARS)).toBe(
      "term_exec · PID 4 · npm run build · succeeded",
    );

    const failure = formatEventSummary({
      verb: "cloud_exec",
      args: { command: "npm run build", cwd: "/workspace/site" },
      ok: false,
      reason: `build failed\n${"detail ".repeat(40)}`,
    }, TOAST_SUMMARY_MAX_CHARS);

    expect(failure.length).toBeLessThanOrEqual(TOAST_SUMMARY_MAX_CHARS);
    expect(failure).not.toContain("\n");
    expect(failure).toEndWith(" · failed");
  });

  test("exports separate hard caps for toast and Activity surfaces", () => {
    expect(TOAST_SUMMARY_MAX_CHARS).toBe(80);
    expect(ACTIVITY_SUMMARY_MAX_CHARS).toBe(160);
  });
});
