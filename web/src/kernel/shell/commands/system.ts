import { optionEnabled, parseOptions, requireOperandCount, ShellUsageError } from "../options";
import type { ShellCommand } from "../types";
import { machineIdentity } from "../../identity";
import { useKernelStore } from "../../store";

const unameFlags = [
  { short: "a", long: "all", description: "print all system information" },
] as const;

function formatEventTime(timestamp: number, origin: number): string {
  return `[+${Math.max(0, timestamp - origin).toString().padStart(5, "0")}ms]`;
}

function eventArgument(args: Readonly<Record<string, unknown>>): string {
  for (const key of ["command", "path", "from", "appId", "tool", "pid"]) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") {
      return typeof value === "string" && value.includes(" ") ? ` "${value}"` : ` ${value}`;
    }
  }
  return "";
}

export function createSystemCommands(): readonly ShellCommand[] {
  return [
    {
      name: "clear",
      summary: "Clear terminal display and scrollback.",
      usage: "clear",
      flags: [],
      async run(_context, args) {
        requireOperandCount("clear", args, 0);
        return { clear: true };
      },
    },
    {
      name: "history",
      summary: "Display this Terminal session's shared command history.",
      usage: "history",
      flags: [],
      async run(context, args) {
        requireOperandCount("history", args, 0);
        const lines = context.session.history.map((command, index) =>
          `${String(index + 1).padStart(5, " ")}  ${command}`,
        );
        return { stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
      },
    },
    {
      name: "whoami",
      summary: "Print current WebMCP Computer user name.",
      usage: "whoami",
      flags: [],
      async run(_context, args) {
        requireOperandCount("whoami", args, 0);
        return { stdout: `${machineIdentity(useKernelStore.getState().settings.hostname).user}\n` };
      },
    },
    {
      name: "hostname",
      summary: "Print WebMCP Computer host name.",
      usage: "hostname",
      flags: [],
      async run(_context, args) {
        requireOperandCount("hostname", args, 0);
        return { stdout: `${machineIdentity(useKernelStore.getState().settings.hostname).host}\n` };
      },
    },
    {
      name: "uname",
      summary: "Print WebMCP Computer system information.",
      usage: "uname [OPTION]...",
      flags: unameFlags,
      async run(_context, args) {
        const options = parseOptions("uname", args, unameFlags);
        requireOperandCount("uname", options.operands, 0);
        return { stdout: optionEnabled(options, "all") ? "WebMCP Computer 1.0 wasm32 (browser)\n" : "WebMCP Computer\n" };
      },
    },
    {
      name: "ps",
      summary: "List running WebMCP Computer windows and commands.",
      usage: "ps",
      flags: [],
      async run(context, args) {
        requireOperandCount("ps", args, 0);
        const rows = context.processes.list().map((process) =>
          `${String(process.pid).padStart(5, " ")} ${process.kind.padEnd(7, " ")} ${process.command}${process.minimized === true ? " (minimized)" : ""}`,
        );
        return { stdout: `  PID TYPE    COMMAND\n${rows.join("\n")}${rows.length === 0 ? "" : "\n"}` };
      },
    },
    {
      name: "kill",
      summary: "Terminate a WebMCP Computer window or running command by PID.",
      usage: "kill PID",
      flags: [],
      async run(context, args) {
        requireOperandCount("kill", args, 1);
        const pid = Number(args[0]);
        if (pid === 1) {
          throw new Error("webmcp-computer: pid 1 is the screensaver; window pids start at 2");
        }
        if (!Number.isInteger(pid) || pid < 2) {
          throw new ShellUsageError(`kill: invalid PID '${args[0] ?? ""}'`);
        }
        const killed = context.processes.kill(pid);
        if (!killed) throw new Error(`webmcp-computer: process PID ${pid} not found`);
        return {};
      },
    },
    {
      name: "open",
      summary: "Open a WebMCP Computer app, file, or directory in a new window.",
      usage: "open APP|PATH",
      flags: [],
      async run(context, args) {
        requireOperandCount("open", args, 1);
        const process = await context.processes.open(
          args[0] ?? "",
          context.session.cwd,
          context.source,
        );
        return { stdout: `Opened ${process.command} (PID ${process.pid})\n` };
      },
    },
    {
      name: "serve",
      summary: "Serve a directory in a live WebMCP Computer Preview window.",
      usage: "serve DIRECTORY",
      flags: [],
      async run(context, args) {
        requireOperandCount("serve", args, 1);
        const process = await context.processes.serve(
          args[0] ?? "",
          context.session.cwd,
          context.source,
        );
        return { stdout: `serving ${process.root}/ → preview (pid ${process.pid})\n` };
      },
    },
    {
      name: "dmesg",
      summary: "Print WebMCP Computer event log.",
      usage: "dmesg",
      flags: [],
      async run(context, args) {
        requireOperandCount("dmesg", args, 0);
        const events = context.processes.events();
        const origin = events[0]?.ts ?? 0;
        const lines = events.map((event) =>
          `${formatEventTime(event.ts, origin)} [${event.source}] ${event.verb}${eventArgument(event.args)}${event.ok === false ? ` — ${event.reason ?? "failed"}` : ""}`,
        );
        return { stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
      },
    },
  ];
}
