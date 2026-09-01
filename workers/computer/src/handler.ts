import { MAX_FS_BATCH_OPERATIONS, PUBLISHED_SITE_RETENTION_DAYS } from "./protocol";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
} as const;

const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const SITE_ID = /^[a-z0-9]{8}$/;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1_024;
const MAX_TOTAL_BYTES = 2 * 1_024 * 1_024;
const MAX_EXEC_COMMAND_BYTES = 8 * 1_024;
const MAX_EXEC_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const textEncoder = new TextEncoder();

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type SiteObject = {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
};

export type SiteStore = {
  get(key: string): Promise<SiteObject | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

export type HandlerEnv = {
  SITES: SiteStore;
  EXEC_RATE: RateLimitBinding;
  PUBLISH_RATE: RateLimitBinding;
  WORKSPACE_WRITE_RATE: RateLimitBinding;
};

export type WorkspaceFileSystem = {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<WorkspaceStat>;
  statOrNull(path: string): Promise<WorkspaceStat | null>;
  readdir(path: string): Promise<WorkspaceDirent[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
};

export type WorkspaceStat = {
  name: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

export type WorkspaceDirent = WorkspaceStat;

export type WorkspaceHandle = {
  fs: WorkspaceFileSystem;
  runtime?: {
    exec(
      command: string,
      options: { cwd?: string; encoding: "utf8"; timeoutMs: number },
    ): Promise<WorkspaceExecHandle>;
    getExec(
      id: string,
      options: { encoding: "utf8"; resume: "tail" },
    ): Promise<WorkspaceExecHandle>;
  };
  [Symbol.dispose](): void;
};

export type WorkspaceExecEvent =
  | { name: "stdout" | "stderr"; value: string }
  | { name: "exit"; code: number };

export type WorkspaceExecResult = {
  exitCode: number;
  pushed: number;
  pulled: number;
  sync: { status: "complete" | "pending"; applied: number };
};

export type WorkspaceExecHandle = ReadableStream<WorkspaceExecEvent> & {
  readonly id: string;
  result(): Promise<WorkspaceExecResult>;
  [Symbol.dispose](): void;
};

export type WorkerDependencies = {
  openWorkspace(wsid: string, env: HandlerEnv): Promise<WorkspaceHandle>;
  randomSlug(): string;
};

type FsOperation = {
  op: "read" | "write" | "mkdir" | "readdir" | "rm" | "rename" | "stat" | "exists";
  path: string;
  to?: string;
  data?: string;
  recursive?: boolean;
};

type PublishFile = { path: string; content: string };
type ExecOperation = { command: string; cwd?: string; timeoutMs: number };

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function oneLine(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = oneLine(error instanceof Error ? error.message : error);
  return /\b(E[A-Z]{2,})\b/.exec(message)?.[1] ?? "EIO";
}

function errorResponse(error: unknown, status?: number): Response {
  const code = errorCode(error);
  const message = oneLine(error instanceof Error ? error.message : error) || code;
  return json({ error: message, code }, status ?? (code === "EINVAL" ? 400 : 409));
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw coded(`${label} must be an object`, "EINVAL");
  }
  return value as Record<string, unknown>;
}

function requireAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw coded("path must be absolute", "EINVAL");
  }
  if (
    value !== "/" &&
    (value.endsWith("/") || value.includes("//") || value.split("/").some((part) => part === "." || part === ".."))
  ) {
    throw coded("path must be normalized and cannot contain '..'", "EINVAL");
  }
  return value;
}

function requireRelativePath(value: unknown): string {
  if (
    typeof value !== "string" || value === "" || value.startsWith("/") ||
    value.endsWith("/") || value.includes("//") || value.includes("\0") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw coded("publish path must be normalized, relative, and cannot contain '..'", "EINVAL");
  }
  return value;
}

function requireWorkspacePath(value: unknown): string {
  const path = requireAbsolutePath(value);
  if (path !== WORKSPACE_MOUNT_ROOT && !path.startsWith(`${WORKSPACE_MOUNT_ROOT}/`)) {
    throw coded("cwd must be /workspace or a path beneath it", "EINVAL");
  }
  return path;
}

// computerd mounts only the workspace-fs subtree /workspace into the container,
// path-preserving (exec sync pushes and pulls nothing outside it). Kernel fs
// paths are namespaced under it so every kernel file is visible to `cloud` at
// the same /workspace/<path> the manual teaches, and container writes sync back.
const WORKSPACE_MOUNT_ROOT = "/workspace";

function workspaceFsPath(path: string): string {
  return path === "/" ? WORKSPACE_MOUNT_ROOT : `${WORKSPACE_MOUNT_ROOT}${path}`;
}

function parseExecOperation(value: unknown): ExecOperation {
  const body = requireRecord(value, "exec body");
  const allowed = new Set(["command", "cwd", "timeoutMs"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw coded("exec body contains unknown fields", "EINVAL");
  }
  if (
    typeof body.command !== "string" || body.command.trim() === "" ||
    textEncoder.encode(body.command).byteLength > MAX_EXEC_COMMAND_BYTES
  ) {
    throw coded("command must be a non-empty string no larger than 8 KB", "EINVAL");
  }
  let timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (!Number.isInteger(body.timeoutMs) || (body.timeoutMs as number) < 1) {
      throw coded("timeoutMs must be a positive integer", "EINVAL");
    }
    timeoutMs = Math.min(body.timeoutMs as number, MAX_EXEC_TIMEOUT_MS);
  }
  return {
    command: body.command,
    ...(body.cwd === undefined ? {} : { cwd: requireWorkspacePath(body.cwd) }),
    timeoutMs,
  };
}

function parseFsOperation(value: unknown): FsOperation {
  const body = requireRecord(value, "filesystem operation");
  const allowed = new Set(["op", "path", "to", "data", "recursive"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw coded("filesystem operation contains unknown fields", "EINVAL");
  }
  const op = body.op;
  if (![
    "read", "write", "mkdir", "readdir", "rm", "rename", "stat", "exists",
  ].includes(String(op))) {
    throw coded("unsupported filesystem operation", "EINVAL");
  }
  const operation: FsOperation = {
    op: op as FsOperation["op"],
    path: workspaceFsPath(requireAbsolutePath(body.path)),
  };
  if (body.to !== undefined) operation.to = workspaceFsPath(requireAbsolutePath(body.to));
  if (body.data !== undefined) {
    if (typeof body.data !== "string") throw coded("data must be base64 text", "EINVAL");
    operation.data = body.data;
  }
  if (body.recursive !== undefined) {
    if (typeof body.recursive !== "boolean") throw coded("recursive must be a boolean", "EINVAL");
    operation.recursive = body.recursive;
  }
  if (operation.op === "write" && operation.data === undefined) {
    throw coded("write requires data", "EINVAL");
  }
  if (operation.op === "rename" && operation.to === undefined) {
    throw coded("rename requires to", "EINVAL");
  }
  return operation;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw coded("data must be valid base64", "EINVAL");
  }
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function serializableStat(stat: WorkspaceStat) {
  return {
    name: stat.name,
    size: stat.size,
    mtime: stat.mtime,
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isSymbolicLink: stat.isSymbolicLink,
  };
}

async function copyTree(
  fs: WorkspaceFileSystem,
  from: string,
  to: string,
): Promise<void> {
  const source = await fs.stat(from);
  if (source.isDirectory) {
    const destination = await fs.statOrNull(to);
    if (destination && !destination.isDirectory) throw coded(`not a directory: ${to}`, "ENOTDIR");
    if (!destination) await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) {
      await copyTree(fs, `${from === "/" ? "" : from}/${entry.name}`, `${to === "/" ? "" : to}/${entry.name}`);
    }
    return;
  }
  const destination = await fs.statOrNull(to);
  if (destination?.isDirectory) throw coded(`is a directory: ${to}`, "EISDIR");
  const bytes = await streamBytes(await fs.readFile(from));
  await fs.writeFile(to, bytes);
}

async function preflightRename(
  fs: WorkspaceFileSystem,
  from: string,
  to: string,
): Promise<void> {
  const source = await fs.stat(from);
  const destination = await fs.statOrNull(to);
  if (!destination) return;
  if (source.isDirectory && !destination.isDirectory) {
    throw coded(`verbos: not a directory: ${from}`, "ENOTDIR");
  }
  if (!source.isDirectory && destination.isDirectory) {
    throw coded(`verbos: is a directory: ${from}`, "EISDIR");
  }
  if (source.isDirectory && (await fs.readdir(to)).length > 0) {
    throw coded(`verbos: directory not empty: ${to}`, "ENOTEMPTY");
  }
}

async function executeFsOperation(
  fs: WorkspaceFileSystem,
  operation: FsOperation,
): Promise<Record<string, unknown>> {
  switch (operation.op) {
    case "read": {
      const data = await streamBytes(await fs.readFile(operation.path));
      return { data: bytesToBase64(data) };
    }
    case "write":
      await fs.writeFile(operation.path, base64ToBytes(operation.data ?? ""));
      return { ok: true };
    case "mkdir":
      await fs.mkdir(operation.path, { recursive: operation.recursive ?? false });
      return { ok: true };
    case "readdir":
      return {
        entries: (await fs.readdir(operation.path)).map((entry) => ({
          name: entry.name,
          size: entry.size,
          mtime: entry.mtime,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          isSymbolicLink: entry.isSymbolicLink,
        })),
      };
    case "rm":
      await fs.rm(operation.path, { recursive: operation.recursive ?? false });
      return { ok: true };
    case "rename":
      await preflightRename(fs, operation.path, operation.to ?? "");
      await copyTree(fs, operation.path, operation.to ?? "");
      await fs.rm(operation.path, { recursive: true });
      return { ok: true };
    case "stat":
      return { stat: serializableStat(await fs.stat(operation.path)) };
    case "exists":
      return { exists: await fs.exists(operation.path) };
  }
}

function mutates(operation: FsOperation): boolean {
  return ["write", "mkdir", "rm", "rename"].includes(operation.op);
}

async function workspaceResponse(
  request: Request,
  env: HandlerEnv,
  dependencies: WorkerDependencies,
  wsid: string,
  batch: boolean,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(coded("invalid JSON body", "EINVAL"), 400);
  }

  let operations: FsOperation[];
  try {
    if (batch) {
      if (
        !Array.isArray(parsed) || parsed.length === 0 ||
        parsed.length > MAX_FS_BATCH_OPERATIONS
      ) {
        throw coded(`batch must contain 1-${MAX_FS_BATCH_OPERATIONS} operations`, "EINVAL");
      }
      operations = parsed.map(parseFsOperation);
    } else {
      operations = [parseFsOperation(parsed)];
    }
  } catch (error) {
    return errorResponse(error, 400);
  }

  const mutationCount = operations.filter(mutates).length;
  if (mutationCount > 0) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    for (let index = 0; index < mutationCount; index += 1) {
      const rate = await env.WORKSPACE_WRITE_RATE.limit({ key: ip });
      if (!rate.success) return json({ error: "rate limited" }, 429);
    }
  }

  try {
    using workspace = await dependencies.openWorkspace(wsid, env);
    // A fresh workspace has no /workspace subtree yet; every namespaced
    // operation needs it (idempotent when present).
    await workspace.fs.mkdir(WORKSPACE_MOUNT_ROOT, { recursive: true });
    const responses: Array<Record<string, unknown>> = [];
    for (const operation of operations) {
      try {
        responses.push(await executeFsOperation(workspace.fs, operation));
      } catch (error) {
        if (!batch) throw error;
        responses.push({
          error: oneLine(error instanceof Error ? error.message : error),
          code: errorCode(error),
        });
      }
    }
    return json(batch ? responses : responses[0]);
  } catch (error) {
    return errorResponse(error);
  }
}

function contentType(path: string): string {
  const extension = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return ({
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    svg: "image/svg+xml; charset=utf-8",
    txt: "text/plain; charset=utf-8",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function parsePublishFiles(value: unknown): { files: PublishFile[]; bytes: number } {
  const body = requireRecord(value, "publish body");
  if (Object.keys(body).some((key) => key !== "files") || !Array.isArray(body.files)) {
    throw coded("publish body requires files", "EINVAL");
  }
  if (body.files.length === 0 || body.files.length > MAX_FILES) {
    throw coded(`publish accepts 1-${MAX_FILES} files`, "E2BIG");
  }
  const seen = new Set<string>();
  let bytes = 0;
  const files = body.files.map((value) => {
    const file = requireRecord(value, "publish file");
    if (Object.keys(file).some((key) => key !== "path" && key !== "content")) {
      throw coded("publish file contains unknown fields", "EINVAL");
    }
    const path = requireRelativePath(file.path);
    if (path === ".verbos-site") {
      throw coded("verbos: publish path is reserved: .verbos-site", "EINVAL");
    }
    if (seen.has(path)) throw coded(`duplicate publish path: ${path}`, "EEXIST");
    seen.add(path);
    if (typeof file.content !== "string") throw coded("publish content must be text", "EINVAL");
    const fileBytes = textEncoder.encode(file.content).byteLength;
    if (fileBytes > MAX_FILE_BYTES) throw coded(`publish file exceeds 256 KB: ${path}`, "EFBIG");
    bytes += fileBytes;
    if (bytes > MAX_TOTAL_BYTES) throw coded("publish exceeds 2 MB total", "EFBIG");
    return { path, content: file.content };
  });
  return { files, bytes };
}

async function allocateSiteId(store: SiteStore, randomSlug: () => string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomSlug();
    if (!SITE_ID.test(id)) throw coded("slug generator returned an invalid id", "EIO");
    if (await store.get(`sites/${id}/.verbos-site`) === null) return id;
  }
  throw coded("could not allocate a unique site id", "EEXIST");
}

async function publishResponse(
  request: Request,
  env: HandlerEnv,
  dependencies: WorkerDependencies,
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rate = await env.PUBLISH_RATE.limit({ key: ip });
  if (!rate.success) return json({ error: "rate limited" }, 429);

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return errorResponse(coded("invalid JSON body", "EINVAL"), 400);
  }
  try {
    const { files } = parsePublishFiles(value);
    const id = await allocateSiteId(env.SITES, dependencies.randomSlug);
    await env.SITES.put(`sites/${id}/.verbos-site`, id);
    for (const file of files) {
      await env.SITES.put(`sites/${id}/${file.path}`, file.content, {
        httpMetadata: { contentType: contentType(file.path) },
      });
    }
    return json({
      id,
      url: `${new URL(request.url).origin}/s/${id}/`,
      expiresInDays: PUBLISHED_SITE_RETENTION_DAYS,
    });
  } catch (error) {
    return errorResponse(error, errorCode(error) === "EINVAL" ? 400 : 413);
  }
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function execResponse(
  request: Request,
  env: HandlerEnv,
  dependencies: WorkerDependencies,
  wsid: string,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(coded("invalid JSON body", "EINVAL"), 400);
  }

  let operation: ExecOperation;
  try {
    operation = parseExecOperation(parsed);
  } catch (error) {
    return errorResponse(error, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rate = await env.EXEC_RATE.limit({ key: ip });
  if (!rate.success) return json({ error: "rate limited" }, 429);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: Uint8Array) => {
        try {
          controller.enqueue(frame);
        } catch {
          // Client disconnected. Keep draining the bounded remote run so Ctrl-C
          // only closes the local stream; runtime timeout still owns execution.
        }
      };
      try {
        using workspace = await dependencies.openWorkspace(wsid, env);
        if (!workspace.runtime) throw new Error("workspace exec runtime unavailable");
        // Fresh workspace: the mounted subtree must exist for cwd and sync.
        await workspace.fs.mkdir(WORKSPACE_MOUNT_ROOT, { recursive: true });
        using run = await workspace.runtime.exec(operation.command, {
          ...(operation.cwd === undefined ? {} : { cwd: operation.cwd }),
          encoding: "utf8",
          timeoutMs: operation.timeoutMs,
        });
        let outputBytes = 0;
        let outputTruncated = false;
        const frames = new TransformStream<WorkspaceExecEvent, Uint8Array>({
          transform(event, streamController) {
            if (event.name === "stdout" || event.name === "stderr") {
              if (outputTruncated) return;
              const chunkBytes = textEncoder.encode(event.value).byteLength;
              if (outputBytes + chunkBytes > MAX_EXEC_OUTPUT_BYTES) {
                outputTruncated = true;
                streamController.enqueue(sseFrame("notice", {
                  message: "verbos: cloud output truncated after 2 MB",
                }));
                return;
              }
              outputBytes += chunkBytes;
              streamController.enqueue(sseFrame(event.name, event.value));
            }
          },
        });
        await run.pipeThrough(frames).pipeTo(new WritableStream({
          write(frame) {
            send(frame);
          },
        }));
        // Streaming claims the original handle, so exit metadata comes from a
        // fresh resumed handle. SDK 0.2.1 hardcodes pushed:0 on resumed handles
        // and their post-pull runs after the original's already applied
        // everything, so pushed/pulled/applied are zeros here even when files
        // synced; only exitCode and syncStatus are trustworthy. The computerd
        // backend (not the SDK client) rejects a second live handle while the
        // original still streams ("already has a live subscriber"), so this
        // must stay strictly after pipeTo resolves.
        using resultRun = await workspace.runtime.getExec(run.id, {
          encoding: "utf8",
          resume: "tail",
        });
        const result = await resultRun.result();
        send(sseFrame("exit", {
          code: result.exitCode,
          pushed: result.pushed,
          pulled: result.pulled,
          applied: result.sync.applied,
          syncStatus: result.sync.status,
        }));
      } catch (error) {
        send(sseFrame("error", {
          error: oneLine(error instanceof Error ? error.message : error),
        }));
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a disconnected client.
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      ...CORS_HEADERS,
    },
  });
}

async function siteResponse(request: Request, env: HandlerEnv, id: string, rawPath: string): Promise<Response> {
  let path: string;
  try {
    const decoded = decodeURIComponent(rawPath);
    const candidate = decoded === ""
      ? "index.html"
      : decoded.endsWith("/") ? `${decoded}index.html` : decoded;
    try {
      path = requireRelativePath(candidate);
    } catch {
      throw coded("verbos: site path must be normalized, relative, and cannot contain '..'", "EINVAL");
    }
  } catch (error) {
    return new Response(oneLine(error instanceof Error ? error.message : error), {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...CORS_HEADERS,
      },
    });
  }
  const object = await env.SITES.get(`sites/${id}/${path}`);
  if (!object) {
    return new Response("not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...CORS_HEADERS,
      },
    });
  }
  return new Response(object.body, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": object.httpMetadata?.contentType ?? contentType(path),
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}

export async function handleRequest(
  request: Request,
  env: HandlerEnv,
  dependencies: WorkerDependencies,
): Promise<Response> {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const { pathname } = new URL(request.url);
    const exec = /^\/ws\/([^/]+)\/exec$/.exec(pathname);
    if (request.method === "POST" && exec) {
      const wsid = exec[1] ?? "";
      if (!WORKSPACE_ID.test(wsid)) return json({ error: "invalid workspace id", code: "EINVAL" }, 400);
      return await execResponse(request, env, dependencies, wsid);
    }
    const publish = /^\/ws\/([^/]+)\/publish$/.exec(pathname);
    if (request.method === "POST" && publish) {
      const wsid = publish[1] ?? "";
      if (!WORKSPACE_ID.test(wsid)) return json({ error: "invalid workspace id", code: "EINVAL" }, 400);
      return await publishResponse(request, env, dependencies);
    }
    const workspace = /^\/ws\/([^/]+)\/fs(\/batch)?$/.exec(pathname);
    if (request.method === "POST" && workspace) {
      const wsid = workspace[1] ?? "";
      if (!WORKSPACE_ID.test(wsid)) return json({ error: "invalid workspace id", code: "EINVAL" }, 400);
      return await workspaceResponse(request, env, dependencies, wsid, workspace[2] === "/batch");
    }
    const site = /^\/s\/([^/]+)\/?(.*)$/.exec(pathname);
    if (request.method === "GET" && site) {
      const id = site[1] ?? "";
      if (!SITE_ID.test(id)) return new Response("not found", { status: 404, headers: CORS_HEADERS });
      return await siteResponse(request, env, id, site[2] ?? "");
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: oneLine(error instanceof Error ? error.message : error) }, 502);
  }
}
