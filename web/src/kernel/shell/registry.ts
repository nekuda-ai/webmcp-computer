import { requireOperandCount, ShellUsageError } from "./options";
import { createSystemCommands } from "./commands/system";
import type { CommandFlag, ShellCommand } from "./types";
import { MANUAL_TOPICS, readManual } from "../manual";
import { getActiveToolDefinition, renderToolManPage } from "../../tools/toolCatalog";
import {
  cloudCwdFromHome,
  defaultCloudExecDependencies,
  executeCloudCommand,
  shellQuote,
} from "../cloudExec";
import { notifyFileSystemChange } from "../fs";
import { useKernelStore } from "../store";
import { assertMachineMutationAdmission } from "../ownershipAdmission";

function flagSyntax(flag: CommandFlag): string {
  const value = flag.value === undefined ? "" : ` ${flag.value}`;
  const short = `-${flag.short}${value}`;
  return flag.long === undefined ? short : `${short}, --${flag.long}${value}`;
}

function renderFlags(flags: readonly CommandFlag[]): string {
  const entries = [
    ...flags.map((flag) => [flagSyntax(flag), flag.description] as const),
    ["--help", "display this help and exit"] as const,
  ];
  const width = Math.max(...entries.map(([syntax]) => syntax.length));
  return entries.map(([syntax, description]) => `  ${syntax.padEnd(width, " ")}  ${description}`).join("\n");
}

export function renderCommandHelp(command: ShellCommand): string {
  return [
    `Usage: ${command.usage}`,
    command.summary,
    "",
    "Options:",
    renderFlags(command.flags),
    "",
  ].join("\n");
}

export function renderManPage(command: ShellCommand): string {
  return [
    `${command.name.toUpperCase()}(1) — WebMCP Computer commands`,
    "",
    "NAME",
    `  ${command.name} - ${command.summary.replace(/\.$/, "")}`,
    "",
    "SYNOPSIS",
    `  ${command.usage}`,
    "",
    "DESCRIPTION",
    `  ${command.description ?? command.summary}`,
    "",
    "OPTIONS",
    renderFlags(command.flags),
    "",
  ].join("\n");
}

const commands: ShellCommand[] = [...createSystemCommands(), {
  name: "cloud",
  summary: "Run a command on the cloud container.",
  description:
    "Run one non-interactive Linux command in the cloud container. Output streams here; Ctrl-C closes the stream but the remote command continues until its timeout.",
  usage: "cloud <command...>",
  flags: [],
  async run(context, args) {
    if (useKernelStore.getState().fileSystemBackend !== "cloud") {
      return {
        stderr: "webmcp-computer: cloud requires the cloud kernel (enable it in Settings, the machine reboots)\n",
        exitCode: 2,
      };
    }
    const override = context.cloudExecRequest;
    if (!override && args.length === 0) throw new ShellUsageError("cloud: missing command");
    const result = await executeCloudCommand({
      command: override?.command ?? args.map(shellQuote).join(" "),
      cwd: override?.cwd ?? cloudCwdFromHome(context.session.cwd),
      ...(override?.timeoutMs === undefined ? {} : { timeoutMs: override.timeoutMs }),
    }, context.cloudExecDependencies ?? defaultCloudExecDependencies(), {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onStdout: context.writeStdout,
      onStderr: context.writeStderr,
    });
    assertMachineMutationAdmission(context.ownershipAdmission);
    // SDK 0.2.1 cannot report per-exec sync counts through resumed handles
    // (the exit frame's pushed/pulled/applied are zeros even when files
    // synced), so refresh once per completed command — deliberately coarse,
    // bounded by command rate. Errors throw above, so reaching here means the
    // exec ran to an exit frame.
    notifyFileSystemChange("~", context.source);
    context.onCloudExecResult?.(result);
    return { exitCode: result.exitCode };
  },
}];

const findCommand = (name: string): ShellCommand | undefined =>
  commands.find((command) => command.name === name);

commands.push({
  name: "man",
  summary: "Display a WebMCP Computer command, tool, or topic manual page.",
  usage: "man COMMAND|TOOL|TOPIC",
  flags: [],
  async run(_context, args) {
    requireOperandCount("man", args, 1);
    const name = args[0] ?? "";
    const command = findCommand(name);
    if (command) return { stdout: renderManPage(command) };
    if (MANUAL_TOPICS.includes(name as (typeof MANUAL_TOPICS)[number])) {
      return { stdout: await readManual(name as (typeof MANUAL_TOPICS)[number]) };
    }
    const tool = getActiveToolDefinition(name);
    if (tool) return { stdout: renderToolManPage(tool) };
    return { stderr: `webmcp-computer: no manual entry for ${name}\n`, exitCode: 1 };
  },
});

export const commandRegistry: readonly ShellCommand[] = commands;

export function getShellCommand(name: string): ShellCommand | undefined {
  return findCommand(name);
}
