import { describe, expect, test } from "bun:test";
import {
  getPreviewRuntime,
  mountPreviewRuntime,
  recordPreviewConsole,
  recordPreviewWarnings,
} from "./runtime";
import {
  MAX_PREVIEW_CONSOLE_MESSAGE_BYTES,
  PREVIEW_CONSOLE_TRUNCATION_MARKER,
  truncatePreviewConsoleMessage,
} from "./consoleMessage";

describe("Preview console runtime", () => {
  test("keeps the newest 200 lines and coalesces 10k notifications", async () => {
    let visibleLines = 0;
    let flushes = 0;
    const unmount = mountPreviewRuntime(42, "~/site", async () => {}, (lines) => {
      visibleLines = lines.length;
      flushes += 1;
    });
    try {
      for (let index = 0; index < 10_000; index += 1) {
        recordPreviewConsole(42, "log", `line ${index}`);
      }
      await Promise.resolve();
      const runtime = getPreviewRuntime(42);
      expect(runtime.lines).toHaveLength(200);
      expect(runtime.lines[0]?.message).toBe("line 9800");
      expect(runtime.lines.at(-1)?.message).toBe("line 9999");
      expect(runtime.dropped).toBe(9_800);
      expect(visibleLines).toBe(200);
      expect(flushes).toBe(1);
    } finally {
      unmount();
    }
  });

  test("truncates bridge and host console messages to 8KB", () => {
    const oversized = `${"🙂".repeat(4_096)} tail`;
    const bridged = truncatePreviewConsoleMessage(oversized);
    expect(new TextEncoder().encode(bridged).byteLength).toBeLessThanOrEqual(
      MAX_PREVIEW_CONSOLE_MESSAGE_BYTES,
    );
    expect(bridged.endsWith(PREVIEW_CONSOLE_TRUNCATION_MARKER)).toBe(true);

    const unmount = mountPreviewRuntime(43, "~/site", async () => {}, () => {});
    try {
      const line = recordPreviewConsole(43, "log", oversized);
      expect(line?.message).toBe(bridged);
      expect(new TextEncoder().encode(line?.message ?? "").byteLength).toBeLessThanOrEqual(
        MAX_PREVIEW_CONSOLE_MESSAGE_BYTES,
      );
    } finally {
      unmount();
    }
  });

  test("surfaces document rewrite warnings in the frame console", async () => {
    const unmount = mountPreviewRuntime(44, "~/apps/map.html", async () => {}, () => {});
    try {
      recordPreviewWarnings(44, ["verbos: missing local asset: map.png"]);
      await Promise.resolve();

      expect(getPreviewRuntime(44).lines).toEqual([
        expect.objectContaining({
          level: "warn",
          message: "verbos: missing local asset: map.png",
        }),
      ]);
    } finally {
      unmount();
    }
  });
});
