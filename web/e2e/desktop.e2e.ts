import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  executeWebMcpToolRaw,
  waitForText,
  waitForFileSystemReady,
  waitForWindow,
  waitForWindowGone,
  windowGeometry,
} from "./harness";

type ProcessResult = {
  pid: number;
  appId: string;
  rect?: { x: number; y: number; width: number; height: number };
  windowRect: { x: number; y: number; width: number; height: number };
};

export async function agentDrivesDesktopScenario(page: Page): Promise<void> {
  const opened = await executeWebMcpTool<ProcessResult>(page, "app_open", { appId: "files" });
  expect(opened).toEqual(expect.objectContaining({ pid: 2, appId: "files" }));
  await waitForWindow(page, "Files", opened.pid);
  await waitForText(page, `[aria-label="Files window, PID ${opened.pid}"] .window-pid`, "PID 2");
  await waitForText(page, ".agent-toast", "AGENT RAN: app_open · files · succeeded");

  const moved = await executeWebMcpTool<ProcessResult>(page, "window_move", {
    pid: opened.pid,
    x: 240,
    y: 180,
  });
  expect(await windowGeometry(page, "Files", opened.pid)).toEqual(moved.windowRect);
  await waitForText(page, ".agent-toast", "AGENT RAN: window_move · PID 2 · succeeded");

  const resized = await executeWebMcpTool<ProcessResult>(page, "window_resize", {
    pid: opened.pid,
    width: 640,
    height: 420,
  });
  expect(await windowGeometry(page, "Files", opened.pid)).toEqual(resized.windowRect);
  await waitForText(page, ".agent-toast", "AGENT RAN: window_resize · PID 2 · succeeded");

  await page.setViewport({ width: 500, height: 400 });
  await page.waitForFunction(
    (pid) => {
      const shell = document.querySelector<HTMLElement>(`[aria-label="Files window, PID ${pid}"]`)?.parentElement;
      const close = shell?.querySelector<HTMLElement>(".window-control--close");
      if (!shell || !close) return false;
      const shellRect = shell.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return shellRect.width <= 500 && shellRect.height <= 362 && closeRect.left >= 0;
    },
    {},
    opened.pid,
  );
  const shrunken = await windowGeometry(page, "Files", opened.pid);
  expect(shrunken.width).toBeLessThanOrEqual(500);
  expect(shrunken.height).toBeLessThanOrEqual(362);
  expect(shrunken.x).toBeGreaterThanOrEqual(0);
  await page.setViewport({ width: 1280, height: 720 });

  expect(await executeWebMcpTool(page, "app_close", { pid: opened.pid })).toEqual({
    closed: true,
    pid: opened.pid,
    appId: "files",
  });
  await waitForWindowGone(page, "Files", opened.pid);
  await waitForText(page, ".agent-toast", "AGENT RAN: app_close · files · succeeded");
}

export async function honestFailureScenario(page: Page): Promise<void> {
  const result = await executeWebMcpToolRaw(page, "app_close", { pid: 99 });
  expect(result.status).toBe("Completed");
  expect(result.output).toEqual({
    content: [{ type: "text", text: "webmcp-computer: process PID 99 not found" }],
    isError: true,
  });
  await waitForText(
    page,
    ".agent-toast",
    "AGENT FAILED: app_close · PID 99 — process PID 99 not found · failed",
  );

  await waitForFileSystemReady(page);
  const missingFile = await executeWebMcpToolRaw(page, "fs_read", { path: "~/missing-x3.txt" });
  expect(missingFile.status).toBe("Completed");
  expect(missingFile.output).toEqual({
    content: [{ type: "text", text: "webmcp-computer: no such file: ~/missing-x3.txt" }],
    isError: true,
  });
  await waitForText(
    page,
    ".agent-toast",
    "AGENT FAILED: fs_read · ~/missing-x3.txt — no such file: ~/missing-x3.txt · failed",
  );
}

export async function multiTabProtectionScenario(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const snapshot = await navigator.locks.query();
    return snapshot.held?.some(({ name }) => name === "webmcp-computer-machine") === true;
  });

  const secondPage = await page.browserContext().newPage();
  try {
    await secondPage.setViewport({ width: 1280, height: 720 });
    await secondPage.goto(page.url(), { waitUntil: "domcontentloaded" });
    await waitForText(secondPage, ".machine-banner", "machine already running in another tab");
  } finally {
    await secondPage.close();
  }
}
