import { defineTool } from "@nekuda/webmcp-sdk";
import { killKernelProcess, listKernelProcesses } from "../kernel/processContext";
import { useKernelStore } from "../kernel/store";
import { releaseTerminalSession, terminalSession } from "../kernel/terminalSessions";
import { runAgentAction } from "./agentAction";
import { ACT_ANNOTATIONS, ASK_ANNOTATIONS, TRANSACT_ANNOTATIONS } from "./taxonomy";

type TermExecInput = { command: string; term_pid?: number; timeout_ms?: number };
type TermReadInput = { term_pid?: number; lines?: number };
type TermStateInput = { term_pid?: number };
type TermHistoryInput = { term_pid?: number; limit?: number };
type PidInput = { pid: number };
type EmptyInput = Record<string, never>;

const MAX_OUTPUT_BYTES = 256 * 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export function truncateTerminalOutput(value: string): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return { value, truncated: false };
  return {
    value: new TextDecoder().decode(bytes.slice(0, MAX_OUTPUT_BYTES)),
    truncated: true,
  };
}

function requireEmptyInput(input: EmptyInput | null | undefined): void {
  if (input == null) return;
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
    throw new Error("webmcp-computer: input must be an empty object");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`webmcp-computer: ${name} must be a string`);
  return value;
}

function requirePid(value: unknown, name = "pid"): number {
  if (value === 1) {
    throw new Error("webmcp-computer: pid 1 is the screensaver; window pids start at 2");
  }
  if (!Number.isInteger(value) || (value as number) < 2) {
    throw new Error(`webmcp-computer: ${name} must be an integer PID starting at 2`);
  }
  return value as number;
}

function requireTimeout(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMEOUT_MS) {
    throw new Error("webmcp-computer: timeout_ms must be an integer from 1 to 120000");
  }
  return value as number;
}

function terminalProcess(pid: number) {
  const process = useKernelStore.getState().processes.find((entry) => entry.pid === pid);
  if (!process) throw new Error(`webmcp-computer: process PID ${pid} not found`);
  if (process.appId !== "terminal") throw new Error(`webmcp-computer: process PID ${pid} is not a terminal`);
  return process;
}

function selectedTerminal(): ReturnType<typeof terminalProcess> | undefined {
  return [...useKernelStore.getState().processes]
    .filter((process) => process.appId === "terminal")
    .sort((left, right) => right.zIndex - left.zIndex)[0];
}

export function resolveTermExecPid(rawPid: unknown): number {
  if (rawPid !== undefined) {
    const pid = requirePid(rawPid, "term_pid");
    terminalProcess(pid);
    return pid;
  }
  const existing = selectedTerminal();
  return existing?.pid ?? useKernelStore.getState().spawn("terminal").pid;
}

function resolveTermReadPid(rawPid: unknown): number {
  if (rawPid !== undefined) {
    const pid = requirePid(rawPid, "term_pid");
    terminalProcess(pid);
    return pid;
  }
  const process = selectedTerminal();
  if (!process) throw new Error("webmcp-computer: no terminal is open");
  return process.pid;
}

export const termExecTool = defineTool<TermExecInput>({
  stableKey: "webmcp_computer.term_exec",
  name: "term_exec",
  title: "Execute terminal command",
  description:
    "Visibly type and execute one just-bash command against the shared WebMCP Computer filesystem. Opens a Terminal when none exists; optionally target a terminal PID. Supports pipes, redirects, variables, subshells, jq, awk, sed, grep, and other bundled commands; network, Python, and JavaScript runtimes are disabled. Times out after 30s by default; timeout_ms can set up to 120s. Returns stdout, stderr, exit_code, and truncated after output appears; stdout and stderr are each capped at 256 KB.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, description: "Shell command to type and execute." },
      term_pid: { type: "integer", minimum: 2, description: "Optional PID of an open Terminal window." },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: "Execution timeout in milliseconds; defaults to 30000 and caps at 120000.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ command: rawCommand, term_pid: rawPid, timeout_ms: rawTimeout }) {
    return runAgentAction(
      "term_exec",
      {
        command: rawCommand,
        ...(rawPid === undefined ? {} : { term_pid: rawPid, pid: rawPid }),
        ...(rawTimeout === undefined ? {} : { timeout_ms: rawTimeout }),
        appId: "terminal",
      },
      async () => {
        const command = requireString(rawCommand, "command");
        const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : requireTimeout(rawTimeout);
        const pid = resolveTermExecPid(rawPid);
        terminalProcess(pid);
        useKernelStore.getState().focus(pid);
        const session = terminalSession(pid);
        await session.waitForView();
        const result = await session.run(command, "agent", { timeoutMs });
        const stdout = truncateTerminalOutput(result.stdout);
        const stderr = truncateTerminalOutput(result.stderr);
        return {
          stdout: stdout.value,
          stderr: stderr.value,
          exit_code: result.exitCode,
          truncated: stdout.truncated || stderr.truncated,
        };
      },
    );
  },
});

export const termReadTool = defineTool<TermReadInput>({
  stableKey: "webmcp_computer.term_read",
  name: "term_read",
  title: "Read terminal scrollback",
  description:
    "Read the last lines of an open WebMCP Computer Terminal's shared 2000-line scrollback. Defaults to the frontmost Terminal and 50 lines; returns the terminal PID, plain-text lines, and truncated when older scrollback was discarded.",
  inputSchema: {
    type: "object",
    properties: {
      term_pid: { type: "integer", minimum: 2, description: "Optional PID of an open Terminal window." },
      lines: { type: "integer", minimum: 1, maximum: 200, description: "Number of trailing lines; defaults to 50." },
    },
    additionalProperties: false,
  },
  annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
  intent: "answer",
  execute(input) {
    const { term_pid: rawPid, lines: rawLines } = input ?? {};
    return runAgentAction("term_read", { ...(rawPid === undefined ? {} : { term_pid: rawPid }) }, () => {
      const pid = resolveTermReadPid(rawPid);
      const lines = rawLines === undefined ? 50 : rawLines;
      if (!Number.isInteger(lines) || lines < 1 || lines > 200) {
        throw new Error("webmcp-computer: lines must be an integer from 1 to 200");
      }
      const session = terminalSession(pid);
      return {
        term_pid: pid,
        lines: session.read(lines),
        truncated: session.hasTruncatedScrollback(),
      };
    });
  },
});

export const termStateTool = defineTool<TermStateInput>({
  stableKey: "webmcp_computer.term_state",
  name: "term_state",
  title: "Read terminal session state",
  description:
    "Read the live shell session behind the frontmost Terminal: PID, cwd, busy state, optional running command, and environment. Pass term_pid to target another Terminal. This reads session objects, never parsed scrollback.",
  inputSchema: {
    type: "object",
    properties: {
      term_pid: { type: "integer", minimum: 2, description: "Optional PID of an open Terminal window." },
    },
    additionalProperties: false,
  },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    const rawPid = input?.term_pid;
    return runAgentAction("term_state", { ...(rawPid === undefined ? {} : { term_pid: rawPid }) }, () => {
      const pid = resolveTermReadPid(rawPid);
      return terminalSession(pid).state();
    });
  },
});

export const termHistoryTool = defineTool<TermHistoryInput>({
  stableKey: "webmcp_computer.term_history",
  name: "term_history",
  title: "Read terminal command history",
  description:
    "Read structured command history from the live frontmost Terminal session, shared with the human and ordered oldest to newest. Defaults to 50 entries; pass term_pid to target another Terminal.",
  inputSchema: {
    type: "object",
    properties: {
      term_pid: { type: "integer", minimum: 2, description: "Optional PID of an open Terminal window." },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Trailing history entries; defaults to 50." },
    },
    additionalProperties: false,
  },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    const { term_pid: rawPid, limit: rawLimit } = input ?? {};
    return runAgentAction("term_history", { ...(rawPid === undefined ? {} : { term_pid: rawPid }) }, () => {
      const limit = rawLimit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("webmcp-computer: limit must be an integer from 1 to 1000");
      }
      const pid = resolveTermReadPid(rawPid);
      return terminalSession(pid).history(limit);
    });
  },
});

export const psTool = defineTool<EmptyInput>({
  stableKey: "webmcp_computer.ps",
  name: "ps",
  title: "List processes",
  description:
    "List the real WebMCP Computer process table: PID 1, open app windows, and transient running shell commands. Returns small records with PID, kind, command, and optional app or cwd.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute(input) {
    return runAgentAction("ps", {}, () => {
      requireEmptyInput(input);
      return { processes: listKernelProcesses() };
    });
  },
});

export const killTool = defineTool<PidInput>({
  stableKey: "webmcp_computer.kill",
  name: "kill",
  title: "Kill process",
  description:
    "Terminate one WebMCP Computer app window or transient shell command by PID. PID 1 is protected. Returns the killed process record; throws when the PID does not exist.",
  inputSchema: {
    type: "object",
    properties: { pid: { type: "integer", minimum: 2, description: "Process PID to terminate." } },
    required: ["pid"],
    additionalProperties: false,
  },
  annotations: TRANSACT_ANNOTATIONS,
  intent: "transact",
  execute({ pid: rawPid }) {
    const window = useKernelStore.getState().processes.find((process) => process.pid === rawPid);
    return runAgentAction(
      "kill",
      {
        pid: rawPid,
        ...(window === undefined ? {} : {
          appId: window.appId,
          rect: window.windowRect,
        }),
      },
      () => {
        const pid = requirePid(rawPid);
        const killed = killKernelProcess(pid);
        if (!killed) throw new Error(`webmcp-computer: process PID ${pid} not found`);
        if (killed.appId === "terminal") releaseTerminalSession(pid);
        return { killed: true, ...killed };
      },
    );
  },
});

export const terminalTools = [
  termExecTool,
  termReadTool,
  termStateTool,
  termHistoryTool,
  psTool,
  killTool,
] as const;
