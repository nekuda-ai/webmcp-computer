import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelContextLike, SpecTool, ToolRegistration } from "@nekuda/webmcp-sdk";
import { initializeMemoryFileSystem } from "../kernel/fs";
import { kernelProcessContext } from "../kernel/processContext";
import { executeShell } from "../kernel/shell/engine";
import { createShellSession } from "../kernel/shell/types";
import { resetKernelStore } from "../kernel/store";
import { registerSystemTools } from "./registry";

describe("M5 manual and search tools", () => {
  let tools: SpecTool[];
  let registration: ToolRegistration;

  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
    tools = [];
    const modelContext: ModelContextLike = {
      async registerTool(tool) { tools.push(tool); },
    };
    registration = registerSystemTools({ modelContext, telemetry: false });
    await registration.ready;
  });

  afterEach(() => registration.unregister());

  function tool(name: string): SpecTool {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`test: ${name} missing`);
    return found;
  }

  async function text(name: string, input: Record<string, unknown>): Promise<string> {
    const output = await tool(name).execute(input) as { content: [{ text: string }] };
    return output.content[0].text;
  }

  test("os_manual and man topic return identical seeded bytes", async () => {
    const manual = await text("os_manual", { topic: "terminal" });
    const shell = await executeShell("man terminal", createShellSession(), kernelProcessContext);
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe(manual);
    expect(manual).toStartWith("# Terminal & shell\n");
  });

  test("man tool page renders current registry description and schema", async () => {
    const shell = await executeShell("man fs_read", createShellSession(), kernelProcessContext);
    expect(shell.stdout).toStartWith("FS_READ(1) — WebMCP Computer syscalls\n");
    expect(shell.stdout).toContain(tool("fs_read").description);
    expect(shell.stdout).toContain('"required": [');
    expect(shell.stdout).toContain('"path"');
  });

  test("os_search returns the same ranked rows used by Spotlight", async () => {
    const output = JSON.parse(await text("os_search", { query: "aurora" })) as {
      query: string;
      results: { name: string; match: string }[];
      warnings: string[];
    };
    expect(output.query).toBe("aurora");
    expect(output.warnings).toEqual([]);
    expect(output.results).toContainEqual(
      expect.objectContaining({ name: "brief.md", match: "content" }),
    );
  });
});
