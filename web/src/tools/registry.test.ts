import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ModelContextLike,
  RegisterToolOptions,
  SpecTool,
  ToolRegistration,
} from "@nekuda/webmcp-sdk";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { initializeMemoryFileSystem, writeFile } from "../kernel/fs";
import { SITE_TOOL_PREFIX } from "../apps/preview/siteToolBridge";
import {
  bootTools,
  createSiteToolRegistryScope,
  awaitToolInvocationQuiescence,
  editorTools,
  getInFlightToolInvocationCount,
  hasInFlightSiteToolInvocation,
  MAX_SITE_TOOL_DESCRIPTION_BYTES,
  MAX_SITE_TOOL_INPUT_SCHEMA_BYTES,
  MAX_SITE_TOOL_RESULT_BYTES,
  MAX_SITE_TOOLS,
  registerAppTools,
  registerSystemTools,
  siteToolInvocationScope,
} from "./registry";
import { appCloseTool, appListTool, sysStatusTool } from "./systemTools";

type CapturedRegistration = {
  tool: SpecTool;
  signal: AbortSignal | undefined;
};

type ToolCase = {
  name: string;
  setup?: () => void | Promise<void>;
  input: Record<string, unknown>;
  assertResult: (result: Record<string, unknown>) => void;
  rejectInput: Record<string, unknown>;
  rejection: string;
};

function createModelContext(registrations: CapturedRegistration[]): ModelContextLike {
  return {
    async registerTool(tool: SpecTool, options?: RegisterToolOptions) {
      registrations.push({ tool, signal: options?.signal });
    },
  };
}

async function captureTool(name: string): Promise<{
  tool: SpecTool;
  registration: ToolRegistration;
}> {
  const captured: CapturedRegistration[] = [];
  const registration = registerSystemTools({
    modelContext: createModelContext(captured),
    telemetry: false,
  });
  await registration.ready;
  const tool = captured.find((entry) => entry.tool.name === name)?.tool;
  if (!tool) throw new Error(`test: ${name} was not registered`);
  return { tool, registration };
}

function parseToolResult(result: unknown): Record<string, unknown> {
  expect(result).toEqual({
    content: [{ type: "text", text: expect.any(String) }],
  });
  const text = (result as { content: [{ text: string }] }).content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

function expectToolErrorResult(result: unknown, message: string): void {
  expect(result).toEqual({
    content: [{ type: "text", text: expect.stringContaining(message) }],
    isError: true,
  });
}

const spawnFiles = () => {
  useKernelStore.getState().spawn("files");
};

const toolCases: ToolCase[] = [
  {
    name: "app_open",
    input: { appId: "files" },
    assertResult(result) {
      expect(result).toEqual({
        pid: 2,
        appId: "files",
        rect: { x: 54, y: 82, width: 420, height: 300 },
        reused: false,
      });
    },
    rejectInput: { appId: "ui" },
    rejection: "webmcp-computer: unknown app 'ui'; expected files, editor, terminal, notes, preview, settings",
  },
  {
    name: "app_close",
    setup: spawnFiles,
    input: { pid: 2 },
    assertResult(result) {
      expect(result).toEqual({ closed: true, pid: 2, appId: "files" });
      expect(useKernelStore.getState().processes).toHaveLength(0);
      expect(useKernelStore.getState().events.at(-1)?.args.rect).toEqual({
        x: 54,
        y: 82,
        width: 420,
        height: 300,
      });
    },
    rejectInput: { pid: 999 },
    rejection: "webmcp-computer: process PID 999 not found",
  },
  {
    name: "app_list",
    setup: spawnFiles,
    input: {},
    assertResult(result) {
      expect(result.processes).toEqual([
        expect.objectContaining({ pid: 2, appId: "files", focused: true }),
      ]);
    },
    rejectInput: { unexpected: true },
    rejection: "webmcp-computer: input must be an empty object",
  },
  {
    name: "window_focus",
    setup() {
      spawnFiles();
      useKernelStore.getState().spawn("editor");
    },
    input: { pid: 2 },
    assertResult(result) {
      expect(result).toEqual(expect.objectContaining({ pid: 2, focused: true, zIndex: 1 }));
    },
    rejectInput: { pid: 999 },
    rejection: "webmcp-computer: process PID 999 not found",
  },
  {
    name: "window_move",
    setup: spawnFiles,
    input: { pid: 2, x: 999_999, y: -999_999 },
    assertResult(result) {
      expect(result.windowRect).toEqual({ x: 1_220, y: 0, width: 420, height: 300 });
    },
    rejectInput: { pid: 2, x: Number.POSITIVE_INFINITY, y: 0 },
    rejection: "webmcp-computer: x must be a finite number",
  },
  {
    name: "window_resize",
    setup: spawnFiles,
    input: { pid: 2, width: 1, height: 999_999 },
    assertResult(result) {
      expect(result.windowRect).toEqual({ x: 54, y: 82, width: 300, height: 682 });
    },
    rejectInput: { pid: 2, width: Number.NaN, height: 300 },
    rejection: "webmcp-computer: width must be a finite number",
  },
  {
    name: "sys_status",
    input: {},
    assertResult(result) {
      expect(result).toEqual({
        hostname: "guest@webmcp-computer",
        uptime_s: expect.any(Number),
        processes: 0,
        fs_backend: null,
        fs_status: "idle",
        skills: "~/skills",
      });
    },
    rejectInput: { unexpected: true },
    rejection: "webmcp-computer: input must be an empty object",
  },
  {
    name: "screensaver_wake",
    input: {},
    assertResult(result) {
      expect(result).toEqual({ awake: true, wasActive: true });
    },
    rejectInput: { unexpected: true },
    rejection: "webmcp-computer: input must be an empty object",
  },
];

describe("system tool registry", () => {
  beforeEach(() => resetKernelStore());

  test("registers all boot tools and unregisters them through abort signals", async () => {
    const captured: CapturedRegistration[] = [];
    const registration = registerSystemTools({
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    const results = await registration.ready;

    const expectedToolNames = [
      "app_open",
      "app_close",
      "app_list",
      "window_focus",
      "window_move",
      "window_resize",
      "sys_status",
      "screensaver_wake",
      "os_manual",
      "os_search",
      "settings_get",
      "settings_set",
      "browser_open",
      "os_publish",
      "cloud_exec",
      "ui_open",
      "fs_read",
      "fs_write",
      "fs_edit",
      "fs_search",
      "fs_list",
      "fs_mkdir",
      "fs_delete",
      "fs_move",
      "term_exec",
      "term_read",
      "term_state",
      "term_history",
      "ps",
      "kill",
    ];
    expect(results).toHaveLength(expectedToolNames.length);
    expect(results.every((result) => result.state === "registered")).toBe(true);
    expect(captured.map(({ tool }) => tool.name)).toEqual(expectedToolNames);
    expect(captured.every(({ signal }) => signal?.aborted === false)).toBe(true);
    expect(useKernelStore.getState().toolRegistryGroups).toEqual([
      expect.objectContaining({ owner: "system", tools: expectedToolNames }),
    ]);

    registration.unregister();
    expect(registration.signal.aborted).toBe(true);
    expect(captured.every(({ signal }) => signal?.aborted === true)).toBe(true);
    expect(useKernelStore.getState().toolRegistryGroups).toEqual([]);
  });

  test("keeps the frame-tool prefix reserved for site-provided tools", () => {
    expect(bootTools.every(({ name }) => !name.startsWith(SITE_TOOL_PREFIX))).toBe(true);
  });

  test("registerAppTools aborts its SDK batch when the owning process is killed", async () => {
    const process = useKernelStore.getState().spawn("editor");
    const captured: CapturedRegistration[] = [];
    const registration = registerAppTools(process.pid, editorTools, {
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    await registration.ready;

    expect(captured.map(({ tool }) => tool.name)).toEqual(["editor_open_file"]);
    expect(registration.signal.aborted).toBe(false);
    expect(captured[0]?.signal?.aborted).toBe(false);
    expect(useKernelStore.getState().toolRegistryGroups).toContainEqual(
      expect.objectContaining({ owner: "editor", pid: process.pid, tools: ["editor_open_file"] }),
    );

    useKernelStore.getState().kill(process.pid);
    expect(registration.signal.aborted).toBe(true);
    expect(captured[0]?.signal?.aborted).toBe(true);
    expect(useKernelStore.getState().toolRegistryGroups).toEqual([]);
  });

  test("minimizing an app keeps its registered tools active", async () => {
    const process = useKernelStore.getState().spawn("editor");
    const captured: CapturedRegistration[] = [];
    const registration = registerAppTools(process.pid, editorTools, {
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    await registration.ready;

    useKernelStore.getState().minimize(process.pid);

    expect(registration.signal.aborted).toBe(false);
    expect(captured[0]?.signal?.aborted).toBe(false);
    expect(useKernelStore.getState().toolRegistryGroups).toContainEqual(
      expect.objectContaining({ owner: "editor", pid: process.pid, tools: ["editor_open_file"] }),
    );

    registration.unregister();
  });

  test("reuses one in-flight app batch across a synchronous unregister and register", async () => {
    const process = useKernelStore.getState().spawn("editor");
    const captured: CapturedRegistration[] = [];
    const options = {
      modelContext: createModelContext(captured),
      telemetry: false,
    };

    const first = registerAppTools(process.pid, editorTools, options);
    first.unregister();
    const second = registerAppTools(process.pid, editorTools, options);
    await Promise.all([first.ready, second.ready]);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tool.name).toBe("editor_open_file");
    expect(captured[0]?.signal?.aborted).toBe(false);
    expect(useKernelStore.getState().toolRegistryGroups).toContainEqual(
      expect.objectContaining({
        owner: "editor",
        pid: process.pid,
        tools: ["editor_open_file"],
      }),
    );

    second.unregister();
    expect(captured[0]?.signal?.aborted).toBe(true);
  });

  test("double-open shares one global tool and targets the frontmost instance", async () => {
    await initializeMemoryFileSystem();
    await writeFile("~/site/first.txt", "first", "system");
    await writeFile("~/site/second.txt", "second", "system");
    const first = useKernelStore.getState().spawn("editor");
    const second = useKernelStore.getState().spawn("editor");
    const captured: CapturedRegistration[] = [];
    const firstRegistration = registerAppTools(first.pid, editorTools, {
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    const secondRegistration = registerAppTools(second.pid, editorTools, {
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    await Promise.all([firstRegistration.ready, secondRegistration.ready]);

    try {
      expect(captured).toHaveLength(1);
      expect(captured[0]?.tool.description).toContain("frontmost Editor");
      const registered = captured[0]?.tool;
      if (!registered) throw new Error("test: editor_open_file was not registered");

      expect(parseToolResult(await registered.execute({ path: "~/site/second.txt" }))).toEqual(
        expect.objectContaining({ pid: second.pid, path: "~/site/second.txt" }),
      );
      expect(
        useKernelStore.getState().processes.find(({ pid }) => pid === second.pid)?.path,
      ).toBe("~/site/second.txt");

      expect(
        parseToolResult(await registered.execute({ path: "~/site/first.txt", pid: first.pid })),
      ).toEqual(expect.objectContaining({ pid: first.pid, path: "~/site/first.txt" }));

      useKernelStore.getState().kill(second.pid);
      expect(secondRegistration.signal.aborted).toBe(true);
      expect(captured[0]?.signal?.aborted).toBe(false);
      useKernelStore.getState().kill(first.pid);
      expect(captured[0]?.signal?.aborted).toBe(true);
    } finally {
      firstRegistration.unregister();
      secondRegistration.unregister();
    }
  });

  test("answer tools declare read-only behavior", () => {
    expect(appListTool.annotations?.readOnlyHint).toBe(true);
    expect(sysStatusTool.annotations?.readOnlyHint).toBe(true);
  });

  test("sys_status uses one backend vocabulary when filesystem is ready", async () => {
    useKernelStore.getState().setFileSystemState("ready", "opfs");
    expect(await sysStatusTool.execute({})).toEqual(expect.objectContaining({
      fs_backend: "local (opfs)",
      fs_status: "local (opfs)",
    }));
    useKernelStore.getState().setFileSystemState("ready", "cloud");
    expect(await sysStatusTool.execute({})).toEqual(expect.objectContaining({
      fs_backend: "cloud",
      fs_status: "cloud",
    }));
  });

  test("registry transports implementation errors as MCP tool errors", async () => {
    await expect(appCloseTool.execute({ pid: 999 })).rejects.toThrow(
      "webmcp-computer: process PID 999 not found",
    );
    const registered = await captureTool("app_close");
    try {
      expectToolErrorResult(
        await registered.tool.execute({ pid: 999 }),
        "webmcp-computer: process PID 999 not found",
      );
    } finally {
      registered.registration.unregister();
    }
  });

  test("zero-parameter tools accept omitted and null host arguments", async () => {
    await initializeMemoryFileSystem();
    const captured: CapturedRegistration[] = [];
    const registration = registerSystemTools({
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    await registration.ready;
    try {
      for (const name of ["app_list", "sys_status", "screensaver_wake", "settings_get"]) {
        const registered = captured.find(({ tool }) => tool.name === name)?.tool;
        if (!registered) throw new Error(`test: ${name} was not registered`);
        for (const input of [undefined, null]) {
          expect(parseToolResult(await registered.execute(input as never))).toBeDefined();
        }
      }
    } finally {
      registration.unregister();
    }
  });

  test("window bounds and PID validation use precise semantics", async () => {
    spawnFiles();
    const move = await captureTool("window_move");
    try {
      const result = parseToolResult(
        await move.tool.execute({ pid: 2, x: 0, y: 999_999 }),
      );
      expect((result.windowRect as Record<string, number>).y).toBe(644);
      const left = parseToolResult(
        await move.tool.execute({ pid: 2, x: -999_999, y: 0 }),
      );
      expect((left.windowRect as Record<string, number>).x).toBe(0);
    } finally {
      move.registration.unregister();
    }

    const close = await captureTool("app_close");
    try {
      expectToolErrorResult(
        await close.tool.execute({ pid: 2.5 }),
        "webmcp-computer: pid must be an integer",
      );
      expectToolErrorResult(
        await close.tool.execute({ pid: 1 }),
        "webmcp-computer: pid 1 is the screensaver; window pids start at 2",
      );
    } finally {
      close.registration.unregister();
    }
  });

  test("app_open applies clamped placement and truthfully reuses singleton windows", async () => {
    const captured = await captureTool("app_open");
    try {
      const opened = parseToolResult(await captured.tool.execute({
        appId: "settings",
        x: -20,
        y: 90,
        width: 900,
        height: 800,
      }));
      expect(opened).toEqual(expect.objectContaining({
        reused: false,
        rect: { x: 0, y: 90, width: 900, height: 682 },
      }));
      const reused = parseToolResult(await captured.tool.execute({
        appId: "settings",
        x: 240,
        width: 500,
        focus: false,
      }));
      expect(reused).toEqual(expect.objectContaining({
        pid: opened.pid,
        reused: true,
        rect: { x: 240, y: 90, width: 500, height: 682 },
      }));
    } finally {
      captured.registration.unregister();
    }
  });

  test("site tool scope enforces prefix and cap, forces annotations, and clears its PID batch", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const captured: CapturedRegistration[] = [];
    const scope = createSiteToolRegistryScope(process.pid, "webmcp-computer://site/", {
      modelContext: createModelContext(captured),
      telemetry: false,
    });

    await expect(scope.register({
      name: "hello",
      description: "Wrong namespace.",
    }, async () => "no"))
      .rejects.toThrow("webmcp-computer: site tool name must start with site_");
    await expect(scope.register({
      name: "site_",
      description: "Missing local name.",
    }, async () => "no"))
      .rejects.toThrow("webmcp-computer: site tool name must include at least one character after site_");

    for (let index = 0; index < MAX_SITE_TOOLS; index += 1) {
      await scope.register({
        name: `site_tool_${index}`,
        description: `Description ${index}`,
      }, async () => ({ index }));
    }
    await expect(scope.register({
      name: "site_over_limit",
      description: "Seventeenth tool.",
    }, async () => "no"))
      .rejects.toThrow("webmcp-computer: site tool limit reached");

    expect(captured).toHaveLength(MAX_SITE_TOOLS);
    expect(captured[0]?.tool.description).toBe("Description 0");
    expect(captured[0]?.tool.annotations).toEqual({
      readOnlyHint: false,
      consequentialHint: false,
      untrustedContentHint: true,
    });
    expect(useKernelStore.getState().toolRegistryGroups).toContainEqual(
      expect.objectContaining({
        owner: "webmcp-computer://site/",
        pid: process.pid,
        tools: Array.from({ length: MAX_SITE_TOOLS }, (_, index) => `site_tool_${index}`),
      }),
    );

    scope.clear();
    expect(captured.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(useKernelStore.getState().toolRegistryGroups).toEqual([]);
    scope.dispose();
  });

  test("site tool scope rejects oversized descriptions and serialized input schemas", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const captured: CapturedRegistration[] = [];
    const scope = createSiteToolRegistryScope(process.pid, "webmcp-computer://site/", {
      modelContext: createModelContext(captured),
      telemetry: false,
    });

    await expect(scope.register({
      name: "site_large_description",
      description: "x".repeat(MAX_SITE_TOOL_DESCRIPTION_BYTES + 1),
    }, async () => "no"))
      .rejects.toThrow("webmcp-computer: site tool description too large: site_large_description");
    await expect(scope.register({
      name: "site_large_schema",
      description: "Schema is too large.",
      inputSchema: { padding: "x".repeat(MAX_SITE_TOOL_INPUT_SCHEMA_BYTES) },
    }, async () => "no"))
      .rejects.toThrow("webmcp-computer: site tool inputSchema too large: site_large_schema");

    expect(captured).toEqual([]);
    scope.dispose();
  });

  test("tracks tool invocations until result conversion settles", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const captured: CapturedRegistration[] = [];
    const scope = createSiteToolRegistryScope(process.pid, "webmcp-computer://site/", {
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    let resolveExecution: ((value: string) => void) | undefined;
    await scope.register({
      name: "site_deferred",
      description: "Resolves when released by the test.",
    }, () => new Promise<string>((resolve) => {
      resolveExecution = resolve;
    }));

    const invocation = captured[0]!.tool.execute({});
    await Promise.resolve();
    expect(getInFlightToolInvocationCount()).toBe(1);
    expect(hasInFlightSiteToolInvocation(siteToolInvocationScope(process.pid))).toBe(true);
    expect(hasInFlightSiteToolInvocation(siteToolInvocationScope(process.pid + 1))).toBe(false);
    let reachedQuiescence = false;
    const quiescence = awaitToolInvocationQuiescence().then(() => {
      reachedQuiescence = true;
    });
    await Promise.resolve();
    expect(reachedQuiescence).toBe(false);

    resolveExecution?.("done");
    await invocation;
    await quiescence;
    expect(getInFlightToolInvocationCount()).toBe(0);
    expect(hasInFlightSiteToolInvocation(siteToolInvocationScope(process.pid))).toBe(false);
    expect(reachedQuiescence).toBe(true);
    scope.dispose();
  });

  test("site tool scope times out, caps results, transports errors, and records Preview toast events", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const captured: CapturedRegistration[] = [];
    const scope = createSiteToolRegistryScope(process.pid, "webmcp-computer://site/", {
      modelContext: createModelContext(captured),
      telemetry: false,
      executionTimeoutMs: 5,
    });
    await scope.register({
      name: "site_slow",
      description: "Never resolves.",
    }, () => new Promise(() => {}));
    await scope.register({
      name: "site_large",
      description: "Returns too much.",
    }, async () => "x".repeat(MAX_SITE_TOOL_RESULT_BYTES + 1));
    await scope.register({
      name: "site_rejects",
      description: "Rejects in the frame.",
    }, async () => {
      throw new Error("site says no");
    });

    expectToolErrorResult(
      await captured.find(({ tool }) => tool.name === "site_slow")!.tool.execute({}),
      "webmcp-computer: site tool timed out: site_slow",
    );
    expectToolErrorResult(
      await captured.find(({ tool }) => tool.name === "site_large")!.tool.execute({}),
      "webmcp-computer: site tool result too large: site_large",
    );
    expectToolErrorResult(
      await captured.find(({ tool }) => tool.name === "site_rejects")!.tool.execute({}),
      "site says no",
    );
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "agent",
      verb: "site_rejects",
      args: { appId: "preview", pid: process.pid },
      ok: false,
    }));

    useKernelStore.getState().kill(process.pid);
    expect(captured.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(useKernelStore.getState().toolRegistryGroups).toEqual([]);
  });

  test("site tool scope attributes agent-made app tools to the UI process", async () => {
    const process = useKernelStore.getState().spawn("ui", { path: "~/apps/test.html" });
    const captured: CapturedRegistration[] = [];
    const scope = createSiteToolRegistryScope(process.pid, "app:~/apps/test.html", {
      appId: "ui",
      modelContext: createModelContext(captured),
      telemetry: false,
    });
    await scope.register({
      name: "site_app_echo",
      description: "Echo from an agent-made app.",
    }, async (input) => input);

    await captured[0]!.tool.execute({ value: "hello" });
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "agent",
      verb: "site_app_echo",
      args: { appId: "ui", pid: process.pid },
      ok: true,
    }));
    scope.dispose();
  });

  for (const toolCase of toolCases) {
    test(`${toolCase.name} returns its happy-path shape`, async () => {
      await toolCase.setup?.();
      const { tool, registration } = await captureTool(toolCase.name);
      try {
        const result = parseToolResult(await tool.execute(toolCase.input));
        toolCase.assertResult(result);
        expect(useKernelStore.getState().events.at(-1)).toEqual(
          expect.objectContaining({ source: "agent", verb: toolCase.name, ok: true }),
        );
      } finally {
        registration.unregister();
      }
    });

    test(`${toolCase.name} rejects degenerate input`, async () => {
      await toolCase.setup?.();
      const { tool, registration } = await captureTool(toolCase.name);
      try {
        expectToolErrorResult(await tool.execute(toolCase.rejectInput), toolCase.rejection);
        expect(useKernelStore.getState().events.at(-1)).toEqual(
          expect.objectContaining({
            source: "agent",
            verb: toolCase.name,
            ok: false,
            reason: expect.stringContaining(toolCase.rejection),
          }),
        );
      } finally {
        registration.unregister();
      }
    });
  }
});
