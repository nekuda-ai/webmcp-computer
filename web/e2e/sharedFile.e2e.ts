import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  inputValue,
  openFilesDirectory,
  reloadWebMCPComputer,
  textContent,
  typeInEditor,
  waitForText,
  waitForWebMcpTools,
  waitForValue,
  waitForWindow,
} from "./harness";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";

const PATH = "~/site/index.html";
const ORIGINAL = "<h1>Original</h1>";
const AGENT_EDIT = "<h1>Agent edit</h1>";
const HUMAN_EDIT = " — human draft";
const DISK_REPLACEMENT = "<h1>Agent replaced disk</h1>";

export async function sharedFileScenario(page: Page): Promise<void> {
  const files = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "files" });
  await waitForWindow(page, "Files", files.pid);
  await waitForText(page, ".file-list", "site");
  await openFilesDirectory(page, "site");
  await waitForText(page, ".app-path", "~/site");

  expect(await executeWebMcpTool(page, "fs_write", { path: PATH, content: ORIGINAL })).toEqual({
    written: true,
    path: PATH,
    bytes: 17,
  });
  await waitForText(page, ".file-list", "index.html");

  const editor = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "editor" });
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "files_reveal", "editor_open_file"]);
  expect(await executeWebMcpTool(page, "editor_open_file", {
    path: PATH,
    pid: editor.pid,
  })).toEqual({ pid: editor.pid, appId: "editor", path: PATH });
  await waitForWindow(page, "Editor", editor.pid);
  const editorSelector = `[aria-label="Editing ${PATH}"]`;
  await waitForValue(page, editorSelector, ORIGINAL);

  expect(
    await executeWebMcpTool(page, "fs_edit", {
      path: PATH,
      old_string: "Original",
      new_string: "Agent edit",
    }),
  ).toEqual({ path: PATH, replacements: 1 });
  await waitForValue(page, editorSelector, AGENT_EDIT);

  await typeInEditor(page, editorSelector, HUMAN_EDIT);
  await waitForValue(page, editorSelector, AGENT_EDIT + HUMAN_EDIT);
  await waitForText(page, `[aria-label="Editor window, PID ${editor.pid}"] .app-status`, "UNSAVED");

  await executeWebMcpTool(page, "fs_write", { path: PATH, content: DISK_REPLACEMENT });
  await waitForText(page, ".file-conflict", "Changed on disk");
  expect(await inputValue(page, editorSelector)).toBe(AGENT_EDIT + HUMAN_EDIT);
  expect(
    await textContent(page, `[aria-label="Editor window, PID ${editor.pid}"] .app-status`),
  ).toContain("CONFLICT");
  expect(await executeWebMcpTool(page, "fs_read", { path: PATH })).toEqual({
    path: PATH,
    content: DISK_REPLACEMENT,
  });

  await reloadWebMCPComputer(page, BOOT_TOOL_NAMES);
  expect(await executeWebMcpTool(page, "fs_read", { path: PATH })).toEqual({
    path: PATH,
    content: DISK_REPLACEMENT,
  });
}
