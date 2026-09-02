import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineTool, type AnyWebMCPTool } from "@nekuda/webmcp-sdk";
import { resetKernelStore, useKernelStore } from "../../kernel/store";
import {
  awaitToolInvocationQuiescence,
  getInFlightToolInvocationCount,
} from "../../tools/registry";
import { resetToolCatalog, setToolCatalogScope } from "../../tools/toolCatalog";
import { resetUiToolGrants, setUiToolGrant } from "./runtime";
import {
  createUiBridgeClient,
  createUiToolHostProxy,
  injectUiBridge,
  UI_CONTENT_SECURITY_POLICY,
  type UiBridgeClient,
  type UiEnvelope,
  type UiHostMessage,
} from "./uiBridge";

function testTool(
  name: string,
  execute: (input: Record<string, unknown>) => unknown,
): AnyWebMCPTool {
  return defineTool({
    stableKey: `test.${name}`,
    name,
    title: `Test ${name}`,
    description: `Execute ${name} for a UI bridge test.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    intent: "act",
    execute,
  });
}

type ConnectedBridge = {
  client: UiBridgeClient;
  host: ReturnType<typeof createUiToolHostProxy>;
  sendToFrame(message: unknown): void;
};

function connect(
  tools: readonly AnyWebMCPTool[],
  grant: readonly string[],
  executionTimeoutMs = 10_000,
): ConnectedBridge {
  const pid = useKernelStore.getState().spawn("ui", {
    path: "~/apps/test.html",
  }).pid;
  const token = "ui-token";
  setToolCatalogScope("ui-test", tools);
  setUiToolGrant(pid, grant);
  let frameReceive: (message: unknown) => void = () => {};
  const host = createUiToolHostProxy({
    pid,
    token,
    executionTimeoutMs,
    send(message) {
      frameReceive(message);
    },
  });
  const createClient = new Function(
    `return (${createUiBridgeClient.toString()})`,
  )() as typeof createUiBridgeClient;
  const client = createClient(
    pid,
    token,
    (message) => host.receive(message),
    (listener) => {
      frameReceive = listener;
    },
  );
  return { client, host, sendToFrame: (message) => frameReceive(message) };
}

describe("UI host bridge", () => {
  beforeEach(() => {
    resetKernelStore();
    resetUiToolGrants();
    resetToolCatalog();
  });

  afterEach(() => {
    resetUiToolGrants();
    resetToolCatalog();
  });

  test("dependency-free init handshake returns granted descriptors", async () => {
    const echo = testTool("echo", (input) => input);
    const { client } = connect([echo], ["echo"]);

    expect(await client.listTools()).toEqual([{
      name: "echo",
      title: "Test echo",
      description: "Execute echo for a UI bridge test.",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }]);
    expect(Object.isFrozen(client)).toBe(true);
  });

  test("round-trips a granted call and emits one settled app event", async () => {
    const echo = testTool("echo", (input) => ({ echoed: input.value }));
    const { client } = connect([echo], ["echo"]);

    await expect(client.callTool("echo", { value: "Aurora" })).resolves.toEqual({
      echoed: "Aurora",
    });
    expect(useKernelStore.getState().events).toEqual([
      expect.objectContaining({
        source: "app",
        verb: "ui_call",
        args: { pid: 2, tool: "echo" },
        ok: true,
      }),
    ]);
  });

  test("tracks execution and disposes pending calls before a frame swap", async () => {
    let release: (() => void) | undefined;
    const slow = testTool("slow", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const { client, host } = connect([slow], ["slow"]);

    const pending = client.callTool("slow", {});
    await Promise.resolve();
    expect(getInFlightToolInvocationCount()).toBe(1);

    host.dispose(new Error("webmcp-computer: UI tool bridge reloaded"));
    await expect(pending).rejects.toThrow("webmcp-computer: UI tool bridge reloaded");
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "app",
      verb: "ui_call",
      ok: false,
      reason: "webmcp-computer: UI tool bridge reloaded",
    }));

    release?.();
    await awaitToolInvocationQuiescence();
    expect(getInFlightToolInvocationCount()).toBe(0);
  });

  test("rejects a result when its grant is revoked during execution", async () => {
    let release: (() => void) | undefined;
    const slow = testTool("slow", () => new Promise<string>((resolve) => {
      release = () => resolve("late result");
    }));
    const { client } = connect([slow], ["slow"]);

    const pending = client.callTool("slow", {});
    await Promise.resolve();
    setUiToolGrant(2, []);
    release?.();

    await expect(pending).rejects.toThrow("webmcp-computer: UI tool not granted: slow");
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      verb: "ui_call",
      ok: false,
      reason: "webmcp-computer: UI tool not granted: slow",
    }));
  });

  test("settles in-flight calls when the UI process dies", async () => {
    let release: (() => void) | undefined;
    const slow = testTool("slow", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const { client } = connect([slow], ["slow"]);

    const pending = client.callTool("slow", {});
    await Promise.resolve();
    useKernelStore.getState().kill(2);

    await expect(pending).rejects.toThrow("webmcp-computer: UI process closed");
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      verb: "ui_call",
      ok: false,
      reason: "webmcp-computer: UI process closed",
    }));

    release?.();
    await awaitToolInvocationQuiescence();
  });

  test("rejects ungranted calls and non-object input at the host", async () => {
    const echo = testTool("echo", (input) => input);
    const { client, host } = connect([echo], []);
    await expect(client.callTool("echo", {})).rejects.toThrow(
      "webmcp-computer: UI tool not granted: echo",
    );

    setUiToolGrant(2, ["echo"]);
    const results: UiEnvelope<UiHostMessage>[] = [];
    const strictHost = createUiToolHostProxy({
      pid: 2,
      token: "strict",
      send: (message) => results.push(message),
    });
    strictHost.receive({
      __webmcpComputerUi: true,
      pid: 2,
      token: "strict",
      kind: "ui-call",
      callId: "bad-input",
      name: "echo",
      input: [],
    });
    expect(results.at(-1)).toEqual(expect.objectContaining({
      kind: "ui-result",
      callId: "bad-input",
      ok: false,
      error: "webmcp-computer: UI tool input must be a plain object: echo",
    }));
    expect(host).toBeDefined();
  });

  test("times out and settles the app event with the reason", async () => {
    const slow = testTool("slow", () => new Promise(() => {}));
    const { client } = connect([slow], ["slow"], 5);

    await expect(client.callTool("slow", {})).rejects.toThrow(
      "webmcp-computer: UI tool timed out: slow",
    );
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "app",
      verb: "ui_call",
      ok: false,
      reason: "webmcp-computer: UI tool timed out: slow",
    }));
  });

  test("rejects frame calls when the host reply is dropped", async () => {
    const client = createUiBridgeClient(42, "timeout-token", () => {}, () => {}, 5);

    await expect(client.callTool("dropped", {})).rejects.toThrow(
      "webmcp-computer: UI tool call was not answered: dropped",
    );
  });

  test("rejects results larger than 256 KB", async () => {
    const large = testTool("large", () => "x".repeat(256 * 1_024 + 1));
    const { client } = connect([large], ["large"]);
    await expect(client.callTool("large", {})).rejects.toThrow(
      "webmcp-computer: UI tool result too large: large",
    );
  });

  test("rejects inputs larger than 256 KB before execution", async () => {
    let executions = 0;
    const echo = testTool("echo", (input) => {
      executions += 1;
      return input;
    });
    const { client } = connect([echo], ["echo"]);

    await expect(client.callTool("echo", {
      value: "x".repeat(256 * 1_024 + 1),
    })).rejects.toThrow("webmcp-computer: UI tool input too large: echo");
    expect(executions).toBe(0);
  });

  test("rejects a third concurrent call", async () => {
    const releases: Array<() => void> = [];
    const slow = testTool("concurrent", () => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));
    const { client } = connect([slow], ["concurrent"]);

    const first = client.callTool("concurrent", {});
    const second = client.callTool("concurrent", {});
    await expect(client.callTool("concurrent", {})).rejects.toThrow(
      "webmcp-computer: UI tool call limit reached: concurrent",
    );
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    releases.forEach((release) => release());
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  test("rejects repeated in-flight call IDs before executing them", async () => {
    let executions = 0;
    let release: (() => void) | undefined;
    const slow = testTool("duplicate", () => {
      executions += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pid = useKernelStore.getState().spawn("ui", {
      path: "~/apps/test.html",
    }).pid;
    setToolCatalogScope("duplicate-test", [slow]);
    setUiToolGrant(pid, ["duplicate"]);
    const responses: UiEnvelope<UiHostMessage>[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstResult = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const host = createUiToolHostProxy({
      pid,
      token: "duplicate-token",
      send(message) {
        responses.push(message);
        if (message.kind === "ui-result" && message.ok) resolveFirst?.();
      },
    });
    const call = {
      __webmcpComputerUi: true,
      pid,
      token: "duplicate-token",
      kind: "ui-call",
      callId: "same",
      name: "duplicate",
      input: {},
    } as const;

    host.receive(call);
    host.receive(call);
    host.receive(call);
    await Promise.resolve();

    expect(executions).toBe(1);
    expect(responses.filter((message) =>
      message.kind === "ui-result" &&
      message.error === "webmcp-computer: duplicate UI call id: same"
    )).toHaveLength(2);

    release?.();
    await firstResult;
    expect(executions).toBe(1);
  });

  test("injects the UI-only content security policy before frame scripts", () => {
    const document = injectUiBridge(
      "<!doctype html><html><head><title>Safe app</title></head><body></body></html>",
      8,
      "csp-token",
    );
    const meta = `<meta http-equiv="Content-Security-Policy" content="${UI_CONTENT_SECURITY_POLICY}">`;

    expect(document).toContain(`<head>${meta}<script>`);
    expect(document.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(document).toContain("connect-src 'none'; form-action 'none'");
    expect(document).toContain("modelContext");
    expect(document).toContain("site-tool-register");
  });

  test("ignores token and PID mismatches in both directions", async () => {
    const sent: unknown[] = [];
    let receive: (message: unknown) => void = () => {};
    const client = createUiBridgeClient(
      42,
      "right-token",
      (message) => sent.push(message),
      (listener) => {
        receive = listener;
      },
    );
    const pending = client.callTool("echo", {});
    receive({
      __webmcpComputerUi: true,
      pid: 99,
      token: "right-token",
      kind: "ui-result",
      callId: "ui-call-1",
      ok: true,
      result: "wrong pid",
    });
    receive({
      __webmcpComputerUi: true,
      pid: 42,
      token: "wrong-token",
      kind: "ui-result",
      callId: "ui-call-1",
      ok: true,
      result: "wrong token",
    });
    receive({
      __webmcpComputerUi: true,
      pid: 42,
      token: "right-token",
      kind: "ui-result",
      callId: "ui-call-1",
      ok: true,
      result: "accepted",
    });
    await expect(pending).resolves.toBe("accepted");

    const hostMessages: unknown[] = [];
    const host = createUiToolHostProxy({
      pid: 42,
      token: "right-token",
      send: (message) => hostMessages.push(message),
    });
    host.receive({ __webmcpComputerUi: true, pid: 99, token: "right-token", kind: "ui-init" });
    host.receive({ __webmcpComputerUi: true, pid: 42, token: "wrong-token", kind: "ui-init" });
    expect(hostMessages).toEqual([]);
    expect(sent[0]).toEqual(expect.objectContaining({ kind: "ui-init" }));
  });
});
