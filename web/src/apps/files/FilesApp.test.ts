import { beforeEach, describe, expect, test } from "bun:test";
import { initializeMemoryFileSystem, readFile, writeFile } from "../../kernel/fs";
import { createFilesAppEntry } from "./FilesApp";

describe("FilesApp New file", () => {
  beforeEach(async () => {
    await initializeMemoryFileSystem();
  });

  test("refuses an existing name without clobbering its content", async () => {
    const path = "~/desktop/existing.txt";
    await writeFile(path, "keep me", "system");

    await expect(createFilesAppEntry(path, "file")).rejects.toThrow(
      `verbos: file exists: ${path}`,
    );
    expect(await readFile(path)).toBe("keep me");
  });
});
