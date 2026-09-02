import { shellPromptPath } from "./shell/paths";
import {
  createShellSession,
  type ShellExecutionSource,
  type ShellResult,
  type ShellSession,
} from "./shell/types";
import { kernelProcessContext } from "./processContext";
import { useKernelStore } from "./store";
import { machineIdentity } from "./identity";
import type { ExecuteShellOptions } from "./shell/engine";
import type {
  CloudExecDependencies,
  CloudExecRequest,
  CloudExecResult,
} from "./cloudExec";

export type TerminalLine = {
  text: string;
  tone: "input" | "output" | "error";
  source?: ShellExecutionSource;
};

export type TerminalSessionEvent =
  | { type: "reset"; lines: readonly TerminalLine[]; prompt: string }
  | { type: "typing"; command: string; prompt: string }
  | { type: "input"; command: string; prompt: string; source: ShellExecutionSource }
  | { type: "output"; text: string; tone: "output" | "error" }
  | { type: "clear" }
  | { type: "prompt"; prompt: string };

type Listener = (event: TerminalSessionEvent) => void;

const MAX_SCROLLBACK_LINES = 2_000;
const MAX_VISIBLE_TYPING_MS = 4_000;

type RunOptions = {
  inputAlreadyRendered?: boolean;
  typeDelayMs?: number;
  timeoutMs?: number;
  cloudExecDependencies?: CloudExecDependencies;
  cloudExecRequest?: CloudExecRequest;
  onCloudExecResult?: (result: CloudExecResult) => void;
};

type ActiveRun = {
  controller: AbortController;
  command: string;
  reason?: "interrupt" | "timeout";
};

type ShellExecutor = (
  sourceText: string,
  session: ShellSession,
  processes: typeof kernelProcessContext,
  options?: ExecuteShellOptions,
) => Promise<ShellResult>;

let shellExecutor: ShellExecutor | undefined;

export function setTerminalShellExecutor(executor: ShellExecutor): void {
  shellExecutor = executor;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(done, milliseconds);
    function done() {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function promptFor(session: ShellSession, source: ShellExecutionSource = "human"): string {
  const hostname = useKernelStore.getState().settings.hostname;
  const { host } = machineIdentity(hostname);
  const identity = source === "agent" ? `codex@${host}` : hostname;
  return `${identity}:${shellPromptPath(session.cwd)}$`;
}

function transcriptLines(text: string, tone: TerminalLine["tone"]): TerminalLine[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const values = normalized.split("\n");
  if (values.at(-1) === "") values.pop();
  return values.map((value) => ({ text: value, tone }));
}

export class TerminalSessionController {
  readonly shell: ShellSession;
  private readonly listeners = new Set<Listener>();
  private readonly lines: TerminalLine[] = [];
  private scrollbackWasTruncated = false;
  private viewCount = 0;
  private readyWaiters = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private activeRun: ActiveRun | undefined;

  constructor(readonly pid: number) {
    const process = useKernelStore.getState().processes.find((entry) => entry.pid === pid);
    this.shell = createShellSession(process?.cwd ?? "~");
  }

  private syncIdentity(): void {
    const identity = machineIdentity(useKernelStore.getState().settings.hostname);
    this.shell.env.USER = identity.user;
    this.shell.env.HOSTNAME = identity.host;
  }

  attach(listener: Listener): () => void {
    this.listeners.add(listener);
    this.viewCount += 1;
    listener({ type: "reset", lines: this.lines, prompt: promptFor(this.shell) });
    for (const resolve of this.readyWaiters) resolve();
    this.readyWaiters.clear();
    return () => {
      this.listeners.delete(listener);
      this.viewCount = Math.max(0, this.viewCount - 1);
    };
  }

  async waitForView(): Promise<void> {
    if (this.viewCount > 0 || typeof document === "undefined") return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.readyWaiters.delete(ready);
        reject(new Error(`webmcp-computer: terminal PID ${this.pid} did not become visible`));
      }, 2_000);
      const ready = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      this.readyWaiters.add(ready);
    });
  }

  read(lines = 50): string[] {
    return this.lines.slice(-lines).map(({ text }) => text);
  }

  hasTruncatedScrollback(): boolean {
    return this.scrollbackWasTruncated;
  }

  state(): {
    pid: number;
    cwd: string;
    busy: boolean;
    running_command?: string;
    env: Record<string, string>;
  } {
    this.syncIdentity();
    return {
      pid: this.pid,
      cwd: this.shell.cwd,
      busy: this.activeRun !== undefined,
      ...(this.activeRun === undefined ? {} : { running_command: this.activeRun.command }),
      env: { ...this.shell.env },
    };
  }

  history(limit = 50): { index: number; command: string }[] {
    const start = Math.max(0, this.shell.history.length - limit);
    return this.shell.history.slice(start).map((command, offset) => ({
      index: start + offset + 1,
      command,
    }));
  }

  interrupt(): boolean {
    if (!this.activeRun) return false;
    this.activeRun.reason = "interrupt";
    this.activeRun.controller.abort();
    return true;
  }

  run(
    command: string,
    source: ShellExecutionSource,
    options: RunOptions = {},
  ): Promise<ShellResult> {
    let resolveResult: (result: ShellResult) => void = () => {};
    let rejectResult: (error: unknown) => void = () => {};
    const result = new Promise<ShellResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.queue = this.queue.then(async () => {
      try {
        resolveResult(await this.runNow(command, source, options));
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async runNow(
    command: string,
    source: ShellExecutionSource,
    options: RunOptions,
  ): Promise<ShellResult> {
    this.syncIdentity();
    const activeRun: ActiveRun = { controller: new AbortController(), command };
    this.activeRun = activeRun;
    const prompt = promptFor(this.shell, source);
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      if (source === "agent") {
        let typed = "";
        this.emit({ type: "typing", command: typed, prompt });
        const reducedMotion = typeof window === "undefined" ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const requestedDelay = options.typeDelayMs ?? (reducedMotion ? 0 : 20);
        const typeDelayMs = Math.min(
          requestedDelay,
          MAX_VISIBLE_TYPING_MS / Math.max(1, command.length),
        );
        for (const character of command) {
          if (activeRun.controller.signal.aborted) break;
          typed += character;
          this.emit({ type: "typing", command: typed, prompt });
          if (typeDelayMs > 0 && typed.length < command.length) {
            await delay(typeDelayMs, activeRun.controller.signal);
          }
        }
      }

      if (activeRun.reason === "interrupt") {
        this.shell.lastExitCode = 130;
        return { stdout: "", stderr: "", exitCode: 130 };
      }

      this.appendLines({ text: `${prompt} ${command}`, tone: "input", source });
      if (!options.inputAlreadyRendered || source === "agent") {
        this.emit({ type: "input", command, prompt, source });
      }

      if (options.timeoutMs !== undefined) {
        const timeOut = () => {
          activeRun.reason = "timeout";
          activeRun.controller.abort();
        };
        if (options.timeoutMs <= 0) timeOut();
        else timeout = globalThis.setTimeout(timeOut, options.timeoutMs);
      }

      const output = (text: string, tone: "output" | "error") => {
        if (
          activeRun.reason && (
            text === "bash: execution aborted\n" ||
            (activeRun.reason === "interrupt" && text.startsWith("webmcp-computer: cloud exec failed:"))
          )
        ) return;
        this.appendLines(...transcriptLines(text, tone));
        this.emit({ type: "output", text, tone });
      };
      if (!shellExecutor) throw new Error("webmcp-computer: terminal shell is not loaded");
      const result = await shellExecutor(command, this.shell, kernelProcessContext, {
        source,
        signal: activeRun.controller.signal,
        ...(options.cloudExecDependencies === undefined ? {} : {
          cloudExecDependencies: options.cloudExecDependencies,
        }),
        ...(options.cloudExecRequest === undefined ? {} : { cloudExecRequest: options.cloudExecRequest }),
        ...(options.onCloudExecResult === undefined ? {} : {
          onCloudExecResult: options.onCloudExecResult,
        }),
        onStdout: (text) => output(text, "output"),
        onStderr: (text) => output(text, "error"),
        onClear: () => {
          this.lines.length = 0;
          this.scrollbackWasTruncated = false;
          this.emit({ type: "clear" });
        },
      });
      if (activeRun.reason === "timeout") {
        throw new Error(`webmcp-computer: command timed out after ${(options.timeoutMs ?? 0) / 1_000}s`);
      }
      if (activeRun.reason === "interrupt") {
        this.shell.lastExitCode = 130;
        return { stdout: result.stdout, stderr: "", exitCode: 130 };
      }
      return result;
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      if (this.activeRun === activeRun) this.activeRun = undefined;
      useKernelStore.getState().setProcessCwd(this.pid, this.shell.cwd);
      this.emit({ type: "prompt", prompt: promptFor(this.shell) });
    }
  }

  private appendLines(...lines: TerminalLine[]): void {
    this.lines.push(...lines);
    if (this.lines.length <= MAX_SCROLLBACK_LINES) return;
    this.lines.splice(0, this.lines.length - MAX_SCROLLBACK_LINES);
    this.scrollbackWasTruncated = true;
  }

  private emit(event: TerminalSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const sessions = new Map<number, TerminalSessionController>();

export function terminalSession(pid: number): TerminalSessionController {
  let session = sessions.get(pid);
  if (!session) {
    session = new TerminalSessionController(pid);
    sessions.set(pid, session);
  }
  return session;
}

export function releaseTerminalSession(pid: number): void {
  sessions.delete(pid);
}

export function resetTerminalSessions(): void {
  sessions.clear();
}
