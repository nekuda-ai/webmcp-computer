import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fs as zenfs } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import { resetKernelStore, useKernelStore } from "./store";
import {
  agentSkillSeedMarkerPath,
  AURORA_BRIEF,
  assignUniqueFileSystemIds,
  checkFileSystem,
  createFile,
  exists,
  initializeMemoryFileSystem,
  joinPath,
  LEGACY_AGENT_SKILL_SHA256,
  ls,
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
  updateFile,
  withFileSystemWriteLock,
  watch,
  writeFile,
} from "./fs";
import { AGENT_SKILL_FILES, AGENT_SKILL_SHA256 } from "./manualContent";
import legacyWindowsManual from "./__fixtures__/windows-manual-legacy.md?raw";
import { PUBLISHED_SITE_RETENTION_DAYS } from "../../../workers/computer/src/protocol";

async function skillsMarker(): Promise<string> {
  return `~${await agentSkillSeedMarkerPath()}`;
}

describe("WebMCP Computer filesystem", () => {
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
      expect(() => normalizePath(path)).toThrow(/^webmcp-computer:/);
    }
    expect(() => joinPath("~/site", "../escape.txt")).toThrow("webmcp-computer: invalid file name");
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
    expect(await readFile("~/notes/welcome.md")).toContain("# Welcome to WebMCP Computer");
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
    expect(terminal).toContain("WebMCP Computer adds `open`, `serve`, `cloud`, `ps`");
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

  test("rejects a delayed human update after takeover even if ownership is reacquired", async () => {
    const path = "~/desktop/ownership.txt";
    await writeFile(path, "new owner", "system");
    let continueUpdate = () => {};
    let markUpdating = () => {};
    const updating = new Promise<void>((resolve) => { markUpdating = resolve; });
    const gate = new Promise<void>((resolve) => { continueUpdate = resolve; });

    const staleWrite = updateFile(path, async () => {
      markUpdating();
      await gate;
      return "stale human";
    }, "human");
    await updating;
    useKernelStore.getState().setMachineOwnership("conflict");
    useKernelStore.getState().setMachineOwnership("owned");
    continueUpdate();

    await expect(staleWrite).rejects.toThrow("machine ownership changed while action was pending");
    expect(await readFile(path)).toBe("new owner");
  });

  test("keeps agent mutations compatible while owned and permits system boot writes while pending", async () => {
    await writeFile("~/site/agent.txt", "agent", "agent");
    useKernelStore.getState().setMachineOwnership("pending");
    await writeFile("~/site/system.txt", "system", "system");

    expect(await readFile("~/site/agent.txt")).toBe("agent");
    expect(await readFile("~/site/system.txt")).toBe("system");
    await expect(writeFile("~/site/human.txt", "human", "human")).rejects.toThrow(
      "machine ownership is still being acquired",
    );
  });

  test("creates files without clobbering existing content", async () => {
    await writeFile("~/desktop/existing.txt", "keep me", "system");

    await expect(createFile("~/desktop/existing.txt", "", "human")).rejects.toThrow(
      "webmcp-computer: file exists: ~/desktop/existing.txt",
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
      "webmcp-computer-filesystem-write:start",
      "first",
      "webmcp-computer-filesystem-write:end",
      "webmcp-computer-filesystem-write:start",
      "second",
      "webmcp-computer-filesystem-write:end",
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
        if (path === "/") return [".webmcp-computer-write-root", "site"];
        if (path === "/site") return [".webmcp-computer-fsck-nested", "index.html"];
        throw notDirectory();
      },
      async rename() {},
      async rm(path) {
        removed.push(path);
      },
    });

    expect(removed).toEqual(["/.webmcp-computer-write-root", "/site/.webmcp-computer-fsck-nested"]);
    expect(report).toEqual({
      repaired: ["~/.webmcp-computer-write-root", "~/site/.webmcp-computer-fsck-nested"],
      warnings: [],
    });
  });

  test("rejects directory reads and writes without corrupting the directory", async () => {
    await expect(readFile("~/desktop")).rejects.toThrow("webmcp-computer: is a directory: ~/desktop");
    await expect(writeFile("~/desktop", "corrupt", "system")).rejects.toThrow(
      /^webmcp-computer: is a directory: ~\/desktop$/,
    );
    expect((await ls("~/desktop")).map(({ name }) => name)).toEqual([
      "brief.md",
      "pizza-demo.md",
    ]);

    await writeFile("~/site/file.txt", "text", "system");
    await expect(mkdir("~/site/file.txt", "system")).rejects.toThrow("webmcp-computer: is a file: ~/site/file.txt");
  });

  test("reports a missing write parent and attributes move failures", async () => {
    await expect(ls("~/missing")).rejects.toThrow(
      "webmcp-computer: no such directory: ~/missing",
    );
    await expect(writeFile("~/site/css/style.css", "body{}", "system")).rejects.toThrow(
      "webmcp-computer: no such directory: ~/site/css",
    );
    await expect(mv("~/missing.txt", "~/site/moved.txt", "system")).rejects.toThrow(
      "webmcp-computer: no such file: ~/missing.txt",
    );
    await writeFile("~/site/source.txt", "source", "system");
    await expect(mv("~/site/source.txt", "~/missing/moved.txt", "system")).rejects.toThrow(
      "webmcp-computer: no such directory: ~/missing",
    );
  });

  test("rejects self-nesting and existing move destinations unless overwrite is explicit", async () => {
    await mkdir("~/site/tree", "system");
    await mkdir("~/site/tree/child", "system");
    await expect(mv("~/site/tree", "~/site/tree/child", "system")).rejects.toThrow(
      "webmcp-computer: cannot move ~/site/tree into itself: ~/site/tree/child",
    );
    await expect(mv("~/site/tree", "~/site/tree", "system")).rejects.toThrow(
      "webmcp-computer: cannot move ~/site/tree into itself: ~/site/tree",
    );

    await writeFile("~/site/source.txt", "source", "system");
    await writeFile("~/site/destination.txt", "destination", "system");
    await expect(
      mv("~/site/source.txt", "~/site/destination.txt", "system"),
    ).rejects.toThrow("webmcp-computer: destination exists: ~/site/destination.txt");
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
        "webmcp-computer: no such file: ~/missing.txt",
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
    await rm("~/.webmcp-computer-seeded", "system");

    await seedFileSystem();

    expect(await readFile("~/desktop/pizza-demo.md")).toBe(PIZZA_DEMO_BRIEF);
  });

  test("backfills missing agent skills without reverting existing edits", async () => {
    await rm("~/skills/apps.md", "system");
    await rm(await skillsMarker(), "system");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");

    await seedFileSystem();

    expect(await readFile("~/skills/apps.md")).toBe(AGENT_SKILL_FILES["apps.md"]);
    expect(await readFile("~/skills/terminal.md")).toBe("visitor skill edit");
  });

  test("upgrades an unchanged previously shipped manual and keeps visitor edits", async () => {
    const legacyHash = new Bun.CryptoHasher("sha256").update(legacyWindowsManual).digest("hex");
    expect(LEGACY_AGENT_SKILL_SHA256.has(legacyHash)).toBe(true);
    expect(legacyWindowsManual).not.toBe(AGENT_SKILL_FILES["windows.md"]);
    await writeFile("~/skills/windows.md", legacyWindowsManual, "system");
    await rm(await skillsMarker(), "system");

    await seedFileSystem();

    expect(await readFile("~/skills/windows.md")).toBe(AGENT_SKILL_FILES["windows.md"]);
    expect(await exists(await skillsMarker())).toBe(true);

    await writeFile("~/skills/windows.md", "visitor skill edit", "human");
    await rm(await skillsMarker(), "system");
    await seedFileSystem();
    expect(await readFile("~/skills/windows.md")).toBe("visitor skill edit");
  });

  test("leaves manuals alone once the current bundle marker exists", async () => {
    await writeFile("~/skills/windows.md", legacyWindowsManual, "system");

    await seedFileSystem();

    expect(await readFile("~/skills/windows.md")).toBe(legacyWindowsManual);
  });

  test("interrupted seeding fills missing files without reverting existing edits", async () => {
    await writeFile("~/desktop/brief.md", "visitor edit", "human");
    await rm("~/.webmcp-computer-seeded", "system");
    await rm("~/notes/welcome.md", "system");
    await writeFile("~/skills/terminal.md", "visitor skill edit", "human");
    await rm(await skillsMarker(), "system");
    await rm("~/skills/preview.md", "system");

    await seedFileSystem();

    expect(await readFile("~/desktop/brief.md")).toBe("visitor edit");
    expect(await readFile("~/notes/welcome.md")).toContain("# Welcome to WebMCP Computer");
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
