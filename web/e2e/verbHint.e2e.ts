import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import {
  executeWebMcpTool,
  waitForFileSystemReady,
  waitForText,
  waitForWindow,
  waitForWindowGone,
} from "./harness";

type OpenResult = { pid: number };

type SettingsResult = { verb_hints: boolean };

async function pointerEnter(page: Page, selector: string): Promise<void> {
  await page.$eval(selector, (element) => {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  });
}

export async function verbHintScenario(page: Page): Promise<void> {
  await waitForFileSystemReady(page);
  const terminal = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "terminal" });
  const settings = await executeWebMcpTool<OpenResult>(page, "app_open", { appId: "settings" });
  await waitForWindow(page, "Terminal", terminal.pid);
  await waitForWindow(page, "Settings", settings.pid);

  const terminalHost = `.terminal-app[data-terminal-pid="${terminal.pid}"] .terminal-host`;
  const hintSwitch = '.window-shell--settings button[aria-label="Verb hints"]';
  await page.waitForSelector(`${terminalHost} .xterm`);
  await page.evaluate((hostSelector, switchSelector) => {
    const host = document.querySelector<HTMLElement>(hostSelector);
    const control = document.querySelector<HTMLElement>(switchSelector);
    if (!host || !control) throw new Error("VerbHint identity targets unavailable");
    host.dataset.verbHintIdentity = "terminal-host";
    control.dataset.verbHintIdentity = "settings-switch";
  }, terminalHost, hintSwitch);

  expect(await executeWebMcpTool<SettingsResult>(page, "settings_set", {
    key: "verb_hints",
    value: false,
  })).toEqual(expect.objectContaining({ verb_hints: false }));
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("aria-checked") === "false",
    {},
    hintSwitch,
  );

  expect(await page.evaluate((hostSelector, switchSelector) => {
    const host = document.querySelector<HTMLElement>(hostSelector);
    const control = document.querySelector<HTMLElement>(switchSelector);
    return {
      hostIdentity: host?.dataset.verbHintIdentity,
      hostWrapped: host?.parentElement?.classList.contains("verb-hint"),
      switchIdentity: control?.dataset.verbHintIdentity,
      switchWrapped: control?.parentElement?.classList.contains("verb-hint"),
      xtermAttached: host?.querySelector(".xterm") !== null,
    };
  }, terminalHost, hintSwitch)).toEqual({
    hostIdentity: "terminal-host",
    hostWrapped: true,
    switchIdentity: "settings-switch",
    switchWrapped: true,
    xtermAttached: true,
  });

  const command = "echo verb-hint-toggle-alive";
  await executeWebMcpTool(page, "term_exec", { command, term_pid: terminal.pid });
  await waitForText(page, `${terminalHost} .xterm-rows`, "verb-hint-toggle-alive");

  expect(await executeWebMcpTool<SettingsResult>(page, "settings_set", {
    key: "verb_hints",
    value: true,
  })).toEqual(expect.objectContaining({ verb_hints: true }));
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("aria-checked") === "true",
    {},
    hintSwitch,
  );
  expect(await page.evaluate((hostSelector, switchSelector) => ({
    hostIdentity: document.querySelector<HTMLElement>(hostSelector)?.dataset.verbHintIdentity,
    switchIdentity: document.querySelector<HTMLElement>(switchSelector)?.dataset.verbHintIdentity,
  }), terminalHost, hintSwitch)).toEqual({
    hostIdentity: "terminal-host",
    switchIdentity: "settings-switch",
  });

  await executeWebMcpTool(page, "window_focus", { pid: settings.pid });
  await page.hover(hintSwitch);
  await waitForText(page, ".verb-hint__tip", "verb_hints: false · settings_set");

  const appearanceTab = ".window-shell--settings .settings-tabs .verb-hint:nth-child(1) button";
  const toolsTab = ".window-shell--settings .settings-tabs .verb-hint:nth-child(2) button";
  await pointerEnter(page, appearanceTab);
  await waitForText(page, ".verb-hint__tip", "appearance · settings_get");
  await pointerEnter(page, toolsTab);
  await waitForText(page, ".verb-hint__tip", "tools · settings_get");
  expect(await page.$$(".verb-hint__tip")).toHaveLength(1);

  await pointerEnter(page, terminalHost);
  await waitForText(page, ".verb-hint__tip", `PID ${terminal.pid} · term_exec`);
  await executeWebMcpTool(page, "app_close", { pid: terminal.pid });
  await waitForWindowGone(page, "Terminal", terminal.pid);
  await page.waitForFunction(() => document.querySelector(".verb-hint__tip") === null);
}
