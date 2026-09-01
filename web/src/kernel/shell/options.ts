import type { CommandFlag } from "./types";

export class ShellUsageError extends Error {}

export type ParsedOptions = {
  operands: string[];
  values: Map<string, string | true>;
};

function flagKey(flag: CommandFlag): string {
  return flag.long ?? flag.short;
}

export function parseOptions(
  command: string,
  args: readonly string[],
  definitions: readonly CommandFlag[],
): ParsedOptions {
  const byShort = new Map(definitions.map((flag) => [flag.short, flag]));
  const byLong = new Map(
    definitions.flatMap((flag) => flag.long === undefined ? [] : [[flag.long, flag] as const]),
  );
  const operands: string[] = [];
  const values = new Map<string, string | true>();
  let optionsDone = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (optionsDone || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsDone = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const flag = byLong.get(name);
      if (!flag) throw new ShellUsageError(`${command}: unrecognized option '--${name}'`);
      if (flag.value === undefined) {
        if (equals !== -1) throw new ShellUsageError(`${command}: option '--${name}' takes no value`);
        values.set(flagKey(flag), true);
        continue;
      }
      const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
      if (value === undefined) {
        throw new ShellUsageError(`${command}: option '--${name}' requires ${flag.value}`);
      }
      if (equals === -1) index += 1;
      values.set(flagKey(flag), value);
      continue;
    }

    const cluster = arg.slice(1);
    for (let offset = 0; offset < cluster.length; offset += 1) {
      const name = cluster[offset] ?? "";
      const flag = byShort.get(name);
      if (!flag) throw new ShellUsageError(`${command}: invalid option -- '${name}'`);
      if (flag.value === undefined) {
        values.set(flagKey(flag), true);
        continue;
      }
      const attached = cluster.slice(offset + 1);
      const value = attached || args[index + 1];
      if (value === undefined) {
        throw new ShellUsageError(`${command}: option requires an argument -- '${name}'`);
      }
      if (!attached) index += 1;
      values.set(flagKey(flag), value);
      break;
    }
  }

  return { operands, values };
}

export function optionEnabled(options: ParsedOptions, name: string): boolean {
  return options.values.get(name) === true;
}

export function optionValue(options: ParsedOptions, name: string): string | undefined {
  const value = options.values.get(name);
  return typeof value === "string" ? value : undefined;
}

export function requireOperandCount(
  command: string,
  operands: readonly string[],
  minimum: number,
  maximum = minimum,
): void {
  if (operands.length < minimum) throw new ShellUsageError(`${command}: missing operand`);
  if (operands.length > maximum) {
    throw new ShellUsageError(`${command}: extra operand '${operands[maximum] ?? ""}'`);
  }
}
