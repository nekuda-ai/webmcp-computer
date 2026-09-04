import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  listWebMcpToolNames,
  waitForText,
  waitForWebMcpToolGone,
  waitForWebMcpTools,
} from "./harness";

export const BOOT_TOOL_NAMES = [
  "app_open",
  "app_close",
  "app_list",
  "window_focus",
  "window_move",
  "window_resize",
  "sys_status",
  "machine_take_over",
  "screensaver_wake",
  "os_manual",
  "os_search",
  "settings_get",
  "settings_set",
  "browser_open",
  "os_publish",
  "cloud_exec",
  "ui_open",
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_search",
  "fs_list",
  "fs_mkdir",
  "fs_delete",
  "fs_move",
  "term_exec",
  "term_read",
  "term_state",
  "term_history",
  "ps",
  "kill",
] as const;

export async function coldBootScenario(page: Page): Promise<void> {
  await page.waitForSelector(".screensaver", { visible: true });
  await waitForText(page, ".screensaver__wake", "PRESS ANY KEY — OR CALL ANY TOOL");
  await waitForWebMcpTools(page, BOOT_TOOL_NAMES);
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);
  const liveTools = page.webmcp.tools().map((tool) => ({
    name: tool.name,
    annotations: tool.annotations as typeof tool.annotations & { consequential?: boolean },
  }));
  if (liveTools.some(({ annotations }) => annotations && "consequential" in annotations)) {
    expect(
      liveTools
        .filter(({ annotations }) => annotations?.consequential === true)
        .map(({ name }) => name),
    ).toEqual(["os_publish", "cloud_exec", "fs_delete", "kill"]);
  } else {
    console.log("SKIP cold-boot taxonomy pin: surface lacks consequential (Chrome <154)");
  }

  const result = await executeWebMcpTool<{ processes: unknown[] }>(page, "app_list");
  expect(result.processes).toEqual([]);
  await page.waitForSelector(".screensaver", { hidden: true });

  const editor = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "editor" });
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "editor_open_file"]);
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES, "editor_open_file"]);
  await executeWebMcpTool(page, "app_close", { pid: editor.pid });
  await waitForWebMcpToolGone(page, "editor_open_file");
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);

  const notes = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "notes" });
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "notes_append", "notes_preview", "notes_stick"]);
  expect(listWebMcpToolNames(page)).toEqual([
    ...BOOT_TOOL_NAMES,
    "notes_append",
    "notes_preview",
    "notes_stick",
  ]);
  await executeWebMcpTool(page, "app_close", { pid: notes.pid });
  await waitForWebMcpToolGone(page, "notes_preview");
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);
}
