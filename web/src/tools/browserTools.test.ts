import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AnyWebMCPTool,
  ModelContextLike,
  RegisterToolOptions,
  SpecTool,
} from "@nekuda/webmcp-sdk";
import type { CdpEvaluateOperation } from "../apps/browser/cdp";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { registerAppTools } from "./registry";
import { abortInFlightAgentActions } from "./agentAction";
import {
  browserTools,
  createBrowserOpenTool,
  createBrowserTools,
} from "./browserTools";

class FakeTransport {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly evaluateCalls: Array<{ operation: CdpEvaluateOperation; expression: string }> = [];
  captureData = ["small"];
  evaluateResult: unknown = { title: "Example", url: "https://example.com/" };

  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } as T;
    }
    if (method === "Page.captureScreenshot") {
      return { data: this.captureData.shift() ?? "" } as T;
    }
    return {} as T;
  }

  async evaluate<T>(operation: CdpEvaluateOperation, expression: string): Promise<T> {
    this.evaluateCalls.push({ operation, expression });
    return this.evaluateResult as T;
  }

  async waitForEvent(): Promise<unknown> {
    return {};
  }
}

class EvaluatingTransport extends FakeTransport {
  constructor(
    private readonly pageDocument: { modelContext?: unknown },
    private readonly pageNavigator: Record<string, unknown> = {},
  ) {
    super();
  }

  override async evaluate<T>(operation: CdpEvaluateOperation, expression: string): Promise<T> {
    this.evaluateCalls.push({ operation, expression });
    const evaluateInPage = new Function(
      "document",
      "navigator",
      `return (${expression});`,
    ) as (document: { modelContext?: unknown }, navigator: Record<string, unknown>) => T | Promise<T>;
    return await evaluateInPage(this.pageDocument, this.pageNavigator);
  }
}

function toolByName(tools: readonly AnyWebMCPTool[], name: string): AnyWebMCPTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`test: missing ${name}`);
  return tool;
}

beforeEach(resetKernelStore);

describe("browser tools", () => {
  test("validates URL, required selectors, and 4 KB text cap", async () => {
    const transport = new FakeTransport();
    const tools = createBrowserTools({ getTransport: () => transport });
    await expect(toolByName(tools, "browser_goto").execute({ url: "file:///tmp/x" }))
      .rejects.toThrow("webmcp-computer: url must use http or https");
    await expect(toolByName(tools, "browser_click").execute({ selector: "" }))
      .rejects.toThrow("webmcp-computer: selector is required");
    await expect(toolByName(tools, "browser_read").execute({ selector: "" }))
      .rejects.toThrow("webmcp-computer: selector is required");
    await expect(toolByName(tools, "browser_type").execute({
      selector: "input",
      text: "x".repeat(4 * 1_024 + 1),
    })).rejects.toThrow("webmcp-computer: browser text exceeds 4 KB cap");
    expect(transport.calls).toEqual([]);
    expect(transport.evaluateCalls).toEqual([]);
    expect(useKernelStore.getState().events.find(({ verb }) => verb === "browser_read")).toEqual(expect.objectContaining({
      source: "agent",
      verb: "browser_read",
      ok: false,
    }));
  });

  test("browser_open reuses and focuses singleton, navigating only on second URL", async () => {
    const transport = new FakeTransport();
    const ensured: Array<string | undefined> = [];
    const tool = createBrowserOpenTool({
      async ensureSession(url) {
        ensured.push(url);
        return { cdp: transport, keepAliveMs: 900_000 };
      },
    });

    const first = await tool.execute({ url: "https://first.test" }) as { pid: number; reused: boolean };
    const second = await tool.execute({ url: "https://second.test" }) as { pid: number; reused: boolean };
    expect(second.pid).toBe(first.pid);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(ensured).toEqual(["https://first.test/", undefined]);
    expect(transport.calls.map(({ method }) => method)).toEqual(["Page.enable", "Page.navigate"]);
    expect(transport.evaluateCalls.map(({ operation }) => operation)).toEqual([
      "identity",
      "identity",
    ]);
    expect(useKernelStore.getState().processes).toHaveLength(1);
    expect(useKernelStore.getState().processes[0]?.focused).toBe(true);
  });

  test("ownership loss aborts the signal passed to an in-flight browser command", async () => {
    let commandSignal: AbortSignal | undefined;
    const transport = {
      async send<T>(_method: string, _params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        commandSignal = signal;
        return await new Promise<T>(() => {});
      },
      async evaluate<T>(): Promise<T> {
        return await new Promise<T>(() => {});
      },
      async waitForEvent(): Promise<unknown> {
        return await new Promise(() => {});
      },
    };
    const tools = createBrowserTools({ getTransport: () => transport });
    const invocation = toolByName(tools, "browser_goto").execute({ url: "https://old-owner.test" });
    await Promise.resolve();

    abortInFlightAgentActions();
    await expect(invocation).rejects.toThrow("machine ownership was lost to another tab");
    expect(commandSignal?.aborted).toBe(true);
  });

  test("browser_open gives Worker failures the required unavailable error voice", async () => {
    const tool = createBrowserOpenTool({
      async ensureSession() {
        throw new Error("rate limited");
      },
    });
    await expect(tool.execute({})).rejects.toThrow(
      "webmcp-computer: browser session unavailable: rate limited",
    );
    expect(useKernelStore.getState().processes).toEqual([]);
  });

  test("screenshot retries at quality 25 when quality 50 exceeds result cap", async () => {
    const transport = new FakeTransport();
    transport.captureData = ["x".repeat(300_000), "small-image"];
    const tools = createBrowserTools({ getTransport: () => transport });
    const result = await toolByName(tools, "browser_screenshot").execute({}) as {
      dataUrl: string;
      width: number;
      height: number;
    };
    expect(result).toEqual({
      dataUrl: "data:image/jpeg;base64,small-image",
      width: 800,
      height: 600,
    });
    expect(
      transport.calls
        .filter(({ method }) => method === "Page.captureScreenshot")
        .map(({ params }) => params?.quality),
    ).toEqual([50, 25]);
  });

  test("site-tools reports missing lab WebMCP API honestly", async () => {
    const transport = new FakeTransport();
    transport.evaluateResult = { supported: false };
    const tools = createBrowserTools({ getTransport: () => transport });
    await expect(toolByName(tools, "browser_site_tools").execute({})).rejects.toThrow(
      "webmcp-computer: this browser session has no WebMCP support",
    );
  });

  test("site-tools uses document.modelContext and normalizes serialized schemas", async () => {
    const schema = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    };
    const transport = new EvaluatingTransport({
      modelContext: {
        async getTools() {
          return [{
            name: "site_echo",
            description: "Echo one message.",
            inputSchema: JSON.stringify(schema),
          }];
        },
      },
    });
    const tools = createBrowserTools({ getTransport: () => transport });

    await expect(toolByName(tools, "browser_site_tools").execute({})).resolves.toEqual([{
      name: "site_echo",
      description: "Echo one message.",
      inputSchema: schema,
    }]);
    expect(transport.evaluateCalls[0]?.expression).toContain("document.modelContext");
    expect(transport.evaluateCalls[0]?.expression).not.toContain("navigator.modelContextTesting");
  });

  test("site-call resolves the document tool descriptor and normalizes its serialized result", async () => {
    const descriptor = {
      name: "site_echo",
      description: "Echo one message.",
      inputSchema: JSON.stringify({ type: "object" }),
    };
    let invocation: { descriptorMatches: boolean; input: unknown } | undefined;
    const transport = new EvaluatingTransport({
      modelContext: {
        async getTools() {
          return [descriptor];
        },
        async executeTool(tool: unknown, input: unknown) {
          invocation = { descriptorMatches: tool === descriptor, input };
          return JSON.stringify({ echoed: "hello" });
        },
      },
    });
    const tools = createBrowserTools({ getTransport: () => transport });

    await expect(toolByName(tools, "browser_site_call").execute({
      name: "site_echo",
      input: { message: "hello" },
    })).resolves.toEqual({ echoed: "hello" });
    expect(invocation).toEqual({
      descriptorMatches: true,
      input: JSON.stringify({ message: "hello" }),
    });
    expect(transport.evaluateCalls[0]?.expression).toContain("document.modelContext");
    expect(transport.evaluateCalls[0]?.expression).not.toContain("navigator.modelContextTesting");
  });

  test("site-call reports when the requested document tool is no longer registered", async () => {
    const transport = new EvaluatingTransport({
      modelContext: {
        async getTools() {
          return [];
        },
        async executeTool() {
          throw new Error("test: must not execute a missing tool");
        },
      },
    });
    const tools = createBrowserTools({ getTransport: () => transport });

    await expect(toolByName(tools, "browser_site_call").execute({
      name: "site_echo",
      input: {},
    })).rejects.toThrow("webmcp-computer: browser page tool not found: site_echo");
  });

  test("puts supplied selectors and text into generated page expressions", async () => {
    const transport = new FakeTransport();
    transport.evaluateResult = true;
    const tools = createBrowserTools({ getTransport: () => transport });
    const selector = "#query[data-kind=\"shared\"]";
    const text = "hello \"shared\" browser";

    await toolByName(tools, "browser_click").execute({ selector });
    await toolByName(tools, "browser_type").execute({ selector, text, submit: true });

    expect(transport.evaluateCalls).toHaveLength(2);
    for (const call of transport.evaluateCalls) {
      expect(call.expression).toContain(JSON.stringify(selector));
    }
    expect(transport.evaluateCalls[1]?.expression).toContain(JSON.stringify(text));
    expect(transport.evaluateCalls[1]?.expression).toContain("if (true)");
  });

  test("dynamic registration follows Browser process lifecycle", async () => {
    const process = useKernelStore.getState().spawn("browser");
    const captured: Array<{ tool: SpecTool; signal?: AbortSignal }> = [];
    const modelContext: ModelContextLike = {
      async registerTool(tool: SpecTool, options?: RegisterToolOptions) {
        captured.push({ tool, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
      },
    };
    const registration = registerAppTools(process.pid, browserTools, {
      modelContext,
      telemetry: false,
    });
    await registration.ready;
    expect(captured.map(({ tool }) => tool.name)).toEqual([
      "browser_goto",
      "browser_read",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_site_tools",
      "browser_site_call",
    ]);
    expect(captured.every(({ signal }) => signal?.aborted === false)).toBe(true);
    useKernelStore.getState().kill(process.pid);
    expect(captured.every(({ signal }) => signal?.aborted === true)).toBe(true);
  });
});
