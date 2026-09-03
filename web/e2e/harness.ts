import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, preview, type PreviewServer } from "vite";
import {
  launch,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type WebMCPToolCallResult,
} from "puppeteer-core";
import {
  serializeSession,
  SESSION_STORAGE_KEY,
  type SessionSnapshot,
} from "../src/kernel/sessionSnapshot";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SURFACE_REQUIREMENT =
  "Chrome 151+ with --enable-features=WebMCP; set WEBMCP_COMPUTER_CHROME to its executable";
const WAIT_TIMEOUT_MS = 10_000;
// Trade-off: duplicates arriving later can escape detection; longer waits can flag calls still in flight.
const INVOCATION_LEDGER_SETTLE_MS = 75;

type HarnessFixture = {
  baseUrl: string;
  browser: Browser;
  previewServer: PreviewServer;
  userDataDir: string;
};

export type WebMCPComputerPage = {
  context: BrowserContext;
  cdpSession: CDPSession;
  invocationLedger: Map<string, InvocationLedgerEntry>;
  page: Page;
};

type ToolInvokedEvent = {
  invocationId: string;
  toolName: string;
};

type ToolRespondedEvent = {
  invocationId: string;
  status: string;
  output?: unknown;
  errorText?: string;
  exception?: unknown;
};

type InvocationLedgerEntry = {
  invocations: ToolInvokedEvent[];
  responses: ToolRespondedEvent[];
};

let fixture: HarnessFixture | undefined;
const pagesWithToolCalls = new WeakSet<Page>();

function surfaceError(chromePath: string, detail: unknown): Error {
  const message = detail instanceof Error ? detail.message : String(detail);
  return new Error(
    `WebMCP Computer e2e WebMCP surface missing. Required: ${SURFACE_REQUIREMENT}. ` +
      `WEBMCP_COMPUTER_CHROME resolved to ${chromePath}. ${message}`,
  );
}

async function closePreview(server: PreviewServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startHarness(): Promise<void> {
  if (fixture) return;

  const chromePath = process.env.WEBMCP_COMPUTER_CHROME ?? DEFAULT_CHROME;
  const userDataDir = await mkdtemp(join(tmpdir(), "webmcp-computer-e2e-"));
  let previewServer: PreviewServer | undefined;
  let browser: Browser | undefined;

  try {
    // A developer may enable PostHog in gitignored web/.env for staging builds. Keep
    // deterministic local E2E runs out of that real analytics project.
    const postHogKey = process.env.VITE_POSTHOG_KEY;
    const postHogHost = process.env.VITE_POSTHOG_HOST;
    process.env.VITE_POSTHOG_KEY = "";
    process.env.VITE_POSTHOG_HOST = "";
    try {
      await build({ logLevel: "silent" });
    } finally {
      if (postHogKey === undefined) delete process.env.VITE_POSTHOG_KEY;
      else process.env.VITE_POSTHOG_KEY = postHogKey;
      if (postHogHost === undefined) delete process.env.VITE_POSTHOG_HOST;
      else process.env.VITE_POSTHOG_HOST = postHogHost;
    }
    previewServer = await preview({
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    const address = previewServer.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("WebMCP Computer e2e could not resolve vite preview port");
    }

    try {
      browser = await launch({
        executablePath: chromePath,
        headless: true,
        userDataDir,
        args: ["--enable-features=WebMCP"],
      });
    } catch (error) {
      throw surfaceError(chromePath, error);
    }

    fixture = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      browser,
      previewServer,
      userDataDir,
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    if (previewServer) await closePreview(previewServer).catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export async function stopHarness(): Promise<void> {
  const current = fixture;
  fixture = undefined;
  if (!current) return;

  await current.browser.close();
  await closePreview(current.previewServer);
  await rm(current.userDataDir, { recursive: true, force: true });
}

type OpenWebMCPComputerPageOptions = {
  activeHostedSession?: boolean;
  browserWorkerUrl?: string;
  computerWorkerUrl?: string;
  forceFileSystemBootFailure?: boolean;
  pauseFileSystemBoot?: boolean;
  sessionSnapshot?: SessionSnapshot;
};

export async function seedSessionOnNextDocument(
  page: Page,
  snapshot: SessionSnapshot,
): Promise<void> {
  await page.evaluateOnNewDocument((key, serialized) => {
    window.localStorage.setItem(key, serialized);
  }, SESSION_STORAGE_KEY, serializeSession(snapshot));
}

export async function rejectPausedFileSystemBoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const init = (
      globalThis as typeof globalThis & {
        __WEBMCP_COMPUTER_INIT__?: { rejectFileSystemBoot?: () => void };
      }
    ).__WEBMCP_COMPUTER_INIT__;
    if (!init?.rejectFileSystemBoot) {
      throw new Error("WebMCP Computer e2e filesystem boot is not paused");
    }
    init.rejectFileSystemBoot();
  });
}

export async function openWebMCPComputerPage(options: OpenWebMCPComputerPageOptions = {}): Promise<WebMCPComputerPage> {
  if (!fixture) throw new Error("WebMCP Computer e2e harness has not started");
  if (options.forceFileSystemBootFailure && options.pauseFileSystemBoot) {
    throw new Error("WebMCP Computer e2e filesystem boot cannot be forced and paused together");
  }
  const chromePath = process.env.WEBMCP_COMPUTER_CHROME ?? DEFAULT_CHROME;
  const context = await fixture.browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const session = await page.createCDPSession();
  const invocationLedger = new Map<string, InvocationLedgerEntry>();
  const ledgerEntry = (invocationId: string) => {
    const existing = invocationLedger.get(invocationId);
    if (existing) return existing;
    const created: InvocationLedgerEntry = { invocations: [], responses: [] };
    invocationLedger.set(invocationId, created);
    return created;
  };
  session.on("WebMCP.toolInvoked", (event: ToolInvokedEvent) => {
    const entry = ledgerEntry(event.invocationId);
    entry.invocations.push(event);
  });
  session.on("WebMCP.toolResponded", (event: ToolRespondedEvent) => {
    ledgerEntry(event.invocationId).responses.push(event);
  });

  try {
    try {
      await session.send("WebMCP.enable");
    } catch (error) {
      throw surfaceError(chromePath, error);
    }

    if (options.sessionSnapshot) await seedSessionOnNextDocument(page, options.sessionSnapshot);

    {
      const sessionPayload = JSON.stringify({
        active: true,
        machineId: "0123456789abcdef0123456789abcdef",
        workspaceId: "0123456789abcdef0123456789abcdef",
        capability: "e2e-hosted-capability-token",
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        browserWorkerUrl: options.browserWorkerUrl ?? fixture.baseUrl,
        computerWorkerUrl: options.computerWorkerUrl ?? fixture.baseUrl,
      });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === fixture?.baseUrl && url.pathname === "/api/session") {
          void request.respond(options.activeHostedSession
            ? { status: 200, contentType: "application/json", body: sessionPayload }
            : { status: 503, contentType: "application/json", body: '{"error":"disabled for test"}' });
          return;
        }
        void request.continue();
      });
    }

    if (options.forceFileSystemBootFailure) {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(globalThis, "__WEBMCP_COMPUTER_INIT__", {
          configurable: true,
          value: {
            bootFileSystem: async () => {
              throw new Error("forced e2e filesystem boot failure");
            },
          },
        });
      });
    } else if (options.pauseFileSystemBoot) {
      await page.evaluateOnNewDocument(() => {
        let rejectBoot: ((error: Error) => void) | undefined;
        Object.defineProperty(globalThis, "__WEBMCP_COMPUTER_INIT__", {
          configurable: true,
          value: {
            bootFileSystem: () => new Promise<never>((_resolve, reject) => {
              rejectBoot = reject;
            }),
            rejectFileSystemBoot: () => {
              rejectBoot?.(new Error("forced e2e delayed filesystem boot failure"));
            },
          },
        });
      });
    }

    const pageUrl = new URL(fixture.baseUrl);
    if (options.browserWorkerUrl !== undefined) {
      pageUrl.searchParams.set("browser_worker", options.browserWorkerUrl);
    }
    if (options.computerWorkerUrl !== undefined) {
      pageUrl.searchParams.set("computer_worker", options.computerWorkerUrl);
    }
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".desktop", { visible: true, timeout: WAIT_TIMEOUT_MS });
    const hasSurface = await page.evaluate(
      () => (document as Document & { modelContext?: unknown }).modelContext !== undefined,
    );
    if (!hasSurface) throw surfaceError(chromePath, "document.modelContext is undefined");
    return { context, cdpSession: session, invocationLedger, page };
  } catch (error) {
    await session.detach().catch(() => undefined);
    await context.close();
    throw error;
  }
}

export async function closeWebMCPComputerPage(testPage: WebMCPComputerPage): Promise<void> {
  let ledgerError: Error | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, INVOCATION_LEDGER_SETTLE_MS));
    const failures: string[] = [];
    if (pagesWithToolCalls.has(testPage.page) && testPage.invocationLedger.size === 0) {
      failures.push("tool calls executed but the invocation ledger is empty");
    }
    for (const [invocationId, entry] of testPage.invocationLedger) {
      const toolName = entry.invocations[0]?.toolName ?? "unknown";
      if (entry.invocations.length !== 1 || entry.responses.length !== 1) {
        failures.push(
          `${toolName} ${invocationId}: ` +
            `${entry.invocations.length} invocation event(s), ${entry.responses.length} response(s)`,
        );
      }
      for (const response of entry.responses) {
        if (JSON.stringify(response).toLowerCase().includes("cross-origin navigation")) {
          failures.push(
            `${toolName} ${invocationId}: cross-origin navigation error`,
          );
        }
      }
    }
    if (failures.length > 0) {
      ledgerError = new Error(`WebMCP Computer e2e WebMCP exactly-once ledger failed:\n${failures.join("\n")}`);
    }
  } finally {
    await testPage.cdpSession.detach().catch(() => undefined);
    await testPage.context.close();
  }
  if (ledgerError) throw ledgerError;
}

export async function waitForWebMcpTools(
  page: Page,
  requiredNames: readonly string[],
): Promise<void> {
  const ready = () => {
    const names = new Set(page.webmcp.tools().map(({ name }) => name));
    return requiredNames.every((name) => names.has(name));
  };
  if (ready()) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.webmcp.off("toolsadded", onToolsAdded);
      reject(
        new Error(
          `Timed out waiting for WebMCP tools. Registered: ${page.webmcp
            .tools()
            .map(({ name }) => name)
            .join(", ")}`,
        ),
      );
    }, WAIT_TIMEOUT_MS);
    const onToolsAdded = () => {
      if (!ready()) return;
      clearTimeout(timeout);
      page.webmcp.off("toolsadded", onToolsAdded);
      resolve();
    };
    page.webmcp.on("toolsadded", onToolsAdded);
    onToolsAdded();
  });
}

export async function waitForWebMcpToolGone(page: Page, name: string): Promise<void> {
  const gone = () => page.webmcp.tools().every((tool) => tool.name !== name);
  if (gone()) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.webmcp.off("toolsremoved", onToolsRemoved);
      reject(new Error(`Timed out waiting for WebMCP tool to unregister: ${name}`));
    }, WAIT_TIMEOUT_MS);
    const onToolsRemoved = () => {
      if (!gone()) return;
      clearTimeout(timeout);
      page.webmcp.off("toolsremoved", onToolsRemoved);
      resolve();
    };
    page.webmcp.on("toolsremoved", onToolsRemoved);
    onToolsRemoved();
  });
}

export function listWebMcpToolNames(page: Page): string[] {
  return page.webmcp.tools().map(({ name }) => name);
}

export async function executeWebMcpToolRaw(
  page: Page,
  name: string,
  input: Record<string, unknown> = {},
  signal: AbortSignal = AbortSignal.timeout(WAIT_TIMEOUT_MS),
): Promise<WebMCPToolCallResult> {
  const tool = page.webmcp.tools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`WebMCP Computer e2e WebMCP tool not registered: ${name}`);
  pagesWithToolCalls.add(page);
  return await tool.execute(input, { signal });
}

function parseToolOutput(output: unknown): unknown {
  if (output === null || typeof output !== "object") return output;
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(content)) return output;
  const text = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  )?.text;
  if (text === undefined) return output;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function executeWebMcpTool(
  page: Page,
  name: string,
  input?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function executeWebMcpTool<T>(
  page: Page,
  name: string,
  input?: Record<string, unknown>,
): Promise<T>;
export async function executeWebMcpTool(
  page: Page,
  name: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await executeWebMcpToolRaw(page, name, input);
  if (result.status !== "Completed") {
    throw new Error(
      `WebMCP ${name} failed with ${result.status}: ${webMcpErrorText(result)}`,
    );
  }
  return parseToolOutput(result.output);
}

export function webMcpErrorText(result: WebMCPToolCallResult): string {
  if (typeof result.errorText === "string" && result.errorText.length > 0) {
    return result.errorText;
  }
  const exception = result.exception;
  const exceptionText =
    typeof exception?.description === "string"
      ? exception.description
      : typeof exception?.value === "string"
        ? exception.value
        : undefined;
  if (exceptionText) return exceptionText.split("\n", 1)[0] ?? exceptionText;
  return JSON.stringify(result);
}

export async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction(
    (target, text) => document.querySelector(target)?.textContent?.includes(text) === true,
    { timeout: WAIT_TIMEOUT_MS },
    selector,
    expected,
  );
}

export async function waitForFileSystemReady(page: Page): Promise<void> {
  await page.waitForSelector('.menu-bar[data-fs-status="ready"]', {
    timeout: WAIT_TIMEOUT_MS,
  });
}

export async function waitForValue(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction(
    (target, value) => {
      const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(target);
      return element?.value === value;
    },
    { timeout: WAIT_TIMEOUT_MS },
    selector,
    expected,
  );
}

export async function textContent(page: Page, selector: string): Promise<string> {
  return await page.$eval(selector, (element) => element.textContent ?? "");
}

export async function inputValue(page: Page, selector: string): Promise<string> {
  return await page.$eval(
    selector,
    (element) => (element as HTMLInputElement | HTMLTextAreaElement).value,
  );
}

export async function waitForWindow(page: Page, appName: string, pid: number): Promise<void> {
  await page.waitForSelector(`[aria-label="${appName} window, PID ${pid}"]`, {
    visible: true,
    timeout: WAIT_TIMEOUT_MS,
  });
}

export async function waitForWindowGone(page: Page, appName: string, pid: number): Promise<void> {
  await page.waitForFunction(
    (label) => document.querySelector(`[aria-label="${label}"]`) === null,
    { timeout: WAIT_TIMEOUT_MS },
    `${appName} window, PID ${pid}`,
  );
}

export async function windowGeometry(
  page: Page,
  appName: string,
  pid: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return await page.$eval(
    `[aria-label="${appName} window, PID ${pid}"]`,
    (surface) => {
      const shell = surface.closest(".window-shell");
      const workarea = surface.closest(".desktop__workarea");
      if (!shell || !workarea) throw new Error("WebMCP Computer e2e could not resolve window geometry");
      const shellRect = shell.getBoundingClientRect();
      const workareaRect = workarea.getBoundingClientRect();
      return {
        x: Math.round(shellRect.left - workareaRect.left),
        y: Math.round(shellRect.top - workareaRect.top),
        width: Math.round(shellRect.width),
        height: Math.round(shellRect.height),
      };
    },
  );
}

export async function openFilesDirectory(page: Page, name: string): Promise<void> {
  const rows = await page.$$(".file-row");
  for (const row of rows) {
    const rowName = await row.$eval(".file-row__name", (element) => element.textContent);
    if (rowName !== name) continue;
    const button = await row.$(".file-row__open");
    if (!button) break;
    await button.click({ count: 2 });
    return;
  }
  throw new Error(`WebMCP Computer e2e file row not found: ${name}`);
}

export async function typeInEditor(
  page: Page,
  selector: string,
  text: string,
  delay?: number,
): Promise<void> {
  const editor = await page.waitForSelector(selector, {
    visible: true,
    timeout: WAIT_TIMEOUT_MS,
  });
  if (!editor) throw new Error(`WebMCP Computer e2e editor not found: ${selector}`);
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text, delay === undefined ? undefined : { delay });
}

export async function typeInTerminal(page: Page, pid: number, command: string): Promise<void> {
  const selector = `.terminal-app[data-terminal-pid="${pid}"] .xterm-helper-textarea`;
  const input = await page.waitForSelector(selector, { timeout: WAIT_TIMEOUT_MS });
  if (!input) throw new Error(`WebMCP Computer e2e terminal input not found for PID ${pid}`);
  await input.focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (terminalPid, expectedCommand) => {
      const terminal = document.querySelector<HTMLElement>(
        `.terminal-app[data-terminal-pid="${terminalPid}"]`,
      );
      return terminal?.dataset.terminalLastCommand === expectedCommand &&
        terminal.dataset.terminalBusy === "false";
    },
    { timeout: WAIT_TIMEOUT_MS },
    String(pid),
    command,
  );
}

export async function reloadWebMCPComputer(page: Page, requiredTools: readonly string[]): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".desktop", { visible: true, timeout: WAIT_TIMEOUT_MS });
  await waitForWebMcpTools(page, requiredTools);
  await waitForFileSystemReady(page);
}
