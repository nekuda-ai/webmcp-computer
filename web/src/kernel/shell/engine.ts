import {
  Bash,
  defineCommand,
  getCommandNames,
  type Command,
  type CommandName,
  type ExecResult,
} from "just-bash/browser";
import { machineIdentity } from "../identity";
import { useKernelStore } from "../store";
import {
  JustBashFileSystem,
  justBashPathFromKernel,
  kernelPathFromJustBash,
} from "./justBashFs";
import { ShellUsageError } from "./options";
import { commandRegistry, getShellCommand, renderCommandHelp } from "./registry";
import { errorMessage } from "../../shared";
import type {
  CommandContext,
  ShellExecutionSource,
  ShellProcessContext,
  ShellResult,
  ShellSession,
} from "./types";
import type {
  CloudExecDependencies,
  CloudExecRequest,
  CloudExecResult,
} from "../cloudExec";
import {
  appendCloudOutput,
  cloudOutputText,
  createCloudOutputBuffer,
  type CloudOutputBuffer,
} from "../cloudExec";
import {
  assertMachineMutationAdmission,
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../ownershipAdmission";

export type ExecuteShellOptions = {
  source?: ShellExecutionSource;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onClear?: () => void;
  signal?: AbortSignal;
  cloudExecDependencies?: CloudExecDependencies;
  cloudExecRequest?: CloudExecRequest;
  onCloudExecResult?: (result: CloudExecResult) => void;
  ownershipAdmission?: MachineMutationAdmission;
};

type ActiveExecution = {
  source: ShellExecutionSource;
  ownershipAdmission: MachineMutationAdmission;
  processes: ShellProcessContext;
  clear: boolean;
  signal?: AbortSignal;
  cloudExecDependencies?: CloudExecDependencies;
  cloudExecRequest?: CloudExecRequest;
  onCloudExecResult?: (result: CloudExecResult) => void;
  streamedStdout: CloudOutputBuffer;
  streamedStderr: CloudOutputBuffer;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
};

type ShellRuntime = {
  bash: Bash;
  session: ShellSession;
  active: ActiveExecution | undefined;
};

const runtimes = new WeakMap<ShellSession, Promise<ShellRuntime>>();
const webmcpComputerCommandNames = new Set(commandRegistry.map(({ name }) => name));
const unavailableBrowserCommandNames = new Set(["tar", "yq", "xan", "sqlite3"]);
const justBashCommandNames = getCommandNames().filter((name) =>
  !webmcpComputerCommandNames.has(name) && !unavailableBrowserCommandNames.has(name)
) as CommandName[];

function withNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function commandError(error: unknown): ExecResult {
  return {
    stdout: "",
    stderr: withNewline(errorMessage(error)),
    exitCode: error instanceof ShellUsageError ? 2 : 1,
  };
}

function bashEnvironment(session: ShellSession): Record<string, string> {
  return Object.fromEntries(Object.entries(session.env).filter(([name]) => name !== "?").map(([name, value]) => {
    if (name === "HOME") return [name, justBashPathFromKernel("~")];
    if ((name === "PWD" || name === "OLDPWD") && (value === "~" || value.startsWith("~/"))) {
      return [name, justBashPathFromKernel(value)];
    }
    return [name, value];
  }));
}

function syncSession(
  session: ShellSession,
  env: Record<string, string>,
  exitCode: number,
): void {
  const cwd = kernelPathFromJustBash(env.PWD ?? justBashPathFromKernel(session.cwd));
  const nextEnv: Record<string, string> = {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => name !== "?")),
    HOME: "~",
    PWD: cwd,
  };
  if (nextEnv.OLDPWD?.startsWith("/")) {
    nextEnv.OLDPWD = kernelPathFromJustBash(nextEnv.OLDPWD);
  }
  for (const name of Object.keys(session.env)) delete session.env[name];
  Object.assign(session.env, nextEnv);
  session.cwd = cwd;
  session.lastExitCode = exitCode;
}

function commandContext(
  runtime: ShellRuntime,
  cwd: string,
  env: Map<string, string>,
): CommandContext | undefined {
  const active = runtime.active;
  if (!active) return undefined;
  return {
    session: {
      ...runtime.session,
      cwd: kernelPathFromJustBash(cwd),
      env: Object.fromEntries(env),
    },
    stdin: "",
    source: active.source,
    ownershipAdmission: active.ownershipAdmission,
    processes: active.processes,
    ...(active.signal === undefined ? {} : { signal: active.signal }),
    ...(active.cloudExecDependencies === undefined ? {} : {
      cloudExecDependencies: active.cloudExecDependencies,
    }),
    ...(active.cloudExecRequest === undefined ? {} : { cloudExecRequest: active.cloudExecRequest }),
    writeStdout: active.writeStdout,
    writeStderr: active.writeStderr,
    ...(active.onCloudExecResult === undefined ? {} : {
      onCloudExecResult: active.onCloudExecResult,
    }),
  };
}

function webmcpComputerCommand(runtime: ShellRuntime, name: string): Command {
  const command = getShellCommand(name);
  if (!command) throw new Error(`webmcp-computer: shell command '${name}' is not registered`);
  return defineCommand(name, async (args, justBashContext) => {
    const showLocalHelp = name === "cloud"
      ? args[0] === "--help" || args[0] === "-h"
      : args.includes("--help");
    if (showLocalHelp) {
      return { stdout: renderCommandHelp(command), stderr: "", exitCode: 0 };
    }
    const context = commandContext(runtime, justBashContext.cwd, justBashContext.env);
    if (!context) return commandError(new Error("webmcp-computer: shell execution context unavailable"));
    try {
      const result = await command.run(
        context,
        name === "cloud"
          ? args
          : args.map((arg) => arg.startsWith("/") ? kernelPathFromJustBash(arg) : arg),
      );
      if (result.clear) {
        const active = runtime.active;
        if (!active) throw new Error("webmcp-computer: shell execution context unavailable");
        active.clear = true;
      }
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    } catch (error) {
      return commandError(error);
    }
  });
}

function catCommand(): Command {
  return defineCommand("cat", async (args, context) => {
    const operands: string[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg === "--") {
        optionsEnded = true;
      } else if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
        operands.push(arg);
      }
    }
    if (operands.length === 1 && operands[0] !== "-") {
      const operand = operands[0] ?? "";
      try {
        const target = context.fs.resolvePath(context.cwd, operand);
        if ((await context.fs.stat(target)).isDirectory) {
          return {
            stdout: "",
            stderr: `cat: ${operand}: Is a directory\n`,
            exitCode: 1,
          };
        }
      } catch {
        // Bundled cat owns all non-directory errors and option behavior.
      }
    }
    return context.origCommand?.(args) ?? commandError(new Error("webmcp-computer: cat unavailable"));
  });
}

function whichCommand(): Command {
  return defineCommand("which", async (args, context) => {
    if (args.includes("--help")) {
      return context.origCommand?.(args) ?? commandError(new Error("webmcp-computer: which unavailable"));
    }

    let showAll = false;
    let silent = false;
    const operands: string[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg === "--") {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
        for (const flag of arg.slice(1)) {
          if (flag === "a") showAll = true;
          else if (flag === "s") silent = true;
          else {
            return context.origCommand?.(args) ??
              commandError(new Error(`which: invalid option -- '${flag}'`));
          }
        }
        continue;
      }
      operands.push(arg);
    }
    if (operands.length === 0) return { stdout: "", stderr: "", exitCode: 1 };

    const registered = new Set(context.getRegisteredCommands?.() ?? []);
    const pathEntries = (context.env.get("PATH") ?? "/usr/bin:/bin").split(":").filter(Boolean);
    const output: string[] = [];
    let allFound = true;
    for (const operand of operands) {
      const matches: string[] = [];
      for (const directory of pathEntries) {
        const target = context.fs.resolvePath(directory, operand);
        if (
          !operand.includes("/") && registered.has(operand) &&
          (directory === "/usr/bin" || directory === "/bin")
        ) {
          matches.push(target);
        } else if (await context.fs.exists(target)) {
          matches.push(target);
        }
        if (!showAll && matches.length > 0) break;
      }
      if (matches.length === 0) allFound = false;
      else if (!silent) output.push(...matches);
    }
    return {
      stdout: output.length === 0 ? "" : `${output.join("\n")}\n`,
      stderr: "",
      exitCode: allFound ? 0 : 1,
    };
  });
}

function envCommand(): Command {
  return defineCommand("env", async (args, context) => {
    const status = context.env.get("?");
    context.env.delete("?");
    try {
      return await context.origCommand?.(args) ?? commandError(new Error("webmcp-computer: env unavailable"));
    } finally {
      if (status !== undefined) context.env.set("?", status);
    }
  });
}

function helpCommand(): Command {
  return defineCommand("os_help", async (args, context) => {
    if (args.length > 0) {
      const command = getShellCommand(args[0] ?? "");
      if (command && args.length === 1) {
        return { stdout: renderCommandHelp(command), stderr: "", exitCode: 0 };
      }
      const builtin = await context.exec?.(`help ${args[0] ?? ""}`, { cwd: context.cwd });
      if (builtin?.exitCode === 0) return builtin;
      return context.exec?.(`${args[0] ?? ""} --help`, { cwd: context.cwd }) ??
        commandError(new Error("webmcp-computer: help unavailable"));
    }
    const builtin = await context.exec?.("help", { cwd: context.cwd });
    const nativeNames = justBashCommandNames;
    const webmcpComputerNames = commandRegistry.map(({ name }) => name);
    return {
      stdout: [
        builtin?.stdout.trimEnd() ?? "just-bash shell builtins unavailable",
        "",
        `just-bash commands (${nativeNames.length}):`,
        `  ${nativeNames.join(" ")}`,
        "",
        `WebMCP Computer commands (${webmcpComputerNames.length}):`,
        `  ${webmcpComputerNames.join(" ")}`,
        "",
        "Run 'os_help [COMMAND]' for combined help; standalone 'help [COMMAND]' is its alias.",
        "Inside pipelines or subshells, 'help' is just-bash help. Run 'man TOPIC' for manuals.",
        "",
      ].join("\n"),
      stderr: builtin?.stderr ?? "",
      exitCode: builtin?.exitCode ?? 0,
    };
  });
}

async function createRuntime(session: ShellSession): Promise<ShellRuntime> {
  let runtime: ShellRuntime | undefined;
  const fs = new JustBashFileSystem(() => {
    const admission = runtime?.active?.ownershipAdmission;
    if (!admission) throw new Error("webmcp-computer: shell execution source unavailable");
    return admission;
  });
  const shellRuntime = {} as ShellRuntime;
  runtime = shellRuntime;
  shellRuntime.session = session;
  shellRuntime.active = undefined;
  shellRuntime.bash = new Bash({
    fs,
    cwd: justBashPathFromKernel(session.cwd),
    env: bashEnvironment(session),
    commands: justBashCommandNames,
    customCommands: [
      ...commandRegistry.map(({ name }) => webmcpComputerCommand(shellRuntime, name)),
      catCommand(),
      envCommand(),
      whichCommand(),
      helpCommand(),
    ],
  });
  return shellRuntime;
}

function runtimeFor(session: ShellSession): Promise<ShellRuntime> {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = createRuntime(session);
    runtimes.set(session, runtime);
  }
  return runtime;
}

function executableSource(sourceText: string, previousExitCode: number): string {
  const directHelp = /^\s*help(?:\s+([A-Za-z0-9_-]+))?\s*$/.exec(sourceText);
  const command = !directHelp
    ? sourceText
    : directHelp[1] === undefined
    ? "os_help"
    : `os_help ${directHelp[1]}`;
  return `(exit ${previousExitCode}); ${command}`;
}

export async function executeShell(
  sourceText: string,
  session: ShellSession,
  processes: ShellProcessContext,
  options: ExecuteShellOptions = {},
): Promise<ShellResult> {
  const source = options.source ?? "human";
  const ownershipAdmission = options.ownershipAdmission ?? captureMachineMutationAdmission(source);
  const identity = machineIdentity(useKernelStore.getState().settings.hostname);
  session.env.USER = identity.user;
  session.env.HOSTNAME = identity.host;
  if (sourceText.trim() === "") return { stdout: "", stderr: "", exitCode: 0 };

  const runtime = await runtimeFor(session);
  if (runtime.active) throw new Error("webmcp-computer: shell session is already executing");

  assertMachineMutationAdmission(ownershipAdmission);
  session.history.push(sourceText);
  if (session.history.length > 1_000) session.history.splice(0, session.history.length - 1_000);

  const process = processes.start(sourceText, session.cwd);
  const abortProcess = () => processes.kill(process.pid);
  if (options.signal?.aborted) abortProcess();
  else options.signal?.addEventListener("abort", abortProcess, { once: true });

  const activeExecution: ActiveExecution = {
    source,
    ownershipAdmission,
    processes,
    clear: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cloudExecDependencies === undefined ? {} : {
      cloudExecDependencies: options.cloudExecDependencies,
    }),
    ...(options.cloudExecRequest === undefined ? {} : { cloudExecRequest: options.cloudExecRequest }),
    ...(options.onCloudExecResult === undefined ? {} : {
      onCloudExecResult: options.onCloudExecResult,
    }),
    streamedStdout: createCloudOutputBuffer(),
    streamedStderr: createCloudOutputBuffer(),
    writeStdout(chunk) {
      appendCloudOutput(activeExecution.streamedStdout, chunk);
      options.onStdout?.(chunk);
    },
    writeStderr(chunk) {
      appendCloudOutput(activeExecution.streamedStderr, chunk);
      options.onStderr?.(chunk);
    },
  };
  runtime.active = activeExecution;

  try {
    const signal = process.signal ?? options.signal;
    const result = await runtime.bash.exec(executableSource(sourceText, session.lastExitCode), {
      cwd: justBashPathFromKernel(session.cwd),
      env: bashEnvironment(session),
      replaceEnv: false,
      ...(signal === undefined ? {} : { signal }),
    });
    assertMachineMutationAdmission(ownershipAdmission);
    syncSession(session, result.env, result.exitCode);
    const active = runtime.active;
    if (!active) throw new Error("webmcp-computer: shell execution context unavailable");
    const clear = active.clear;
    if (clear) options.onClear?.();
    if (result.stdout !== "") options.onStdout?.(result.stdout);
    if (result.stderr !== "") options.onStderr?.(result.stderr);
    return {
      stdout: `${cloudOutputText(active.streamedStdout)}${result.stdout}`,
      stderr: `${cloudOutputText(active.streamedStderr)}${result.stderr}`,
      exitCode: result.exitCode,
      ...(clear ? { clear: true } : {}),
    };
  } catch (error) {
    const stderr = withNewline(errorMessage(error));
    session.lastExitCode = 1;
    options.onStderr?.(stderr);
    return { stdout: "", stderr, exitCode: 1 };
  } finally {
    runtime.active = undefined;
    options.signal?.removeEventListener("abort", abortProcess);
    processes.finish(process.pid);
  }
}
