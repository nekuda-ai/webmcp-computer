import { expect } from "bun:test";
import type { Frame, Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import {
  executeWebMcpTool,
  executeWebMcpToolRaw,
  listWebMcpToolNames,
  waitForText,
  waitForWebMcpToolGone,
  waitForWebMcpTools,
  waitForWindow,
} from "./harness";

type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
};

type ConsoleResult = {
  pid: number;
  url: string;
  lines: Array<{ level: string; message: string; ts: number }>;
  truncated: boolean;
  dropped: number;
};

type SiteAnswer = {
  answer: string;
};

const pageHtml = (heading: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"><script defer src="app.js"></script></head><body><h1 id="preview-heading">${heading}</h1><img alt="Aurora" src="pixel.png"></body></html>`;
const INITIAL_HTML = pageHtml("Aurora first");
const UPDATED_HTML = pageHtml("Aurora live");
const STYLE_CSS = "body { background-color: rgb(11, 22, 33); color: white; }";
const UPDATED_STYLE_CSS = `${STYLE_CSS} h1 { letter-spacing: 0.02em; }`;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const APP_JS = `
document.getElementById("preview-heading").dataset.deferReady = "yes";
document.body.dataset.externalScript = "loaded";
const tools = [
  {
    name: "site_hello",
    description: "Greet one Aurora Trails visitor by name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    execute: ({ name }) => ({ answer: "Aurora says hello to " + name + "." }),
  },
  {
    name: "site_book_night",
    description: "Book one visible Aurora Trails night-hike request for a named guest.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    execute: ({ name }) => {
      document.getElementById("preview-heading").textContent = "Night booked for " + name;
      return { answer: "Aurora booked a night hike for " + name + "." };
    },
  },
  {
    name: "site_timeout",
    description: "Never settles, to prove the host timeout.",
    execute: () => new Promise(() => {}),
  },
];
const oversized = document.modelContext.registerTool({
  name: "site_oversized",
  description: "x".repeat(4 * 1024 + 1),
  execute: () => "unreachable",
}).then(
  () => { throw new Error("oversized site tool unexpectedly registered"); },
  (error) => { document.body.dataset.siteRegistrationError = String(error?.message ?? error); },
);
Promise.all([...tools.map((tool) => document.modelContext.registerTool(tool)), oversized])
  .then(() => console.log("Aurora site tools ready"));
console.error("M4 injected error");
setTimeout(() => { throw new Error("M4 uncaught error"); }, 0);
`;

async function waitForFileSystem(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await executeWebMcpTool<{ fs_status: string }>(page, "sys_status");
    if (status.fs_status === "local (opfs)" || status.fs_status === "local (memory)") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Preview e2e filesystem did not become ready");
}

async function waitForStableFrameText(
  page: Page,
  expected: string,
  previousUrl?: string,
): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  let stableUrl = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const frame = page.frames().filter(
      (candidate) => candidate.parentFrame() === page.mainFrame() &&
        candidate.url().startsWith("blob:") &&
        candidate.url() !== previousUrl,
    ).at(-1);
    if (frame) {
      const body = await frame.$eval("body", (element) => element.textContent ?? "").catch(() => "");
      if (body.includes(expected)) {
        if (stableUrl !== frame.url()) {
          stableUrl = frame.url();
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 100) {
          return frame;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Preview frame did not stably render '${expected}'`);
}

export async function previewScenario(page: Page): Promise<void> {
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);
  await waitForFileSystem(page);
  await executeWebMcpTool(page, "fs_write", {
    path: "~/site/index.html",
    content: INITIAL_HTML,
  });
  await executeWebMcpTool(page, "fs_write", {
    path: "~/site/style.css",
    content: STYLE_CSS,
  });
  await executeWebMcpTool(page, "fs_write", {
    path: "~/site/app.js",
    content: APP_JS,
  });
  await executeWebMcpTool(page, "fs_write", {
    path: "~/site/pixel.png",
    content: PNG_BASE64,
    encoding: "base64",
  });

  const served = await executeWebMcpTool<ExecResult>(page, "term_exec", {
    command: "serve site/",
  });
  expect(served.stderr).toBe("");
  expect(served.exit_code).toBe(0);
  expect(served.truncated).toBe(false);
  const pid = Number(served.stdout.match(/preview \(pid (\d+)\)/)?.[1]);
  expect(pid).toBeGreaterThanOrEqual(2);
  expect(served.stdout).toBe(`serving ~/site/ → preview (pid ${pid})\n`);

  await waitForWindow(page, "Preview", pid);
  const previewToolNames = [
    "preview_get_console",
    "preview_reload",
    "preview_get_url",
  ] as const;
  const siteToolNames = ["site_hello", "site_book_night", "site_timeout"] as const;
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, ...previewToolNames]);
  const allowedInitialToolNames = new Set<string>([
    ...BOOT_TOOL_NAMES,
    ...previewToolNames,
    ...siteToolNames,
  ]);
  expect(listWebMcpToolNames(page).every((name) => allowedInitialToolNames.has(name))).toBe(true);

  await page.waitForSelector(`[data-preview-pid="${pid}"] iframe`, {
    visible: true,
    timeout: 10_000,
  });
  const sandbox = await page.$eval(
    `[data-preview-pid="${pid}"] iframe`,
    (iframe) => iframe.getAttribute("sandbox"),
  );
  expect(sandbox).toBe("allow-scripts");

  const firstFrame = await waitForStableFrameText(page, "Aurora first");
  await firstFrame.waitForFunction(
    () => {
      const image = document.querySelector("img");
      return getComputedStyle(document.body).backgroundColor === "rgb(11, 22, 33)" &&
        image instanceof HTMLImageElement &&
        image.naturalWidth > 0 &&
        document.body.dataset.externalScript === "loaded" &&
        document.getElementById("preview-heading")?.dataset.deferReady === "yes";
    },
    { timeout: 10_000 },
  );
  expect(await firstFrame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgb(11, 22, 33)",
  );
  expect(await firstFrame.$eval("img", (image) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await firstFrame.$eval("img", (image) => image.getAttribute("src"))).toBe(
    `data:image/png;base64,${PNG_BASE64}`,
  );
  const firstUrl = firstFrame.url();

  await firstFrame.waitForFunction(
    () => document.body.dataset.siteRegistrationError ===
      "verbos: site tool description too large: site_oversized",
    { timeout: 10_000 },
  );

  await waitForWebMcpTools(page, [
    ...BOOT_TOOL_NAMES,
    ...previewToolNames,
    ...siteToolNames,
  ]);
  const firstSiteTools = page.webmcp.tools().filter(({ name }) => name.startsWith("site_"));
  expect(firstSiteTools.map(({ name }) => name)).toEqual([...siteToolNames]);
  expect(firstSiteTools.every(({ annotations }) => annotations?.untrustedContent === true)).toBe(true);
  expect(await firstFrame.evaluate(() => {
    const context = (document as Document & {
      modelContext: { getTools(): Array<{ name: string }> };
    }).modelContext;
    return context.getTools().map(({ name }) => name);
  })).toEqual([...siteToolNames]);

  expect(await executeWebMcpTool<SiteAnswer>(page, "site_hello", { name: "Mira" })).toEqual({
    answer: "Aurora says hello to Mira.",
  });
  expect(await executeWebMcpTool<SiteAnswer>(page, "site_book_night", { name: "Mira" })).toEqual({
    answer: "Aurora booked a night hike for Mira.",
  });
  await waitForText(page, ".agent-toast", "AGENT RAN: preview · site_book_night");
  await firstFrame.waitForFunction(
    () => document.getElementById("preview-heading")?.textContent === "Night booked for Mira",
    { timeout: 10_000 },
  );
  const timedOut = await executeWebMcpToolRaw(
    page,
    "site_timeout",
    {},
    AbortSignal.timeout(20_000),
  );
  expect(timedOut.status).toBe("Completed");
  expect(timedOut.output).toEqual({
    content: [{ type: "text", text: "verbos: site tool timed out: site_timeout" }],
    isError: true,
  });

  await Promise.all([
    executeWebMcpTool(page, "fs_write", {
      path: "~/site/index.html",
      content: UPDATED_HTML,
    }),
    executeWebMcpTool(page, "fs_write", {
      path: "~/site/style.css",
      content: UPDATED_STYLE_CSS,
    }),
    executeWebMcpTool(page, "fs_write", {
      path: "~/site/pixel.png",
      content: PNG_BASE64,
      encoding: "base64",
    }),
  ]);
  const secondFrame = await waitForStableFrameText(page, "Aurora live", firstUrl);
  expect(await secondFrame.$eval("img", (image) => image.getAttribute("src"))).toBe(
    `data:image/png;base64,${PNG_BASE64}`,
  );
  await waitForWebMcpTools(page, [
    ...BOOT_TOOL_NAMES,
    ...previewToolNames,
    ...siteToolNames,
  ]);
  const secondBookTool = page.webmcp.tools().find(({ name }) => name === "site_book_night");
  expect(secondBookTool).toBeDefined();
  expect(secondBookTool).not.toBe(firstSiteTools.find(({ name }) => name === "site_book_night"));
  expect(await executeWebMcpTool<SiteAnswer>(page, "site_book_night", { name: "Sol" })).toEqual({
    answer: "Aurora booked a night hike for Sol.",
  });
  await waitForText(page, `[data-preview-pid="${pid}"] .preview-console`, "M4 injected error");
  await waitForText(page, `[data-preview-pid="${pid}"] .preview-console`, "M4 uncaught error");

  const consoleResult = await executeWebMcpTool<ConsoleResult>(
    page,
    "preview_get_console",
    { pid },
  );
  expect(consoleResult.pid).toBe(pid);
  expect(consoleResult.url).toBe("verbos://site/");
  expect(consoleResult.truncated).toBe(false);
  expect(consoleResult.dropped).toBe(0);
  expect(consoleResult.lines).toContainEqual(
    expect.objectContaining({ level: "error", message: "M4 injected error" }),
  );
  expect(consoleResult.lines.some(({ level, message }) =>
    level === "error" && message.includes("M4 uncaught error"),
  )).toBe(true);
  expect(await executeWebMcpTool(page, "preview_get_url", { pid })).toEqual({
    pid,
    url: "verbos://site/",
    root: "~/site",
  });

  await executeWebMcpTool(page, "app_close", { pid });
  await waitForWebMcpToolGone(page, "preview_get_console");
  await waitForWebMcpToolGone(page, "site_book_night");
  expect(listWebMcpToolNames(page)).toEqual([...BOOT_TOOL_NAMES]);
}
