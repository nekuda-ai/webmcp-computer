import { beforeEach, describe, expect, test } from "bun:test";
import { initializeMemoryFileSystem, writeFile } from "./fs";
import {
  actOnSearchResult,
  MAX_OS_SEARCH_FILE_BYTES,
  searchOS,
  searchOSDetailed,
} from "./osSearch";
import { resetKernelStore, useKernelStore } from "./store";
import { executeShell } from "./shell/engine";
import { setTerminalShellExecutor } from "./terminalSessions";

setTerminalShellExecutor(executeShell);

describe("M5 OS search", () => {
  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
  });

  test("ranks exact filename before filename prefix before content", async () => {
    await writeFile("~/site/aurora.md", "exact", "system");
    await writeFile("~/site/aurora-guide.md", "prefix", "system");
    await writeFile("~/site/notes.md", "content mentions aurora here", "system");

    const results = (await searchOS("aurora")).filter(({ kind }) => kind === "file");
    expect(results.slice(0, 3).map(({ name, match }) => ({ name, match }))).toEqual([
      { name: "aurora.md", match: "exact-name" },
      { name: "aurora-guide.md", match: "name-prefix" },
      { name: "brief.md", match: "content" },
    ]);
    expect(results.find(({ name }) => name === "notes.md")).toEqual(
      expect.objectContaining({ match: "content", verb: "editor_open_file", args: { path: "~/site/notes.md" } }),
    );
  });

  test("caps file-content indexing at 256 KB", async () => {
    await writeFile(
      "~/site/large.txt",
      `${"x".repeat(MAX_OS_SEARCH_FILE_BYTES)}beyond-the-cap`,
      "system",
    );

    expect((await searchOS("beyond-the-cap")).some(({ id }) => id === "file:~/site/large.txt")).toBe(false);
  });

  test("keeps searchable results and reports failed subtrees", async () => {
    const output = await searchOSDetailed("needle", 20, {
      async ls(path) {
        if (path === "~") {
          return [{
            name: "blocked",
            path: "~/blocked",
            kind: "directory",
            size: 0,
            modifiedAt: 0,
          }];
        }
        throw new Error(`webmcp-computer: permission denied: ${path}`);
      },
      async readFilePrefix() {
        throw new Error("test: unexpected read");
      },
    });

    expect(output.warnings).toEqual(["webmcp-computer: permission denied: ~/blocked"]);
    expect(output.results).toEqual([]);
  });

  test("indexes apps, settings, processes, commands, and acts on rows", async () => {
    const files = useKernelStore.getState().spawn("files");
    const app = (await searchOS("settings")).find((result) => result.id === "app:settings");
    expect(app).toEqual(expect.objectContaining({ kind: "app", verb: "app_open" }));
    if (!app) throw new Error("test: settings app result missing");
    await actOnSearchResult(app);
    expect(useKernelStore.getState().processes.at(-1)?.appId).toBe("settings");
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({ source: "human", verb: "app_open" }),
    );

    const process = (await searchOS(String(files.pid))).find(({ id }) => id === `process:${files.pid}`);
    expect(process).toEqual(expect.objectContaining({ verb: "window_focus" }));
    expect((await searchOS("screensaver_minutes"))[0]).toEqual(
      expect.objectContaining({
        kind: "setting",
        match: "exact-name",
        verb: "app_open",
        args: { appId: "settings" },
      }),
    );
    expect((await searchOS("uname"))[0]).toEqual(
      expect.objectContaining({ kind: "command", match: "exact-name", verb: "term_exec" }),
    );
    expect((await searchOS("grep"))[0]).toEqual(
      expect.objectContaining({
        id: "command:grep",
        kind: "command",
        match: "exact-name",
        verb: "term_exec",
      }),
    );
    expect((await searchOS("os_publish"))[0]).toEqual(expect.objectContaining({
      id: "tool:os_publish",
      kind: "command",
      match: "exact-name",
      verb: "term_exec",
      args: { command: "man os_publish" },
    }));
    expect((await searchOS("cloud_exec"))[0]).toEqual(expect.objectContaining({
      id: "tool:cloud_exec",
      kind: "command",
      match: "exact-name",
      verb: "term_exec",
      args: { command: "man cloud_exec" },
    }));
  });

  test("indexes every Browser tool name through the Browser app row", async () => {
    for (const name of [
      "browser_open",
      "browser_goto",
      "browser_read",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_site_tools",
      "browser_site_call",
    ]) {
      expect((await searchOS(name)).find(({ id }) => id === "app:browser")).toEqual(expect.objectContaining({
        id: "app:browser",
        kind: "app",
        verb: "browser_open",
        args: {},
      }));
    }
  });

  test("actuates the Browser row through its shared session path", async () => {
    const browser = (await searchOS("browser")).find(({ id }) => id === "app:browser");
    if (!browser) throw new Error("test: Browser app result missing");
    let ensureCalls = 0;

    await actOnSearchResult(browser, {
      async ensureBrowserSession() {
        ensureCalls += 1;
      },
    });

    const state = useKernelStore.getState();
    const process = state.processes.find(({ appId }) => appId === "browser");
    expect(ensureCalls).toBe(1);
    expect(process).toBeDefined();
    expect(Object.values(process?.windowRect ?? {}).every(Number.isFinite)).toBe(true);
    expect(state.events.at(-1)).toEqual(expect.objectContaining({
      source: "human",
      verb: "browser_open",
      args: expect.objectContaining({ appId: "browser", pid: process?.pid }),
    }));
    expect(Object.values(state.spawn("files").windowRect).every(Number.isFinite)).toBe(true);
  });

  test("replays complete truthful calls and reuses an existing Editor", async () => {
    await writeFile("~/site/aurora.md", "exact", "system");
    const editor = useKernelStore.getState().spawn("editor");
    const file = (await searchOS("aurora.md")).find(({ id }) => id === "file:~/site/aurora.md");
    if (!file) throw new Error("test: file result missing");
    await actOnSearchResult(file);
    expect(useKernelStore.getState().processes.filter(({ appId }) => appId === "editor")).toHaveLength(1);
    expect(useKernelStore.getState().processes.find(({ pid }) => pid === editor.pid)?.path).toBe(
      "~/site/aurora.md",
    );

    const setting = (await searchOS("screensaver_minutes"))[0];
    expect(setting).toEqual(expect.objectContaining({ verb: "app_open", args: { appId: "settings" } }));
    if (!setting) throw new Error("test: setting result missing");
    await actOnSearchResult(setting);
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({ source: "human", verb: "app_open" }),
    );

    const command = (await searchOS("uname"))[0];
    if (!command) throw new Error("test: command result missing");
    await actOnSearchResult(command);
    const terminal = useKernelStore.getState().processes.find(({ appId }) => appId === "terminal");
    expect(terminal).toBeDefined();
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({ source: "human", verb: "term_exec", ok: true }),
    );
  });
});
