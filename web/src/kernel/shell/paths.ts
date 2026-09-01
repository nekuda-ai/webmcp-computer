import { joinPath, normalizePath, parentPath } from "../fs";

export function resolveShellPath(cwd: string, value: string): string {
  if (value === "" || value === ".") return normalizePath(cwd);
  if (value === "~" || value.startsWith("~/")) return normalizePath(value);
  if (value.startsWith("/")) return normalizePath(value === "/" ? "~" : `~${value}`);
  return normalizePath(`${cwd}/${value}`);
}

export function shellBasename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "~") return "~";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function shellJoin(directory: string, name: string): string {
  return joinPath(directory, name);
}

export { parentPath };

export function shellPromptPath(cwd: string): string {
  return normalizePath(cwd);
}

export function globPatternMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
