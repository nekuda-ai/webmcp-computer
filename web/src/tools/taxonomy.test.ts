import { beforeEach, describe, expect, test } from "bun:test";
import type { AnyWebMCPTool, ModelContextLike, SpecTool } from "@nekuda/webmcp-sdk";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { previewTools } from "./previewTools";
import { browserOpenTool, browserTools } from "./browserTools";
import { getActiveToolDefinition } from "./toolCatalog";
import {
  bootTools,
  createSiteToolRegistryScope,
  editorTools,
  filesTools,
  notesTools,
  registerSystemTools,
} from "./registry";

const VERBOS_TOOLS = [
  ...bootTools,
  ...editorTools,
  ...filesTools,
  ...notesTools,
  ...previewTools,
  ...browserTools,
];

const EXPECTED_CLASS = {
  app_close: "act",
  app_list: "ask",
  app_open: "act",
  browser_click: "act",
  browser_goto: "act",
  browser_open: "act",
  browser_read: "ask",
  browser_screenshot: "ask",
  browser_site_call: "act",
  browser_site_tools: "ask",
  browser_type: "act",
  cloud_exec: "transact",
  editor_open_file: "act",
  files_reveal: "act",
  fs_delete: "transact",
  fs_edit: "act",
  fs_list: "ask",
  fs_mkdir: "act",
  fs_move: "act",
  fs_read: "ask",
  fs_search: "ask",
  fs_write: "act",
  kill: "transact",
  notes_append: "act",
  notes_preview: "act",
  notes_stick: "act",
  os_manual: "ask",
  os_search: "ask",
  preview_get_console: "ask",
  preview_get_url: "ask",
  preview_reload: "act",
  ps: "ask",
  screensaver_wake: "act",
  settings_get: "ask",
  settings_set: "act",
  os_publish: "transact",
  sys_status: "ask",
  term_exec: "act",
  term_history: "ask",
  term_read: "ask",
  term_state: "ask",
  ui_open: "act",
  window_focus: "act",
  window_move: "act",
  window_resize: "act",
} as const;

const EXPECTED_UNTRUSTED_CONTENT = [
  "fs_read",
  "fs_search",
  "os_search",
  "browser_read",
  "browser_screenshot",
  "browser_site_call",
  "browser_site_tools",
  "preview_get_console",
  "term_read",
] as const;

type InvocationClass = "ask" | "act" | "transact";

function expectedClassForName(name: string): InvocationClass | undefined {
  return EXPECTED_CLASS[name as keyof typeof EXPECTED_CLASS];
}

describe("tool invocation taxonomy", () => {
  beforeEach(resetKernelStore);

  test("pins every boot and dynamic tool to ask, act, or transact wire hints", async () => {
    const tools = VERBOS_TOOLS;
    expect(tools).toHaveLength(Object.keys(EXPECTED_CLASS).length);
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);

    for (const tool of tools) {
      const classification = expectedClassForName(tool.name);
      expect(classification, `${tool.name} needs a deliberate class`).toBeDefined();
      expect(tool.intent).toBe(classification === "ask" ? "answer" : classification);
      expect(tool.annotations?.readOnlyHint).toBe(classification === "ask");
      expect(tool.annotations?.consequentialHint).toBe(classification === "transact");
      expect(tool.annotations?.untrustedContentHint ?? false).toBe(
        EXPECTED_UNTRUSTED_CONTENT.includes(
          tool.name as (typeof EXPECTED_UNTRUSTED_CONTENT)[number],
        ),
      );
    }

    expect(
      Object.keys(EXPECTED_CLASS).sort(),
    ).toEqual(tools.map(({ name }) => name).sort());
    const captured: SpecTool[] = [];
    const modelContext: ModelContextLike = {
      async registerTool(tool) {
        captured.push(tool);
      },
    };
    const registration = registerSystemTools({ modelContext, telemetry: false });
    await registration.ready;
    try {
      expect(captured.filter(({ annotations }) => annotations?.consequentialHint).map(({ name }) => name))
        .toEqual(["os_publish", "cloud_exec", "fs_delete", "kill"]);
    } finally {
      registration.unregister();
    }
  });

  test("keeps every input schema closed and required keys declared", () => {
    type ObjectSchema = {
      type?: string;
      properties?: Record<string, unknown>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };

    for (const tool of VERBOS_TOOLS) {
      const schema = tool.inputSchema as ObjectSchema;
      const properties = schema.properties ?? {};
      expect(schema.type, `${tool.name} inputSchema must be an object`).toBe("object");
      expect(schema.additionalProperties, `${tool.name} must reject unknown keys`).toBe(false);
      for (const required of schema.required ?? []) {
        expect(
          Object.hasOwn(properties, required),
          `${tool.name} requires undeclared property '${required}'`,
        ).toBe(true);
      }
    }
  });

  test("representative self-validating tools reject unknown keys", async () => {
    for (const name of ["app_list", "settings_get", "ps"]) {
      const tool = VERBOS_TOOLS.find((candidate) => candidate.name === name) as
        | AnyWebMCPTool
        | undefined;
      expect(tool, `${name} must exist`).toBeDefined();
      await expect(tool!.execute({ unexpected: true })).rejects.toThrow(
        "verbos: input must be an empty object",
      );
    }
  });

  test("app_list exposes minimized state for every window", async () => {
    const visible = useKernelStore.getState().spawn("files");
    const minimized = useKernelStore.getState().spawn("editor");
    useKernelStore.getState().minimize(minimized.pid);
    const appList = VERBOS_TOOLS.find(({ name }) => name === "app_list") as
      | AnyWebMCPTool
      | undefined;
    expect(appList).toBeDefined();

    const result = await appList!.execute({}) as {
      processes: Array<{ pid: number; minimized: boolean }>;
    };

    expect(appList?.description).toContain("minimized state");
    expect(result.processes).toEqual([
      expect.objectContaining({ pid: visible.pid, minimized: false }),
      expect.objectContaining({ pid: minimized.pid, minimized: true }),
    ]);
  });

  test("forces site tools to act and untrusted annotations", async () => {
    const process = useKernelStore.getState().spawn("preview", { path: "~/site" });
    const captured: SpecTool[] = [];
    const modelContext: ModelContextLike = {
      async registerTool(tool) {
        captured.push(tool);
      },
    };
    const scope = createSiteToolRegistryScope(process.pid, "verbos://site/", {
      modelContext,
      telemetry: false,
    });

    try {
      const descriptorClaimingTrustedRead = {
        name: "site_claims_read_only",
        description: "Claims trusted read-only metadata.",
        annotations: {
          readOnlyHint: true,
          untrustedContentHint: false,
        },
      };
      await scope.register(descriptorClaimingTrustedRead, async () => ({ claimed: false }));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.annotations).toEqual({
        readOnlyHint: false,
        consequentialHint: false,
        untrustedContentHint: true,
      });
      expect(getActiveToolDefinition("site_claims_read_only")).toEqual(expect.objectContaining({
        intent: "act",
        annotations: {
          readOnlyHint: false,
          consequentialHint: false,
          untrustedContentHint: true,
        },
      }));
    } finally {
      scope.dispose();
    }
  });
});
