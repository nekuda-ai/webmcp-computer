import {
  Async,
  constants,
  IndexFS,
  InMemory,
  Inode,
  type CreationOptions,
  type InodeLike,
} from "@zenfs/core";
import { dirname } from "@zenfs/core/path";
import { resolveWorkerUrl } from "../shared/workerUrl";
import { MAX_FS_BATCH_OPERATIONS } from "../../../workers/computer/src/protocol";
import {
  hostedAuthorization,
  hostedSessionSnapshot,
  hostedWorkerUrl,
  hostedWorkspaceId,
} from "./hostedSession";

export const CLOUD_KERNEL_STORAGE_KEY = "webmcp_computer.cloud_kernel";
export const WORKSPACE_STORAGE_KEY = "webmcp_computer.workspace";

const WORKSPACE_ID = /^[0-9a-f]{32}$/;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export type ComputerWorkerResolutionOptions = {
  search?: string;
  storage?: StorageReader;
  envUrl?: string;
  defaultUrl?: string;
  production?: boolean;
};

export type CloudFsDependencies = {
  fetch: typeof fetch;
  workerBaseUrl: string;
  workspaceId: string;
  authorization?: () => Promise<{ Authorization: string }>;
  requestTimeoutMs?: number;
};

export type CloudFsOperation = {
  op: "read" | "write" | "mkdir" | "readdir" | "rm" | "rename" | "stat" | "exists";
  path: string;
  to?: string;
  data?: string;
  recursive?: boolean;
};

type RemoteStat = {
  name: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

type RemoteDirent = RemoteStat;
type FsResponse = {
  data?: string;
  entries?: RemoteDirent[];
  stat?: RemoteStat;
  exists?: boolean;
  error?: string;
  code?: string;
};

export const CLOUD_FS_REQUEST_TIMEOUT_MS = 5_000;

function defaultStorage(): StorageWriter | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function cloudKernelPreference(storage: StorageReader | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(CLOUD_KERNEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setCloudKernelPreference(
  enabled: boolean,
  storage: StorageWriter | undefined = defaultStorage(),
): void {
  storage?.setItem(CLOUD_KERNEL_STORAGE_KEY, String(enabled));
}

function mintWorkspaceId(random = crypto.getRandomValues.bind(crypto)): string {
  const bytes = random(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ensureWorkspaceId(
  storage: StorageWriter | undefined = defaultStorage(),
  random?: (array: Uint8Array) => Uint8Array,
): string {
  if (hostedSessionSnapshot().status === "active") return hostedWorkspaceId();
  const stored = storage?.getItem(WORKSPACE_STORAGE_KEY);
  if (stored && WORKSPACE_ID.test(stored)) return stored;
  const workspaceId = mintWorkspaceId(random);
  storage?.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
  return workspaceId;
}

export function resolveComputerWorkerUrl(
  options: ComputerWorkerResolutionOptions = {},
): string {
  if (hostedSessionSnapshot().status === "active") return hostedWorkerUrl("computer");
  const envUrl = options.envUrl ?? import.meta.env.VITE_COMPUTER_WORKER_URL;
  return resolveWorkerUrl({
    queryKey: "computer_worker",
    storageKey: "webmcp_computer.computer_worker",
    label: "computer",
    ...(options.defaultUrl === undefined ? {} : { defaultUrl: options.defaultUrl }),
    ...(envUrl === undefined ? {} : { envUrl }),
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.production === undefined ? {} : { production: options.production }),
  });
}

function coded(message: string, code?: string, path?: string): Error {
  return Object.assign(new Error(message), {
    ...(code === undefined ? {} : { code }),
    ...(path === undefined ? {} : { path }),
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asResponse(value: unknown, path: string): FsResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw coded("webmcp-computer: computer Worker returned an invalid filesystem response", "EIO", path);
  }
  return value as FsResponse;
}

export class CloudFsClient {
  readonly #dependencies: CloudFsDependencies;

  constructor(dependencies: CloudFsDependencies) {
    if (!WORKSPACE_ID.test(dependencies.workspaceId)) {
      throw new Error("webmcp-computer: invalid cloud workspace id");
    }
    this.#dependencies = dependencies;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const timeoutMs = this.#dependencies.requestTimeoutMs ?? CLOUD_FS_REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      const authorization = await this.#dependencies.authorization?.() ?? {};
      response = await this.#dependencies.fetch(
        `${this.#dependencies.workerBaseUrl}/ws/${this.#dependencies.workspaceId}/fs${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authorization },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      if (
        error !== null && typeof error === "object" &&
        ["AbortError", "TimeoutError"].includes(String((error as { name?: unknown }).name))
      ) {
        throw coded(`webmcp-computer: cloud filesystem request timed out after ${timeoutMs}ms`, "ETIMEDOUT");
      }
      throw error;
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const error = value && typeof value === "object" ? value as FsResponse : undefined;
      throw coded(
        typeof error?.error === "string" ? error.error : `computer Worker returned ${response.status}`,
        typeof error?.code === "string" ? error.code : "EIO",
      );
    }
    return value;
  }

  async operation(operation: CloudFsOperation): Promise<FsResponse> {
    const response = asResponse(await this.#post("", operation), operation.path);
    if (response.error) throw coded(response.error, response.code, operation.path);
    return response;
  }

  async batch(operations: readonly CloudFsOperation[]): Promise<FsResponse[]> {
    const value = await this.#post("/batch", operations);
    if (!Array.isArray(value) || value.length !== operations.length) {
      throw coded("webmcp-computer: computer Worker returned an invalid batch response", "EIO");
    }
    return value.map((entry, index) => asResponse(entry, operations[index]?.path ?? "/"));
  }

  async read(path: string): Promise<Uint8Array> {
    const response = await this.operation({ op: "read", path });
    if (typeof response.data !== "string") throw coded("invalid read response", "EIO", path);
    return base64ToBytes(response.data);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.operation({ op: "write", path, data: bytesToBase64(bytes) });
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    await this.operation({ op: "mkdir", path, recursive });
  }

  async readdir(path: string): Promise<RemoteDirent[]> {
    const response = await this.operation({ op: "readdir", path });
    if (!Array.isArray(response.entries)) throw coded("invalid readdir response", "EIO", path);
    return response.entries;
  }

  async rm(path: string, recursive = false): Promise<void> {
    await this.operation({ op: "rm", path, recursive });
  }

  async rename(path: string, to: string): Promise<void> {
    await this.operation({ op: "rename", path, to });
  }
}

function inodeFromRemote(stat: RemoteStat): Inode {
  return new Inode({
    mode: (stat.isDirectory ? constants.S_IFDIR | 0o755 : constants.S_IFREG | 0o644),
    size: stat.size,
    mtimeMs: stat.mtime,
  });
}

const CloudFileSystemBase = Async(IndexFS);

export class CloudFileSystem extends CloudFileSystemBase {
  readonly #client: CloudFsClient;
  _sync = InMemory.create({ label: "webmcp-computer-cloud-cache" });

  constructor(client: CloudFsClient) {
    super(0x636c6f75, "cloudfs");
    this.#client = client;
  }

  async load(): Promise<void> {
    const root = await this.#client.batch([
      { op: "stat", path: "/" },
      { op: "readdir", path: "/" },
    ]);
    if (root[0]?.error) throw coded(root[0].error, root[0].code, "/");
    if (!root[0]?.stat || !root[0].stat.isDirectory || !Array.isArray(root[1]?.entries)) {
      throw coded("webmcp-computer: cloud workspace returned an invalid root", "EIO", "/");
    }
    this.index.set("/", inodeFromRemote(root[0].stat));

    let directories: Array<{ path: string; entries: RemoteDirent[] }> = [{
      path: "/",
      entries: root[1].entries,
    }];
    while (directories.length > 0) {
      const next: string[] = [];
      for (const directory of directories) {
        for (const entry of directory.entries) {
          const path = `${directory.path === "/" ? "" : directory.path}/${entry.name}`;
          this.index.set(path, inodeFromRemote(entry));
          if (entry.isDirectory) next.push(path);
        }
      }
      if (next.length === 0) break;
      directories = [];
      for (let offset = 0; offset < next.length; offset += MAX_FS_BATCH_OPERATIONS) {
        const paths = next.slice(offset, offset + MAX_FS_BATCH_OPERATIONS);
        const responses = await this.#client.batch(paths.map((path) => ({ op: "readdir", path })));
        directories.push(...responses.map((response, index) => {
          const path = paths[index] ?? "/";
          if (response.error) throw coded(response.error, response.code, path);
          if (!Array.isArray(response.entries)) throw coded("invalid readdir response", "EIO", path);
          return { path, entries: response.entries };
        }));
      }
    }
  }

  override async createFile(path: string, options: CreationOptions): Promise<Inode> {
    const inode = await super.createFile(path, options);
    try {
      await this.#client.write(path, new Uint8Array());
      return inode;
    } catch (error) {
      this.index.delete(path);
      throw error;
    }
  }

  override async touch(path: string, metadata: InodeLike): Promise<void> {
    const inode = this.index.get(path);
    if (!inode) throw coded(`no such file: ${path}`, "ENOENT", path);
    if (
      typeof metadata.size === "number" &&
      metadata.size !== inode.size &&
      (inode.mode & constants.S_IFMT) !== constants.S_IFDIR
    ) {
      const current = await this.#client.read(path);
      const resized = new Uint8Array(metadata.size);
      resized.set(current.subarray(0, metadata.size));
      await this.#client.write(path, resized);
    }
    await super.touch(path, metadata);
  }

  protected override async _mkdir(path: string): Promise<void> {
    await this.#client.mkdir(path);
  }

  protected override async remove(path: string): Promise<void> {
    await this.#client.rm(path, true);
  }

  protected override removeSync(): void {
    throw coded("cloud filesystem has no synchronous remove", "ENOSYS");
  }

  override async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
    if (end <= start) return;
    const bytes = await this.#client.read(path);
    buffer.set(bytes.subarray(start, end));
  }

  override async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
    const inode = this.index.get(path);
    if (!inode) throw coded(`no such file: ${path}`, "ENOENT", path);
    if ((inode.mode & constants.S_IFMT) === constants.S_IFDIR) return;
    let current = new Uint8Array();
    if (offset > 0 || inode.size > buffer.byteLength) {
      current = new Uint8Array(await this.#client.read(path));
    }
    const bytes = new Uint8Array(Math.max(current.byteLength, offset + buffer.byteLength));
    bytes.set(current);
    bytes.set(buffer, offset);
    await this.#client.write(path, bytes);
    inode.update({ size: bytes.byteLength, mtimeMs: Date.now() });
    this.index.set(path, inode);
  }

  override async rename(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const moved = [...this.index.entries()].filter(([path]) =>
      path === oldPath || path.startsWith(`${oldPath}/`)
    );
    if (moved.length === 0) throw coded(`no such file: ${oldPath}`, "ENOENT", oldPath);
    if ((dirname(newPath) + "/").startsWith(`${oldPath}/`)) {
      throw coded(`cannot move into itself: ${newPath}`, "EBUSY", newPath);
    }
    const source = this.index.get(oldPath);
    const destination = this.index.get(newPath);
    const sourceIsDirectory = source !== undefined &&
      (source.mode & constants.S_IFMT) === constants.S_IFDIR;
    const destinationIsDirectory = destination !== undefined &&
      (destination.mode & constants.S_IFMT) === constants.S_IFDIR;
    if (destination) {
      if (sourceIsDirectory && destinationIsDirectory) {
        const destinationHasChildren = [...this.index.keys()].some((path) =>
          path.startsWith(`${newPath}/`)
        );
        if (destinationHasChildren) {
          throw coded(`is a directory: ${oldPath}`, "EISDIR", oldPath);
        }
      } else if (sourceIsDirectory) {
        throw coded(`not a directory: ${oldPath}`, "ENOTDIR", oldPath);
      } else if (destinationIsDirectory) {
        throw coded(`is a directory: ${oldPath}`, "EISDIR", oldPath);
      }
    }
    await this.#client.rename(oldPath, newPath);
    for (const [path] of moved) this.index.delete(path);
    this.index.delete(newPath);
    for (const [path, inode] of moved) {
      this.index.set(`${newPath}${path.slice(oldPath.length)}`, inode);
    }
  }
}

export async function createCloudFileSystem(
  dependencies: CloudFsDependencies,
): Promise<CloudFileSystem> {
  const fileSystem = new CloudFileSystem(new CloudFsClient(dependencies));
  await fileSystem.load();
  return fileSystem;
}
