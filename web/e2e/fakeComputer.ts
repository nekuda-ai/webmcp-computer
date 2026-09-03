import {
  handleRequest,
  type HandlerEnv,
  type SiteObject,
  type SiteStore,
  type WorkerDependencies,
  type WorkspaceHandle,
  type WorkspaceStat,
} from "../../workers/computer/src/handler";

type WorkspaceTree = {
  directories: Set<string>;
  files: Map<string, Uint8Array>;
};

export type FakeComputer = {
  origin: string;
  readWorkspaceText(path: string): string | undefined;
  stop(): Promise<void>;
};

export type FakeComputerHandler = {
  fetch(request: Request): Promise<Response>;
  readWorkspaceText(path: string): string | undefined;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function parent(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

class MemoryWorkspace {
  readonly tree: WorkspaceTree = {
    directories: new Set(["/"]),
    files: new Map(),
  };

  readonly handle: WorkspaceHandle = {
    fs: {
      readFile: async (path) => {
        const bytes = this.tree.files.get(path);
        if (!bytes) {
          if (this.tree.directories.has(path)) throw coded(`is a directory: ${path}`, "EISDIR");
          throw coded(`no such file: ${path}`, "ENOENT");
        }
        return stream(bytes);
      },
      writeFile: async (path, content) => {
        if (!this.tree.directories.has(parent(path))) {
          throw coded(`no such directory: ${parent(path)}`, "ENOENT");
        }
        if (this.tree.directories.has(path)) throw coded(`is a directory: ${path}`, "EISDIR");
        this.tree.files.set(path, Uint8Array.from(content));
      },
      exists: async (path) => this.tree.files.has(path) || this.tree.directories.has(path),
      stat: async (path) => {
        const value = this.stat(path);
        if (!value) throw coded(`no such file: ${path}`, "ENOENT");
        return value;
      },
      statOrNull: async (path) => this.stat(path) ?? null,
      readdir: async (path) => {
        if (!this.tree.directories.has(path)) {
          if (this.tree.files.has(path)) throw coded(`not a directory: ${path}`, "ENOTDIR");
          throw coded(`no such directory: ${path}`, "ENOENT");
        }
        const prefix = path === "/" ? "/" : `${path}/`;
        const names = new Set<string>();
        for (const candidate of [...this.tree.directories, ...this.tree.files.keys()]) {
          if (candidate === path || !candidate.startsWith(prefix)) continue;
          const name = candidate.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
        return [...names].sort().map((name) =>
          this.stat(`${path === "/" ? "" : path}/${name}`) as WorkspaceStat
        );
      },
      mkdir: async (path, options) => {
        if (options?.recursive && this.tree.directories.has(path)) return;
        if (this.tree.files.has(path) || this.tree.directories.has(path)) {
          throw coded(`file exists: ${path}`, "EEXIST");
        }
        const parts = path.split("/").filter(Boolean);
        let current = "";
        for (let index = 0; index < parts.length; index += 1) {
          current += `/${parts[index]}`;
          if (this.tree.files.has(current)) throw coded(`not a directory: ${current}`, "ENOTDIR");
          if (
            index !== parts.length - 1 && !options?.recursive &&
            !this.tree.directories.has(current)
          ) {
            throw coded(`no such directory: ${current}`, "ENOENT");
          }
          this.tree.directories.add(current);
        }
      },
      rm: async (path, options) => {
        if (this.tree.files.delete(path)) return;
        if (!this.tree.directories.has(path)) throw coded(`no such file: ${path}`, "ENOENT");
        const prefix = `${path}/`;
        const hasChildren = [...this.tree.files.keys(), ...this.tree.directories].some((entry) =>
          entry.startsWith(prefix)
        );
        if (hasChildren && !options?.recursive) {
          throw coded(`directory not empty: ${path}`, "ENOTEMPTY");
        }
        for (const file of [...this.tree.files.keys()]) {
          if (file.startsWith(prefix)) this.tree.files.delete(file);
        }
        for (const directory of [...this.tree.directories]) {
          if (directory === path || directory.startsWith(prefix)) {
            this.tree.directories.delete(directory);
          }
        }
      },
    },
    [Symbol.dispose]() {},
  };

  private stat(path: string): WorkspaceStat | undefined {
    const bytes = this.tree.files.get(path);
    const directory = this.tree.directories.has(path);
    if (!bytes && !directory) return undefined;
    return {
      name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
      size: bytes?.byteLength ?? 0,
      mtime: 123,
      isFile: bytes !== undefined,
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
      ...(value.contentType === undefined
        ? {}
        : { httpMetadata: { contentType: value.contentType } }),
    } : null;
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    const bytes = typeof value === "string"
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? Uint8Array.from(value)
        : new Uint8Array(await new Response(value).arrayBuffer());
    const contentType = options?.httpMetadata?.contentType;
    this.values.set(key, {
      bytes,
      ...(contentType === undefined ? {} : { contentType }),
    });
  }
}

export function createFakeComputerHandler(options: { requireAuthorization?: boolean } = {}): FakeComputerHandler {
  const workspaces = new Map<string, MemoryWorkspace>();
  const sites = new MemorySiteStore();
  let nextSite = 1;
  const env = {
    GATEWAY_SIGNING_SECRET: "fake-computer-gateway-secret-at-least-32-characters",
    SITES: sites,
    EXEC_RATE: { async limit() { return { success: true }; } },
    EXEC_RATE_IP: { async limit() { return { success: true }; } },
    PUBLISH_RATE: { async limit() { return { success: true }; } },
    PUBLISH_RATE_IP: { async limit() { return { success: true }; } },
    WORKSPACE_WRITE_RATE: { async limit() { return { success: true }; } },
    WORKSPACE_WRITE_RATE_IP: { async limit() { return { success: true }; } },
  } satisfies HandlerEnv;
  const dependencies = {
    async authenticate(request: Request, _env: HandlerEnv, workspaceId: string) {
      if (
        options.requireAuthorization &&
        !request.headers.get("Authorization")?.startsWith("Bearer ")
      ) throw new Error("unauthorized");
      return {
        audience: "verbos-cloudflare" as const,
        expiresAt: 2_000,
        issuedAt: 1_000,
        origin: "http://127.0.0.1",
        scopes: ["computer" as const],
        subject: "fake-subject",
        version: 1 as const,
        workspace: workspaceId,
      };
    },
    async openWorkspace(wsid: string) {
      let workspace = workspaces.get(wsid);
      if (!workspace) {
        workspace = new MemoryWorkspace();
        workspaces.set(wsid, workspace);
      }
      return workspace.handle;
    },
    randomSlug() {
      return `fake${String(nextSite++).padStart(4, "0")}`;
    },
  } satisfies WorkerDependencies;

  return {
    async fetch(request) {
      return await handleRequest(request, env, dependencies);
    },
    readWorkspaceText(path) {
      for (const workspace of workspaces.values()) {
        const bytes = workspace.tree.files.get(path);
        if (bytes) return decoder.decode(bytes);
      }
      return undefined;
    },
  };
}

export function startFakeComputer(): FakeComputer {
  const handler = createFakeComputerHandler({ requireAuthorization: true });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return handler.fetch(request);
    },
  });
  if (server.port === undefined) {
    void server.stop(true);
    throw new Error("Fake Computer did not bind a TCP port");
  }
  let stopped = false;

  return {
    origin: `http://127.0.0.1:${server.port}`,
    readWorkspaceText: handler.readWorkspaceText,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
}
