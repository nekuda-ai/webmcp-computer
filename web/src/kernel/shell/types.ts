import type { EventSource } from "../types";
import type {
  CloudExecDependencies,
  CloudExecRequest,
  CloudExecResult,
} from "../cloudExec";

export type ShellExecutionSource = Extract<EventSource, "agent" | "human">;

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  clear?: boolean;
};

export type ShellSession = {
  cwd: string;
  env: Record<string, string>;
  history: string[];
  lastExitCode: number;
};

export type ShellProcess = {
  pid: number;
  kind: "window" | "command";
  command: string;
  appId?: string;
  cwd?: string;
  minimized?: boolean;
};

export type ServedShellProcess = ShellProcess & {
  root: string;
  reused: boolean;
};

export type ShellEvent = {
  source: EventSource;
  verb: string;
  args: Readonly<Record<string, unknown>>;
  ts: number;
  ok?: boolean;
  reason?: string;
};

export type StartedShellProcess = {
  pid: number;
  signal?: AbortSignal;
};

export type ShellProcessContext = {
  start(command: string, cwd: string): StartedShellProcess;
  finish(pid: number): void;
  list(): ShellProcess[];
  kill(pid: number): ShellProcess | undefined;
  open(target: string, cwd: string, source: ShellExecutionSource): Promise<ShellProcess>;
  serve(target: string, cwd: string, source: ShellExecutionSource): Promise<ServedShellProcess>;
  events(): readonly ShellEvent[];
};

export type CommandContext = {
  session: ShellSession;
  stdin: string;
  source: ShellExecutionSource;
  processes: ShellProcessContext;
  signal?: AbortSignal;
  cloudExecDependencies?: CloudExecDependencies;
  cloudExecRequest?: CloudExecRequest;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  onCloudExecResult?(result: CloudExecResult): void;
};

export type CommandRunResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  clear?: boolean;
};

export type CommandFlag = {
  short: string;
  long?: string;
  value?: string;
  description: string;
};

export type ShellCommand = {
  name: string;
  summary: string;
  usage: string;
  flags: readonly CommandFlag[];
  description?: string;
  run(context: CommandContext, args: readonly string[]): Promise<CommandRunResult>;
};

export function createShellSession(cwd = "~"): ShellSession {
  return {
    cwd,
    env: {
      HOME: "~",
      HOSTNAME: "webmcp-computer",
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/webmcp-computer",
      USER: "guest",
    },
    history: [],
    lastExitCode: 0,
  };
}

export function commandResult(result: CommandRunResult = {}): ShellResult {
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
    ...(result.clear === undefined ? {} : { clear: result.clear }),
  };
}
