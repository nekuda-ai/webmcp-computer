import { describe, expect, test } from "bun:test";
import { configureSingle, fs as zenfs } from "@zenfs/core";
import {
  cloudKernelPreference,
  CLOUD_KERNEL_STORAGE_KEY,
  createCloudFileSystem,
  ensureWorkspaceId,
  resolveComputerWorkerUrl,
  setCloudKernelPreference,
  WORKSPACE_STORAGE_KEY,
  type CloudFsOperation,
} from "./cloudFs";
import {
  initializeMemoryFileSystem,
  mkdir,
  mv,
  readFile,
  selectFileSystemBackend,
  writeFile,
} from "./fs";
import { MAX_FS_BATCH_OPERATIONS } from "../../../workers/computer/src/protocol";
import { createFakeComputerHandler } from "../../e2e/fakeComputer";

const WSID = "0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Node = { kind: "file"; bytes: Uint8Array; mtime: number } | { kind: "directory"; mtime: number };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function protocolFake() {
  const nodes = new Map<string, Node>([["/", { kind: "directory", mtime: 1 }]]);
  const urls: string[] = [];
  const batchSizes: number[] = [];
  const error = (message: string, code: string) => Response.json({ error: message, code }, { status: 409 });
  const stat = (path: string) => {
    const node = nodes.get(path);
    if (!node) return undefined;
    return {
      name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
      size: node.kind === "file" ? node.bytes.byteLength : 0,
      mtime: node.mtime,
      isFile: node.kind === "file",
      isDirectory: node.kind === "directory",
      isSymbolicLink: false,
    };
  };
  const operation = (op: CloudFsOperation): Response | Record<string, unknown> => {
    const node = nodes.get(op.path);
    if (op.op === "exists") return { exists: node !== undefined };
    if (op.op === "stat") {
      const value = stat(op.path);
      return value ? { stat: value } : error(`no such file: ${op.path}`, "ENOENT");
    }
    if (op.op === "readdir") {
      if (!node) return error(`no such directory: ${op.path}`, "ENOENT");
      if (node.kind !== "directory") return error(`not a directory: ${op.path}`, "ENOTDIR");
      const prefix = op.path === "/" ? "/" : `${op.path}/`;
      const entries = [...nodes.keys()]
        .filter((path) => path.startsWith(prefix) && path !== op.path && !path.slice(prefix.length).includes("/"))
        .map((path) => stat(path));
      return { entries };
    }
    if (op.op === "read") {
      if (!node) return error(`no such file: ${op.path}`, "ENOENT");
      if (node.kind !== "file") return error(`is a directory: ${op.path}`, "EISDIR");
      return { data: base64(node.bytes) };
    }
    if (op.op === "mkdir") {
      const parent = op.path.slice(0, op.path.lastIndexOf("/")) || "/";
      if (!nodes.has(parent)) return error(`no such directory: ${parent}`, "ENOENT");
      nodes.set(op.path, { kind: "directory", mtime: Date.now() });
      return { ok: true };
    }
    if (op.op === "write") {
      const parent = op.path.slice(0, op.path.lastIndexOf("/")) || "/";
      if (nodes.get(parent)?.kind !== "directory") return error(`no such directory: ${parent}`, "ENOENT");
      const binary = atob(op.data ?? "");
      nodes.set(op.path, {
        kind: "file",
        bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
        mtime: Date.now(),
      });
      return { ok: true };
    }
    if (op.op === "rm") {
      if (!node) return error(`no such file: ${op.path}`, "ENOENT");
      for (const path of nodes.keys()) {
        if (path === op.path || path.startsWith(`${op.path}/`)) nodes.delete(path);
      }
      return { ok: true };
    }
    if (op.op === "rename") {
      if (!node) return error(`no such file: ${op.path}`, "ENOENT");
      const moves = [...nodes.entries()].filter(([path]) => path === op.path || path.startsWith(`${op.path}/`));
      for (const [path] of moves) nodes.delete(path);
      for (const [path, value] of moves) nodes.set(`${op.to}${path.slice(op.path.length)}`, value);
      return { ok: true };
    }
    return error("unsupported", "EINVAL");
  };

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as CloudFsOperation | CloudFsOperation[];
    if (Array.isArray(body)) {
      batchSizes.push(body.length);
      if (body.length > MAX_FS_BATCH_OPERATIONS) {
        return Response.json(
          { error: `batch must contain 1-${MAX_FS_BATCH_OPERATIONS} operations`, code: "EINVAL" },
          { status: 400 },
        );
      }
      const results: unknown[] = [];
      for (const entry of body) {
        const result = operation(entry);
        results.push(result instanceof Response ? await result.json() : result);
      }
      return Response.json(results);
    }
    const result = operation(body);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetch: fetcher as typeof fetch, nodes, urls, batchSizes };
}

async function renameCollisionSnapshot(destination: "directory" | "file") {
  await mkdir("~/source", "system");
  await writeFile("~/source/new.txt", "new", "system");
  if (destination === "directory") {
    await mkdir("~/destination", "system");
    await writeFile("~/destination/old.txt", "old", "system");
  } else {
    await writeFile("~/destination", "old", "system");
  }
  let error: { code?: string; message?: string } | undefined;
  try {
    await mv("~/source", "~/destination", "system", true);
  } catch (caught) {
    error = caught as { code?: string; message?: string };
  }
  return {
    code: error?.code,
    message: error?.message,
    source: await readFile("~/source/new.txt"),
    destination: destination === "directory"
      ? await readFile("~/destination/old.txt")
      : await readFile("~/destination"),
  };
}

describe("cloud filesystem backend", () => {
  test("round-trips ZenFS operations and preserves POSIX errors through injected fetch", async () => {
    const fake = protocolFake();
    const cloud = await createCloudFileSystem({
      fetch: fake.fetch,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
    });
    await configureSingle(cloud);

    await zenfs.promises.mkdir("/notes");
    await zenfs.promises.writeFile("/notes/proof.txt", "cloud", "utf8");
    expect(await zenfs.promises.readFile("/notes/proof.txt", "utf8")).toBe("cloud");
    expect((await zenfs.promises.stat("/notes/proof.txt")).size).toBe(5);
    expect(await zenfs.promises.readdir("/notes")).toEqual(["proof.txt"]);

    await zenfs.promises.rename("/notes/proof.txt", "/notes/moved.txt");
    expect(decoder.decode((fake.nodes.get("/notes/moved.txt") as { bytes: Uint8Array }).bytes)).toBe("cloud");
    await zenfs.promises.rm("/notes/moved.txt");
    expect(fake.nodes.has("/notes/moved.txt")).toBe(false);
    await expect(zenfs.promises.readFile("/notes/missing.txt", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(fake.urls[0]).toEndWith(`/ws/${WSID}/fs/batch`);
  });

  test("selects cloud then OPFS then memory, exposing cloud failure", async () => {
    const calls: string[] = [];
    const warning: unknown[] = [];
    expect(await selectFileSystemBackend(
      async () => { calls.push("opfs"); },
      async () => { calls.push("memory"); },
      async () => { calls.push("cloud"); },
    )).toBe("cloud");
    expect(calls).toEqual(["cloud"]);

    calls.length = 0;
    expect(await selectFileSystemBackend(
      async () => { calls.push("opfs"); throw new Error("opfs down"); },
      async () => { calls.push("memory"); },
      async () => { calls.push("cloud"); throw new Error("cloud down"); },
      (error) => warning.push(error),
    )).toBe("memory");
    expect(calls).toEqual(["cloud", "opfs", "memory"]);
    expect(warning[0]).toEqual(expect.objectContaining({ message: "cloud down" }));
  });

  test("times out a never-settling cloud mount and falls back to OPFS", async () => {
    let requestSignal: AbortSignal | undefined;
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const warning: unknown[] = [];
    const backend = await selectFileSystemBackend(
      async () => {},
      async () => {},
      async () => {
        await createCloudFileSystem({
          fetch: hangingFetch,
          workerBaseUrl: "http://computer.test",
          workspaceId: WSID,
          requestTimeoutMs: 1,
        });
      },
      (error) => warning.push(error),
      10,
    );
    expect(backend).toBe("opfs");
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
    expect(warning[0]).toEqual(expect.objectContaining({
      message: "webmcp-computer: cloud filesystem mount timed out after 10ms",
    }));
  });

  test("treats throwing storage as cloud-off and keeps local backend selection usable", async () => {
    const throwingStorage = {
      getItem(): string | null {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(cloudKernelPreference(throwingStorage)).toBe(false);
    expect(resolveComputerWorkerUrl({
      storage: throwingStorage,
      search: "",
      envUrl: "https://env.test",
      production: true,
    })).toBe("https://env.test");
    const calls: string[] = [];
    expect(await selectFileSystemBackend(
      async () => { calls.push("opfs"); },
      async () => { calls.push("memory"); },
      cloudKernelPreference(throwingStorage) ? async () => { calls.push("cloud"); } : undefined,
    )).toBe("opfs");
    expect(calls).toEqual(["opfs"]);
  });

  test("matches local data-preserving failures for directory rename collisions", async () => {
    await initializeMemoryFileSystem();
    const localDirectory = await renameCollisionSnapshot("directory");
    const directoryFake = protocolFake();
    await configureSingle(await createCloudFileSystem({
      fetch: directoryFake.fetch,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
    }));
    expect(await renameCollisionSnapshot("directory")).toEqual(localDirectory);

    await initializeMemoryFileSystem();
    const localFile = await renameCollisionSnapshot("file");
    const fileFake = protocolFake();
    await configureSingle(await createCloudFileSystem({
      fetch: fileFake.fetch,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
    }));
    expect(await renameCollisionSnapshot("file")).toEqual(localFile);
  });

  test("chunks wide cloud-directory loads to the shared Worker batch cap", async () => {
    const fake = protocolFake();
    for (let index = 0; index < MAX_FS_BATCH_OPERATIONS + 12; index += 1) {
      fake.nodes.set(`/directory-${index}`, { kind: "directory", mtime: index + 2 });
    }
    await createCloudFileSystem({
      fetch: fake.fetch,
      workerBaseUrl: "http://computer.test",
      workspaceId: WSID,
    });
    expect(fake.batchSizes).toEqual([2, MAX_FS_BATCH_OPERATIONS, 12]);
  });

  test("e2e fake delegates validation, caps, publish routes, and rename errors to real handler", async () => {
    const fake = createFakeComputerHandler();
    const fsRequest = (body: unknown, suffix = "") => fake.fetch(new Request(
      `http://computer.test/ws/${WSID}/fs${suffix}`,
      { method: "POST", body: JSON.stringify(body) },
    ));
    expect((await fsRequest(
      Array.from({ length: MAX_FS_BATCH_OPERATIONS + 1 }, () => ({ op: "exists", path: "/" })),
      "/batch",
    )).status).toBe(400);
    expect((await fsRequest({ op: "read", path: "relative" })).status).toBe(400);
    expect((await fsRequest({ op: "exists", path: "/", unknown: true })).status).toBe(400);
    expect((await fake.fetch(new Request("http://computer.test/publish", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", content: "wrong route" }] }),
    }))).status).toBe(404);

    await fsRequest({ op: "mkdir", path: "/target" });
    await fsRequest({ op: "write", path: "/from.txt", data: base64(encoder.encode("from")) });
    const collision = await fsRequest({ op: "rename", path: "/from.txt", to: "/target" });
    expect(collision.status).toBe(409);
    expect(await collision.json() as unknown).toEqual(expect.objectContaining({ code: "EISDIR" }));

    const published = await fake.fetch(new Request(`http://computer.test/ws/${WSID}/publish`, {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", content: "live" }] }),
    }));
    expect(published.status).toBe(200);
    const site = await fake.fetch(new Request("http://computer.test/s/fake0001"));
    expect(await site.text()).toBe("live");
  });

  test("mirrors preference, mints one capability id, and keeps production overrides loopback-only", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    };
    setCloudKernelPreference(true, storage);
    expect(cloudKernelPreference(storage)).toBe(true);
    expect(values.get(CLOUD_KERNEL_STORAGE_KEY)).toBe("true");
    const id = ensureWorkspaceId(storage, (array) => {
      array.fill(0xab);
      return array;
    });
    expect(id).toBe("ab".repeat(16));
    expect(ensureWorkspaceId(storage)).toBe(id);
    expect(values.get(WORKSPACE_STORAGE_KEY)).toBe(id);

    expect(resolveComputerWorkerUrl({
      production: true,
      search: "?computer_worker=http%3A%2F%2F127.0.0.1%3A9876",
      storage,
      envUrl: "https://env.test/path",
    })).toBe("http://127.0.0.1:9876");
    expect(resolveComputerWorkerUrl({
      production: true,
      search: "?computer_worker=https%3A%2F%2Fevil.test",
      storage,
      envUrl: "https://env.test/path",
    })).toBe("https://env.test");
  });
});
