type VerbArgument = string | number | Readonly<Record<string, unknown>>;

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

export function formatVerbCall(verb: string, argument?: VerbArgument): string {
  const detail = meaningfulArgument(argument);
  return detail === undefined ? verb : `${detail} · ${verb}`;
}
