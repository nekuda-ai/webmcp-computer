type VerbArgument = string | number | Readonly<Record<string, unknown>>;

type EventSummaryInput = {
  verb: string;
  args: Readonly<Record<string, unknown>>;
  ok?: boolean;
  reason?: string;
};

export const TOAST_SUMMARY_MAX_CHARS = 80;
export const ACTIVITY_SUMMARY_MAX_CHARS = 160;

const INLINE_COMMAND_MAX_CHARS = 48;
const TARGET_MAX_CHARS = 40;

const ARGUMENT_KEYS = [
  "command",
  "path",
  "from",
  "note",
  "appId",
  "term_pid",
  "pid",
  "key",
  "query",
  "x",
  "width",
] as const;

function meaningfulArgument(argument: VerbArgument | undefined): string | undefined {
  if (typeof argument === "string") return argument.trim() === "" ? undefined : argument;
  if (typeof argument === "number") return String(argument);
  if (argument === undefined) return undefined;

  for (const key of ARGUMENT_KEYS) {
    const value = argument[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (key === "pid" || key === "term_pid") return `PID ${value}`;
    if (key === "key") {
      const setting = argument.value;
      if (typeof setting === "string" || typeof setting === "number" || typeof setting === "boolean") {
        return `${value}: ${setting}`;
      }
    }
    return String(value);
  }

  return undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateWithCount(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…".slice(0, maxChars);

  let visibleChars = Math.max(0, maxChars - 15);
  let suffix = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const omittedChars = value.length - visibleChars;
    suffix = `… (+${omittedChars} chars)`;
    visibleChars = Math.max(0, maxChars - suffix.length);
  }
  return `${value.slice(0, visibleChars)}${suffix}`;
}

function commandPreview(command: string): string | undefined {
  const normalized = singleLine(command);
  if (normalized === "") return undefined;
  if (normalized.length <= INLINE_COMMAND_MAX_CHARS) return normalized;

  const firstToken = normalized.match(/^[^\s;&|]+/)?.[0];
  const safeHead = firstToken && firstToken.length <= 24 ? firstToken : "shell";
  const representedChars = safeHead === "shell" ? 0 : safeHead.length;
  return `${safeHead} … (+${normalized.length - representedChars} chars)`;
}

function eventTarget(verb: string, args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["path", "from", "cwd", "url", "query", "tool", "name"] as const) {
    const value = args[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const normalized = singleLine(String(value));
    if (normalized !== "") return truncateWithCount(normalized, TARGET_MAX_CHARS);
  }

  const terminalPid = args.term_pid;
  if (
    typeof terminalPid === "number" ||
    (typeof terminalPid === "string" && terminalPid.trim() !== "")
  ) {
    return `PID ${terminalPid}`;
  }

  if (verb === "cloud_exec") return "/workspace";
  const appId = args.appId;
  if (typeof appId === "string" && appId.trim() !== "") return singleLine(appId);
  const pid = args.pid;
  return typeof pid === "number" || (typeof pid === "string" && pid.trim() !== "")
    ? `PID ${pid}`
    : undefined;
}

function boundedWithSuffix(value: string, suffix: string, maxChars: number): string {
  if (`${value}${suffix}`.length <= maxChars) return `${value}${suffix}`;
  if (suffix.length >= maxChars) return suffix.slice(suffix.length - maxChars);
  return `${truncateWithCount(value, maxChars - suffix.length)}${suffix}`;
}

export function formatEventSummary(event: EventSummaryInput, maxChars: number): string {
  const parts = [event.verb];
  const target = eventTarget(event.verb, event.args);
  if (target !== undefined) parts.push(target);
  const command = typeof event.args.command === "string"
    ? commandPreview(event.args.command)
    : undefined;
  if (command !== undefined) parts.push(command);

  let core = parts.join(" · ");
  if (event.ok === false && event.reason !== undefined) {
    // The product prefix is noise inside the OS's own trace; dmesg keeps the raw error.
    const reason = singleLine(event.reason).replace(/^webmcp-computer: /, "");
    if (reason !== "") core += ` — ${reason}`;
  }
  const status = event.ok === true ? " · succeeded" : event.ok === false ? " · failed" : "";
  return boundedWithSuffix(core, status, maxChars);
}

export function formatVerbCall(verb: string, argument?: VerbArgument): string {
  const detail = meaningfulArgument(argument);
  return detail === undefined ? verb : `${detail} · ${verb}`;
}
