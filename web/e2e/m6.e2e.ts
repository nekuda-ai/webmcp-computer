import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  reloadVerbOS,
  seedSessionOnNextDocument,
  typeInEditor,
  waitForFileSystemReady,
  waitForText,
  waitForValue,
  waitForWindow,
  windowGeometry,
  waitForWebMcpTools,
} from "./harness";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import { SESSION_STORAGE_KEY, type SessionSnapshot } from "../src/kernel/sessionSnapshot";

type Rect = { x: number; y: number; width: number; height: number };
type OpenResult = { pid: number; rect: Rect; reused: boolean };
type Process = {
  pid: number;
  appId: string;
  path?: string;
  cwd?: string;
  windowRect: Rect;
  zIndex: number;
  focused: boolean;
};

export async function sessionRestoreScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const files = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "files" });
  const editor = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "editor",
    path: "~/desktop/brief.md",
  });
  const terminal = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "terminal" });
  await executeWebMcpTool(page, "term_exec", { command: "cd ~/site", term_pid: terminal.pid });
  await executeWebMcpTool(page, "window_move", { pid: editor.pid, x: 310, y: 175 });
  await executeWebMcpTool(page, "window_focus", { pid: files.pid });
  const before = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");

  await reloadVerbOS(page, BOOT_TOOL_NAMES);
  await page.waitForSelector(".screensaver", { hidden: true });
  const after = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
  expect(after.processes).toEqual(before.processes);
  expect(after.processes).toHaveLength(3);
  expect(after.processes.find(({ pid }) => pid === terminal.pid)?.cwd).toBe("~/site");
  for (const process of after.processes) {
    const name = process.appId[0]?.toUpperCase() + process.appId.slice(1);
    await waitForWindow(page, name, process.pid);
    expect(await windowGeometry(page, name, process.pid)).toEqual(process.windowRect);
  }
}

export async function repeatedSessionRestoreScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const editor = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "editor",
    path: "~/desktop/brief.md",
  });
  const terminal = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "terminal" });
  await executeWebMcpTool(page, "window_move", { pid: editor.pid, x: 210, y: 140 });
  await executeWebMcpTool(page, "window_move", { pid: terminal.pid, x: 360, y: 230 });
  const before = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
  expect(before.processes).toHaveLength(2);
  await page.waitForFunction(
    (storageKey) => {
      const serialized = window.sessionStorage.getItem(storageKey);
      if (!serialized) return false;
      const snapshot = JSON.parse(serialized) as { processes?: unknown[] };
      return snapshot.processes?.length === 2;
    },
    {},
    SESSION_STORAGE_KEY,
  );

  for (let reload = 0; reload < 3; reload += 1) {
    await reloadVerbOS(page, BOOT_TOOL_NAMES);
    await page.waitForSelector(".screensaver", { hidden: true });
    const restored = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
    const pids = restored.processes.map(({ pid }) => pid);

    expect(restored.processes).toHaveLength(2);
    expect(restored.processes).toEqual(before.processes);
    expect(new Set(pids).size).toBe(pids.length);
    expect(pids.every((pid) => Number.isInteger(pid) && pid >= 2)).toBe(true);
  }
}

export async function smallerViewportRestoreScenario(page: Page): Promise<void> {
  const snapshot: SessionSnapshot = {
    version: 1,
    processes: [{
      pid: 2,
      appId: "preview",
      windowRect: { x: 1_100, y: 600, width: 720, height: 500 },
      zIndex: 0,
      focused: true,
    }],
    minimizedPids: [],
    nextPid: 3,
    nextSpawnCount: 1,
    lastSpawnOrigin: { x: 1_100, y: 600 },
    stickyNotes: [],
  };
  await seedSessionOnNextDocument(page, snapshot);
  await page.setViewport({ width: 640, height: 480 });
  await reloadVerbOS(page, BOOT_TOOL_NAMES);
  await waitForWindow(page, "Preview", 2);

  const restored = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
  expect(restored.processes).toEqual([
    expect.objectContaining({
      pid: 2,
      windowRect: { x: 580, y: 404, width: 640, height: 442 },
    }),
  ]);
  expect(await windowGeometry(page, "Preview", 2)).toEqual({
    x: 580,
    y: 404,
    width: 640,
    height: 442,
  });
}

export async function agentPlacementScenario(page: Page): Promise<void> {
  const opened = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "files",
    x: 236,
    y: 148,
    width: 510,
    height: 344,
  });
  expect(opened).toEqual(expect.objectContaining({
    reused: false,
    rect: { x: 236, y: 148, width: 510, height: 344 },
  }));
  await waitForWindow(page, "Files", opened.pid);
  expect(await windowGeometry(page, "Files", opened.pid)).toEqual(opened.rect);
}

export async function unfocusedStackingScenario(page: Page): Promise<void> {
  const rect = { x: 220, y: 140, width: 500, height: 340 };
  const files = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "files",
    ...rect,
  });
  const editor = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "editor",
    focus: false,
    ...rect,
  });
  await waitForWindow(page, "Files", files.pid);
  await waitForWindow(page, "Editor", editor.pid);

  const hit = await page.evaluate((pid) => {
    const focused = document.querySelector<HTMLElement>(`[aria-label="Files window, PID ${pid}"]`);
    if (!focused) return false;
    const bounds = focused.getBoundingClientRect();
    const element = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return element !== null && focused.contains(element);
  }, files.pid);
  expect(hit).toBe(true);

  const listed = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
  const focused = listed.processes.find(({ pid }) => pid === files.pid);
  const unfocused = listed.processes.find(({ pid }) => pid === editor.pid);
  expect(focused).toEqual(expect.objectContaining({ focused: true }));
  expect(unfocused).toEqual(expect.objectContaining({ focused: false }));
  expect(focused?.zIndex).toBeGreaterThan(unfocused?.zIndex ?? Number.POSITIVE_INFINITY);
}

export async function emptyOpfsWriteScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const status = await executeWebMcpTool<{ fs_backend: string | null }>(page, "sys_status");
  expect(status.fs_backend).toBe("local (opfs)");

  const path = "~/site/empty-opfs.txt";
  await executeWebMcpTool(page, "fs_write", { path, content: "old content" });
  expect(await executeWebMcpTool<{ bytes: number }>(page, "fs_write", { path, content: "" }))
    .toEqual(expect.objectContaining({ bytes: 0 }));
  expect(await executeWebMcpTool<{ content: string }>(page, "fs_read", { path }))
    .toEqual(expect.objectContaining({ content: "" }));

  await executeWebMcpTool(page, "fs_write", { path, content: "old again" });
  const redirected = await executeWebMcpTool<{ stderr: string; exit_code: number }>(page, "term_exec", {
    command: `echo -n > ${path}`,
  });
  expect(redirected).toEqual(expect.objectContaining({ stderr: "", exit_code: 0 }));
  expect(await executeWebMcpTool<{ content: string }>(page, "fs_read", { path }))
    .toEqual(expect.objectContaining({ content: "" }));

  const failedRedirect = await executeWebMcpTool<{ stderr: string; exit_code: number }>(page, "term_exec", {
    command: "echo -n > ~/m6-missing-parent/empty.txt",
  });
  expect(failedRedirect.exit_code).toBe(1);
  expect(failedRedirect.stderr).toContain("verbos: no such directory: ~/m6-missing-parent");
}

export async function orphanedStickyNoteScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  await page.waitForFunction(
    (storageKey) => {
      const serialized = window.sessionStorage.getItem(storageKey);
      if (!serialized) return false;
      const snapshot = JSON.parse(serialized) as { stickyNotes?: unknown[] };
      return snapshot.stickyNotes?.length === 0;
    },
    {},
    SESSION_STORAGE_KEY,
  );
  expect(await page.$('[aria-label="Sticky note missing"]')).toBeNull();
}

export async function autosaveCatScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const path = "~/desktop/autosave.txt";
  await executeWebMcpTool(page, "fs_write", { path, content: "autosave" });
  const editor = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "editor", path });
  const selector = `[aria-label="Editing ${path}"]`;
  await waitForValue(page, selector, "autosave");
  await typeInEditor(page, selector, " works", 110);
  await waitForText(page, `[aria-label="Editor window, PID ${editor.pid}"] .app-status`, "UNSAVED");
  await waitForText(page, `[aria-label="Editor window, PID ${editor.pid}"] .app-status`, "CLEAN");
  const result = await executeWebMcpTool<{ stdout: string; exit_code: number }>(page, "term_exec", {
    command: `cat ${path}`,
  });
  expect(result).toEqual(expect.objectContaining({ stdout: "autosave works", exit_code: 0 }));
}

export async function desktopIconScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const path = "~/desktop/brief.md";
  const icon = await page.waitForSelector(`[data-desktop-path="${path}"]`, { visible: true });
  if (!icon) throw new Error(`VerbOS e2e desktop icon missing: ${path}`);
  await icon.click({ count: 2, delay: 80 });
  await page.waitForSelector(`[aria-label="Editing ${path}"]`, { visible: true });
  const listed = await executeWebMcpTool<{ processes: Process[] }>(page, "app_list");
  expect(listed.processes).toContainEqual(expect.objectContaining({ appId: "editor", path }));
}

export async function stickyActivityScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const notes = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "notes" });
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "notes_append", "notes_preview", "notes_stick"]);
  await executeWebMcpTool(page, "notes_stick", { title_or_index: "welcome", sticky: true });
  await page.waitForSelector('[aria-label="Sticky note welcome"]', { visible: true });

  const settings = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "settings" });
  await waitForWindow(page, "Settings", settings.pid);
  await page.evaluate(() => {
    const activity = [...document.querySelectorAll<HTMLButtonElement>(".settings-tabs button")]
      .find((button) => button.textContent === "Activity");
    activity?.click();
  });
  await waitForText(page, ".activity-log", "[agent] notes_stick · notes");

  await executeWebMcpTool(page, "notes_stick", { title_or_index: 1, sticky: false });
  await page.waitForSelector('[aria-label="Sticky note welcome"]', { hidden: true });
  expect(notes.pid).toBeGreaterThanOrEqual(2);
}

export async function windowChromeThemeScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  for (const appId of ["files", "editor", "terminal", "notes", "preview", "settings"]) {
    await executeWebMcpTool(page, "app_open", { appId });
  }
  const inspect = async () => await page.evaluate(() => ({
    windows: [...document.querySelectorAll<HTMLElement>(".window-surface")].map((surface) => ({
      overflow: getComputedStyle(surface).overflow,
      radius: getComputedStyle(surface).borderRadius,
    })),
    iconColors: [...document.querySelectorAll<HTMLElement>(".dock-icon")]
      .map((icon) => getComputedStyle(icon).color),
  }));
  const light = await inspect();
  expect(light.windows).toHaveLength(6);
  expect(light.windows.every(({ overflow, radius }) => overflow === "hidden" && radius !== "0px")).toBe(true);
  expect(new Set(light.iconColors).size).toBe(1);

  await executeWebMcpTool(page, "settings_set", { key: "theme", value: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const dark = await inspect();
  expect(dark.windows.every(({ overflow, radius }) => overflow === "hidden" && radius !== "0px")).toBe(true);
  expect(new Set(dark.iconColors).size).toBe(1);
  expect(dark.iconColors[0]).not.toBe(light.iconColors[0]);
}
