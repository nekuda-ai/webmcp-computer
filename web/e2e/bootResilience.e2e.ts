import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  executeWebMcpToolRaw,
  rejectPausedFileSystemBoot,
  waitForText,
  waitForWebMcpTools,
  waitForWindow,
  waitForWindowGone,
} from "./harness";
import type { SessionSnapshot } from "../src/kernel/sessionSnapshot";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";

export const SAVED_EDITOR_SESSION: SessionSnapshot = {
  version: 1,
  processes: [{
    pid: 2,
    appId: "editor",
    path: "~/desktop/brief.md",
    windowRect: { x: 180, y: 120, width: 560, height: 390 },
    zIndex: 0,
    focused: true,
  }],
  minimizedPids: [],
  nextPid: 3,
  nextSpawnCount: 1,
  lastSpawnOrigin: { x: 180, y: 120 },
  stickyNotes: [],
};

export async function bootResilienceScenario(page: Page): Promise<void> {
  await page.waitForSelector(".desktop", { visible: true });
  await waitForText(page, ".screensaver__fs-error", "FS FAILURE");
  await waitForText(page, ".screensaver__fs-error", "forced e2e filesystem boot failure");

  const fsResult = await executeWebMcpToolRaw(page, "fs_read", {
    path: "~/desktop/brief.md",
  });
  expect(fsResult.status).toBe("Completed");
  expect(fsResult.output).toEqual({
    content: [{ type: "text", text: "webmcp-computer: filesystem not ready" }],
    isError: true,
  });

  const appResult = await executeWebMcpTool<{ pid: number; appId: string }>(page, "app_open", {
    appId: "files",
  });
  expect(appResult).toEqual(expect.objectContaining({ pid: 2, appId: "files" }));
  await waitForWindow(page, "Files", appResult.pid);
}

export async function bootFailurePreservesSessionScenario(page: Page): Promise<void> {
  await waitForWindow(page, "Editor", 2);
  const files = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "files" });
  await waitForWindow(page, "Files", files.pid);

  await page.waitForFunction(() => {
    const serialized = window.localStorage.getItem("webmcp_computer.session.v1");
    if (!serialized) return false;
    const saved = JSON.parse(serialized) as { processes?: Array<{ pid: number; appId: string }> };
    return saved.processes?.some(({ pid, appId }) => pid === 2 && appId === "editor") === true &&
      saved.processes.some(({ pid, appId }) => pid === 3 && appId === "files");
  });

  const listed = await executeWebMcpTool<{ processes: Array<{ pid: number; appId: string }> }>(
    page,
    "app_list",
  );
  expect(listed.processes).toContainEqual(expect.objectContaining({ pid: 2, appId: "editor" }));
  expect(listed.processes).toContainEqual(expect.objectContaining({ pid: 3, appId: "files" }));
}

export async function preRestoreAppOpenScenario(page: Page): Promise<void> {
  await waitForWebMcpTools(page, BOOT_TOOL_NAMES);
  const live = await executeWebMcpTool<{ pid: number; appId: string }>(page, "app_open", {
    appId: "files",
  });
  expect(live).toEqual(expect.objectContaining({ pid: 2, appId: "files" }));
  await waitForWindow(page, "Files", live.pid);

  await rejectPausedFileSystemBoot(page);
  await waitForWindow(page, "Editor", 3);
  const listed = await executeWebMcpTool<{
    processes: Array<{ pid: number; appId: string; focused: boolean }>;
  }>(page, "app_list");
  expect(listed.processes).toContainEqual(expect.objectContaining({
    pid: live.pid,
    appId: "files",
    focused: true,
  }));
  expect(listed.processes).toContainEqual(expect.objectContaining({ pid: 3, appId: "editor" }));

  await executeWebMcpTool(page, "app_close", { pid: live.pid });
  await waitForWindowGone(page, "Files", live.pid);
}
