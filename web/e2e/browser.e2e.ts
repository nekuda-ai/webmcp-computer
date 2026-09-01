import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import type { FakeBrowserRun } from "./fakeBrowserRun";
import {
  executeWebMcpTool,
  listWebMcpToolNames,
  waitForWebMcpToolGone,
  waitForWebMcpTools,
  waitForWindow,
} from "./harness";

const BROWSER_TOOL_NAMES = [
  "browser_goto",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_site_tools",
  "browser_site_call",
] as const;

type BrowserOpenResult = { pid: number; url: string; keepAliveMs: number; reused: boolean };
type BrowserPageResult = { url: string; title: string };
type BrowserReadResult = BrowserPageResult & { text: string; truncated: boolean };
type ScreenshotResult = { dataUrl: string; width: number; height: number };
type ExecResult = { stdout: string; stderr: string; exit_code: number; truncated: boolean };

export async function browserScenario(page: Page, fake: FakeBrowserRun): Promise<void> {
  const opened = await executeWebMcpTool<BrowserOpenResult>(page, "browser_open", {
    url: "https://start.test/",
  });
  expect(opened).toEqual(expect.objectContaining({
    url: "https://start.test/",
    keepAliveMs: 300_000,
    reused: false,
  }));
  await waitForWindow(page, "Browser", opened.pid);
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, ...BROWSER_TOOL_NAMES]);
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES, ...BROWSER_TOOL_NAMES]);
  expect(await page.$eval(
    `[data-browser-pid="${opened.pid}"] iframe`,
    (iframe) => iframe.getAttribute("src"),
  )).toBe(fake.liveViewUrl);

  const navigated = await executeWebMcpTool<BrowserPageResult>(page, "browser_goto", {
    url: "https://journey.test/products",
  });
  expect(navigated).toEqual({
    url: "https://journey.test/products",
    title: "Fake page: journey.test",
  });
  const initialRead = await executeWebMcpTool<BrowserReadResult>(page, "browser_read", {});
  expect(initialRead).toEqual(expect.objectContaining({
    url: "https://journey.test/products",
    text: "Fake page loaded at https://journey.test/products",
    truncated: false,
  }));

  await executeWebMcpTool(page, "browser_click", { selector: "#mutate" });
  const clickedRead = await executeWebMcpTool<BrowserReadResult>(page, "browser_read", {});
  expect(clickedRead.text).toBe("Fake page clicked");
  expect(fake.state.clickCount).toBe(1);

  const typedText = "shared browser e2e";
  expect(await executeWebMcpTool(page, "browser_type", {
    selector: "#query",
    text: typedText,
    submit: true,
  })).toEqual({ selector: "#query", characters: typedText.length, submit: true });
  expect(fake.state.typedValue).toBe(typedText);
  expect(fake.state.submitted).toBe(true);

  const siteTools = await executeWebMcpTool<Array<{ name: string }>>(page, "browser_site_tools", {});
  expect(siteTools.map(({ name }) => name)).toEqual(["site_fake_echo"]);
  expect(await executeWebMcpTool(page, "browser_site_call", {
    name: "site_fake_echo",
    input: { message: "hello from inner site" },
  })).toEqual({ echoed: "hello from inner site" });
  expect(fake.state.siteCallCount).toBe(1);

  const screenshot = await executeWebMcpTool<ScreenshotResult>(page, "browser_screenshot", {});
  expect(screenshot.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(screenshot).toEqual(expect.objectContaining({ width: 800, height: 600 }));

  const dmesg = await executeWebMcpTool<ExecResult>(page, "term_exec", { command: "dmesg" });
  expect(dmesg.exit_code).toBe(0);
  for (const name of ["browser_open", ...BROWSER_TOOL_NAMES]) {
    expect(dmesg.stdout).toContain(`[agent] ${name}`);
  }

  await executeWebMcpTool(page, "app_close", { pid: opened.pid });
  await fake.waitForDelete();
  await waitForWebMcpToolGone(page, "browser_goto");
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);
}
