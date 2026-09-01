import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ModelContextLike,
  RegisterToolOptions,
  SpecTool,
  ToolRegistration,
  AnyWebMCPTool,
} from "@nekuda/webmcp-sdk";
import { initializeMemoryFileSystem, readFileBytes } from "../kernel/fs";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import {
  editorTools,
  filesTools,
  notesTools,
  registerAppTools,
  registerSystemTools,
} from "./registry";

let captured: SpecTool[] = [];
let registration: ToolRegistration;
let dynamicRegistrations: ToolRegistration[] = [];

function modelContext(): ModelContextLike {
  return {
    async registerTool(tool: SpecTool, _options?: RegisterToolOptions) {
      captured.push(tool);
    },
  };
}

function tool(name: string): SpecTool {
  const value = captured.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`test: ${name} was not registered`);
  return value;
}

async function invoke(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool(name).execute(input);
  expect(result).toEqual({ content: [{ type: "text", text: expect.any(String) }] });
  return JSON.parse((result as { content: [{ text: string }] }).content[0].text) as Record<
    string,
    unknown
  >;
}

async function expectToolError(
  name: string,
  input: Record<string, unknown>,
  message: string,
): Promise<void> {
  expect(await tool(name).execute(input)).toEqual({
    content: [{ type: "text", text: expect.stringContaining(message) }],
    isError: true,
  });
}

async function registerDynamic(pid: number, tools: readonly AnyWebMCPTool[]): Promise<void> {
  const dynamic = registerAppTools(pid, tools, {
    modelContext: modelContext(),
    telemetry: false,
  });
  dynamicRegistrations.push(dynamic);
  await dynamic.ready;
}

describe("M2 filesystem tools", () => {
  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
    captured = [];
    dynamicRegistrations = [];
    registration = registerSystemTools({ modelContext: modelContext(), telemetry: false });
    await registration.ready;
  });

  afterEach(() => {
    for (const dynamic of dynamicRegistrations) dynamic.unregister();
    registration.unregister();
  });

  test("fs_write and fs_read round-trip shared bytes", async () => {
    expect(await invoke("fs_write", { path: "~/site/index.html", content: "Aurora" })).toEqual({
      written: true,
      path: "~/site/index.html",
      bytes: 6,
    });
    expect(await invoke("fs_read", { path: "~/site/index.html" })).toEqual({
      path: "~/site/index.html",
      content: "Aurora",
    });
    expect(useKernelStore.getState().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agent", verb: "fs_write", ok: true }),
        expect.objectContaining({ source: "system", verb: "fs_change" }),
      ]),
    );
  });

  test("fs_write and fs_read round-trip real base64 bytes including an empty file", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const pngBytes = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
      1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100,
      248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
      96, 130,
    ]);

    expect(
      await invoke("fs_write", {
        path: "~/site/pixel.png",
        content: pngBase64,
        encoding: "base64",
      }),
    ).toEqual({ written: true, path: "~/site/pixel.png", bytes: pngBytes.byteLength });
    expect(await invoke("fs_read", { path: "~/site/pixel.png", encoding: "base64" })).toEqual({
      path: "~/site/pixel.png",
      content: pngBase64,
    });
    expect(await readFileBytes("~/site/pixel.png")).toEqual(pngBytes);

    expect(
      await invoke("fs_write", {
        path: "~/site/pixel.png",
        content: "",
        encoding: "base64",
      }),
    ).toEqual({ written: true, path: "~/site/pixel.png", bytes: 0 });
    expect(await readFileBytes("~/site/pixel.png")).toEqual(new Uint8Array());
  });

  test("fs_write rejects invalid base64 without changing the destination", async () => {
    const path = "~/site/existing.png";
    await invoke("fs_write", { path, content: "keep me" });

    await expectToolError(
      "fs_write",
      { path, content: "/x==", encoding: "base64" },
      "verbos: invalid base64 content",
    );
    expect(await readFileBytes(path)).toEqual(new TextEncoder().encode("keep me"));
  });

  test("fs_edit enforces unique anchors and reports replacement counts", async () => {
    await invoke("fs_write", { path: "~/site/edit.txt", content: "one two one" });
    await expectToolError(
      "fs_edit",
      {
        path: "~/site/edit.txt",
        old_string: "one",
        new_string: "three",
      },
      "verbos: old_string matches 2 times in ~/site/edit.txt; pass replace_all or a longer anchor",
    );
    expect(
      await invoke("fs_edit", {
        path: "~/site/edit.txt",
        old_string: "one",
        new_string: "three",
        replace_all: true,
      }),
    ).toEqual({ path: "~/site/edit.txt", replacements: 2 });
    expect(await invoke("fs_read", { path: "~/site/edit.txt" })).toEqual({
      path: "~/site/edit.txt",
      content: "three two three",
    });

    expect(
      await invoke("fs_edit", {
        path: "~/site/edit.txt",
        old_string: "two",
        new_string: "2",
      }),
    ).toEqual({ path: "~/site/edit.txt", replacements: 1 });
  });

  test("fs_edit rejects missing anchors", async () => {
    await invoke("fs_write", { path: "~/site/edit.txt", content: "aurora" });
    await expectToolError(
      "fs_edit",
      {
        path: "~/site/edit.txt",
        old_string: "missing",
        new_string: "found",
      },
      "verbos: old_string not found in ~/site/edit.txt",
    );
  });

  test("fs_search finds case-insensitive lines, caps results, and skips binary files", async () => {
    await invoke("fs_write", {
      path: "~/site/a.txt",
      content: "Aurora first\nno match",
    });
    await invoke("fs_write", { path: "~/site/b.txt", content: "second AURORA" });
    await invoke("fs_write", { path: "~/site/image.png", content: "aurora binary" });

    expect(await invoke("fs_search", { query: "aurora", path: "~/site" })).toEqual({
      results: [
        { path: "~/site/a.txt", line: 1, text: "Aurora first" },
        { path: "~/site/b.txt", line: 1, text: "second AURORA" },
      ],
      truncated: false,
    });
    expect(
      await invoke("fs_search", { query: "aurora", path: "~/site", max_results: 1 }),
    ).toEqual({
      results: [{ path: "~/site/a.txt", line: 1, text: "Aurora first" }],
      truncated: true,
    });
  });

  test("fs directory tools create, list, move, and delete", async () => {
    await invoke("fs_mkdir", { path: "~/site/assets" });
    await invoke("fs_write", { path: "~/site/assets/theme.css", content: "body{}" });
    expect(await invoke("fs_list", { path: "~/site/assets" })).toEqual({
      path: "~/site/assets",
      entries: [expect.objectContaining({ name: "theme.css", kind: "file", size: 6 })],
    });
    await invoke("fs_move", {
      from: "~/site/assets/theme.css",
      to: "~/site/assets/aurora.css",
    });
    await invoke("fs_delete", { path: "~/site/assets" });
    expect(await invoke("fs_list", { path: "~/site" })).toEqual({
      path: "~/site",
      entries: [],
    });
  });

  test("files_reveal targets the frontmost Files window", async () => {
    const files = useKernelStore.getState().spawn("files");
    await registerDynamic(files.pid, filesTools);

    expect(await invoke("files_reveal", { path: "~/notes/welcome.md" })).toEqual({
      pid: files.pid,
      path: "~/notes/welcome.md",
      directory: "~/notes",
    });
    expect(useKernelStore.getState().processes[0]?.path).toBe("~/notes");
  });

  test("fs_mkdir and fs_move identify a missing destination directory", async () => {
    await expectToolError("fs_mkdir", { path: "~/site/a/b" },
      "verbos: no such directory: ~/site/a",
    );
    await invoke("fs_write", { path: "~/site/source.txt", content: "source" });
    await expectToolError(
      "fs_move",
      { from: "~/site/source.txt", to: "~/nope/moved.txt" },
      "verbos: no such directory: ~/nope",
    );
  });

  test("fs_move requires explicit overwrite for an existing destination", async () => {
    await invoke("fs_write", { path: "~/site/source.txt", content: "source" });
    await invoke("fs_write", { path: "~/site/destination.txt", content: "destination" });
    await expectToolError(
      "fs_move",
      { from: "~/site/source.txt", to: "~/site/destination.txt" },
      "verbos: destination exists: ~/site/destination.txt",
    );

    expect(await invoke("fs_move", {
      from: "~/site/source.txt",
      to: "~/site/destination.txt",
      overwrite: true,
    })).toEqual({
      moved: true,
      from: "~/site/source.txt",
      to: "~/site/destination.txt",
    });
    expect(await invoke("fs_read", { path: "~/site/destination.txt" })).toEqual({
      path: "~/site/destination.txt",
      content: "source",
    });
  });

  test("app_open path and editor_open_file target one visible editor", async () => {
    const appOpen = await invoke("app_open", {
      appId: "editor",
      path: "~/desktop/brief.md",
    });
    await registerDynamic(appOpen.pid as number, editorTools);
    const editorOpen = await invoke("editor_open_file", { path: "~/notes/welcome.md" });

    expect(appOpen).toEqual(
      expect.objectContaining({ pid: 2, appId: "editor", path: "~/desktop/brief.md" }),
    );
    expect(editorOpen).toEqual({ pid: 2, appId: "editor", path: "~/notes/welcome.md" });
    expect(useKernelStore.getState().processes.map(({ path }) => path)).toEqual([
      "~/notes/welcome.md",
    ]);
  });

  test("all tool-based editor paths reject non-text files", async () => {
    await invoke("fs_write", { path: "~/site/image.png", content: "PNG" });
    const editor = useKernelStore.getState().spawn("editor");
    await registerDynamic(editor.pid, editorTools);
    await expectToolError(
      "app_open",
      { appId: "editor", path: "~/site/image.png" },
      "verbos: not a text file: ~/site/image.png (3 bytes)",
    );
    await expectToolError("editor_open_file", { path: "~/site/image.png" },
      "verbos: not a text file: ~/site/image.png (3 bytes)",
    );
  });

  test("notes_append creates and appends exact text", async () => {
    const notes = useKernelStore.getState().spawn("notes");
    await registerDynamic(notes.pid, notesTools);
    await invoke("notes_append", { note: "field-log", text: "first" });
    await invoke("notes_append", { note: "field-log", text: " + second" });
    expect(await invoke("fs_read", { path: "~/notes/field-log.md" })).toEqual({
      path: "~/notes/field-log.md",
      content: "first + second",
    });
  });

  test("notes_append serializes concurrent updates", async () => {
    const notes = useKernelStore.getState().spawn("notes");
    await registerDynamic(notes.pid, notesTools);
    await Promise.all([
      invoke("notes_append", { note: "concurrent", text: "first" }),
      invoke("notes_append", { note: "concurrent", text: "second" }),
    ]);
    const result = await invoke("fs_read", { path: "~/notes/concurrent.md" });
    expect(result.content).toBe("firstsecond");
  });

  test("fs_read rejects binary files and truncates large text", async () => {
    await invoke("fs_write", { path: "~/site/image.png", content: "PNG" });
    await expectToolError("fs_read", { path: "~/site/image.png" },
      "verbos: not a text file: ~/site/image.png (3 bytes)",
    );

    const large = "x".repeat(256 * 1_024 + 1);
    await invoke("fs_write", { path: "~/site/large.txt", content: large });
    const result = await invoke("fs_read", { path: "~/site/large.txt" });
    expect(result).toEqual({
      path: "~/site/large.txt",
      content: "x".repeat(256 * 1_024),
      truncated: true,
      bytes: 256 * 1_024 + 1,
    });
  });

  test("fs_read rejects base64 output that would exceed the result cap", async () => {
    const overCapBase64 = `${"AAAA".repeat(65_536)}AA==`;
    await invoke("fs_write", {
      path: "~/site/large.png",
      content: overCapBase64,
      encoding: "base64",
    });

    await expectToolError(
      "fs_read",
      { path: "~/site/large.png", encoding: "base64" },
      "verbos: base64 content exceeds 256 KB result limit: ~/site/large.png (196609 bytes)",
    );
  });

  test("notes_preview controls visible Notes state", async () => {
    const notes = useKernelStore.getState().spawn("notes");
    await registerDynamic(notes.pid, notesTools);
    expect(await invoke("notes_preview", { enabled: true })).toEqual({
      enabled: true,
      pid: notes.pid,
    });
    expect(useKernelStore.getState().notesPreviewEnabledByPid[notes.pid]).toBe(true);
  });

  test("notes_stick resolves title or index and persists visible sticky state", async () => {
    const notes = useKernelStore.getState().spawn("notes");
    await registerDynamic(notes.pid, notesTools);
    expect(await invoke("notes_stick", { title_or_index: "welcome", sticky: true })).toEqual({
      pid: notes.pid,
      path: "~/notes/welcome.md",
      sticky: true,
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    });
    expect(useKernelStore.getState().stickyNotes).toEqual([
      expect.objectContaining({ path: "~/notes/welcome.md" }),
    ]);
    expect(useKernelStore.getState().processes[0]?.path).toBe("~/notes/welcome.md");
    expect(await invoke("notes_stick", { title_or_index: 1, sticky: false })).toEqual({
      pid: notes.pid,
      path: "~/notes/welcome.md",
      sticky: false,
    });
    expect(useKernelStore.getState().stickyNotes).toEqual([]);
  });

  test("invalid paths fail with visible agent trace", async () => {
    await expectToolError("fs_read", { path: "~/../escape" },
      "verbos: path escapes home",
    );
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({ source: "agent", verb: "fs_read", ok: false }),
    );
  });

  test("fs_delete protects the home root", async () => {
    await expectToolError("fs_delete", { path: "~" },
      "verbos: cannot delete home directory: ~",
    );
    expect(await invoke("fs_list", { path: "~" })).toEqual({
      path: "~",
      entries: expect.any(Array),
    });
  });
});
