import { describe, expect, test } from "bun:test";
import {
  createSiteModelContextFacade,
  createSiteToolProxy,
  type SiteToolFrameMessage,
  type SiteToolHostMessage,
} from "./siteToolBridge";

describe("Preview site modelContext facade", () => {
  test("stringified facade is dependency-free and completes a register/execute round trip", async () => {
    const createFacade = new Function(
      "return (" + createSiteModelContextFacade.toString() + ")",
    )() as typeof createSiteModelContextFacade;
    const sent: SiteToolFrameMessage[] = [];
    let receive: ((message: SiteToolHostMessage) => void) | undefined;
    const facade = createFacade(
      (message) => sent.push(message),
      (listener) => {
        receive = listener;
      },
    );

    const registration = facade.registerTool({
      name: "site_bare_realm",
      description: "Run without module dependencies.",
      execute(input) {
        return { echoed: input.value };
      },
    });
    const requestId = (sent[0] as { requestId: string }).requestId;
    receive?.({ kind: "site-tool-registration", requestId, ok: true });
    await registration;

    receive?.({
      kind: "site-tool-call",
      callId: "call-bare-realm",
      name: "site_bare_realm",
      input: { value: "round trip" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toContainEqual({
      kind: "site-tool-result",
      callId: "call-bare-realm",
      ok: true,
      result: { echoed: "round trip" },
    });
  });

  test("lists only its own registered tools, executes them, and unregisters on abort", async () => {
    const sent: SiteToolFrameMessage[] = [];
    let receive: ((message: SiteToolHostMessage) => void) | undefined;
    const facade = createSiteModelContextFacade(
      (message) => sent.push(message),
      (listener) => {
        receive = listener;
      },
    );
    const controller = new AbortController();
    const registration = facade.registerTool({
      name: "site_hello",
      description: "Return a greeting.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute(input) {
        return { greeting: `Aurora says hello to ${String(input.name)}` };
      },
    }, { signal: controller.signal });

    expect(facade.getTools()).toEqual([]);
    expect(sent[0]).toEqual(expect.objectContaining({
      kind: "site-tool-register",
      tool: expect.objectContaining({ name: "site_hello" }),
    }));
    const requestId = (sent[0] as { requestId: string }).requestId;
    receive?.({ kind: "site-tool-registration", requestId, ok: true });
    await registration;

    expect(facade.getTools()).toEqual([
      expect.objectContaining({
        name: "site_hello",
        annotations: {
          readOnlyHint: false,
          consequentialHint: false,
          untrustedContentHint: true,
        },
      }),
    ]);

    receive?.({
      kind: "site-tool-call",
      callId: "call-1",
      name: "site_hello",
      input: { name: "Mira" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toContainEqual({
      kind: "site-tool-result",
      callId: "call-1",
      ok: true,
      result: { greeting: "Aurora says hello to Mira" },
    });

    controller.abort();
    expect(facade.getTools()).toEqual([]);
    expect(sent.at(-1)).toEqual({ kind: "site-tool-unregister", name: "site_hello" });
  });

  test("does not register when signal is already aborted", async () => {
    const sent: SiteToolFrameMessage[] = [];
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const facade = createSiteModelContextFacade(
      (message) => sent.push(message),
      () => {},
    );

    await expect(facade.registerTool({
      name: "site_never",
      description: "Never registers.",
      execute() {},
    }, { signal: controller.signal })).rejects.toThrow("gone");
    expect(sent).toEqual([]);
  });

  test("rejects oversized results before posting them to the host", async () => {
    const sent: SiteToolFrameMessage[] = [];
    let receive: ((message: SiteToolHostMessage) => void) | undefined;
    const facade = createSiteModelContextFacade(
      (message) => sent.push(message),
      (listener) => {
        receive = listener;
      },
    );
    const registration = facade.registerTool({
      name: "site_large",
      description: "Returns too much data.",
      execute() {
        return "x".repeat(256 * 1_024 + 1);
      },
    });
    const requestId = (sent[0] as { requestId: string }).requestId;
    receive?.({ kind: "site-tool-registration", requestId, ok: true });
    await registration;

    receive?.({
      kind: "site-tool-call",
      callId: "call-large",
      name: "site_large",
      input: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({
      kind: "site-tool-result",
      callId: "call-large",
      ok: false,
      error: "verbos: site tool result too large: site_large",
    });
  });
});

describe("Preview site tool call proxy", () => {
  test("resolves site results and drops an aborted pending call", async () => {
    const sent: Array<{ callId: string; name: string }> = [];
    const proxy = createSiteToolProxy((message) => sent.push(message));
    const completed = proxy.execute("site_hello", { name: "Mira" });
    proxy.receive({
      kind: "site-tool-result",
      callId: sent[0]!.callId,
      ok: true,
      result: "hello Mira",
    });
    await expect(completed).resolves.toBe("hello Mira");

    const controller = new AbortController();
    const aborted = proxy.execute("site_slow", {}, controller.signal);
    controller.abort(new Error("timed out"));
    await expect(aborted).rejects.toThrow("timed out");
  });
});
