import { isTextFile, ls, readFilePrefix, type FileEntry } from "./fs";
import { ensureBrowserSession } from "../apps/browser/session";
import { commandRegistry } from "./shell/registry";
import { useKernelStore } from "./store";
import { APP_IDS, type AppId } from "./types";
import { terminalSession } from "./terminalSessions";

export type OSSearchMatch = "exact-name" | "name-prefix" | "content";
export type OSSearchResult = {
  id: string;
  kind: "file" | "app" | "setting" | "process" | "command";
  name: string;
  detail: string;
  match: OSSearchMatch;
  verb: string;
  args: Record<string, unknown>;
};

export type OSSearchOutput = {
  results: OSSearchResult[];
  warnings: string[];
};

export type OSSearchFileSystem = {
  ls(path: string): Promise<FileEntry[]>;
  readFilePrefix(path: string, maxBytes: number): Promise<string>;
};

export type OSSearchActDependencies = {
  ensureBrowserSession(): Promise<unknown>;
};

const defaultActDependencies: OSSearchActDependencies = { ensureBrowserSession };

export const MAX_OS_SEARCH_FILE_BYTES = 256 * 1_024;

const JUST_BASH_COMMAND_NAMES = [
  "echo", "cat", "printf", "ls", "mkdir", "rmdir", "touch", "rm", "cp", "mv", "ln",
  "chmod", "pwd", "readlink", "head", "tail", "wc", "stat", "grep", "fgrep", "egrep",
  "rg", "sed", "awk", "sort", "uniq", "comm", "cut", "paste", "tr", "rev", "nl", "fold",
  "expand", "unexpand", "strings", "split", "column", "join", "tee", "find", "basename",
  "dirname", "tree", "du", "env", "printenv", "alias", "unalias", "history", "xargs", "true",
  "false", "clear", "bash", "sh", "jq", "base64", "diff", "date", "sleep", "timeout", "time",
  "seq", "expr", "md5sum", "sha1sum", "sha256sum", "file", "html-to-markdown", "help", "which",
  "tac", "hostname", "whoami", "od", "gzip", "gunzip", "zcat",
] as const;

const APP_SEARCH_CONTENT: Partial<Record<AppId, string>> = {
  browser:
    "browser application browser_open browser_goto browser_read browser_click browser_type " +
    "browser_screenshot browser_site_tools browser_site_call shared Cloudflare Chrome WebMCP",
};

const DISCOVERABLE_TOOL_NAMES = ["os_publish", "cloud_exec"] as const;

const MATCH_RANK: Record<OSSearchMatch, number> = {
  "exact-name": 0,
  "name-prefix": 1,
  content: 2,
};

const KIND_RANK: Record<OSSearchResult["kind"], number> = {
  file: 0,
  app: 1,
  setting: 2,
  process: 3,
  command: 4,
};

function matchFor(
  name: string,
  content: string,
  needle: string,
  aliases: readonly string[] = [],
): OSSearchMatch | undefined {
  const names = [name, ...aliases].map((value) => value.toLowerCase());
  const normalizedName = names[0] ?? "";
  if (names.includes(needle)) return "exact-name";
  if (names.some((value) => value.startsWith(needle))) return "name-prefix";
  if (`${normalizedName}\n${content.toLowerCase()}`.includes(needle)) return "content";
  return undefined;
}

function contentSnippet(content: string, needle: string): string {
  const normalized = content.replaceAll(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(needle);
  if (index === -1) return normalized.slice(0, 96);
  const start = Math.max(0, index - 30);
  const end = Math.min(normalized.length, index + needle.length + 56);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

async function fileResults(
  needle: string,
  fileSystem: OSSearchFileSystem,
): Promise<{ results: OSSearchResult[]; warnings: string[] }> {
  const results: OSSearchResult[] = [];
  const warnings: string[] = [];
  const visit = async (path: string): Promise<void> => {
    let entries: FileEntry[];
    try {
      entries = await fileSystem.ls(path);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const entry of entries) {
      if (entry.kind === "directory") {
        await visit(entry.path);
        continue;
      }
      if (!isTextFile(entry.path)) continue;
      let content: string;
      try {
        content = await fileSystem.readFilePrefix(entry.path, MAX_OS_SEARCH_FILE_BYTES);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const stem = entry.name.replace(/\.[^.]+$/, "");
      const match = matchFor(entry.name, content, needle, stem === entry.name ? [] : [stem]);
      if (!match) continue;
      results.push({
        id: `file:${entry.path}`,
        kind: "file",
        name: entry.name,
        detail: match === "content" ? contentSnippet(content, needle) : entry.path,
        match,
        verb: "editor_open_file",
        args: { path: entry.path },
      });
    }
  };
  await visit("~");
  return { results, warnings };
}

function inMemoryResults(needle: string): OSSearchResult[] {
  const state = useKernelStore.getState();
  const results: OSSearchResult[] = [];

  for (const appId of APP_IDS) {
    if (appId === "ui") continue;
    const match = matchFor(appId, APP_SEARCH_CONTENT[appId] ?? `${appId} application`, needle);
    if (!match) continue;
    results.push({
      id: `app:${appId}`,
      kind: "app",
      name: appId,
      detail: `Open ${appId}`,
      match,
      verb: appId === "browser" ? "browser_open" : "app_open",
      args: appId === "browser" ? {} : { appId },
    });
  }

  for (const [key, value] of Object.entries(state.settings)) {
    const display = typeof value === "string" ? value : String(value);
    const match = matchFor(key, display, needle);
    if (!match) continue;
    results.push({
      id: `setting:${key}`,
      kind: "setting",
      name: key,
      detail: display,
      match,
      verb: "app_open",
      args: { appId: "settings" },
    });
  }

  for (const process of state.processes) {
    const name = process.appId;
    const match = matchFor(name, `PID ${process.pid} ${process.path ?? ""}`, needle);
    if (!match) continue;
    results.push({
      id: `process:${process.pid}`,
      kind: "process",
      name: `${name} — PID ${process.pid}`,
      detail: process.path ?? "Running window",
      match,
      verb: "window_focus",
      args: { pid: process.pid },
    });
  }

  for (const command of commandRegistry) {
    const match = matchFor(command.name, `${command.summary} ${command.usage}`, needle);
    if (!match) continue;
    results.push({
      id: `command:${command.name}`,
      kind: "command",
      name: command.name,
      detail: command.summary,
      match,
      verb: "term_exec",
      args: { command: `${command.name} --help` },
    });
  }
  const verbosCommands = new Set(commandRegistry.map(({ name }) => name));
  for (const name of JUST_BASH_COMMAND_NAMES) {
    if (verbosCommands.has(name)) continue;
    const detail = "Bundled just-bash command";
    const match = matchFor(name, detail, needle);
    if (!match) continue;
    results.push({
      id: `command:${name}`,
      kind: "command",
      name,
      detail,
      match,
      verb: "term_exec",
      args: { command: `${name} --help` },
    });
  }
  for (const name of DISCOVERABLE_TOOL_NAMES) {
    const detail = "VerbOS tool; open its live manual page";
    const match = matchFor(name, "publish site public URL QR cloud execute container Linux command", needle);
    if (!match) continue;
    results.push({
      id: `tool:${name}`,
      kind: "command",
      name,
      detail,
      match,
      verb: "term_exec",
      args: { command: `man ${name}` },
    });
  }
  return results;
}

export async function searchOS(query: string, limit = 20): Promise<OSSearchResult[]> {
  return (await searchOSDetailed(query, limit)).results;
}

export async function searchOSDetailed(
  query: string,
  limit = 20,
  fileSystem: OSSearchFileSystem = { ls, readFilePrefix },
): Promise<OSSearchOutput> {
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("verbos: query must be a non-empty string");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("verbos: limit must be an integer from 1 to 100");
  }
  const needle = query.trim().toLowerCase();
  const files = await fileResults(needle, fileSystem);
  const results = [...files.results, ...inMemoryResults(needle)];
  return { results: results.sort((left, right) =>
    MATCH_RANK[left.match] - MATCH_RANK[right.match] ||
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  ).slice(0, limit), warnings: files.warnings };
}

export async function actOnSearchResult(
  result: OSSearchResult,
  dependencies: OSSearchActDependencies = defaultActDependencies,
): Promise<void> {
  const state = useKernelStore.getState();
  if (result.kind === "file") {
    const path = result.args.path;
    if (typeof path !== "string") return;
    const existing = [...state.processes]
      .filter(({ appId }) => appId === "editor")
      .sort((left, right) => right.zIndex - left.zIndex)[0];
    const process = existing ?? state.spawn("editor", { path });
    if (existing) {
      state.setProcessPath(existing.pid, path);
      state.focus(existing.pid);
    }
    state.osEvent("human", "editor_open_file", { path, pid: process.pid, appId: "editor" });
    return;
  }
  if (result.kind === "app") {
    if (result.verb === "browser_open") {
      await dependencies.ensureBrowserSession();
      const process = state.spawn("browser");
      state.osEvent("human", "browser_open", { appId: "browser", pid: process.pid });
      return;
    }
    const appId = result.args.appId as AppId;
    const process = state.spawn(appId);
    state.osEvent("human", "app_open", { appId, pid: process.pid });
    return;
  }
  if (result.kind === "process") {
    const pid = result.args.pid;
    if (typeof pid !== "number") return;
    state.focus(pid);
    state.osEvent("human", "window_focus", { pid });
    return;
  }
  const appId = result.kind === "setting" ? "settings" : "terminal";
  const existing = [...state.processes]
    .filter((process) => process.appId === appId)
    .sort((left, right) => right.zIndex - left.zIndex)[0];
  const process = existing ?? state.spawn(appId);
  if (existing) state.focus(existing.pid);
  if (result.kind === "setting") {
    state.osEvent("human", "app_open", { appId, pid: process.pid, reused: existing !== undefined });
    return;
  }

  const command = result.args.command;
  if (typeof command !== "string") return;
  const event = state.osEvent("human", "term_exec", {
    command,
    term_pid: process.pid,
    pid: process.pid,
    appId: "terminal",
  });
  try {
    const session = terminalSession(process.pid);
    await session.waitForView();
    await session.run(command, "human");
    useKernelStore.getState().settleEvent(event, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useKernelStore.getState().settleEvent(event, false, message);
    throw error;
  }
}
