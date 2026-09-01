import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fs as zenfs } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import { resetKernelStore, useKernelStore } from "./store";
import {
  AURORA_BRIEF,
  assignUniqueFileSystemIds,
  checkFileSystem,
  CONTEXT_MENUS_AGENT_SKILL_SHA256,
  CONTEXT_MENUS_FIXES_AGENT_SKILL_SHA256,
  CONTEXT_MENUS_FIXES_2_AGENT_SKILL_SHA256,
  createFile,
  EXPANSION_MERGE_850_SHA256,
  EXPANSION_MERGE_852_SHA256,
  EXPANSION_MERGE_853_SHA256,
  exists,
  initializeMemoryFileSystem,
  joinPath,
  ls,
  M7_AGENT_SKILL_SHA256,
  M8_AGENT_SKILL_SHA256,
  M9_BROWSER_AGENT_SKILL_SHA256,
  M10_CLOUD_AGENT_SKILL_SHA256,
  NEK_852_AGENT_SKILL_SHA256,
  NEK850_CLOUD_EXEC_AGENT_SKILL_SHA256,
  NEK850_FIXES_AGENT_SKILL_SHA256,
  NEK850_TRANSACT_AGENT_SKILL_SHA256,
  mkdir,
  mv,
  normalizePath,
  parentPath,
  PIZZA_DEMO_BRIEF,
  readFile,
  rm,
  seedFileSystem,
  selectFileSystemBackend,
  stat,
  withFileSystemWriteLock,
  watch,
  writeFile,
} from "./fs";
import { AGENT_SKILL_FILES, AGENT_SKILL_SHA256 } from "./manualContent";
import { PUBLISHED_SITE_RETENTION_DAYS } from "../../../workers/computer/src/protocol";

const M7_TERMINAL_SKILL = [
  "# Terminal & shell",
  "",
  "A POSIX-style shell with a real grammar (mvdan/sh) executing against the shared",
  "filesystem. Your commands are TYPED VISIBLY into the terminal, character by character,",
  "on an accent-tinted row with a `codex@verbos` prompt — the human watches you work in",
  "the same window they type into. You share one session per terminal window: cwd, env,",
  "and history are common, so the human's `history` shows your commands.",
  "",
  "## Tools",
  "",
  "- `term_exec {command, term_pid?, timeout_ms?}` → `{stdout, stderr, exit_code,",
  "  truncated}`. Opens a terminal if none exists. Default timeout 30s (max 120s);",
  "  stdout/stderr each capped at 256 KB with `truncated: true` past that. Redirect failures",
  "  write the reason to stderr and return a nonzero `exit_code`.",
  "- `term_read {term_pid?, lines?}` — the last N lines of the shared scrollback",
  "  (2000-line buffer). Use it to see what the human typed or what you missed.",
  "- `term_state {term_pid?}` → `{pid, cwd, busy, running_command?, env}` from the live",
  "  shell session object — never parsed from scrollback.",
  "- `term_history {term_pid?, limit?}` → `[{index, command}]`, newest last. It reads the",
  "  same history the human sees; default 50, maximum 1000.",
  "- `ps` — the real process table: windows AND transient running commands, with PIDs.",
  "- `kill {pid}` — closes a window or aborts a running command. PID 1 is protected.",
  "",
  "## What the shell supports",
  "",
  "Pipelines `|`, redirects `> >> <`, `; && ||`, quoting, `$VAR` and `${VAR}`, `~`, `*`",
  "globs, real exit codes and `$?`. Commands: 31 built-ins (`ls cat grep find head tail wc",
  "mkdir rm mv cp touch echo cd pwd env export history clear date whoami hostname uname ps",
  "kill open serve dmesg man help which`). Every command answers `--help` (GNU style) and",
  "`man <cmd>`.",
  "",
  "Not supported (clean refusal, exit 2, `verbos: not supported yet: <construct>`):",
  "subshells `$(...)`, backticks, `for`/`while`/`if`, functions, heredocs, `&`. The",
  "refusal happens at parse time — the rest of the line does not run. Use multiple",
  "`term_exec` calls instead of shell control flow.",
  "",
  "## Tips",
  "",
  "- `dmesg` prints the OS event log — everything you and the human did, attributed.",
  "- `open <app>` spawns app windows from the shell (`open editor`).",
  "- Long commands accelerate their visible typing (ceiling ~4s) — you don't pay 20ms/char",
  "  forever, and the human still sees every keystroke land.",
  "- A command that exceeds its timeout rejects with `verbos: command timed out after Ns`.",
  "  Output produced before timeout stays visible in terminal transcript; the human can",
  "  also Ctrl+C you.",
  "",
].join("\n");

function beforeNek852Readme(): string {
  return withoutNek852Readme(withoutNek850Readme(AGENT_SKILL_FILES["README.md"]));
}

function withoutNek852Readme(content: string): string {
  return content.replace(
    "6. `settings_get` / `settings_set` read and change persisted settings. `verb_hints`\n" +
      "   defaults on; setting it false removes every hover chip, including this toggle's own\n" +
      "   hint after it switches off. `cloud_kernel` changes mount only after reload; read\n" +
      "   `~/skills/cloud.md` first.",
    "6. `settings_get` / `settings_set` read and change persisted settings. `cloud_kernel`\n" +
      "   changes mount only after reload; read `~/skills/cloud.md` first.",
  );
}

// The NEK-852 and NEK-853 chains merged from sibling branches: each recorded
// hash predates the OTHER branch's edits, so every "before" reconstruction
// composes both reversal families from the merged content.
function beforeNek852Windows(): string {
  return withoutNek852Windows(without853Windows(AGENT_SKILL_FILES["windows.md"]));
}

function without853Windows(content: string): string {
  return withoutContextMenusWindows(
    withoutContextMenuFixesWindows(withoutContextMenuFixes2Windows(content)),
  );
}

function withoutNek852Windows(content: string): string {
  return content.replace(
    "Everything you do renders for the human: a glowing CODEX cursor moves to the window you\n" +
      "touched, a toast shows `AGENT RAN: <arg> · <verb>` when a target exists (otherwise\n" +
      "`AGENT RAN: <verb>`). Failures show `AGENT FAILED: <verb> · <reason>`. The menu bar\n" +
      "shows AGENT ONLINE while you're active. The CODEX cursor fades 8 seconds after your\n" +
      "latest action. Arrange windows considerately — the human is using the same desktop.",
    "Everything you do renders for the human: a glowing CODEX cursor moves to the window you\n" +
      "touched, a toast shows `AGENT RAN: <verb> · <arg>` (failures show `AGENT FAILED` with\n" +
      "the reason), and the menu bar shows AGENT ONLINE while you're active. The CODEX cursor\n" +
      "fades 8 seconds after your latest action. Arrange windows considerately — the human is\n" +
      "using the same desktop.",
  );
}

function beforeNek850Readme(): string {
  return withoutNek850Readme(withoutNek852Readme(AGENT_SKILL_FILES["README.md"]));
}

function withoutNek850Readme(content: string): string {
  return content
    .replace(
      "- `~/skills/cloud.md` — cloud-kernel reboot rules, container exec, and public `os_publish`",
      "- `~/skills/cloud.md` — cloud-kernel reboot rules and public `os_publish`",
    )
    .replace("Cold boot registers 30 system tools.", "Cold boot registers 29 system tools.");
}

function beforeNek850Cloud(): string {
  return AGENT_SKILL_FILES["cloud.md"].replace(
    /\n## Execute in the cloud container\n[\s\S]*?(?=\n## Publish a site)/,
    "",
  );
}

function beforeNek850FixesCloud(): string {
  return AGENT_SKILL_FILES["cloud.md"].replace(
    "\n`cloud_exec` is a **transact** tool because arbitrary code execution and unrestricted\n" +
      "container egress can expose workspace bytes and incur billed work. Inspect the command first.\n",
    "",
  );
}

function beforeNek850FixesTerminal(): string {
  return AGENT_SKILL_FILES["terminal.md"]
    .replace(
      "VerbOS adds `open`, `serve`, `cloud`, `ps`, `kill`, `dmesg`, `uname`, `whoami`, `hostname`,",
      "VerbOS adds `open`, `serve`, `ps`, `kill`, `dmesg`, `uname`, `whoami`, `hostname`,",
    )
    .replace(
      "Browser shell keeps `curl` and all network configuration disabled, and has no Python or\n" +
        "JavaScript runtime. Use `cloud` for network access and Node.js or Python runtimes. Commands\n" +
        "without `cloud` stay local and offline.",
      "`curl` and all network configuration are absent. Python and JavaScript runtimes are\n" +
        "also absent. Use only local files and bundled commands.",
    );
}

function beforeNek850TransactConventions(): string {
  return AGENT_SKILL_FILES["conventions.md"].replace(
    "- **transact** is consequential or irreversible (`fs_delete`, `kill`, `os_publish`,\n" +
      "  `cloud_exec`); take a second thought before calling it. Publishing makes selected\n" +
      "  bytes public, and cloud execution runs arbitrary code with open network egress.",
    "- **transact** is consequential or irreversible (`fs_delete`, `kill`, `os_publish`);\n" +
      "  take a second thought before calling it. Publishing makes selected bytes public.",
  );
}

function beforeM10Readme(): string {
  return beforeNek852Readme()
    .replace("- `~/skills/cloud.md` — cloud-kernel reboot rules and public `os_publish`\n", "")
    .replace(
      "1. `sys_status {}` returns `{hostname, uptime_s, processes, fs_backend, fs_status,\n" +
        "   skills}`. When ready, `fs_backend` and `fs_status` both use `cloud`, `local (opfs)`,\n" +
        "   or `local (memory)`. `os_manual` returns these same seeded files verbatim.",
      "1. `sys_status {}` returns `{hostname, uptime_s, processes, fs_backend, fs_status,\n" +
        "   skills}`. `os_manual` returns these same seeded files verbatim.",
    )
    .replace(
      "6. `settings_get` / `settings_set` read and change persisted settings. `cloud_kernel`\n" +
        "   changes mount only after reload; read `~/skills/cloud.md` first.",
      "6. `settings_get` / `settings_set` read and change the persisted machine settings.",
    )
    .replace("Cold boot registers 29 system tools.", "Cold boot registers 28 system tools.");
}

function beforeM10Conventions(): string {
  return beforeNek850TransactConventions().replace(
    "- **transact** is consequential or irreversible (`fs_delete`, `kill`, `os_publish`);\n" +
      "  take a second thought before calling it. Publishing makes selected bytes public.",
    "- **transact** is consequential or irreversible (`fs_delete`, `kill`); take a second\n" +
      "  thought before calling it.",
  );
}

function beforeContextMenuFixesWindows(): string {
  return withoutNek852Windows(
    withoutContextMenuFixesWindows(withoutContextMenuFixes2Windows(AGENT_SKILL_FILES["windows.md"])),
  );
}

function withoutContextMenuFixesWindows(content: string): string {
  return content
    .replace(
      "Some tools exist only while their app is open. A minimized window remains open and keeps\n" +
        "its tools registered. Opening Notes registers `notes_append`, `notes_preview`, and\n" +
        "`notes_stick`; Editor registers `editor_open_file`; Files registers `files_reveal`;\n" +
        "Preview brings its own three tools; Browser brings seven browser tools.",
      "Some tools exist only while their app is open: opening Notes registers\n" +
        "`notes_append`, `notes_preview`, and `notes_stick`; Editor registers `editor_open_file`; Files registers\n" +
        "`files_reveal`; Preview brings its own three tools; Browser brings seven browser tools.",
    )
    .replace(
      "Right-click the desktop background, desktop icons, Files rows or background, window\n" +
        "titlebars, or Dock icons for VerbOS-native menus. Each tool-backed item shows its\n" +
        "registered syscall; Minimize and Copy path stay human-only because no registered agent\n" +
        "tool matches them.\n" +
        "Minimize CSS-hides the mounted window, keeping its process, buffers, and dynamic tools\n" +
        "alive; Dock Focus or agent `window_focus` restores it.\n",
      "Right-click the desktop background, Files rows or background, window titlebars, or Dock\n" +
        "icons for VerbOS-native menus. Each tool-backed item shows its registered syscall;\n" +
        "Minimize and Copy path stay human-only because no registered agent tool matches them.\n" +
        "Minimize keeps the process alive, and Dock Focus or agent `window_focus` restores it.\n",
    );
}

function beforeContextMenuFixes2Windows(): string {
  return withoutNek852Windows(withoutContextMenuFixes2Windows(AGENT_SKILL_FILES["windows.md"]));
}

function withoutContextMenuFixes2Windows(content: string): string {
  return content.replace(
    "- `app_list {}` — every window with PID, rect, z-index, focus state, and minimized state.",
    "- `app_list {}` — every window with PID, rect, z-index, focus state.",
  );
}

function beforeContextMenusWindows(): string {
  return withoutNek852Windows(without853Windows(AGENT_SKILL_FILES["windows.md"]));
}

function withoutContextMenusWindows(content: string): string {
  return content.replace(
    "- Zoom does not exist for either user. The final titlebar dot is inert decoration.\n" +
      "\n" +
      "## Human context menus\n" +
      "\n" +
      "Right-click the desktop background, Files rows or background, window titlebars, or Dock\n" +
      "icons for VerbOS-native menus. Each tool-backed item shows its registered syscall;\n" +
      "Minimize and Copy path stay human-only because no registered agent tool matches them.\n" +
      "Minimize keeps the process alive, and Dock Focus or agent `window_focus` restores it.\n" +
      "Text inputs, textareas, and contenteditable bodies keep the browser's native context menu\n" +
      "for clipboard access.\n",
    "- Minimize and zoom do not exist for either user. Two titlebar dots are inert decoration.\n",
  );
}

describe("VerbOS filesystem", () => {
  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
  });

  test("normalizes ~ paths without allowing the 13 home-escape shapes", () => {
    expect(normalizePath("~/site//assets/../index.html")).toBe("~/site/index.html");
    expect(normalizePath("~/./notes/")).toBe("~/notes");
    expect(joinPath("~/site", "index.html")).toBe("~/site/index.html");
    expect(parentPath("~/site/index.html")).toBe("~/site");
    expect(parentPath("~/site")).toBe("~");

    const escapeShapes = [
      "/etc/passwd",
      "etc/passwd",
      "../escape.txt",
      "~other/escape.txt",
      "file:///etc/passwd",
      "C:\\Windows\\system.ini",
      "~/../escape.txt",
      "~/../../escape.txt",
      "~/site/../../escape.txt",
      "~/site/../..",
      "~//../escape.txt",
      "~/./../escape.txt",
      "~/site/\0escape.txt",
    ];
    expect(escapeShapes).toHaveLength(13);
    for (const path of escapeShapes) {
      expect(() => normalizePath(path)).toThrow(/^verbos:/);
    }
    expect(() => joinPath("~/site", "../escape.txt")).toThrow("verbos: invalid file name");
  });

  test("seeds exact demo briefs, agent skills, notes, and empty site", async () => {
    const sourceBrief = await Bun.file(
      new URL("../../../docs/demo/aurora-brief.md", import.meta.url),
    ).text();
    const sourcePizzaDemo = await Bun.file(
      new URL("../../../docs/demo/pizza-demo.md", import.meta.url),
    ).text();

    expect(AURORA_BRIEF).toBe(sourceBrief);
    expect(PIZZA_DEMO_BRIEF).toBe(sourcePizzaDemo);
    expect(await readFile("~/desktop/brief.md")).toBe(sourceBrief);
    expect(await readFile("~/desktop/pizza-demo.md")).toBe(sourcePizzaDemo);
    expect(await readFile("~/notes/welcome.md")).toContain("# Welcome to VerbOS");
    for (const [name, source] of Object.entries(AGENT_SKILL_FILES)) {
      const sourceFile = await Bun.file(
        new URL(`../../../docs/agent-skills/${name}`, import.meta.url),
      ).text();
      expect(new Bun.CryptoHasher("sha256").update(sourceFile).digest("hex")).toBe(
        AGENT_SKILL_SHA256[name as keyof typeof AGENT_SKILL_SHA256],
      );
      expect(source).toBe(sourceFile);
      expect(await readFile(`~/skills/${name}`)).toBe(sourceFile);
    }
    expect(await ls("~/site")).toEqual([]);
    expect((await ls("~")).map(({ name }) => name)).toEqual(["desktop", "notes", "site", "skills"]);
  });

  test("pins cloud manual published-site retention to the Worker contract", async () => {
    const source = await Bun.file(
      new URL("../../../docs/agent-skills/cloud.md", import.meta.url),
    ).text();
    expect(source).toContain(`deleted after ${PUBLISHED_SITE_RETENTION_DAYS} days`);
    expect(source).toContain("R2 bucket lifecycle");
    expect(source).toContain("`cloud_exec {command, cwd?, timeoutMs?}`");
    expect(source).toContain("`cloud_exec` is a **transact** tool");
    expect(source).toContain("Pipes never straddle browser and container shells");
    expect(source).toContain("restart loses those installed dependencies");
    expect(new Bun.CryptoHasher("sha256").update(source).digest("hex")).toBe(
      AGENT_SKILL_SHA256["cloud.md"],
    );
    const terminal = await Bun.file(
      new URL("../../../docs/agent-skills/terminal.md", import.meta.url),
    ).text();
    expect(terminal).toContain("VerbOS adds `open`, `serve`, `cloud`, `ps`");
    expect(terminal).toContain("Use `cloud` for network access and Node.js or Python runtimes");
  });

  test("round-trips writes, lists metadata, moves, and deletes", async () => {
    await writeFile("~/site/index.html", "<h1>Aurora</h1>", "system");
    expect(await readFile("~/site/index.html")).toBe("<h1>Aurora</h1>");
    expect(await stat("~/site/index.html")).toEqual(
      expect.objectContaining({ path: "~/site/index.html", kind: "file", size: 15 }),
    );

    await mkdir("~/site/assets", "system");
    await mv("~/site/index.html", "~/site/home.html", "system");
    expect((await ls("~/site")).map(({ name }) => name)).toEqual(["assets", "home.html"]);
    await rm("~/site/assets", "system");
    await rm("~/site/home.html", "system");
    expect(await ls("~/site")).toEqual([]);
  });

  test("creates files without clobbering existing content", async () => {
    await writeFile("~/desktop/existing.txt", "keep me", "system");

    await expect(createFile("~/desktop/existing.txt", "", "human")).rejects.toThrow(
      "verbos: file exists: ~/desktop/existing.txt",
    );
    expect(await readFile("~/desktop/existing.txt")).toBe("keep me");
  });

  test("atomically replaces shorter writes and enters the exclusive Web Lock", async () => {
    await writeFile("~/site/settings.json", "x".repeat(512), "system");
    await writeFile("~/site/settings.json", "{}\n", "system");
    expect(await readFile("~/site/settings.json")).toBe("{}\n");
    expect((await stat("~/site/settings.json")).size).toBe(3);

    const calls: string[] = [];
    let tail = Promise.resolve();
    const locks = {
      request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        expect(options.mode).toBe("exclusive");
        const result = tail.then(async () => {
          calls.push(`${name}:start`);
          const value = await callback({ name, mode: "exclusive" } as Lock);
          calls.push(`${name}:end`);
          return value;
        });
        tail = result.then(() => undefined);
        return result;
      },
    } as Pick<LockManager, "request">;

    await Promise.all([
      withFileSystemWriteLock(async () => {
        calls.push("first");
      }, locks),
      withFileSystemWriteLock(async () => {
        calls.push("second");
      }, locks),
    ]);
    expect(calls).toEqual([
      "verbos-filesystem-write:start",
      "first",
      "verbos-filesystem-write:end",
      "verbos-filesystem-write:start",
      "second",
      "verbos-filesystem-write:end",
    ]);
  });

  test("keeps the target and cleans the temporary when atomic rename fails", async () => {
    await writeFile("~/site/settings.json", "old", "system");
    const rename = spyOn(zenfs.promises, "rename").mockImplementation(async () => {
      throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    });
    try {
      await expect(writeFile("~/site/settings.json", "new", "system")).rejects.toThrow(
        "injected rename failure",
      );
    } finally {
      rename.mockRestore();
    }

    expect(await readFile("~/site/settings.json")).toBe("old");
    expect((await ls("~/site")).map(({ name }) => name)).toEqual(["settings.json"]);
  });

  test("pins the real WebAccess index entries shape used for OPFS ID repair", async () => {
    const indexFile = {
      kind: "file",
      name: "index.html",
      async getFile() {
        return { lastModified: 123, size: 4 };
      },
    } as unknown as FileSystemFileHandle;
    const site = {
      kind: "directory",
      name: "site",
      async *entries() {
        yield ["index.html", indexFile] as const;
      },
    } as unknown as FileSystemDirectoryHandle;
    const root = {
      kind: "directory",
      name: "",
      async *entries() {
        yield ["site", site] as const;
      },
    } as unknown as FileSystemDirectoryHandle;
    const webAccess = await WebAccess.create({ handle: root, disableHandleCache: true });
    const entries = [...webAccess.index.entries()];

    expect(entries.map(([path]) => path)).toEqual(["/", "/site", "/site/index.html"]);
    for (const entry of entries) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe("string");
      expect(entry[0].startsWith("/")).toBe(true);
      expect(entry[1]).toEqual(expect.objectContaining({
        data: expect.any(Number),
        ino: expect.any(Number),
        nlink: expect.any(Number),
      }));
    }
    const rootIds = { ino: entries[0]?.[1].ino, data: entries[0]?.[1].data };
    assignUniqueFileSystemIds(webAccess.index.entries());

    expect(webAccess.index.get("/")).toEqual(expect.objectContaining(rootIds));
    const ids = entries.slice(1).flatMap(([, { ino, data }]) => [ino, data]);
    expect(ids.sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
    expect(new Set(ids).size).toBe(4);
    expect(entries.slice(1).every(([, inode]) => inode.nlink === 1)).toBe(true);
  });

  test("fsck repairs a readable directory whose stat metadata says file", async () => {
    let repaired = false;
    let movedPath = "";
    const notDirectory = () => Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    const report = await checkFileSystem({
      async stat(path) {
        return {
          isDirectory: () => path === "/" || (path === "/notes" && repaired),
        };
      },
      async readdir(path) {
        if (path === "/") return ["notes"];
        if (path === "/notes") return ["welcome.md"];
        throw notDirectory();
      },
      async rename(from, to) {
        if (from === "/notes") {
          movedPath = to;
          return;
        }
        if (from === movedPath && to === "/notes") {
          repaired = true;
          return;
        }
        throw new Error(`unexpected rename ${from} -> ${to}`);
      },
      async rm() {},
    });

    expect(report).toEqual({ repaired: ["~/notes"], warnings: [] });
  });

  test("fsck surfaces directory metadata it cannot repair", async () => {
    const notDirectory = () => Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    const report = await checkFileSystem({
      async stat(path) {
        return { isDirectory: () => path === "/" };
      },
      async readdir(path) {
        if (path === "/") return ["notes"];
        if (path === "/notes") return ["welcome.md"];
        throw notDirectory();
      },
      async rename() {
        throw new Error("repair denied");
      },
      async rm() {},
    });

    expect(report.repaired).toEqual([]);
    expect(report.warnings).toContainEqual(expect.stringContaining("~/notes: readable directory reported as a file"));
  });

  test("fsck sweeps stale write and repair temporaries recursively", async () => {
    const removed: string[] = [];
    const notDirectory = () => Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    const report = await checkFileSystem({
      async stat(path) {
        return { isDirectory: () => path === "/" || path === "/site" };
      },
      async readdir(path) {
        if (path === "/") return [".verbos-write-root", "site"];
        if (path === "/site") return [".verbos-fsck-nested", "index.html"];
        throw notDirectory();
      },
      async rename() {},
      async rm(path) {
        removed.push(path);
      },
    });

    expect(removed).toEqual(["/.verbos-write-root", "/site/.verbos-fsck-nested"]);
    expect(report).toEqual({
      repaired: ["~/.verbos-write-root", "~/site/.verbos-fsck-nested"],
      warnings: [],
    });
  });

  test("rejects directory reads and writes without corrupting the directory", async () => {
    await expect(readFile("~/desktop")).rejects.toThrow("verbos: is a directory: ~/desktop");
    await expect(writeFile("~/desktop", "corrupt", "system")).rejects.toThrow(
      /^verbos: is a directory: ~\/desktop$/,
    );
    expect((await ls("~/desktop")).map(({ name }) => name)).toEqual([
      "brief.md",
      "pizza-demo.md",
    ]);

    await writeFile("~/site/file.txt", "text", "system");
    await expect(mkdir("~/site/file.txt", "system")).rejects.toThrow("verbos: is a file: ~/site/file.txt");
  });

  test("reports a missing write parent and attributes move failures", async () => {
    await expect(ls("~/missing")).rejects.toThrow(
      "verbos: no such directory: ~/missing",
    );
    await expect(writeFile("~/site/css/style.css", "body{}", "system")).rejects.toThrow(
      "verbos: no such directory: ~/site/css",
    );
    await expect(mv("~/missing.txt", "~/site/moved.txt", "system")).rejects.toThrow(
      "verbos: no such file: ~/missing.txt",
    );
    await writeFile("~/site/source.txt", "source", "system");
    await expect(mv("~/site/source.txt", "~/missing/moved.txt", "system")).rejects.toThrow(
      "verbos: no such directory: ~/missing",
    );
  });

  test("rejects self-nesting and existing move destinations unless overwrite is explicit", async () => {
    await mkdir("~/site/tree", "system");
    await mkdir("~/site/tree/child", "system");
    await expect(mv("~/site/tree", "~/site/tree/child", "system")).rejects.toThrow(
      "verbos: cannot move ~/site/tree into itself: ~/site/tree/child",
    );
    await expect(mv("~/site/tree", "~/site/tree", "system")).rejects.toThrow(
      "verbos: cannot move ~/site/tree into itself: ~/site/tree",
    );

    await writeFile("~/site/source.txt", "source", "system");
    await writeFile("~/site/destination.txt", "destination", "system");
    await expect(
      mv("~/site/source.txt", "~/site/destination.txt", "system"),
    ).rejects.toThrow("verbos: destination exists: ~/site/destination.txt");
    expect(await readFile("~/site/source.txt")).toBe("source");
    expect(await readFile("~/site/destination.txt")).toBe("destination");

    await mv("~/site/source.txt", "~/site/destination.txt", "system", true);
    expect(await exists("~/site/source.txt")).toBe(false);
    expect(await readFile("~/site/destination.txt")).toBe("source");
  });

  test("reports stable errors and emits each mutation on the OS event bus", async () => {
    const watched: string[] = [];
    const unwatch = watch((change) => watched.push(`${change.operation}:${change.path}`));
    try {
      await expect(readFile("~/missing.txt")).rejects.toThrow(
        "verbos: no such file: ~/missing.txt",
      );
      await mkdir("~/scratch", "agent");
      await writeFile("~/scratch/note.txt", "hello", "agent");
      await mv("~/scratch/note.txt", "~/scratch/moved.txt", "agent");
      await rm("~/scratch", "agent");
    } finally {
      unwatch();
    }

    expect(watched).toEqual([
      "mkdir:~/scratch",
      "write:~/scratch/note.txt",
      "move:~/scratch/moved.txt",
      "delete:~/scratch",
    ]);
    expect(
      useKernelStore.getState().events.filter(({ verb }) => verb === "fs_change"),
    ).toHaveLength(4);
    expect(useKernelStore.getState().events.at(-1)).toEqual(
      expect.objectContaining({
        source: "system",
        verb: "fs_change",
        args: expect.objectContaining({ source: "agent", path: "~/scratch" }),
      }),
    );
  });

  test("seed marker preserves visitor edits", async () => {
    await writeFile("~/desktop/brief.md", "visitor edit", "human");
    await writeFile("~/desktop/pizza-demo.md", "visitor pizza edit", "human");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await seedFileSystem();
    expect(await readFile("~/desktop/brief.md")).toBe("visitor edit");
    expect(await readFile("~/desktop/pizza-demo.md")).toBe("visitor pizza edit");
    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("backfills pizza demo for an existing installation", async () => {
    await rm("~/desktop/pizza-demo.md", "system");
    await rm("~/.verbos-pizza-demo-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/desktop/pizza-demo.md")).toBe(PIZZA_DEMO_BRIEF);
  });

  test("backfills M7 agent skills without reverting existing edits", async () => {
    await rm("~/skills/apps.md", "system");
    await rm("~/.verbos-m7-seeded", "system");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");

    await seedFileSystem();

    expect(await readFile("~/skills/apps.md")).toBe(AGENT_SKILL_FILES["apps.md"]);
    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("backfills M8 manuals without reverting existing edits", async () => {
    const previousConventions = beforeM10Conventions().replace(
      "bash: missing-command: command not found",
      "verbos: not supported yet: for loop",
    );
    expect(new Bun.CryptoHasher("sha256").update(previousConventions).digest("hex")).toBe(
      M7_AGENT_SKILL_SHA256["conventions.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(M7_TERMINAL_SKILL).digest("hex")).toBe(
      M7_AGENT_SKILL_SHA256["terminal.md"],
    );
    await writeFile("~/skills/conventions.md", previousConventions, "system");
    await writeFile("~/skills/terminal.md", M7_TERMINAL_SKILL, "system");
    await rm("~/.verbos-m8-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/conventions.md")).toBe(AGENT_SKILL_FILES["conventions.md"]);
    expect(await readFile("~/skills/terminal.md")).toBe(AGENT_SKILL_FILES["terminal.md"]);

    await rm("~/.verbos-m8-seeded", "system");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await seedFileSystem();

    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("backfills the polished terminal manual without reverting existing edits", async () => {
    const previousTerminal = beforeNek850FixesTerminal()
      .replace(
        "`clear`, shared `history`, `man`, and `verbos_help`. Run `verbos_help` to list both bundled\n" +
          "and VerbOS commands. A standalone top-level `help` or `help COMMAND` is an alias for\n" +
          "`verbos_help`; inside a pipeline or subshell, `help` is just-bash's native builtin and does\n" +
          "not include VerbOS commands. Run `COMMAND --help` for command usage and\n" +
          "`man <topic|tool|OS-command>` for VerbOS manuals.",
        "`clear`, shared `history`, and `man`. Run `help` to list both bundled and VerbOS commands. Run\n" +
          "`COMMAND --help` or `help COMMAND` for command usage, and `man <topic|tool|OS-command>`\n" +
          "for VerbOS manuals.",
      )
      .replace(
        "\nFilesystem compatibility is intentionally limited: `ln SOURCE DEST` copies the source bytes\n" +
          "once rather than creating a real hard link, symbolic links are unsupported so `readlink`\n" +
          "fails, and `chmod` validates the path but is otherwise a no-op.\n",
        "",
      );
    expect(new Bun.CryptoHasher("sha256").update(previousTerminal).digest("hex")).toBe(
      M8_AGENT_SKILL_SHA256["terminal.md"],
    );
    await writeFile("~/skills/terminal.md", previousTerminal, "system");
    await rm("~/.verbos-m9-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/terminal.md")).toBe(AGENT_SKILL_FILES["terminal.md"]);

    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await rm("~/.verbos-m9-seeded", "system");
    await seedFileSystem();

    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("backfills browser manual and migrates unchanged topic indexes", async () => {
    const previousReadme = beforeM10Readme()
      .replace("- `~/skills/browser.md` — the shared Cloudflare Chrome session and its dynamic tools\n", "")
      .replace("Cold boot registers 28 system tools.", "Cold boot registers 27 system tools.");
    const previousWindows = beforeNek852Windows()
      .replace(
        "- `browser_open` — start or focus the singleton shared Cloudflare Chrome window. Read\n" +
          "  `~/skills/browser.md`; Browser does not open through agent `app_open`.\n",
        "",
      )
      .replace(
        "`files_reveal`; Preview brings its own three tools; Browser brings seven browser tools.\n" +
          "Your tool list is alive — re-list",
        "`files_reveal`; Preview brings its own three tools. Your tool list is alive — re-list",
      );
    expect(new Bun.CryptoHasher("sha256").update(previousReadme).digest("hex")).toBe(
      M9_BROWSER_AGENT_SKILL_SHA256["README.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousWindows).digest("hex")).toBe(
      M9_BROWSER_AGENT_SKILL_SHA256["windows.md"],
    );
    await writeFile("~/skills/README.md", previousReadme, "system");
    await writeFile("~/skills/windows.md", previousWindows, "system");
    await rm("~/skills/browser.md", "system");
    await rm("~/.verbos-m9-browser-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/README.md")).toBe(AGENT_SKILL_FILES["README.md"]);
    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);
    expect(await readFile("~/skills/browser.md")).toBe(AGENT_SKILL_FILES["browser.md"]);

    await writeFile("~/skills/README.md", "visitor skill edit", "human");
    await rm("~/.verbos-m9-browser-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/README.md")).toBe("visitor skill edit");
  });

  test("backfills cloud manual and migrates unchanged M9 indexes without reverting edits", async () => {
    const previousReadme = beforeM10Readme();
    const previousConventions = beforeM10Conventions();
    const previousFilesystem = AGENT_SKILL_FILES["filesystem.md"].replace(
      "One shared filesystem. It persists in browser OPFS by default or in a Cloudflare\n" +
        "Computer workspace after the cloud-kernel reboot described in `~/skills/cloud.md`.\n" +
        "The human sees it in Files and Editor; you see it through `fs_*` tools and the shell.\n" +
        "Same bytes, live in both directions.",
      "One shared filesystem, persisted in the browser (OPFS). The human sees it in the Files\n" +
        "window and edits it in the Editor; you see it through `fs_*` tools and the shell. Same\n" +
        "bytes, live in both directions.",
    );
    expect(new Bun.CryptoHasher("sha256").update(previousReadme).digest("hex")).toBe(
      M10_CLOUD_AGENT_SKILL_SHA256["README.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousConventions).digest("hex")).toBe(
      M10_CLOUD_AGENT_SKILL_SHA256["conventions.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousFilesystem).digest("hex")).toBe(
      M10_CLOUD_AGENT_SKILL_SHA256["filesystem.md"],
    );
    await writeFile("~/skills/README.md", previousReadme, "system");
    await writeFile("~/skills/conventions.md", previousConventions, "system");
    await writeFile("~/skills/filesystem.md", previousFilesystem, "system");
    await rm("~/skills/cloud.md", "system");
    await rm("~/.verbos-m10-cloud-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/README.md")).toBe(AGENT_SKILL_FILES["README.md"]);
    expect(await readFile("~/skills/conventions.md")).toBe(AGENT_SKILL_FILES["conventions.md"]);
    expect(await readFile("~/skills/filesystem.md")).toBe(AGENT_SKILL_FILES["filesystem.md"]);
    expect(await readFile("~/skills/cloud.md")).toBe(AGENT_SKILL_FILES["cloud.md"]);

    await writeFile("~/skills/README.md", "visitor skill edit", "human");
    await rm("~/.verbos-m10-cloud-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/README.md")).toBe("visitor skill edit");
  });

  test("migrates the unchanged manual for verb hints without reverting edits", async () => {
    const previousReadme = beforeNek852Readme();
    const previousWindows = beforeNek852Windows();
    expect(new Bun.CryptoHasher("sha256").update(previousReadme).digest("hex")).toBe(
      NEK_852_AGENT_SKILL_SHA256["README.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousWindows).digest("hex")).toBe(
      NEK_852_AGENT_SKILL_SHA256["windows.md"],
    );
    await writeFile("~/skills/README.md", previousReadme, "system");
    await writeFile("~/skills/windows.md", previousWindows, "system");
    if (await exists("~/.verbos-nek-852-seeded")) {
      await rm("~/.verbos-nek-852-seeded", "system");
    }

    await seedFileSystem();

    expect(await readFile("~/skills/README.md")).toBe(AGENT_SKILL_FILES["README.md"]);
    expect(await readFile("~/skills/README.md")).toContain("`verb_hints`\n   defaults on");
    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);
    expect(await readFile("~/skills/windows.md")).toContain(
      "AGENT FAILED: <verb> · <reason>",
    );

    await writeFile("~/skills/README.md", "visitor skill edit", "human");
    await writeFile("~/skills/windows.md", "visitor windows edit", "human");
    await rm("~/.verbos-nek-852-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/README.md")).toBe("visitor skill edit");
    expect(await readFile("~/skills/windows.md")).toBe("visitor windows edit");
  });

  test("backfills context-menu manual without reverting existing edits", async () => {
    const previousWindows = beforeContextMenusWindows();
    expect(new Bun.CryptoHasher("sha256").update(previousWindows).digest("hex")).toBe(
      CONTEXT_MENUS_AGENT_SKILL_SHA256["windows.md"],
    );
    await writeFile("~/skills/windows.md", previousWindows, "system");
    if (await exists("~/.verbos-context-menus-seeded")) {
      await rm("~/.verbos-context-menus-seeded", "system");
    }

    await seedFileSystem();

    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);

    await writeFile("~/skills/windows.md", "visitor skill edit", "human");
    await rm("~/.verbos-context-menus-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe("visitor skill edit");
  });

  test("backfills context-menu fixes without reverting existing edits", async () => {
    const previousWindows = beforeContextMenuFixesWindows();
    expect(new Bun.CryptoHasher("sha256").update(previousWindows).digest("hex")).toBe(
      CONTEXT_MENUS_FIXES_AGENT_SKILL_SHA256["windows.md"],
    );
    await writeFile("~/skills/windows.md", previousWindows, "system");
    if (await exists("~/.verbos-context-menus-fixes-seeded")) {
      await rm("~/.verbos-context-menus-fixes-seeded", "system");
    }

    await seedFileSystem();

    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);

    await writeFile("~/skills/windows.md", "visitor skill edit", "human");
    await rm("~/.verbos-context-menus-fixes-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe("visitor skill edit");
  });

  test("backfills context-menu fix round 2 without reverting existing edits", async () => {
    const previousWindows = beforeContextMenuFixes2Windows();
    expect(new Bun.CryptoHasher("sha256").update(previousWindows).digest("hex")).toBe(
      CONTEXT_MENUS_FIXES_2_AGENT_SKILL_SHA256["windows.md"],
    );
    await writeFile("~/skills/windows.md", previousWindows, "system");
    if (await exists("~/.verbos-context-menus-fixes-2-seeded")) {
      await rm("~/.verbos-context-menus-fixes-2-seeded", "system");
    }

    await seedFileSystem();

    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);

    await writeFile("~/skills/windows.md", "visitor skill edit", "human");
    await rm("~/.verbos-context-menus-fixes-2-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe("visitor skill edit");
  });

  test("reconciles single-branch dev manuals after the expansion merge", async () => {
    const from852 = without853Windows(AGENT_SKILL_FILES["windows.md"]);
    const from853 = withoutNek852Windows(AGENT_SKILL_FILES["windows.md"]);
    expect(new Bun.CryptoHasher("sha256").update(from852).digest("hex")).toBe(
      EXPANSION_MERGE_852_SHA256["windows.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(from853).digest("hex")).toBe(
      EXPANSION_MERGE_853_SHA256["windows.md"],
    );

    await writeFile("~/skills/windows.md", from852, "system");
    if (await exists("~/.verbos-webmcp-expansion-merge-seeded")) {
      await rm("~/.verbos-webmcp-expansion-merge-seeded", "system");
    }
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);

    await writeFile("~/skills/windows.md", from853, "system");
    if (await exists("~/.verbos-webmcp-expansion-merge-seeded-853")) {
      await rm("~/.verbos-webmcp-expansion-merge-seeded-853", "system");
    }
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);

    await writeFile("~/skills/windows.md", "visitor skill edit", "human");
    await rm("~/.verbos-webmcp-expansion-merge-seeded", "system");
    await rm("~/.verbos-webmcp-expansion-merge-seeded-853", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe("visitor skill edit");

    const readme852 = withoutNek850Readme(AGENT_SKILL_FILES["README.md"]);
    const readme850 = withoutNek852Readme(AGENT_SKILL_FILES["README.md"]);
    expect(new Bun.CryptoHasher("sha256").update(readme852).digest("hex")).toBe(
      EXPANSION_MERGE_852_SHA256["README.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(readme850).digest("hex")).toBe(
      EXPANSION_MERGE_850_SHA256["README.md"],
    );
    await writeFile("~/skills/README.md", readme850, "system");
    await rm("~/.verbos-webmcp-expansion-merge-seeded-850", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/README.md")).toBe(AGENT_SKILL_FILES["README.md"]);
  });

  test("migrates unchanged cloud-exec manuals without reverting edits", async () => {
    const previousReadme = beforeNek850Readme();
    const previousCloud = beforeNek850Cloud();
    expect(new Bun.CryptoHasher("sha256").update(previousReadme).digest("hex")).toBe(
      NEK850_CLOUD_EXEC_AGENT_SKILL_SHA256["README.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousCloud).digest("hex")).toBe(
      NEK850_CLOUD_EXEC_AGENT_SKILL_SHA256["cloud.md"],
    );
    await writeFile("~/skills/README.md", previousReadme, "system");
    await writeFile("~/skills/cloud.md", previousCloud, "system");
    await rm("~/.verbos-nek-850-cloud-exec-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/README.md")).toBe(AGENT_SKILL_FILES["README.md"]);
    expect(await readFile("~/skills/cloud.md")).toBe(AGENT_SKILL_FILES["cloud.md"]);

    await writeFile("~/skills/cloud.md", "visitor skill edit", "human");
    await rm("~/.verbos-nek-850-cloud-exec-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/cloud.md")).toBe("visitor skill edit");
  });

  test("migrates unchanged NEK-850 fix manuals without reverting edits", async () => {
    const previousCloud = beforeNek850FixesCloud();
    const previousTerminal = beforeNek850FixesTerminal();
    expect(new Bun.CryptoHasher("sha256").update(previousCloud).digest("hex")).toBe(
      NEK850_FIXES_AGENT_SKILL_SHA256["cloud.md"],
    );
    expect(new Bun.CryptoHasher("sha256").update(previousTerminal).digest("hex")).toBe(
      NEK850_FIXES_AGENT_SKILL_SHA256["terminal.md"],
    );
    await writeFile("~/skills/cloud.md", previousCloud, "system");
    await writeFile("~/skills/terminal.md", previousTerminal, "system");
    await rm("~/.verbos-nek-850-fixes-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/cloud.md")).toBe(AGENT_SKILL_FILES["cloud.md"]);
    expect(await readFile("~/skills/terminal.md")).toBe(AGENT_SKILL_FILES["terminal.md"]);

    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await rm("~/.verbos-nek-850-fixes-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("migrates the unchanged transact-tier conventions manual without reverting edits", async () => {
    const previousConventions = beforeNek850TransactConventions();
    expect(new Bun.CryptoHasher("sha256").update(previousConventions).digest("hex")).toBe(
      NEK850_TRANSACT_AGENT_SKILL_SHA256["conventions.md"],
    );
    await writeFile("~/skills/conventions.md", previousConventions, "system");
    await rm("~/.verbos-nek-850-transact-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/skills/conventions.md")).toBe(AGENT_SKILL_FILES["conventions.md"]);

    await writeFile("~/skills/conventions.md", "visitor skill edit", "human");
    await rm("~/.verbos-nek-850-transact-seeded", "system");
    await seedFileSystem();
    expect(await readFile("~/skills/conventions.md")).toBe("visitor skill edit");
  });

  test("interrupted seeding fills missing files without reverting existing edits", async () => {
    await writeFile("~/desktop/brief.md", "visitor edit", "human");
    await rm("~/.verbos-m2-seeded", "system");
    await rm("~/notes/welcome.md", "system");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await rm("~/.verbos-m5-seeded", "system");
    await rm("~/skills/preview.md", "system");

    await seedFileSystem();

    expect(await readFile("~/desktop/brief.md")).toBe("visitor edit");
    expect(await readFile("~/notes/welcome.md")).toContain("# Welcome to VerbOS");
    expect(await exists("~/notes/welcome.md")).toBe(true);
    expect(await exists("~/missing.txt")).toBe(false);
    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
    expect(await readFile("~/skills/preview.md")).toBe(AGENT_SKILL_FILES["preview.md"]);
  });

  test("falls back to memory when OPFS configuration fails", async () => {
    let memoryMounted = false;
    const backend = await selectFileSystemBackend(
      async () => {
        throw new Error("configure failed");
      },
      async () => {
        memoryMounted = true;
      },
    );

    expect(backend).toBe("memory");
    expect(memoryMounted).toBe(true);
  });
});
