import { describe, expect, test } from "bun:test";
import { ACTIVITY_SUMMARY_MAX_CHARS } from "../../desktop/verbPresentation";
import { humanizeEvent, relativeEventAge } from "./ActivityLog";

describe("Settings Activity presentation", () => {
  test("humanizes the same OS-event records dmesg reads", () => {
    expect(humanizeEvent({
      source: "agent",
      verb: "fs_write",
      args: { path: "~/site/index.html" },
      ts: 8_000,
    }, 10_500)).toBe("[agent] fs_write · ~/site/index.html · 2s ago");
    expect(humanizeEvent({
      source: "human",
      verb: "app_open",
      args: { appId: "files" },
      ts: 10_500,
    }, 10_500)).toBe("[human] app_open · files · now");
    expect(humanizeEvent({
      source: "app",
      verb: "ui_call",
      args: { pid: 8, tool: "fs_write" },
      ts: 10_500,
      ok: true,
    }, 10_500)).toBe("[app] ui_call · fs_write · succeeded · now");
    expect(humanizeEvent({
      source: "system",
      verb: "restore_suppressed_duplicate",
      args: { appId: "editor", pid: 40, x: 120, y: 130 },
      ts: 10_500,
    }, 10_500)).toBe("[system] restore_suppressed_duplicate · editor · now");
    expect(humanizeEvent({
      source: "agent",
      verb: "fs_read",
      args: { path: "~/missing.txt" },
      ts: 10_500,
      ok: false,
      reason: "webmcp-computer: no such file: ~/missing.txt",
    }, 10_500)).toBe(
      "[agent] fs_read · ~/missing.txt — no such file: ~/missing.txt · failed · now",
    );
  });

  test("formats minute and hour ages compactly", () => {
    expect(relativeEventAge(0, 90_000)).toBe("1m ago");
    expect(relativeEventAge(0, 7_200_000)).toBe("2h ago");
  });

  test("bounds long command events while preserving operation, target, and outcome", () => {
    const summary = humanizeEvent({
      source: "agent",
      verb: "cloud_exec",
      args: {
        command: `base64 --decode ${"eHl6".repeat(100)}`,
        cwd: "/workspace/site",
      },
      ts: 10_500,
      ok: false,
      reason: `remote build failed\n${"stack ".repeat(50)}`,
    }, 10_500);

    expect(summary.length).toBeLessThanOrEqual(ACTIVITY_SUMMARY_MAX_CHARS);
    expect(summary).toStartWith("[agent] cloud_exec · /workspace/site · base64 … (+");
    expect(summary).not.toContain("eHl6eHl6");
    expect(summary).not.toContain("\n");
    expect(summary).toEndWith(" · failed · now");
  });
});
