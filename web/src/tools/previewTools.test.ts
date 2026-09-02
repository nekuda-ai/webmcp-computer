import { beforeEach, describe, expect, test } from "bun:test";
import {
  dropPreviewConsoleLines,
  mountPreviewRuntime,
  recordPreviewConsole,
} from "../apps/preview/runtime";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { previewGetConsoleTool } from "./previewTools";

type ConsoleResult = {
  pid: number;
  url: string;
  lines: Array<{ message: string }>;
  truncated: boolean;
  dropped: number;
};

describe("Preview tools", () => {
  beforeEach(() => resetKernelStore());

  test("preview_get_console reports its bounded window and dropped lines", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const unmount = mountPreviewRuntime(process.pid, "~/site", async () => {}, () => {});
    try {
      for (let index = 0; index < 205; index += 1) {
        recordPreviewConsole(process.pid, "log", `line ${index}`);
      }
      dropPreviewConsoleLines(process.pid, 3);
      const result = await previewGetConsoleTool.execute({ pid: process.pid }) as ConsoleResult;

      expect(result).toEqual({
        pid: process.pid,
        url: "webmcp-computer://site/",
        lines: expect.any(Array),
        truncated: true,
        dropped: 8,
      });
      expect(result.lines).toHaveLength(200);
      expect(result.lines[0]?.message).toBe("line 5");
      expect(result.lines.at(-1)?.message).toBe("line 204");
      recordPreviewConsole(process.pid, "log", "line after snapshot");
      expect(result.lines[0]?.message).toBe("line 5");
      expect(result.lines.at(-1)?.message).toBe("line 204");
    } finally {
      unmount();
    }
  });
});
