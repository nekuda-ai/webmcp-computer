import { expect } from "bun:test";
import type { Frame, Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import {
  executeWebMcpTool,
  reloadWebMCPComputer,
  waitForFileSystemReady,
  waitForWebMcpTools,
  waitForWindow,
} from "./harness";
import { SESSION_STORAGE_KEY } from "../src/kernel/sessionSnapshot";

type UiOpenResult = {
  pid: number;
  path: string;
  rect: { x: number; y: number; width: number; height: number };
  grantedTools: string[];
};

function appHtml(version: string): string {
  return `<!doctype html>
<html>
  <head><title>M7 ${version}</title></head>
  <body>
    <h1 id="version">${version}</h1>
    <button id="write" type="button">Write shared file</button>
    <button id="denied" type="button">Try denied tool</button>
    <output id="status">ready ${version}</output>
    <script>
      const status = document.getElementById("status");
      document.modelContext.registerTool({
        name: "site_agent_app_echo",
        description: "Echo a value through the visible agent-made app and return its version.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        execute(input) {
          status.textContent = "tool ${version} " + String(input.value);
          return { echoed: String(input.value), version: "${version}" };
        },
      }).catch((error) => {
        status.textContent = "tool registration error " + String(error.message || error);
      });
      document.getElementById("write").onclick = async () => {
        try {
          const result = await window.webmcpComputer.callTool("fs_write", {
            path: "~/site/from-agent-app.txt",
            content: "written by human click ${version}",
          });
          status.textContent = "write ok " + result.path;
        } catch (error) {
          status.textContent = "write error " + String(error.message || error);
        }
      };
      document.getElementById("denied").onclick = async () => {
        try {
          await window.webmcpComputer.callTool("settings_set", { key: "crt", value: false });
          status.textContent = "denied call unexpectedly succeeded";
        } catch (error) {
          status.textContent = "denied " + String(error.message || error);
        }
      };
    </script>
  </body>
</html>`;
}

async function waitForUiFrame(
  page: Page,
  expectedVersion: string,
  previousFrame?: Frame,
): Promise<Frame> {
  const frame = await page.waitForFrame(
    (candidate) => candidate.parentFrame() === page.mainFrame() &&
      candidate.url() === "about:srcdoc" &&
      candidate !== previousFrame,
    { timeout: 10_000 },
  );
  await frame.waitForFunction(
    (expected) => document.querySelector("#version")?.textContent === expected,
    { timeout: 10_000 },
    expectedVersion,
  );
  return frame;
}

async function waitForFrameText(frame: Frame, expected: string): Promise<void> {
  await frame.waitForFunction(
    (text) => document.querySelector("#status")?.textContent?.includes(text) === true,
    { timeout: 10_000 },
    expected,
  );
}

export async function agentMadeAppScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const opened = await executeWebMcpTool<UiOpenResult>(page, "ui_open", {
    name: "shared-control",
    html: appHtml("version one"),
    allowTools: ["fs_write", "fs_read"],
    x: 210,
    y: 120,
    width: 600,
    height: 460,
  });
  expect(opened).toEqual(expect.objectContaining({
    path: "~/apps/shared-control.html",
    rect: { x: 210, y: 120, width: 600, height: 460 },
    grantedTools: ["fs_write", "fs_read"],
  }));

  await waitForWindow(page, "App", opened.pid);
  const iframeSelector = `[aria-label="App window, PID ${opened.pid}"] iframe`;
  await page.waitForSelector(iframeSelector, { visible: true });
  expect(await page.$eval(iframeSelector, (iframe) => iframe.getAttribute("sandbox")))
    .toBe("allow-scripts");
  expect(await page.$eval(
    `[aria-label="App window, PID ${opened.pid}"] .window-title`,
    (title) => title.textContent,
  )).toBe("shared-control");

  const firstFrame = await waitForUiFrame(page, "version one");
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "site_agent_app_echo"]);
  expect(await executeWebMcpTool(page, "site_agent_app_echo", { value: "first" })).toEqual({
    echoed: "first",
    version: "version one",
  });
  await waitForFrameText(firstFrame, "tool version one first");
  await firstFrame.click("#write");
  await waitForFrameText(firstFrame, "write ok ~/site/from-agent-app.txt");
  expect(await executeWebMcpTool<{ content: string }>(page, "fs_read", {
    path: "~/site/from-agent-app.txt",
  })).toEqual(expect.objectContaining({ content: "written by human click version one" }));
  const trace = await executeWebMcpTool<{ stdout: string }>(page, "term_exec", {
    command: "dmesg",
  });
  expect(trace.stdout).toContain("[app] ui_call fs_write");

  // term_exec opened a Terminal window above the app; raise the app before clicking it.
  await executeWebMcpTool(page, "window_focus", { pid: opened.pid });
  await firstFrame.click("#denied");
  await waitForFrameText(firstFrame, "webmcp-computer: UI tool not granted: settings_set");

  await executeWebMcpTool(page, "fs_write", {
    path: opened.path,
    content: appHtml("version two"),
  });
  const secondFrame = await waitForUiFrame(page, "version two", firstFrame);
  expect(await secondFrame.$eval("#version", (heading) => heading.textContent)).toBe("version two");
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "site_agent_app_echo"]);
  expect(await executeWebMcpTool(page, "site_agent_app_echo", { value: "second" })).toEqual({
    echoed: "second",
    version: "version two",
  });
  await waitForFrameText(secondFrame, "tool version two second");

  await page.waitForFunction(
    (storageKey, pid) => {
      const value = window.localStorage.getItem(storageKey);
      if (!value) return false;
      const snapshot = JSON.parse(value) as { processes?: Array<{ pid?: number; appId?: string }> };
      return snapshot.processes?.some(
        (process) => process.pid === pid && process.appId === "ui",
      ) === true;
    },
    { timeout: 10_000 },
    SESSION_STORAGE_KEY,
    opened.pid,
  );

  await reloadWebMCPComputer(page, BOOT_TOOL_NAMES);
  await waitForWindow(page, "App", opened.pid);
  const restoredFrame = await waitForUiFrame(page, "version two", secondFrame);
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "site_agent_app_echo"]);
  expect(await executeWebMcpTool(page, "site_agent_app_echo", { value: "restored" })).toEqual({
    echoed: "restored",
    version: "version two",
  });
  await waitForFrameText(restoredFrame, "tool version two restored");
  // The restored session brings the Terminal back too; raise the app before clicking it.
  await executeWebMcpTool(page, "window_focus", { pid: opened.pid });
  await restoredFrame.click("#write");
  await waitForFrameText(restoredFrame, "webmcp-computer: UI tool not granted: fs_write");
}
