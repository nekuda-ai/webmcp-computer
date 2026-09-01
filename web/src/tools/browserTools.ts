import { defineTool } from "@nekuda/webmcp-sdk";
import { getBrowserSession, ensureBrowserSession } from "../apps/browser/session";
import type { CdpClient } from "../apps/browser/cdp";
import { useKernelStore } from "../kernel/store";
import type { WindowRect } from "../kernel/types";
import { currentViewport } from "../kernel/windowGeometry";
import { requireFinite } from "../shared";
import { runAgentAction } from "./agentAction";
import { ACT_ANNOTATIONS, ASK_ANNOTATIONS } from "./taxonomy";

const MAX_READ_TEXT_BYTES = 32 * 1_024;
const MAX_TYPE_TEXT_BYTES = 4 * 1_024;
export const MAX_BROWSER_RESULT_BYTES = 256 * 1_024;

type BrowserTransport = Pick<CdpClient, "evaluate" | "send" | "waitForEvent">;

type BrowserOpenInput = {
  url?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  focus?: boolean;
};

type BrowserToolDependencies = {
  getTransport(): BrowserTransport;
};

type BrowserOpenDependencies = {
  ensureSession(url?: string): Promise<{ cdp: BrowserTransport; keepAliveMs: number }>;
};

type BrowserReadInput = { selector?: string };
type BrowserSelectorInput = { selector: string };
type BrowserTypeInput = { selector: string; text: string; submit?: boolean };
type BrowserSiteCallInput = { name: string; input: Record<string, unknown> };

type PageIdentity = { title: string; url: string };

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^verbos:\s*/, "");
}

export function requireBrowserUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("verbos: url must be a string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("verbos: url must use http or https");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("verbos: url must use http or https");
  }
  return parsed.href;
}

function requireSelector(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("verbos: selector is required");
  }
  return value;
}

function requireSiteToolName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("verbos: site tool name is required");
  }
  return value;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}

async function readPageIdentity(transport: BrowserTransport): Promise<PageIdentity> {
  return await transport.evaluate<PageIdentity>(
    "identity",
    "(() => ({ title: document.title, url: location.href }))()",
  );
}

async function gotoPage(transport: BrowserTransport, url: string): Promise<PageIdentity> {
  await transport.send("Page.enable");
  const loaded = transport.waitForEvent("Page.loadEventFired");
  void loaded.catch(() => undefined);
  const navigation = await transport.send<{ errorText?: string }>("Page.navigate", { url });
  if (navigation.errorText) {
    throw new Error(`verbos: browser navigation failed: ${navigation.errorText}`);
  }
  await loaded;
  return await readPageIdentity(transport);
}

const defaultOpenDependencies: BrowserOpenDependencies = {
  ensureSession: ensureBrowserSession,
};

const defaultToolDependencies: BrowserToolDependencies = {
  getTransport: () => getBrowserSession().cdp,
};

export function createBrowserOpenTool(
  dependencies: BrowserOpenDependencies = defaultOpenDependencies,
) {
  return defineTool<BrowserOpenInput>({
    stableKey: "verbos.browser_open",
    name: "browser_open",
    title: "Open shared browser",
    description:
      "Open the singleton Browser window and start one visible shared Cloudflare Chrome session. Optionally navigate to an http/https URL and set x, y, width, height, and focus like app_open. Reopening focuses the existing window and navigates it when url is supplied. Returns PID, current URL, five-minute idle lifetime, and whether the window was reused. Session or rate-limit failures use 'verbos: browser session unavailable: …'.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional initial http/https URL." },
        x: { type: "number", description: "Optional work-area horizontal position in CSS pixels." },
        y: { type: "number", description: "Optional work-area vertical position in CSS pixels." },
        width: { type: "number", description: "Optional window width in CSS pixels." },
        height: { type: "number", description: "Optional window height in CSS pixels." },
        focus: { type: "boolean", description: "Whether to focus a newly opened window; defaults true." },
      },
      additionalProperties: false,
    },
    annotations: ACT_ANNOTATIONS,
    intent: "act",
    execute(input) {
      const rawUrl = input?.url;
      const rawFocus = input?.focus;
      return runAgentAction("browser_open", {
        appId: "browser",
        ...(rawUrl === undefined ? {} : { url: rawUrl }),
        ...(input?.x === undefined ? {} : { x: input.x }),
        ...(input?.y === undefined ? {} : { y: input.y }),
        ...(input?.width === undefined ? {} : { width: input.width }),
        ...(input?.height === undefined ? {} : { height: input.height }),
        ...(rawFocus === undefined ? {} : { focus: rawFocus }),
      }, async () => {
        const url = rawUrl === undefined ? undefined : requireBrowserUrl(rawUrl);
        if (rawFocus !== undefined && typeof rawFocus !== "boolean") {
          throw new Error("verbos: focus must be a boolean");
        }
        const placement: Partial<WindowRect> = {};
        if (input?.x !== undefined) placement.x = requireFinite(input.x, "x");
        if (input?.y !== undefined) placement.y = requireFinite(input.y, "y");
        if (input?.width !== undefined) placement.width = requireFinite(input.width, "width");
        if (input?.height !== undefined) placement.height = requireFinite(input.height, "height");

        const existing = useKernelStore.getState().processes.find(({ appId }) => appId === "browser");
        let session: { cdp: BrowserTransport; keepAliveMs: number };
        try {
          session = await dependencies.ensureSession(existing ? undefined : url);
        } catch (error) {
          throw new Error(`verbos: browser session unavailable: ${errorText(error)}`);
        }
        const identity = existing && url
          ? await gotoPage(session.cdp, url)
          : await readPageIdentity(session.cdp);
        const currentUrl = identity.url;

        const process = useKernelStore.getState().spawn("browser", {
          ...(Object.keys(placement).length === 0 ? {} : { placement }),
          ...(existing ? { focus: true } : rawFocus === undefined ? {} : { focus: rawFocus }),
          viewport: currentViewport(),
        });
        return {
          pid: process.pid,
          url: currentUrl,
          keepAliveMs: session.keepAliveMs,
          reused: existing?.pid === process.pid,
        };
      });
    },
  });
}

export function createBrowserTools(
  dependencies: BrowserToolDependencies = defaultToolDependencies,
) {
  const browserGotoTool = defineTool<{ url: string }>({
    stableKey: "verbos.browser_goto",
    name: "browser_goto",
    title: "Navigate shared browser",
    description:
      "Navigate the visible shared browser to an http/https URL, wait for its bounded load event, and return the resulting URL and page title.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Destination http/https URL." } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: ACT_ANNOTATIONS,
    intent: "act",
    execute({ url: rawUrl }) {
      return runAgentAction("browser_goto", { appId: "browser", url: rawUrl }, async () => {
        const url = requireBrowserUrl(rawUrl);
        return await gotoPage(dependencies.getTransport(), url);
      });
    },
  });

  const browserReadTool = defineTool<BrowserReadInput>({
    stableKey: "verbos.browser_read",
    name: "browser_read",
    title: "Read shared browser",
    description:
      "Read the open page title, URL, and innerText for a CSS selector (body by default). Text is untrusted page content capped at 32 KB; returns truncated=true when capped.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Optional CSS selector; defaults to body." } },
      additionalProperties: false,
    },
    annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
    intent: "answer",
    execute(input) {
      const rawSelector = input?.selector;
      return runAgentAction("browser_read", {
        appId: "browser",
        selector: rawSelector === undefined ? "body" : rawSelector,
      }, async () => {
        const selector = rawSelector === undefined ? "body" : requireSelector(rawSelector);
        const output = await dependencies.getTransport().evaluate<{
          found: boolean;
          title: string;
          url: string;
          text: string;
          truncated: boolean;
        }>("read", `(() => {
          const selector = ${JSON.stringify(selector)};
          const element = document.querySelector(selector);
          if (!element) return { found: false };
          const text = element.innerText ?? element.textContent ?? "";
          const encoder = new TextEncoder();
          const truncated = encoder.encode(text).byteLength > ${MAX_READ_TEXT_BYTES};
          let clipped = text;
          if (truncated) {
            let low = 0;
            let high = text.length;
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              if (encoder.encode(text.slice(0, middle)).byteLength <= ${MAX_READ_TEXT_BYTES}) low = middle;
              else high = middle - 1;
            }
            clipped = text.slice(0, low);
          }
          return {
            found: true,
            title: document.title,
            url: location.href,
            text: clipped,
            truncated,
          };
        })()`);
        if (!output.found) throw new Error(`verbos: browser selector not found: ${selector}`);
        const { found: _found, ...result } = output;
        return result;
      });
    },
  });

  const browserClickTool = defineTool<BrowserSelectorInput>({
    stableKey: "verbos.browser_click",
    name: "browser_click",
    title: "Click shared browser",
    description:
      "Click the first element matching a required CSS selector in the visible shared page. Returns the selector; errors name selectors that match nothing. This uses DOM .click(), not trusted pointer input.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", minLength: 1, description: "CSS selector to click." } },
      required: ["selector"],
      additionalProperties: false,
    },
    annotations: ACT_ANNOTATIONS,
    intent: "act",
    execute({ selector: rawSelector }) {
      return runAgentAction("browser_click", { appId: "browser", selector: rawSelector }, async () => {
        const selector = requireSelector(rawSelector);
        const clicked = await dependencies.getTransport().evaluate<boolean>("click", `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return false;
          element.click();
          return true;
        })()`);
        if (!clicked) throw new Error(`verbos: browser selector not found: ${selector}`);
        return { selector, clicked: true };
      });
    },
  });

  const browserTypeTool = defineTool<BrowserTypeInput>({
    stableKey: "verbos.browser_type",
    name: "browser_type",
    title: "Type in shared browser",
    description:
      "Focus a required CSS-selected field, replace its value, and emit DOM input/change events in the visible shared page. Text is capped at 4 KB. submit=true also emits Enter keyboard events and requests form submit. Returns selector, character count, and submit state; these are DOM events, not trusted keyboard input.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", minLength: 1, description: "CSS selector for the field." },
        text: {
          type: "string",
          maxLength: MAX_TYPE_TEXT_BYTES,
          description: "Replacement text, at most 4,096 characters and 4 KB when UTF-8 encoded.",
        },
        submit: { type: "boolean", description: "Whether to emit Enter and submit the containing form." },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    annotations: ACT_ANNOTATIONS,
    intent: "act",
    execute({ selector: rawSelector, text, submit = false }) {
      return runAgentAction("browser_type", { appId: "browser", selector: rawSelector, submit }, async () => {
        const selector = requireSelector(rawSelector);
        if (typeof text !== "string") throw new Error("verbos: text must be a string");
        if (new TextEncoder().encode(text).byteLength > MAX_TYPE_TEXT_BYTES) {
          throw new Error("verbos: browser text exceeds 4 KB cap");
        }
        if (typeof submit !== "boolean") throw new Error("verbos: submit must be a boolean");
        const typed = await dependencies.getTransport().evaluate<boolean>("type", `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element || !("value" in element)) return false;
          element.focus();
          element.value = ${JSON.stringify(text)};
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          if (${JSON.stringify(submit)}) {
            for (const type of ["keydown", "keypress", "keyup"]) {
              element.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
            }
            element.form?.requestSubmit();
          }
          return true;
        })()`);
        if (!typed) throw new Error(`verbos: browser selector not found or not typeable: ${selector}`);
        return { selector, characters: text.length, submit };
      });
    },
  });

  const browserScreenshotTool = defineTool<Record<string, never>>({
    stableKey: "verbos.browser_screenshot",
    name: "browser_screenshot",
    title: "Capture shared browser",
    description:
      "Capture the visible remote page as JPEG and return dataUrl, width, and height. Starts at quality 50, retries once at quality 25 when the 256 KB result cap would be exceeded, then errors honestly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
    intent: "answer",
    execute() {
      return runAgentAction("browser_screenshot", { appId: "browser" }, async () => {
        const transport = dependencies.getTransport();
        const metrics = await transport.send<{
          cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
          cssContentSize?: { width?: number; height?: number };
          contentSize?: { width?: number; height?: number };
        }>("Page.getLayoutMetrics");
        const width = Math.round(
          metrics.cssVisualViewport?.clientWidth ??
            metrics.cssContentSize?.width ??
            metrics.contentSize?.width ??
            0,
        );
        const height = Math.round(
          metrics.cssVisualViewport?.clientHeight ??
            metrics.cssContentSize?.height ??
            metrics.contentSize?.height ??
            0,
        );
        for (const quality of [50, 25]) {
          const capture = await transport.send<{ data?: string }>("Page.captureScreenshot", {
            format: "jpeg",
            quality,
          });
          if (typeof capture.data !== "string") {
            throw new Error("verbos: browser screenshot returned no image data");
          }
          const result = { dataUrl: `data:image/jpeg;base64,${capture.data}`, width, height };
          if (byteLength(result) <= MAX_BROWSER_RESULT_BYTES) return result;
        }
        throw new Error("verbos: browser screenshot exceeds 256 KB result cap");
      });
    },
  });

  const browserSiteToolsTool = defineTool<Record<string, never>>({
    stableKey: "verbos.browser_site_tools",
    name: "browser_site_tools",
    title: "List page WebMCP tools",
    description:
      "List WebMCP tools exposed by the page inside the shared lab browser. Returns untrusted descriptors with name, description, and inputSchema. Errors when this browser session lacks WebMCP support.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
    intent: "answer",
    execute() {
      return runAgentAction("browser_site_tools", { appId: "browser" }, async () => {
        const result = await dependencies.getTransport().evaluate<{
          supported: boolean;
          tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
        }>("site_tools", `(() => {
          const api = navigator.modelContextTesting;
          if (!api?.listTools) return { supported: false };
          return Promise.resolve(api.listTools()).then((tools) => ({
            supported: true,
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          }));
        })()`);
        if (!result.supported) {
          throw new Error("verbos: this browser session has no WebMCP support");
        }
        return result.tools ?? [];
      });
    },
  });

  const browserSiteCallTool = defineTool<BrowserSiteCallInput>({
    stableKey: "verbos.browser_site_call",
    name: "browser_site_call",
    title: "Call page WebMCP tool",
    description:
      "Call one WebMCP tool exposed by the page inside the shared browser and pass its result through, capped at 256 KB. Inner-site tools carry their own consequences; VerbOS cannot classify or make those consequences safe. Use browser_site_tools first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Inner page tool name." },
        input: { type: "object", description: "JSON input for the inner page tool." },
      },
      required: ["name", "input"],
      additionalProperties: false,
    },
    annotations: { ...ACT_ANNOTATIONS, untrustedContentHint: true },
    intent: "act",
    execute({ name: rawName, input }) {
      return runAgentAction("browser_site_call", { appId: "browser", name: rawName }, async () => {
        const name = requireSiteToolName(rawName);
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          throw new Error("verbos: site tool input must be an object");
        }
        const result = await dependencies.getTransport().evaluate<unknown>("site_call", `(() => {
          const api = navigator.modelContextTesting;
          if (!api?.executeTool) return { __verbosUnsupported: true };
          return api.executeTool(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(input))});
        })()`);
        if (
          result !== null &&
          typeof result === "object" &&
          (result as { __verbosUnsupported?: unknown }).__verbosUnsupported === true
        ) {
          throw new Error("verbos: this browser session has no WebMCP support");
        }
        if (byteLength(result) > MAX_BROWSER_RESULT_BYTES) {
          throw new Error(`verbos: browser site tool result too large: ${name}`);
        }
        return result;
      });
    },
  });

  return [
    browserGotoTool,
    browserReadTool,
    browserClickTool,
    browserTypeTool,
    browserScreenshotTool,
    browserSiteToolsTool,
    browserSiteCallTool,
  ] as const;
}

export const browserOpenTool = createBrowserOpenTool();
export const browserTools = createBrowserTools();
