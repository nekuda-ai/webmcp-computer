import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import { BOOT_TOOL_NAMES } from "./coldBoot.e2e";
import {
  executeWebMcpTool,
  reloadWebMCPComputer,
  waitForText,
  waitForFileSystemReady,
  waitForWebMcpToolGone,
  waitForWebMcpTools,
  waitForWindow,
} from "./harness";

type Settings = {
  theme: string;
  accent: string;
  crt: boolean;
  hostname: string;
  screensaver_minutes: number;
};

type SearchOutput = {
  query: string;
  results: { name: string; detail: string; match: string; verb: string }[];
  warnings: string[];
};

type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
};

type OpenResult = { pid: number; reused: boolean };

export async function spotlightHoverPrecedenceScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  expect(await page.$(".spotlight")).toBeNull();

  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  const input = await page.waitForSelector(
    '.spotlight__search input[aria-label="Search WebMCP Computer"]',
    { visible: true },
  );
  if (!input) throw new Error("WebMCP Computer e2e Spotlight input not found");
  await input.type("aurora");
  await page.waitForFunction(
    () => (document.querySelector(".spotlight__results")?.textContent ?? "").includes("brief.md"),
  );

  expect(await page.$(".spotlight [data-verb-hint]")).toBeNull();
  await page.keyboard.press("ArrowDown");
  const keyboardSelection = await page.$eval(
    ".spotlight__result.is-selected",
    (element) => element.textContent,
  );
  await page.$eval(".spotlight__result:first-child", (element) => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(await page.$eval(
    ".spotlight__result.is-selected",
    (element) => element.textContent,
  )).toBe(keyboardSelection);
  await page.$eval(".spotlight__result:first-child", (element) => {
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  });
  expect(await page.$eval(
    ".spotlight__result:first-child",
    (element) => element.getAttribute("aria-selected"),
  )).toBe("true");
  await page.keyboard.press("Escape");
}

async function wallpaperPhotoStyle(page: Page): Promise<{
  layerCount: number;
  repeat: string;
  size: string;
}> {
  return await page.$eval(".desktop__wallpaper", (wallpaper) => {
    const style = getComputedStyle(wallpaper);
    const splitLayers = (value: string) => {
      const layers: string[] = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "(") depth += 1;
        if (value[index] === ")") depth -= 1;
        if (value[index] === "," && depth === 0) {
          layers.push(value.slice(start, index).trim());
          start = index + 1;
        }
      }
      layers.push(value.slice(start).trim());
      return layers;
    };
    const images = splitLayers(style.backgroundImage);
    const photoIndex = images.findIndex((image) => image.includes("wallpaper.jpg"));
    return {
      layerCount: images.length,
      repeat: splitLayers(style.backgroundRepeat)[photoIndex] ?? "",
      size: splitLayers(style.backgroundSize)[photoIndex] ?? "",
    };
  });
}

export async function m5Scenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  expect(await page.$(".menu-bar [data-verb-hint]")).toBeNull();

  const light = await executeWebMcpTool<Settings>(page, "settings_set", {
    key: "theme",
    value: "light",
  });
  expect(light.theme).toBe("light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  expect(await wallpaperPhotoStyle(page)).toEqual({
    layerCount: 3,
    repeat: "no-repeat",
    size: "cover",
  });

  const dark = await executeWebMcpTool<Settings>(page, "settings_set", {
    key: "theme",
    value: "dark",
  });
  expect(dark.theme).toBe("dark");
  await page.waitForFunction(() => {
    const wallpaper = document.querySelector(".desktop__wallpaper");
    return document.documentElement.dataset.theme === "dark" &&
      wallpaper !== null &&
      getComputedStyle(wallpaper).filter.includes("brightness(0.42)");
  });
  expect(await wallpaperPhotoStyle(page)).toEqual({
    layerCount: 3,
    repeat: "no-repeat",
    size: "cover",
  });

  await reloadWebMCPComputer(page, BOOT_TOOL_NAMES);
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  expect((await executeWebMcpTool<Settings>(page, "settings_get")).theme).toBe("dark");

  const identity = await executeWebMcpTool<Settings>(page, "settings_set", {
    key: "hostname",
    value: "builder@aurora",
  });
  expect(identity.hostname).toBe("builder@aurora");
  await waitForText(page, ".menu-bar__user", "~/BUILDER");
  const identityShell = await executeWebMcpTool<ExecResult>(page, "term_exec", {
    command: "whoami; hostname; echo $USER@$HOSTNAME",
  });
  expect(identityShell.stdout).toBe("builder\naurora\nbuilder@aurora\n");
  await waitForText(page, ".window-shell--terminal .window-title", "Terminal — builder@aurora");

  const search = await executeWebMcpTool<SearchOutput>(page, "os_search", { query: "aurora" });
  expect(search.results).toContainEqual(
    expect.objectContaining({ name: "brief.md", match: "content", verb: "editor_open_file" }),
  );
  expect(search.warnings).toEqual([]);
  await page.waitForSelector('.spotlight input[value="aurora"]', { visible: true });
  expect(await page.evaluate(
    () => document.activeElement?.matches('.spotlight input') ?? false,
  )).toBe(false);
  await page.waitForSelector(".spotlight", { hidden: true, timeout: 5_000 });
  await executeWebMcpTool<SearchOutput>(page, "os_search", { query: "aurora", show: false });
  expect(await page.$(".spotlight")).toBeNull();

  await page.$eval(
    ".window-shell--terminal .xterm-helper-textarea",
    (element) => (element as HTMLTextAreaElement).focus(),
  );
  expect(await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForSelector(".spotlight", { visible: true });
  const spotlightInput = await page.waitForSelector(
    '.spotlight__search input[aria-label="Search WebMCP Computer"]',
    { visible: true },
  );
  if (!spotlightInput) throw new Error("WebMCP Computer e2e Spotlight input not found");
  await spotlightInput.type("aurora");
  await page.waitForFunction(
    () => document.querySelector<HTMLInputElement>('.spotlight__search input')?.value === "aurora",
  );
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".spotlight__results")?.textContent ?? "";
      return text.includes("brief.md") || text.includes("webmcp-computer:");
    },
  );
  const spotlightText = await page.$eval(
    ".spotlight__results",
    (element) => element.textContent ?? "",
  );
  expect(spotlightText).toContain("brief.md");
  expect(spotlightText).toContain("~/desktop/brief.md · editor_open_file");
  await page.keyboard.press("Escape");

  const terminalManual = await executeWebMcpTool<string>(page, "os_manual", { topic: "terminal" });
  expect(terminalManual).toStartWith("# Terminal & shell\n");
  expect(terminalManual).toContain("term_state");

  const manPage = await executeWebMcpTool<ExecResult>(page, "term_exec", {
    command: "man fs_read",
  });
  expect(manPage.stdout).toStartWith("FS_READ(1) — WebMCP Computer syscalls\n");

  const settingsWindow = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "settings",
  });
  await waitForWindow(page, "Settings", settingsWindow.pid);
  const reusedSettings = await executeWebMcpTool<OpenResult>(page, "app_open", {
    appId: "settings",
  });
  expect(reusedSettings).toEqual(expect.objectContaining({ pid: settingsWindow.pid, reused: true }));
  expect(await page.$$(".window-shell--settings")).toHaveLength(1);

  const darkButton = await page.waitForSelector(
    ".window-shell--settings .settings-segmented button:last-child",
    { visible: true },
  );
  if (!darkButton) throw new Error("WebMCP Computer e2e dark theme button not found");
  await darkButton.hover();
  await page.waitForSelector('.verb-hint__tip.is-ready[data-placement]', { visible: true });
  const hintGeometry = await page.evaluate(() => {
    const anchor = document.querySelector(".window-shell--settings .settings-segmented button:last-child");
    const tip = document.querySelector(".verb-hint__tip.is-ready");
    if (!anchor || !tip) return null;
    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const panel = document.querySelector(".settings-panel");
    return {
      insideViewport: tipRect.left >= 0 && tipRect.top >= 0 &&
        tipRect.right <= window.innerWidth && tipRect.bottom <= window.innerHeight,
      clearsAnchor: tipRect.bottom <= anchorRect.top || tipRect.top >= anchorRect.bottom,
      panelHasHorizontalOverflow: panel ? panel.scrollWidth > panel.clientWidth : true,
    };
  });
  expect(hintGeometry).toEqual({
    insideViewport: true,
    clearsAnchor: true,
    panelHasHorizontalOverflow: false,
  });
  await darkButton.click();
  await page.waitForSelector(".verb-hint__tip", { hidden: true });

  await page.click('button[aria-label="Open Notes"]');
  await page.click('button[aria-label="Open Notes"]');
  expect(await page.$$(".window-shell--notes")).toHaveLength(1);
  const windowChrome = await page.$eval(".window-shell--settings", (shell) => {
    const inert = [...shell.querySelectorAll<HTMLElement>(".window-control--inert")];
    const surface = shell.querySelector<HTMLElement>(".window-surface");
    return {
      inertCount: inert.length,
      inertOpacity: inert.map((dot) => getComputedStyle(dot).opacity),
      idleOpacity: getComputedStyle(shell).opacity,
      borderColor: surface ? getComputedStyle(surface).borderColor : "",
    };
  });
  // NEK-853 made Minimize functional; only the zoom dot stays inert.
  expect(windowChrome.inertCount).toBe(1);
  expect(windowChrome.inertOpacity).toEqual(["0.48"]);
  expect(Number(windowChrome.idleOpacity)).toBeGreaterThanOrEqual(0.95);
  expect(windowChrome.borderColor).not.toContain("0)");
  const preview = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "preview" });
  const reusedPreview = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "preview" });
  expect(reusedPreview).toEqual(expect.objectContaining({ pid: preview.pid, reused: true }));
  expect(await page.$$(".window-shell--preview")).toHaveLength(1);

  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".settings-tabs button")]
      .find((candidate) => candidate.textContent === "Tool Monitor");
    button?.click();
  });
  await waitForText(page, ".tool-monitor", "system");

  const editor = await executeWebMcpTool<{ pid: number }>(page, "app_open", { appId: "editor" });
  await waitForWebMcpTools(page, [...BOOT_TOOL_NAMES, "editor_open_file"]);
  await page.waitForSelector(`.tool-monitor__group[data-tool-owner="editor"]`, { visible: true });
  await waitForText(page, ".tool-monitor", "+1 JUST REGISTERED");
  const monitoredEditorTools = await page.$eval(
    `.tool-monitor__group[data-tool-owner="editor"] .tool-monitor__tools`,
    (element) => (element.textContent ?? "").split(" · ").filter(Boolean),
  );
  const realEditorTools = page.webmcp.tools()
    .map(({ name }) => name)
    .filter((name) => name === "editor_open_file");
  expect(monitoredEditorTools).toEqual(realEditorTools);
  const editorPath = `.window-shell--editor input[aria-label="File path"]`;
  await page.click(editorPath);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.type(editorPath, "~/missing-editor-file.md");
  await page.click(".window-shell--editor .editor-open button[type=submit]");
  await waitForText(page, ".window-shell--editor .app-status", "ERROR");
  expect(await page.$eval(".window-shell--editor .app-status", (status) => ({
    overflowY: getComputedStyle(status).overflowY,
    whiteSpace: getComputedStyle(status).whiteSpace,
  }))).toEqual({ overflowY: "auto", whiteSpace: "normal" });
  expect(await page.$eval(
    ".window-shell--editor button.app-button--primary",
    (button) => (button as HTMLButtonElement).disabled,
  )).toBe(true);
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  const fileSearch = await page.waitForSelector(
    '.spotlight__search input[aria-label="Search WebMCP Computer"]',
    { visible: true },
  );
  if (!fileSearch) throw new Error("WebMCP Computer e2e file search input not found");
  await fileSearch.type("brief.md");
  await waitForText(page, ".spotlight__results", "brief.md");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (pid) => {
      const editorWindows = document.querySelectorAll(".window-shell--editor");
      const path = document.querySelector<HTMLInputElement>(
        `.window-shell--editor[style*="z-index"] input[aria-label="File path"]`,
      );
      const windowLabel = document.querySelector(
        `.window-shell--editor [aria-label="Editor window, PID ${pid}"]`,
      );
      return editorWindows.length === 1 && windowLabel !== null && path?.value === "~/desktop/brief.md";
    },
    {},
    editor.pid,
  );
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>(
      ".window-shell--editor button.app-button--primary",
    )?.disabled,
  );
  await executeWebMcpTool(page, "app_close", { pid: editor.pid });
  await waitForWebMcpToolGone(page, "editor_open_file");
  await page.waitForFunction(
    () => document.querySelector('.tool-monitor__group[data-tool-owner="editor"]') === null,
  );
}
