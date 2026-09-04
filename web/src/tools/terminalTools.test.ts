import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ModelContextLike,
  RegisterToolOptions,
  SpecTool,
  ToolRegistration,
} from "@nekuda/webmcp-sdk";
import { initializeMemoryFileSystem, readFile, writeFile } from "../kernel/fs";
import { executeShell } from "../kernel/shell/engine";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import {
  resetTerminalSessions,
  setTerminalShellExecutor,
  terminalSession,
  TerminalSessionController,
  type TerminalSessionEvent,
} from "../kernel/terminalSessions";
import { abortInFlightAgentActions } from "./agentAction";
import { registerSystemTools } from "./registry";
import { termExecTool } from "./terminalTools";

let captured: SpecTool[] = [];
let registration: ToolRegistration;

setTerminalShellExecutor(executeShell);

function modelContext(): ModelContextLike {
  return {
    async registerTool(tool: SpecTool, _options?: RegisterToolOptions) {
      captured.push(tool);
    },
  };
}

function tool(name: string): SpecTool {
  const value = captured.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`test: ${name} was not registered`);
  return value;
}

async function invoke(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool(name).execute(input);
  expect(result).toEqual({ content: [{ type: "text", text: expect.any(String) }] });
  return JSON.parse((result as { content: [{ text: string }] }).content[0].text) as Record<
    string,
    unknown
  >;
}

async function invokeValue(name: string, input: Record<string, unknown>): Promise<unknown> {
  const result = await tool(name).execute(input);
  expect(result).toEqual({ content: [{ type: "text", text: expect.any(String) }] });
  return JSON.parse((result as { content: [{ text: string }] }).content[0].text) as unknown;
}

describe("M3 terminal tools", () => {
  beforeEach(async () => {
    resetKernelStore();
    resetTerminalSessions();
    await initializeMemoryFileSystem();
    captured = [];
    registration = registerSystemTools({ modelContext: modelContext(), telemetry: false });
    await registration.ready;
  });

  afterEach(() => {
    registration.unregister();
    resetTerminalSessions();
  });

  test("term_exec caps output at 256 KB and reports truncation", async () => {
    const content = "x".repeat(256 * 1_024 + 17);
    await writeFile("~/site/large.txt", content, "system");

    expect(await invoke("term_exec", { command: "cat ~/site/large.txt" })).toEqual({
      stdout: "x".repeat(256 * 1_024),
      stderr: "",
      exit_code: 0,
      truncated: true,
    });
  });

  test("term_exec keeps the action admission through a delayed shell mutation", async () => {
    const path = "~/site/delayed-terminal.txt";
    await writeFile(path, "initial", "system");
    let releaseShell = () => {};
    const shellGate = new Promise<void>((resolve) => { releaseShell = resolve; });
    let markShellStarted = () => {};
    const shellStarted = new Promise<void>((resolve) => { markShellStarted = resolve; });
    let markShellSettled = () => {};
    const shellSettled = new Promise<void>((resolve) => { markShellSettled = resolve; });

    setTerminalShellExecutor(async (_command, _session, _processes, options) => {
      markShellStarted();
      await shellGate;
      try {
        if (!options?.ownershipAdmission) throw new Error("test: missing terminal admission");
        await writeFile(path, "stale terminal", options.ownershipAdmission);
        return { stdout: "", stderr: "", exitCode: 0 };
      } finally {
        markShellSettled();
      }
    });
    try {
      const action = termExecTool.execute({ command: `echo stale > ${path}` });
      await shellStarted;
      useKernelStore.getState().setMachineOwnership("conflict");
      abortInFlightAgentActions();
      await expect(action).rejects.toThrow("machine ownership was lost to another tab");
      useKernelStore.getState().setMachineOwnership("owned");
      await writeFile(path, "new owner", "human");

      releaseShell();
      await shellSettled;
      expect(await readFile(path)).toBe("new owner");
    } finally {
      setTerminalShellExecutor(executeShell);
    }
  });

  test("term_read reports when backing scrollback discarded old lines", async () => {
    const content = `${Array.from({ length: 2_101 }, (_, index) => `line-${index}`).join("\n")}\n`;
    await writeFile("~/site/lines.txt", content, "system");
    await invoke("term_exec", { command: "cat ~/site/lines.txt" });

    const result = await invoke("term_read", { lines: 200 });
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(200);
    expect((result.lines as string[]).at(-1)).toBe("line-2100");
  });

  test("terminal session timeout aborts its pipeline and rejects", async () => {
    const controller = new TerminalSessionController(2);
    const events: TerminalSessionEvent[] = [];
    controller.attach((event) => events.push(event));

    await expect(
      controller.run("echo never", "agent", { typeDelayMs: 0, timeoutMs: 0 }),
    ).rejects.toThrow("webmcp-computer: command timed out after 0s");
    expect(useKernelStore.getState().commandProcesses).toEqual([]);
    expect(events.some((event) => event.type === "output" &&
      event.text === "bash: execution aborted\n")).toBe(false);
  });

  test("terminal session accepts Ctrl+C while busy", async () => {
    const controller = new TerminalSessionController(2);
    const events: TerminalSessionEvent[] = [];
    let interrupted = false;
    controller.attach((event) => {
      events.push(event);
      if (event.type === "typing" && event.command === "") interrupted = controller.interrupt();
    });

    expect(await controller.run("echo interrupted", "agent", { typeDelayMs: 100 })).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 130,
    });
    expect(interrupted).toBe(true);
    expect(events.at(-1)?.type).toBe("prompt");
  });

  test("term_state reads cwd, env, and active command from the live session", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    const controller = terminalSession(process.pid);
    await controller.run("cd ~/site; export TRAIL=aurora", "human", { typeDelayMs: 0 });

    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const detach = controller.attach((event) => {
      if (event.type === "typing") markStarted();
    });
    const running = controller.run("echo visibly-running", "agent", { typeDelayMs: 30 });
    await started;
    const state = await invoke("term_state", { term_pid: process.pid });
    expect(state).toEqual({
      pid: process.pid,
      cwd: "~/site",
      busy: true,
      running_command: "echo visibly-running",
      env: expect.objectContaining({ TRAIL: "aurora" }),
    });
    expect(state.env).not.toHaveProperty("?");
    await running;
    detach();
    expect(await invoke("term_state", { term_pid: process.pid })).toEqual(
      expect.objectContaining({ pid: process.pid, cwd: "~/site", busy: false }),
    );
  });

  test("term_history returns shared human and agent commands newest last", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    const controller = terminalSession(process.pid);
    await controller.run("pwd", "human", { typeDelayMs: 0 });
    await invoke("term_exec", { command: "echo agent", term_pid: process.pid });

    expect(await invokeValue("term_history", { term_pid: process.pid, limit: 2 })).toEqual([
      { index: 1, command: "pwd" },
      { index: 2, command: "echo agent" },
    ]);
  });

  test("a command that keeps cwd does not replace the process array", async () => {
    const process = useKernelStore.getState().spawn("terminal");
    useKernelStore.getState().setProcessCwd(process.pid, "~");
    const processes = useKernelStore.getState().processes;

    await terminalSession(process.pid).run("pwd", "human", { typeDelayMs: 0 });

    expect(useKernelStore.getState().processes).toBe(processes);
  });

  test("configured hostname feeds human and agent prompts", async () => {
    useKernelStore.setState((state) => ({
      settings: { ...state.settings, hostname: "builder@aurora" },
    }));
    const controller = new TerminalSessionController(2);
    const prompts: string[] = [];
    controller.attach((event) => {
      if (event.type === "reset" || event.type === "typing") prompts.push(event.prompt);
    });
    await controller.run("echo prompt", "agent", { typeDelayMs: 0 });
    expect(prompts[0]).toBe("builder@aurora:~$");
    expect(prompts).toContain("codex@aurora:~$");
  });

  test("kill reports PID 1 as screensaver across tool and shell", async () => {
    await expect(invoke("kill", { pid: 1 })).rejects.toThrow(
      "webmcp-computer: pid 1 is the screensaver; window pids start at 2",
    );
    expect(await invoke("term_exec", { command: "kill 1" })).toEqual({
      stdout: "",
      stderr: "webmcp-computer: pid 1 is the screensaver; window pids start at 2\n",
      exit_code: 1,
      truncated: false,
    });
  });
});
