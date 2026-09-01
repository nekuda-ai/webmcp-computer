import { beforeEach, describe, expect, test } from "bun:test";
import type { FileEntry, FileStat } from "../kernel/fs";
import { resetKernelStore, useKernelStore } from "../kernel/store";
import { qrMatrix, qrSvg } from "../shared/qr";
import { PUBLISHED_SITE_RETENTION_DAYS } from "../../../workers/computer/src/protocol";
import {
  collectPublishFiles,
  createOsPublishTool,
  MAX_PUBLISH_FILE_BYTES,
  type OsPublishFileSystem,
} from "./osPublish";

const WSID = "0123456789abcdef0123456789abcdef";

function fakeFileSystem(files: Record<string, string>): OsPublishFileSystem {
  const directories = new Set<string>(["~"]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length - 1; index += 1) {
      directories.add(parts.slice(0, index + 1).join("/"));
    }
  }
  const fileStat = (path: string): FileStat => {
    if (directories.has(path)) return { path, kind: "directory", size: 0, modifiedAt: 1 };
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    return { path, kind: "file", size: new TextEncoder().encode(content).byteLength, modifiedAt: 1 };
  };
  return {
    async stat(path) { return fileStat(path); },
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    },
    async ls(path) {
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const candidate of [...directories, ...Object.keys(files)]) {
        if (!candidate.startsWith(prefix)) continue;
        const name = candidate.slice(prefix.length).split("/")[0];
        if (name) children.add(name);
      }
      return [...children].sort().map((name) => {
        const child = `${path}/${name}`;
        const value = fileStat(child);
        return { ...value, name } satisfies FileEntry;
      });
    },
  };
}

describe("os_publish", () => {
  beforeEach(resetKernelStore);

  test("collects default ~/site recursively and returns URL, expiry, counts, bytes, and trace", async () => {
    const fileSystem = fakeFileSystem({
      "~/site/index.html": "<h1>Live</h1>",
      "~/site/assets/app.js": "console.log('live')",
    });
    let body: unknown;
    let requestUrl: string | undefined;
    const tool = createOsPublishTool({
      fileSystem,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
      fetch: (async (input, init) => {
        requestUrl = String(input);
        body = JSON.parse(String(init?.body));
        return Response.json({
          url: "https://computer.test/s/aaaaaaaa/",
          id: "aaaaaaaa",
          expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
        });
      }) as typeof fetch,
    });
    const result = await tool.execute({}) as {
      url: string;
      expiresInDays: number;
      files: number;
      bytes: number;
    };
    expect(result).toEqual({
      url: "https://computer.test/s/aaaaaaaa/",
      expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
      files: 2,
      bytes: new TextEncoder().encode("<h1>Live</h1>console.log('live')").byteLength,
    });
    expect(body).toEqual({ files: [
      { path: "assets/app.js", content: "console.log('live')" },
      { path: "index.html", content: "<h1>Live</h1>" },
    ] });
    expect(requestUrl).toBe(`http://computer.test/ws/${WSID}/publish`);
    expect(useKernelStore.getState().events.at(-1)).toEqual(expect.objectContaining({
      source: "agent",
      verb: "os_publish",
      ok: true,
      args: expect.objectContaining({
        url: result.url,
        expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
        files: 2,
        bytes: result.bytes,
      }),
    }));
  });

  test("describes public deletion after the configured retention window", () => {
    const tool = createOsPublishTool();
    expect(tool.description).toContain(
      `public and deleted after ${PUBLISHED_SITE_RETENTION_DAYS} days`,
    );
  });

  test("rejects a publish response without an expiry in house voice", async () => {
    const files = fakeFileSystem({ "~/site/index.html": "ok" });
    const missingExpiry = createOsPublishTool({
      fileSystem: files,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
      fetch: (async () => Response.json({
        url: "https://computer.test/s/aaaaaaaa/",
        id: "aaaaaaaa",
      })) as unknown as typeof fetch,
    });

    await expect(missingExpiry.execute({})).rejects.toThrow(
      "verbos: computer Worker returned an invalid publish expiry",
    );
  });

  test("rejects a file extension and names the offending path", async () => {
    await expect(collectPublishFiles(undefined, fakeFileSystem({
      "~/site/index.html": "ok",
      "~/site/assets/photo.png": "not text",
    }))).rejects.toThrow("verbos: os_publish rejects non-text file: ~/site/assets/photo.png");
  });

  test("enforces file count, per-file, and total caps before network", async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`~/site/${index}.txt`, "x"]),
    );
    await expect(collectPublishFiles(undefined, fakeFileSystem(tooMany))).rejects.toThrow(
      "verbos: os_publish exceeds 64-file cap",
    );
    await expect(collectPublishFiles(undefined, fakeFileSystem({
      "~/site/large.txt": "x".repeat(MAX_PUBLISH_FILE_BYTES + 1),
    }))).rejects.toThrow("verbos: os_publish file exceeds 256 KB: ~/site/large.txt");
    await expect(collectPublishFiles(undefined, fakeFileSystem(Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `~/site/${index}.txt`,
        "x".repeat(MAX_PUBLISH_FILE_BYTES),
      ]),
    )))).rejects.toThrow("verbos: os_publish exceeds 2 MB total cap");
  });

  test("rejects a file root, Worker failure, and unsafe publish URL with house voice", async () => {
    const files = fakeFileSystem({ "~/site/index.html": "ok" });
    await expect(collectPublishFiles("~/site/index.html", files)).rejects.toThrow(
      "verbos: publish path is not a directory: ~/site/index.html",
    );
    const failed = createOsPublishTool({
      fileSystem: files,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
      fetch: (async () => Response.json({ error: "rate limited" }, { status: 429 })) as unknown as typeof fetch,
    });
    await expect(failed.execute({})).rejects.toThrow("verbos: site publish failed: rate limited");

    const unsafe = createOsPublishTool({
      fileSystem: files,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
      fetch: (async () => Response.json({ url: "javascript:alert(1)" })) as unknown as typeof fetch,
    });
    await expect(unsafe.execute({})).rejects.toThrow(
      "verbos: computer Worker returned an invalid publish URL",
    );
  });

  test("pins the fixed publish URL QR matrix and inline SVG", () => {
    const url = "https://computer.test/s/aaaaaaaa/";
    const matrix = qrMatrix(url);
    const bits = matrix.map((row) => row.map(Number).join("")).join("\n");
    expect(new Bun.CryptoHasher("sha256").update(bits).digest("hex")).toBe(
      "221c6f0126a6f104d7b51ab9e3cb182bf6117b990bd3403de56aa8dfcd0d6eb8",
    );
    expect(matrix.length).toBe(29);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(qrSvg(url)).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(qrSvg(url)).toContain("QR code for published site");
  });

  test("renders publish QR at phone-scannable size", async () => {
    const css = await Bun.file(new URL("../styles/desktop.css", import.meta.url)).text();
    expect(css).toContain("width: 130px;");
    expect(css).toContain("height: 130px;");
    expect(css).toContain("flex: 0 0 130px;");
  });
});
