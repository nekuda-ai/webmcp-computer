import { beforeEach, describe, expect, test } from "bun:test";
import {
  FileSystemError,
  initializeMemoryFileSystem,
  readFile,
  readFileBytes,
  watch,
  writeFile,
  writeFileBytes,
  type FileSystemChange,
} from "../fs";
import { resetKernelStore } from "../store";
import {
  JustBashFileSystem,
  justBashPathFromKernel,
  kernelPathFromJustBash,
} from "./justBashFs";
import type { ShellExecutionSource } from "./types";

describe("M8 just-bash filesystem adapter", () => {
  let source: ShellExecutionSource;
  let fs: JustBashFileSystem;

  beforeEach(async () => {
    resetKernelStore();
    await initializeMemoryFileSystem();
    source = "human";
    fs = new JustBashFileSystem(() => source);
  });

  test("maps canonical POSIX home paths to VerbOS paths", () => {
    expect(kernelPathFromJustBash("/site/index.html")).toBe("~/site/index.html");
    expect(kernelPathFromJustBash("~/site/../notes/welcome.md")).toBe("~/notes/welcome.md");
    expect(justBashPathFromKernel("~/site/index.html")).toBe("/site/index.html");
    expect(fs.resolvePath("/site", "../notes/x.md")).toBe("/notes/x.md");
  });

  test("reads, writes, appends, and preserves binary bytes", async () => {
    await fs.writeFile("/site/text.txt", "hello");
    await fs.appendFile("/site/text.txt", " world");
    expect(await fs.readFile("/site/text.txt")).toBe("hello world");
    expect(await readFile("~/site/text.txt")).toBe("hello world");

    const binary = Uint8Array.from([0, 255, 128, 65]);
    await fs.writeFile("/site/image.png", binary);
    expect(await fs.readFileBuffer("/site/image.png")).toEqual(binary);
    expect(await readFileBytes("~/site/image.png")).toEqual(binary);
  });

  test("implements stat, typed readdir, recursive mkdir, copy, move, and remove", async () => {
    await fs.mkdir("/site/src/nested", { recursive: true });
    await fs.writeFile("/site/src/nested/a.txt", "alpha");

    expect(await fs.stat("/")).toEqual(expect.objectContaining({ isDirectory: true }));
    expect(await fs.stat("/site/src/nested/a.txt")).toEqual(
      expect.objectContaining({ isFile: true, isDirectory: false, size: 5 }),
    );
    expect(await fs.readdirWithFileTypes("/site/src/nested")).toEqual([
      { name: "a.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);

    await fs.cp("/site/src", "/site/copy", { recursive: true });
    expect(await fs.readFile("/site/copy/nested/a.txt")).toBe("alpha");
    await fs.mv("/site/copy/nested/a.txt", "/site/copy/nested/b.txt");
    expect(await fs.exists("/site/copy/nested/a.txt")).toBe(false);
    expect(await fs.exists("/site/copy/nested/b.txt")).toBe(true);
    await fs.rm("/site/copy", { recursive: true });
    expect(await fs.exists("/site/copy")).toBe(false);
  });

  test("surfaces kernel missing-file and is-a-directory errors unchanged", async () => {
    await expect(fs.readFile("/site/missing.txt")).rejects.toThrow(
      "verbos: no such file: ~/site/missing.txt",
    );
    try {
      await fs.readFile("/site");
      throw new Error("test: directory read unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      expect(error).toEqual(expect.objectContaining({
        code: "EISDIR",
        message: "verbos: is a directory: ~/site",
      }));
    }
  });

  test("refuses to mutate when execution source is unavailable", async () => {
    const unavailable = new JustBashFileSystem(() => {
      throw new Error("verbos: shell execution source unavailable");
    });

    await expect(unavailable.writeFile("/site/unattributed.txt", "x")).rejects.toThrow(
      "verbos: shell execution source unavailable",
    );
    expect(await fs.exists("/site/unattributed.txt")).toBe(false);
  });

  test("uses current execution source for every mutation", async () => {
    const changes: FileSystemChange[] = [];
    const unwatch = watch((change) => changes.push(change));
    try {
      await fs.writeFile("/site/human.txt", "h");
      source = "agent";
      await fs.appendFile("/site/human.txt", "a");
      await fs.mkdir("/site/agent-dir");
      await fs.rm("/site/agent-dir");
    } finally {
      unwatch();
    }

    expect(changes.map(({ operation, path, source: actor }) => `${operation}:${path}:${actor}`)).toEqual([
      "write:~/site/human.txt:human",
      "write:~/site/human.txt:agent",
      "mkdir:~/site/agent-dir:agent",
      "delete:~/site/agent-dir:agent",
    ]);
  });

  test("passes kernel directory-parent and overwrite behavior through", async () => {
    await expect(fs.writeFile("/missing/file.txt", "x")).rejects.toThrow(
      "verbos: no such directory: ~/missing",
    );
    await writeFile("~/site/from.txt", "from", "system");
    await writeFile("~/site/to.txt", "to", "system");
    await fs.mv("/site/from.txt", "/site/to.txt");
    expect(await readFile("~/site/to.txt")).toBe("from");
  });

  test("round-trips supported encodings", async () => {
    await fs.writeFile("/site/hex.bin", "00ff41", "hex");
    expect(await fs.readFile("/site/hex.bin", "hex")).toBe("00ff41");
    await writeFileBytes("~/site/base64.bin", Uint8Array.from([0, 1, 2, 255]), "system");
    expect(await fs.readFile("/site/base64.bin", "base64")).toBe("AAEC/w==");
  });
});
