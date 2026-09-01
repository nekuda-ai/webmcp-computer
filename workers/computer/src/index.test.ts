import { describe, expect, test } from "bun:test";
import {
  handleRequest,
  type HandlerEnv,
  type SiteObject,
  type SiteStore,
  type WorkerDependencies,
  type WorkspaceExecEvent,
  type WorkspaceExecHandle,
  type WorkspaceExecResult,
  type WorkspaceHandle,
} from "./handler";
import { MAX_FS_BATCH_OPERATIONS, PUBLISHED_SITE_RETENTION_DAYS } from "./protocol";
import { randomSlug } from "./slug";

const WSID = "0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function claimingExecHandle(
  id: string,
  events: readonly WorkspaceExecEvent[],
  result: WorkspaceExecResult,
  onDispose: () => void,
  onStreamEnd: () => void = () => undefined,
): WorkspaceExecHandle {
  let index = 0;
  let streamed = false;
  const readable = new ReadableStream<WorkspaceExecEvent>({
    pull(controller) {
      streamed = true;
      const event = events[index++];
      if (event === undefined) {
        onStreamEnd();
        controller.close();
      } else controller.enqueue(event);
    },
  }, { highWaterMark: 0 });
  return Object.assign(readable, {
    id,
    async result() {
      if (streamed) {
        throw new Error("exec handle already streaming: call result() or iterate the stream, not both");
      }
      return result;
    },
    [Symbol.dispose]: onDispose,
  });
}

class MemoryWorkspace {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>(["/"]);
  disposeCount = 0;

  readonly client: WorkspaceHandle = {
    fs: {
      readFile: async (path: string) => {
        const bytes = this.files.get(path);
        if (!bytes) {
          if (this.directories.has(path)) throw coded(`is a directory: ${path}`, "EISDIR");
          throw coded(`no such file: ${path}`, "ENOENT");
        }
        return stream(bytes);
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        if (!this.directories.has(parent)) throw coded(`no such directory: ${parent}`, "ENOENT");
        if (this.directories.has(path)) throw coded(`is a directory: ${path}`, "EISDIR");
        this.files.set(path, typeof content === "string" ? encoder.encode(content) : Uint8Array.from(content));
      },
      exists: async (path: string) => this.files.has(path) || this.directories.has(path),
      stat: async (path: string) => {
        const stat = this.stat(path);
        if (!stat) throw coded(`no such file: ${path}`, "ENOENT");
        return stat;
      },
      statOrNull: async (path: string) => this.stat(path) ?? null,
      readdir: async (path: string) => {
        if (!this.directories.has(path)) {
          if (this.files.has(path)) throw coded(`not a directory: ${path}`, "ENOTDIR");
          throw coded(`no such directory: ${path}`, "ENOENT");
        }
        const prefix = path === "/" ? "/" : `${path}/`;
        const names = new Set<string>();
        for (const candidate of [...this.directories, ...this.files.keys()]) {
          if (!candidate.startsWith(prefix) || candidate === path) continue;
          const name = candidate.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
        return [...names].sort().map((name) => {
          const candidate = `${path === "/" ? "" : path}/${name}`;
          return this.stat(candidate)!;
        });
      },
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        if (this.files.has(path)) throw coded(`file exists: ${path}`, "EEXIST");
        const parts = path.split("/").filter(Boolean);
        let current = "";
        for (let index = 0; index < parts.length; index += 1) {
          current += `/${parts[index]}`;
          if (index !== parts.length - 1 && !options?.recursive && !this.directories.has(current)) {
            throw coded(`no such directory: ${current}`, "ENOENT");
          }
          this.directories.add(current);
        }
      },
      rm: async (path: string, options?: { recursive?: boolean }) => {
        if (this.files.delete(path)) return;
        if (!this.directories.has(path)) throw coded(`no such file: ${path}`, "ENOENT");
        const prefix = `${path}/`;
        const hasChildren = [...this.files.keys(), ...this.directories].some((entry) => entry.startsWith(prefix));
        if (hasChildren && !options?.recursive) throw coded(`directory not empty: ${path}`, "ENOTEMPTY");
        for (const file of this.files.keys()) if (file.startsWith(prefix)) this.files.delete(file);
        for (const directory of this.directories) if (directory === path || directory.startsWith(prefix)) this.directories.delete(directory);
      },
    },
    runtime: {
      async exec(): Promise<WorkspaceExecHandle> {
        throw new Error("test: exec runtime not configured");
      },
      async getExec(): Promise<WorkspaceExecHandle> {
        throw new Error("test: exec runtime not configured");
      },
    },
    [Symbol.dispose]: () => { this.disposeCount += 1; },
  };

  private stat(path: string) {
    const file = this.files.get(path);
    const directory = this.directories.has(path);
    if (!file && !directory) return undefined;
    return {
      name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
      size: file?.byteLength ?? 0,
      mtime: 123,
      isFile: file !== undefined,
      isDirectory: directory,
      isSymbolicLink: false,
    };
  }
}

class MemorySiteStore implements SiteStore {
  readonly values = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async get(key: string): Promise<SiteObject | null> {
    const value = this.values.get(key);
    return value ? {
      body: stream(value.bytes),
      ...(value.contentType === undefined ? {} : { httpMetadata: { contentType: value.contentType } }),
    } : null;
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = encoder.encode(value);
    else if (value instanceof Uint8Array) bytes = Uint8Array.from(value);
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.values.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
  }
}

function fixture(options: {
  execRate?: boolean;
  execError?: Error;
  execEvents?: readonly WorkspaceExecEvent[];
  writeRate?: boolean;
  writeRates?: boolean[];
  publishRate?: boolean;
  slugs?: string[];
} = {}) {
  const workspace = new MemoryWorkspace();
  const sites = new MemorySiteStore();
  const slugs = options.slugs ?? ["aaaaaaaa"];
  const rateCalls = { exec: 0, publish: 0, write: 0 };
  const execCalls: Array<{ command: string; options: Record<string, unknown> }> = [];
  const getExecCalls: Array<{ id: string; options: Record<string, unknown> }> = [];
  let execDisposeCount = 0;
  const execEvents = options.execEvents ?? [
    { name: "stdout", value: "one\n" },
    { name: "stderr", value: "warning\n" },
    { name: "stdout", value: "two\n" },
    { name: "exit", code: 7 },
  ] satisfies WorkspaceExecEvent[];
  const execResult: WorkspaceExecResult = {
    exitCode: 7,
    pushed: 2,
    pulled: 1,
    sync: { status: "complete", applied: 4 },
  };
  let liveStream = false;
  Object.assign(workspace.client, {
    runtime: {
      async exec(command: string, execOptions: Record<string, unknown>) {
        execCalls.push({ command, options: execOptions });
        if (options.execError) throw options.execError;
        liveStream = true;
        return claimingExecHandle(
          "run-1",
          execEvents,
          execResult,
          () => {
            execDisposeCount += 1;
            liveStream = false;
          },
          () => { liveStream = false; },
        );
      },
      async getExec(id: string, getOptions: Record<string, unknown>) {
        getExecCalls.push({ id, options: getOptions });
        // computerd rejects a second live handle while the original one still
        // streams — pin the handler's stream-then-getExec ordering.
        if (liveStream) throw new Error(`exec ${id} already has a live subscriber`);
        return claimingExecHandle(id, [], execResult, () => { execDisposeCount += 1; });
      },
    },
  });
  const env = {
    SITES: sites,
    EXEC_RATE: { async limit() {
      rateCalls.exec += 1;
      return { success: options.execRate ?? true };
    } },
    PUBLISH_RATE: { async limit() {
      rateCalls.publish += 1;
      return { success: options.publishRate ?? true };
    } },
    WORKSPACE_WRITE_RATE: { async limit() {
      const success = options.writeRates?.[rateCalls.write] ?? options.writeRate ?? true;
      rateCalls.write += 1;
      return { success };
    } },
  } satisfies HandlerEnv;
  const dependencies = {
    async openWorkspace() { return workspace.client; },
    randomSlug() {
      const slug = slugs.shift();
      if (!slug) throw new Error("test: no slug left");
      return slug;
    },
  } satisfies WorkerDependencies;
  return {
    dependencies,
    env,
    execCalls,
    getExecCalls,
    execDisposeCount: () => execDisposeCount,
    rateCalls,
    sites,
    workspace,
  };
}

function fsRequest(body: unknown, suffix = ""): Request {
  return new Request(`https://computer.test/ws/${WSID}/fs${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify(body),
  });
}

function execRequest(body: unknown, wsid = WSID): Request {
  return new Request(`https://computer.test/ws/${wsid}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify(body),
  });
}

function base64(text: string): string {
  return btoa(text);
}

describe("computer worker", () => {
  test("round-trips filesystem operations and positional batches with CORS", async () => {
    const { env, dependencies, workspace } = fixture();
    const operations = [
      { op: "mkdir", path: "/notes" },
      { op: "write", path: "/notes/proof.txt", data: base64("cloud") },
      { op: "read", path: "/notes/proof.txt" },
      { op: "stat", path: "/notes/proof.txt" },
      { op: "readdir", path: "/notes" },
      { op: "exists", path: "/missing" },
    ];
    const response = await handleRequest(fsRequest(operations, "/batch"), env, dependencies);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const results = await response.json() as Array<Record<string, unknown>>;
    expect(results).toHaveLength(operations.length);
    expect(results[2]).toEqual({ data: base64("cloud") });
    expect(results[3]).toEqual({ stat: expect.objectContaining({ size: 5, isFile: true }) });
    expect(results[4]).toEqual({ entries: [expect.objectContaining({ name: "proof.txt" })] });
    expect(results[5]).toEqual({ exists: false });
    expect(workspace.disposeCount).toBe(1);
  });

  test("namespaces every fs path under the /workspace container mount", async () => {
    const { env, dependencies, workspace } = fixture();
    const response = await handleRequest(
      fsRequest({ op: "write", path: "/gate.txt", data: base64("pushed") }),
      env,
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(workspace.directories.has("/workspace")).toBe(true);
    expect(decoder.decode(workspace.files.get("/workspace/gate.txt"))).toBe("pushed");
    expect(workspace.files.has("/gate.txt")).toBe(false);
  });

  test("moves files through read-write-rm because SDK has no rename", async () => {
    const { env, dependencies, workspace } = fixture();
    workspace.directories.add("/workspace/site");
    workspace.files.set("/workspace/site/index.html", encoder.encode("<h1>one</h1>"));
    workspace.files.set("/workspace/site/home.html", encoder.encode("old"));
    const response = await handleRequest(fsRequest({
      op: "rename",
      path: "/site/index.html",
      to: "/site/home.html",
    }), env, dependencies);
    expect(response.status).toBe(200);
    expect(decoder.decode(workspace.files.get("/workspace/site/home.html"))).toBe("<h1>one</h1>");
    expect(workspace.files.has("/workspace/site/index.html")).toBe(false);
  });

  test("rejects directory rename collisions before copying or deleting source data", async () => {
    const directoryFixture = fixture();
    directoryFixture.workspace.directories.add("/workspace/source");
    directoryFixture.workspace.files.set("/workspace/source/new.txt", encoder.encode("new"));
    directoryFixture.workspace.directories.add("/workspace/destination");
    directoryFixture.workspace.files.set("/workspace/destination/old.txt", encoder.encode("old"));
    const directoryCollision = await handleRequest(fsRequest({
      op: "rename",
      path: "/source",
      to: "/destination",
    }), directoryFixture.env, directoryFixture.dependencies);
    expect(directoryCollision.status).toBe(409);
    expect(await directoryCollision.json() as unknown).toEqual(expect.objectContaining({
      code: "ENOTEMPTY",
    }));
    expect(decoder.decode(directoryFixture.workspace.files.get("/workspace/source/new.txt"))).toBe("new");
    expect(decoder.decode(directoryFixture.workspace.files.get("/workspace/destination/old.txt"))).toBe("old");

    const fileFixture = fixture();
    fileFixture.workspace.directories.add("/workspace/source");
    fileFixture.workspace.files.set("/workspace/source/new.txt", encoder.encode("new"));
    fileFixture.workspace.files.set("/workspace/destination", encoder.encode("old"));
    const fileCollision = await handleRequest(fsRequest({
      op: "rename",
      path: "/source",
      to: "/destination",
    }), fileFixture.env, fileFixture.dependencies);
    expect(fileCollision.status).toBe(409);
    expect(await fileCollision.json() as unknown).toEqual(expect.objectContaining({ code: "ENOTDIR" }));
    expect(decoder.decode(fileFixture.workspace.files.get("/workspace/source/new.txt"))).toBe("new");
    expect(decoder.decode(fileFixture.workspace.files.get("/workspace/destination"))).toBe("old");
  });

  test("rejects traversal and preserves POSIX errors in batch positions", async () => {
    const { env, dependencies } = fixture();
    const traversal = await handleRequest(
      fsRequest({ op: "read", path: "/notes/../secret" }),
      env,
      dependencies,
    );
    expect(traversal.status).toBe(400);
    expect(await traversal.json() as unknown).toEqual(expect.objectContaining({ code: "EINVAL" }));

    const batch = await handleRequest(fsRequest([
      { op: "read", path: "/missing.txt" },
      { op: "exists", path: "/missing.txt" },
    ], "/batch"), env, dependencies);
    expect(await batch.json() as unknown).toEqual([
      expect.objectContaining({ code: "ENOENT" }),
      { exists: false },
    ]);
  });

  test("rate limits writes and publishes while reads stay unlimited", async () => {
    const { env, dependencies } = fixture({ writeRate: false, publishRate: false });
    const write = await handleRequest(
      fsRequest({ op: "write", path: "/x", data: base64("x") }),
      env,
      dependencies,
    );
    expect(write.status).toBe(429);
    expect(await write.json() as unknown).toEqual({ error: "rate limited" });
    const read = await handleRequest(fsRequest({ op: "exists", path: "/x" }), env, dependencies);
    expect(read.status).toBe(200);
    const publish = await handleRequest(new Request(`https://computer.test/ws/${WSID}/publish`, {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", content: "ok" }] }),
    }), env, dependencies);
    expect(publish.status).toBe(429);
  });

  test("charges one workspace rate token per mutating batch operation", async () => {
    const { env, dependencies, rateCalls, workspace } = fixture();
    const response = await handleRequest(fsRequest([
      { op: "mkdir", path: "/one" },
      { op: "exists", path: "/one" },
      { op: "mkdir", path: "/two" },
      { op: "write", path: "/two/file.txt", data: base64("x") },
    ], "/batch"), env, dependencies);
    expect(response.status).toBe(200);
    expect(rateCalls.write).toBe(3);
    expect(workspace.directories.has("/workspace/one")).toBe(true);

    const rejected = fixture({ writeRates: [true, false] });
    const limited = await handleRequest(fsRequest([
      { op: "mkdir", path: "/not-created" },
      { op: "write", path: "/also-not-created", data: base64("x") },
    ], "/batch"), rejected.env, rejected.dependencies);
    expect(limited.status).toBe(429);
    expect(rejected.rateCalls.write).toBe(2);
    expect(rejected.workspace.directories.has("/workspace/not-created")).toBe(false);
  });

  test("publishes validated text with retention, unique slugs, and content types", async () => {
    const { env, dependencies, sites } = fixture({ slugs: ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb"] });
    const publish = async (content: string) => await handleRequest(new Request(`https://computer.test/ws/${WSID}/publish`, {
      method: "POST",
      body: JSON.stringify({ files: [
        { path: "index.html", content },
        { path: "assets/app.js", content: "console.log('ok')" },
      ] }),
    }), env, dependencies);
    expect(await (await publish("one")).json() as unknown).toEqual({
      expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
      id: "aaaaaaaa",
      url: "https://computer.test/s/aaaaaaaa/",
    });
    expect(await (await publish("two")).json() as unknown).toEqual({
      expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
      id: "bbbbbbbb",
      url: "https://computer.test/s/bbbbbbbb/",
    });
    expect(sites.values.get("sites/aaaaaaaa/index.html")?.contentType).toBe("text/html; charset=utf-8");
    expect(sites.values.get("sites/aaaaaaaa/assets/app.js")?.contentType).toBe("text/javascript; charset=utf-8");
    const publicPublish = await handleRequest(new Request("https://computer.test/publish", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", content: "anonymous" }] }),
    }), env, dependencies);
    expect(publicPublish.status).toBe(404);
  });

  test("rejects publish traversal and all three caps", async () => {
    const { env, dependencies } = fixture();
    const publish = async (files: Array<{ path: string; content: string }>) => await handleRequest(
      new Request(`https://computer.test/ws/${WSID}/publish`, { method: "POST", body: JSON.stringify({ files }) }),
      env,
      dependencies,
    );
    expect((await publish([{ path: "../index.html", content: "x" }])).status).toBe(400);
    expect((await publish(Array.from({ length: 65 }, (_, index) => ({
      path: `${index}.txt`, content: "x",
    })))).status).toBe(413);
    expect((await publish([{ path: "large.txt", content: "x".repeat(256 * 1_024 + 1) }])).status).toBe(413);
    expect((await publish(Array.from({ length: 9 }, (_, index) => ({
      path: `${index}.txt`, content: "x".repeat(256 * 1_024),
    })))).status).toBe(413);
    const reserved = await publish([{ path: ".verbos-site", content: "reserved" }]);
    expect(reserved.status).toBe(400);
    expect(await reserved.json() as unknown).toEqual(expect.objectContaining({ code: "EINVAL" }));
  });

  test("serves immutable site bytes, preflight, 404, and top-level failures with CORS", async () => {
    const { env, dependencies, sites } = fixture();
    await sites.put("sites/aaaaaaaa/index.html", "<h1>live</h1>", {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    const served = await handleRequest(
      new Request("https://computer.test/s/aaaaaaaa/"),
      env,
      dependencies,
    );
    expect(await served.text()).toBe("<h1>live</h1>");
    expect(served.headers.get("Cache-Control")).toContain("immutable");
    expect(served.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");

    await sites.put("sites/aaaaaaaa/sub/index.html", "nested", {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    const nested = await handleRequest(
      new Request("https://computer.test/s/aaaaaaaa/sub/"),
      env,
      dependencies,
    );
    expect(await nested.text()).toBe("nested");
    const invalidSitePath = await handleRequest(
      new Request("https://computer.test/s/aaaaaaaa/%2e%2e%2fsecret"),
      env,
      dependencies,
    );
    const invalidSiteMessage = await invalidSitePath.text();
    expect(invalidSiteMessage).toContain("verbos: site path");
    expect(invalidSiteMessage).not.toContain("publish path");

    const missing = await handleRequest(new Request("https://computer.test/missing"), env, dependencies);
    expect(missing.status).toBe(404);
    const preflight = await handleRequest(
      new Request(`https://computer.test/ws/${WSID}/publish`, { method: "OPTIONS" }),
      env,
      dependencies,
    );
    expect(preflight.status).toBe(204);

    const explodingEnv = {
      ...env,
      WORKSPACE_WRITE_RATE: { async limit(): Promise<{ success: boolean }> { throw new Error("rate exploded"); } },
    };
    const exploded = await handleRequest(
      fsRequest({ op: "write", path: "/x", data: base64("x") }),
      explodingEnv,
      dependencies,
    );
    expect(exploded.status).toBe(502);
    expect(exploded.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await exploded.json() as unknown).toEqual({ error: "rate exploded" });
  });

  test("keeps random slugs unbiased by rejecting the incomplete modulo range", () => {
    const chunks = [
      [252, 253, 254, 255, 0, 35, 36, 251],
      [1, 2, 3, 4],
    ];
    let call = 0;
    const slug = randomSlug((array) => {
      const values = chunks[call++] ?? [];
      array.set(values.slice(0, array.length));
      return array;
    });
    expect(slug).toBe("a9a9bcde");
    expect(call).toBe(2);
  });

  test("pins the shared filesystem batch limit", () => {
    expect(MAX_FS_BATCH_OPERATIONS).toBe(128);
  });

  test("validates capability-scoped exec input and clamps timeout", async () => {
    const { env, dependencies, execCalls } = fixture();
    expect((await handleRequest(execRequest({ command: "pwd" }, "bad"), env, dependencies)).status)
      .toBe(400);
    expect((await handleRequest(execRequest({ command: "" }), env, dependencies)).status).toBe(400);
    expect((await handleRequest(execRequest({ command: "x".repeat(8 * 1_024 + 1) }), env, dependencies)).status)
      .toBe(400);
    expect((await handleRequest(execRequest({ command: "pwd", cwd: "/etc" }), env, dependencies)).status)
      .toBe(400);
    expect((await handleRequest(execRequest({ command: "pwd", cwd: "/workspace/../etc" }), env, dependencies)).status)
      .toBe(400);

    const response = await handleRequest(execRequest({
      command: "pwd",
      cwd: "/workspace/site",
      timeoutMs: 999_999,
    }), env, dependencies);
    expect(response.status).toBe(200);
    await response.text();
    expect(execCalls).toEqual([{
      command: "pwd",
      options: { cwd: "/workspace/site", encoding: "utf8", timeoutMs: 600_000 },
    }]);
  });

  test("rate limits exec before opening a workspace", async () => {
    const { env, dependencies, rateCalls, execCalls } = fixture({ execRate: false });
    const response = await handleRequest(execRequest({ command: "pwd" }), env, dependencies);
    expect(response.status).toBe(429);
    expect(await response.json() as unknown).toEqual({ error: "rate limited" });
    expect(rateCalls.exec).toBe(1);
    expect(execCalls).toEqual([]);
  });

  test("streams ordered exec SSE, enriches exit, and disposes both RPC stubs", async () => {
    const value = fixture();
    const response = await handleRequest(execRequest({ command: "printf one" }), value.env, value.dependencies);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toBe(
      "event: stdout\ndata: \"one\\n\"\n\n" +
      "event: stderr\ndata: \"warning\\n\"\n\n" +
      "event: stdout\ndata: \"two\\n\"\n\n" +
      "event: exit\ndata: {\"code\":7,\"pushed\":2,\"pulled\":1,\"applied\":4,\"syncStatus\":\"complete\"}\n\n",
    );
    expect(value.execCalls).toEqual([{
      command: "printf one",
      options: { encoding: "utf8", timeoutMs: 300_000 },
    }]);
    expect(value.getExecCalls).toEqual([{
      id: "run-1",
      options: { encoding: "utf8", resume: "tail" },
    }]);
    expect(value.execDisposeCount()).toBe(2);
    expect(value.workspace.disposeCount).toBe(1);
  });

  test("caps cumulative exec output at 2 MB, sends one notice, and still exits", async () => {
    const megabyte = 1_024 * 1_024;
    const value = fixture({ execEvents: [
      { name: "stdout", value: "a".repeat(megabyte) },
      { name: "stderr", value: "b".repeat(megabyte) },
      { name: "stdout", value: "dropped" },
      { name: "exit", code: 7 },
    ] });

    const response = await handleRequest(execRequest({ command: "large-output" }), value.env, value.dependencies);
    const body = await response.text();
    const frames = body.trim().split("\n\n").map((frame) => {
      const [eventLine = "", dataLine = ""] = frame.split("\n");
      return {
        event: eventLine.slice("event: ".length),
        data: JSON.parse(dataLine.slice("data: ".length)) as unknown,
      };
    });

    expect(frames.map(({ event }) => event)).toEqual(["stdout", "stderr", "notice", "exit"]);
    expect(frames[0]?.data).toBe("a".repeat(megabyte));
    expect(frames[1]?.data).toBe("b".repeat(megabyte));
    expect(body).not.toContain("dropped");
    expect(frames[2]?.data).toEqual({ message: "verbos: cloud output truncated after 2 MB" });
  });

  test("continues the bounded remote run after the SSE client disconnects", async () => {
    const value = fixture();
    let release = () => {};
    const remoteOutput = new Promise<void>((resolve) => { release = resolve; });
    let resultCalls = 0;
    let markFinished = () => {};
    const remoteFinished = new Promise<void>((resolve) => { markFinished = resolve; });
    let runDisposeCount = 0;
    const run: WorkspaceExecHandle = Object.assign(new ReadableStream<WorkspaceExecEvent>({
      async start(controller) {
        await remoteOutput;
        controller.enqueue({ name: "stdout", value: "finished\n" });
        controller.close();
      },
    }), {
      id: "run-disconnect",
      async result() { throw new Error("result-after-stream must not be called"); },
      [Symbol.dispose]() {
        runDisposeCount += 1;
        markFinished();
      },
    });
    const resultRun = claimingExecHandle("run-disconnect", [], {
      exitCode: 0,
      pushed: 0,
      pulled: 0,
      sync: { status: "complete", applied: 0 },
    }, () => {});
    const resultMethod = resultRun.result;
    Object.defineProperty(resultRun, "result", {
      value: async () => {
        resultCalls += 1;
        return await resultMethod();
      },
    });
    Object.assign(value.workspace.client, {
      runtime: {
        async exec() { return run; },
        async getExec() { return resultRun; },
      },
    });

    const response = await handleRequest(execRequest({ command: "sleep 60" }), value.env, value.dependencies);
    const canceling = response.body?.cancel();
    release();
    await canceling;
    await remoteFinished;

    expect(resultCalls).toBe(1);
    expect(runDisposeCount).toBe(1);
    expect(value.workspace.disposeCount).toBe(1);
  });

  test("turns upstream exec failures into one SSE error event", async () => {
    const value = fixture({ execError: new Error("container unavailable\nretry later") });
    const response = await handleRequest(execRequest({ command: "pwd" }), value.env, value.dependencies);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      "event: error\ndata: {\"error\":\"container unavailable retry later\"}\n\n",
    );
    expect(value.workspace.disposeCount).toBe(1);
  });
});
