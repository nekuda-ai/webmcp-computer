import { defineTool } from "@nekuda/webmcp-sdk";
import {
  isTextFile,
  joinPath,
  ls,
  mkdir,
  mv,
  normalizePath,
  parentPath,
  readFile,
  readFileBytes,
  rm,
  stat,
  updateFile,
  writeFile,
  writeFileBytes,
} from "../kernel/fs";
import { useKernelStore } from "../kernel/store";
import { assertMachineMutationAdmission } from "../kernel/ownershipAdmission";
import { runAgentAction } from "./agentAction";
import { focusAppTarget } from "./appTarget";
import { ACT_ANNOTATIONS, ASK_ANNOTATIONS, TRANSACT_ANNOTATIONS } from "./taxonomy";

type PathInput = { path: string };
type FileEncoding = "utf8" | "base64";
type ReadInput = PathInput & { encoding?: FileEncoding };
type WriteInput = ReadInput & { content: string };
type MoveInput = { from: string; to: string; overwrite?: boolean };
type AppPathInput = PathInput & { pid?: number };
type NoteInput = { note: string; text: string; pid?: number };
type NotesPreviewInput = { enabled: boolean; pid?: number };
type NotesStickInput = { title_or_index: string | number; sticky: boolean };
type EditInput = PathInput & {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};
type SearchInput = { query: string; path?: string; max_results?: number };
type SearchResult = { path: string; line: number; text: string };

const MAX_READ_BYTES = 256 * 1_024;

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`webmcp-computer: ${name} must be a string`);
  return value;
}

function requireEncoding(value: unknown): FileEncoding {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new Error('webmcp-computer: encoding must be "utf8" or "base64"');
}

function decodeBase64(content: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error("webmcp-computer: invalid base64 content");
  }
  try {
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64(bytes) !== content) throw new Error("webmcp-computer: invalid base64 content");
    return bytes;
  } catch {
    throw new Error("webmcp-computer: invalid base64 content");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function requireTextFile(path: string, kind: "file" | "directory", size: number): void {
  if (kind === "directory") throw new Error(`webmcp-computer: is a directory: ${path}`);
  if (!isTextFile(path)) throw new Error(`webmcp-computer: not a text file: ${path} (${size} bytes)`);
}

function notePath(note: string): string {
  const value = requireString(note, "note");
  const path = value.startsWith("~/")
    ? normalizePath(value)
    : joinPath("~/notes", value.endsWith(".md") ? value : `${value}.md`);
  if (!path.startsWith("~/notes/")) {
    throw new Error(`webmcp-computer: note must be inside ~/notes/: ${value}`);
  }
  return path;
}

async function resolveNotePath(titleOrIndex: string | number): Promise<string> {
  const notes = (await ls("~/notes")).filter(
    (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
  );
  if (typeof titleOrIndex === "number") {
    if (!Number.isInteger(titleOrIndex) || titleOrIndex < 1 || titleOrIndex > notes.length) {
      throw new Error(`webmcp-computer: note index must be an integer from 1 to ${notes.length}`);
    }
    return notes[titleOrIndex - 1]?.path ?? "";
  }
  const title = requireString(titleOrIndex, "title_or_index").trim();
  if (title === "") throw new Error("webmcp-computer: title_or_index must not be empty");
  if (title.startsWith("~")) {
    const path = normalizePath(title);
    if (parentPath(path) !== "~/notes" || !path.endsWith(".md")) {
      throw new Error(`webmcp-computer: note must be a Markdown file inside ~/notes/: ${path}`);
    }
    const target = await stat(path);
    if (target.kind !== "file") throw new Error(`webmcp-computer: is a directory: ${path}`);
    return path;
  }
  const needle = title.toLowerCase().replace(/\.md$/i, "");
  const match = notes.find((entry) => entry.name.replace(/\.md$/i, "").toLowerCase() === needle);
  if (!match) throw new Error(`webmcp-computer: note not found: ${title}`);
  return match.path;
}

export const fsReadTool = defineTool<ReadInput>({
  stableKey: "webmcp_computer.fs_read",
  name: "fs_read",
  title: "Read file",
  description:
    "Read one UTF-8 text file from the shared WebMCP Computer filesystem by ~-rooted path. Text files only; content over 256 KB is truncated and `truncated: true` is set. Pass encoding=\"base64\" to read any file as base64; oversized base64 output fails instead of being truncated.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "~-rooted file path to read." },
      encoding: {
        type: "string",
        enum: ["utf8", "base64"],
        description: "Output encoding; defaults to utf8.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
  intent: "answer",
  execute({ path: rawPath, encoding: rawEncoding }) {
    return runAgentAction("fs_read", { path: rawPath }, async () => {
      const path = normalizePath(requireString(rawPath, "path"));
      const encoding = requireEncoding(rawEncoding);
      const file = await stat(path);
      if (encoding === "base64") {
        if (file.kind === "directory") throw new Error(`webmcp-computer: is a directory: ${path}`);
        const encodedSize = 4 * Math.ceil(file.size / 3);
        if (encodedSize > MAX_READ_BYTES) {
          throw new Error(
            `webmcp-computer: base64 content exceeds 256 KB result limit: ${path} (${file.size} bytes)`,
          );
        }
        return { path, content: encodeBase64(await readFileBytes(path)) };
      }
      requireTextFile(path, file.kind, file.size);
      const content = await readFile(path);
      if (file.size <= MAX_READ_BYTES) return { path, content };
      const bytes = new TextEncoder().encode(content);
      return {
        path,
        content: new TextDecoder().decode(bytes.slice(0, MAX_READ_BYTES)),
        truncated: true,
        bytes: file.size,
      };
    });
  },
});

export const fsWriteTool = defineTool<WriteInput>({
  stableKey: "webmcp_computer.fs_write",
  name: "fs_write",
  title: "Write file",
  description:
    "Create or replace one UTF-8 text file in the shared WebMCP Computer filesystem. Empty content truncates the file to zero bytes. Parent directory must exist; visible Files and Editor windows update live. Pass encoding=\"base64\" to decode content and atomically write binary bytes.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "~-rooted destination file path." },
      content: { type: "string", description: "Complete UTF-8 file content; empty string truncates to zero bytes." },
      encoding: {
        type: "string",
        enum: ["utf8", "base64"],
        description: "Content encoding; defaults to utf8.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ path: rawPath, content: rawContent, encoding: rawEncoding }) {
    return runAgentAction("fs_write", { path: rawPath }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      const content = requireString(rawContent, "content");
      const encoding = requireEncoding(rawEncoding);
      if (encoding === "base64") {
        const bytes = decodeBase64(content);
        await writeFileBytes(path, bytes, mutationAdmission);
        return { written: true, path, bytes: bytes.byteLength };
      }
      await writeFile(path, content, mutationAdmission);
      return { written: true, path, bytes: new TextEncoder().encode(content).byteLength };
    });
  },
});

export const fsEditTool = defineTool<EditInput>({
  stableKey: "webmcp_computer.fs_edit",
  name: "fs_edit",
  title: "Edit file",
  description:
    "Replace exact text in one UTF-8 file. old_string must be a unique anchor unless replace_all=true; if it matches zero or multiple times, the error tells you to choose a longer anchor. Returns the normalized path and replacement count.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "~-rooted text-file path to edit." },
      old_string: {
        type: "string",
        minLength: 1,
        description: "Exact existing text; unique unless replace_all is true.",
      },
      new_string: { type: "string", description: "Exact replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace every exact match instead of requiring one unique match.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ path: rawPath, old_string: rawOldString, new_string: rawNewString, replace_all }) {
    return runAgentAction("fs_edit", { path: rawPath }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      const oldString = requireString(rawOldString, "old_string");
      const newString = requireString(rawNewString, "new_string");
      if (oldString.length === 0) throw new Error("webmcp-computer: old_string must not be empty");
      if (replace_all !== undefined && typeof replace_all !== "boolean") {
        throw new Error("webmcp-computer: replace_all must be a boolean");
      }
      const file = await stat(path);
      requireTextFile(path, file.kind, file.size);
      let replacements = 0;
      await updateFile(path, (current) => {
        replacements = current.split(oldString).length - 1;
        if (replacements === 0) {
          throw new Error(`webmcp-computer: old_string not found in ${path}`);
        }
        if (!replace_all && replacements !== 1) {
          throw new Error(
            `webmcp-computer: old_string matches ${replacements} times in ${path}; pass replace_all or a longer anchor`,
          );
        }
        return replace_all
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString);
      }, mutationAdmission);
      return { path, replacements };
    });
  },
});

async function searchTextFiles(
  root: string,
  query: string,
  maxResults: number,
): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const results: SearchResult[] = [];
  const needle = query.toLowerCase();

  const searchFile = async (path: string) => {
    if (!isTextFile(path)) return;
    const content = await readFile(path);
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] ?? "";
      if (text.toLowerCase().includes(needle)) {
        results.push({ path, line: index + 1, text });
        if (results.length > maxResults) return;
      }
    }
  };

  const visit = async (path: string): Promise<void> => {
    const target = await stat(path);
    if (target.kind === "file") {
      await searchFile(path);
      return;
    }
    for (const entry of await ls(path)) {
      if (results.length > maxResults) return;
      if (entry.kind === "directory") await visit(entry.path);
      else await searchFile(entry.path);
    }
  };

  await visit(root);
  return { results: results.slice(0, maxResults), truncated: results.length > maxResults };
}

export const fsSearchTool = defineTool<SearchInput>({
  stableKey: "webmcp_computer.fs_search",
  name: "fs_search",
  title: "Search files",
  description:
    "Search text-file contents case-insensitively below a ~-rooted path, skipping binary files. Returns matching path, 1-based line number, and full line text, plus a truncated flag when max_results is exceeded.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Case-insensitive substring to find." },
      path: { type: "string", description: "~-rooted file or directory; defaults to ~." },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum matches to return; defaults to 50.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { ...ASK_ANNOTATIONS, untrustedContentHint: true },
  intent: "answer",
  execute({ query: rawQuery, path: rawPath, max_results: rawMaxResults }) {
    return runAgentAction("fs_search", { query: rawQuery, path: rawPath ?? "~" }, async () => {
      const query = requireString(rawQuery, "query");
      if (query.length === 0) throw new Error("webmcp-computer: query must not be empty");
      const path = normalizePath(rawPath === undefined ? "~" : requireString(rawPath, "path"));
      const maxResults = rawMaxResults ?? 50;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
        throw new Error("webmcp-computer: max_results must be an integer from 1 to 200");
      }
      return searchTextFiles(path, query, maxResults);
    });
  },
});

export const fsListTool = defineTool<PathInput>({
  stableKey: "webmcp_computer.fs_list",
  name: "fs_list",
  title: "List directory",
  description:
    "List direct children of one ~-rooted WebMCP Computer directory. Returns sorted directories first, then files, with type, size, and modification time.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "~-rooted directory path to list." } },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: ASK_ANNOTATIONS,
  intent: "answer",
  execute({ path: rawPath }) {
    return runAgentAction("fs_list", { path: rawPath }, async () => {
      const path = normalizePath(requireString(rawPath, "path"));
      return { path, entries: await ls(path) };
    });
  },
});

export const fsMkdirTool = defineTool<PathInput>({
  stableKey: "webmcp_computer.fs_mkdir",
  name: "fs_mkdir",
  title: "Create directory",
  description: "Create one directory at a ~-rooted path. Parent directory must already exist.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "~-rooted directory path to create." } },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ path: rawPath }) {
    return runAgentAction("fs_mkdir", { path: rawPath }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      await mkdir(path, mutationAdmission);
      return { created: true, path };
    });
  },
});

export const fsDeleteTool = defineTool<PathInput>({
  stableKey: "webmcp_computer.fs_delete",
  name: "fs_delete",
  title: "Delete path",
  description:
    "Delete one file or directory tree from the shared WebMCP Computer filesystem. The home root itself cannot be deleted.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "~-rooted file or directory to delete." } },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: TRANSACT_ANNOTATIONS,
  intent: "transact",
  execute({ path: rawPath }) {
    return runAgentAction("fs_delete", { path: rawPath }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      await rm(path, mutationAdmission);
      return { deleted: true, path };
    });
  },
});

export const fsMoveTool = defineTool<MoveInput>({
  stableKey: "webmcp_computer.fs_move",
  name: "fs_move",
  title: "Move path",
  description:
    "Move or rename one file or directory between two ~-rooted paths. Destination parent must exist and destination must be absent unless overwrite=true is passed; overwrite defaults to false.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Existing ~-rooted source path." },
      to: { type: "string", description: "New ~-rooted destination path." },
      overwrite: {
        type: "boolean",
        description: "Replace an existing destination. Defaults to false.",
      },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ from: rawFrom, to: rawTo, overwrite }) {
    return runAgentAction("fs_move", {
      from: rawFrom,
      to: rawTo,
      ...(overwrite === undefined ? {} : { overwrite }),
    }, async (_signal, mutationAdmission) => {
      const from = normalizePath(requireString(rawFrom, "from"));
      const to = normalizePath(requireString(rawTo, "to"));
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        throw new Error("webmcp-computer: overwrite must be a boolean");
      }
      await mv(from, to, mutationAdmission, overwrite ?? false);
      return { moved: true, from, to };
    });
  },
});

export const editorOpenFileTool = defineTool<AppPathInput>({
  stableKey: "webmcp_computer.editor_open_file",
  name: "editor_open_file",
  title: "Open file in Editor",
  description:
    "Open one existing ~-rooted text file in the frontmost Editor window. Pass pid to target another open Editor when multiple exist. Returns the owning PID and normalized path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Existing ~-rooted text-file path." },
      pid: { type: "integer", minimum: 2, description: "Optional PID of an open Editor." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ path: rawPath, pid: rawPid }) {
    return runAgentAction("editor_open_file", {
      path: rawPath,
      appId: "editor",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      const file = await stat(path);
      requireTextFile(path, file.kind, file.size);
      assertMachineMutationAdmission(mutationAdmission);
      const process = focusAppTarget("editor", rawPid);
      useKernelStore.getState().setProcessPath(process.pid, path);
      return { pid: process.pid, appId: process.appId, path };
    });
  },
});

export const notesAppendTool = defineTool<NoteInput>({
  stableKey: "webmcp_computer.notes_append",
  name: "notes_append",
  title: "Append to note",
  description:
    "Append exact text to a Markdown note under ~/notes/ and show it in the frontmost Notes window. Pass pid when multiple Notes windows exist. A bare note name receives a .md extension; a missing note is created.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description: "Bare note name or full ~-rooted path inside ~/notes/.",
      },
      text: { type: "string", description: "Exact UTF-8 text to append." },
      pid: { type: "integer", minimum: 2, description: "Optional PID of an open Notes window." },
    },
    required: ["note", "text"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ note: rawNote, text: rawText, pid: rawPid }) {
    return runAgentAction("notes_append", {
      note: rawNote,
      appId: "notes",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, async (_signal, mutationAdmission) => {
      const path = notePath(rawNote);
      const text = requireString(rawText, "text");
      assertMachineMutationAdmission(mutationAdmission);
      const process = focusAppTarget("notes", rawPid);
      await updateFile(path, (current) => current + text, mutationAdmission, true);
      assertMachineMutationAdmission(mutationAdmission);
      useKernelStore.getState().setProcessPath(process.pid, path);
      return {
        appended: true,
        pid: process.pid,
        path,
        bytes: new TextEncoder().encode(text).byteLength,
      };
    });
  },
});

export const notesPreviewTool = defineTool<NotesPreviewInput>({
  stableKey: "webmcp_computer.notes_preview",
  name: "notes_preview",
  title: "Toggle notes preview",
  description:
    "Show or hide rendered Markdown preview in the frontmost Notes window. Pass pid to identify another open Notes window when multiple exist.",
  inputSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "Whether Notes renders Markdown preview." },
      pid: { type: "integer", minimum: 2, description: "Optional PID of an open Notes window." },
    },
    required: ["enabled"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ enabled, pid: rawPid }) {
    return runAgentAction("notes_preview", {
      enabled,
      appId: "notes",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, (_signal, mutationAdmission) => {
      if (typeof enabled !== "boolean") throw new Error("webmcp-computer: enabled must be a boolean");
      assertMachineMutationAdmission(mutationAdmission);
      const process = focusAppTarget("notes", rawPid);
      useKernelStore.getState().setNotesPreviewEnabled(process.pid, enabled);
      return { enabled, pid: process.pid };
    });
  },
});

export const notesStickTool = defineTool<NotesStickInput>({
  stableKey: "webmcp_computer.notes_stick",
  name: "notes_stick",
  title: "Stick note to desktop",
  description:
    "Stick or unstick one existing Markdown note as a visible desktop card. Identify it by case-insensitive title, ~-rooted path, or 1-based index from the sorted Notes list. Sticky state and card position persist for this browser tab's session. Returns the Notes PID, normalized path, sticky state, and position when stuck.",
  inputSchema: {
    type: "object",
    properties: {
      title_or_index: {
        anyOf: [
          { type: "string", minLength: 1 },
          { type: "integer", minimum: 1 },
        ],
        description: "Note title/path or 1-based Notes-list index.",
      },
      sticky: { type: "boolean", description: "True to show the card; false to remove it." },
    },
    required: ["title_or_index", "sticky"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ title_or_index: titleOrIndex, sticky }) {
    return runAgentAction("notes_stick", { title_or_index: titleOrIndex, sticky, appId: "notes" }, async (_signal, mutationAdmission) => {
      if (typeof sticky !== "boolean") throw new Error("webmcp-computer: sticky must be a boolean");
      if (typeof titleOrIndex !== "string" && typeof titleOrIndex !== "number") {
        throw new Error("webmcp-computer: title_or_index must be a string or integer");
      }
      const path = await resolveNotePath(titleOrIndex);
      assertMachineMutationAdmission(mutationAdmission);
      const process = focusAppTarget("notes");
      useKernelStore.getState().setProcessPath(process.pid, path);
      const note = useKernelStore.getState().setNoteSticky(path, sticky);
      return {
        pid: process.pid,
        path,
        sticky,
        ...(sticky && note ? { position: { x: note.x, y: note.y } } : {}),
      };
    });
  },
});

export const filesRevealTool = defineTool<AppPathInput>({
  stableKey: "webmcp_computer.files_reveal",
  name: "files_reveal",
  title: "Reveal in Files",
  description:
    "Reveal a ~-rooted file or directory in the frontmost Files window. Pass pid to target another open Files window when multiple exist. Files open to the target directory or the file's containing directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Existing ~-rooted path to reveal." },
      pid: { type: "integer", minimum: 2, description: "Optional PID of an open Files window." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: ACT_ANNOTATIONS,
  intent: "act",
  execute({ path: rawPath, pid: rawPid }) {
    return runAgentAction("files_reveal", {
      path: rawPath,
      appId: "files",
      ...(rawPid === undefined ? {} : { pid: rawPid }),
    }, async (_signal, mutationAdmission) => {
      const path = normalizePath(requireString(rawPath, "path"));
      const target = await stat(path);
      const directory = target.kind === "directory" ? path : parentPath(path);
      assertMachineMutationAdmission(mutationAdmission);
      const process = focusAppTarget("files", rawPid);
      useKernelStore.getState().setProcessPath(process.pid, directory);
      return { pid: process.pid, path, directory };
    });
  },
});

export const fileTools = [
  fsReadTool,
  fsWriteTool,
  fsEditTool,
  fsSearchTool,
  fsListTool,
  fsMkdirTool,
  fsDeleteTool,
  fsMoveTool,
] as const;
