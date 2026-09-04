import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";
import {
  FileSystemError,
  exists as kernelExists,
  ls,
  mkdir as kernelMkdir,
  mv as kernelMove,
  normalizePath,
  readFileBytes,
  rm as kernelRemove,
  stat as kernelStat,
  touchFile,
  writeFileBytes,
} from "../fs";
import {
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "../ownershipAdmission";
import type { ShellExecutionSource } from "./types";

export const JUST_BASH_HOME = "/";

type EncodingOptions = { encoding?: BufferEncoding | null };
type DirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

function normalizePosix(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function kernelPathFromJustBash(path: string): string {
  const absolute = normalizePosix(
    path === "~"
      ? JUST_BASH_HOME
      : path.startsWith("~/")
      ? path.slice(1)
      : path,
  );
  return absolute === JUST_BASH_HOME ? "~" : normalizePath(`~${absolute}`);
}

export function justBashPathFromKernel(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "~" ? JUST_BASH_HOME : normalized.slice(1);
}

function encodingFrom(options?: EncodingOptions | BufferEncoding): BufferEncoding {
  if (typeof options === "string") return options;
  return options?.encoding ?? "utf8";
}

function bytesFromString(content: string, encoding: BufferEncoding): Uint8Array {
  if (encoding === "utf8" || encoding === "utf-8") return new TextEncoder().encode(content);
  if (encoding === "hex") {
    if (content.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(content)) {
      throw new Error("webmcp-computer: invalid hex file content");
    }
    return Uint8Array.from(
      Array.from({ length: content.length / 2 }, (_, index) =>
        Number.parseInt(content.slice(index * 2, index * 2 + 2), 16)
      ),
    );
  }
  if (encoding === "base64") {
    const decoded = atob(content);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  const mask = encoding === "ascii" ? 0x7f : 0xff;
  return Uint8Array.from(content, (character) => character.charCodeAt(0) & mask);
}

function stringFromBytes(content: Uint8Array, encoding: BufferEncoding): string {
  if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(content);
  if (encoding === "hex") {
    return Array.from(content, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let binary = "";
  for (let index = 0; index < content.length; index += 0x8000) {
    binary += String.fromCharCode(...content.subarray(index, index + 0x8000));
  }
  return encoding === "base64" ? btoa(binary) : binary;
}

function contentBytes(
  content: FileContent,
  options?: EncodingOptions | BufferEncoding,
): Uint8Array {
  return content instanceof Uint8Array
    ? Uint8Array.from(content)
    : bytesFromString(content, encodingFrom(options));
}

async function missing(path: string): Promise<boolean> {
  try {
    await kernelStat(path);
    return false;
  } catch (error) {
    if (error instanceof FileSystemError && error.code === "ENOENT") return true;
    throw error;
  }
}

export class JustBashFileSystem implements IFileSystem {
  constructor(
    private readonly executionAdmission: () => MachineMutationAdmission | ShellExecutionSource,
  ) {}

  private admission(): MachineMutationAdmission {
    const admission = this.executionAdmission();
    return typeof admission === "string" ? captureMachineMutationAdmission(admission) : admission;
  }

  async readFile(
    path: string,
    options?: EncodingOptions | BufferEncoding,
  ): Promise<string> {
    return stringFromBytes(await this.readFileBuffer(path), encodingFrom(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    try {
      return await readFileBytes(kernelPathFromJustBash(path));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("webmcp-computer: is a directory:")) {
        throw new FileSystemError(error.message, "EISDIR");
      }
      throw error;
    }
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: EncodingOptions | BufferEncoding,
  ): Promise<void> {
    const admission = this.admission();
    await writeFileBytes(
      kernelPathFromJustBash(path),
      contentBytes(content, options),
      admission,
    );
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: EncodingOptions | BufferEncoding,
  ): Promise<void> {
    const admission = this.admission();
    const target = kernelPathFromJustBash(path);
    const addition = contentBytes(content, options);
    let current: Uint8Array<ArrayBufferLike> = new Uint8Array();
    try {
      current = await readFileBytes(target);
    } catch (error) {
      if (!(error instanceof FileSystemError) || error.code !== "ENOENT") throw error;
    }
    const combined = new Uint8Array(current.byteLength + addition.byteLength);
    combined.set(current);
    combined.set(addition, current.byteLength);
    await writeFileBytes(target, combined, admission);
  }

  async exists(path: string): Promise<boolean> {
    return await kernelExists(kernelPathFromJustBash(path));
  }

  async stat(path: string): Promise<FsStat> {
    const result = await kernelStat(kernelPathFromJustBash(path));
    return {
      isFile: result.kind === "file",
      isDirectory: result.kind === "directory",
      isSymbolicLink: false,
      mode: result.kind === "directory" ? 0o755 : 0o644,
      size: result.size,
      mtime: new Date(result.modifiedAt),
      identity: result.path,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const admission = this.admission();
    const target = kernelPathFromJustBash(path);
    if (!options?.recursive) {
      await kernelMkdir(target, admission);
      return;
    }
    const segments = target === "~" ? [] : target.slice(2).split("/");
    let current = "~";
    for (const segment of segments) {
      current = normalizePath(`${current}/${segment}`);
      if (await missing(current)) await kernelMkdir(current, admission);
      else if ((await kernelStat(current)).kind !== "directory") {
        throw new Error(`webmcp-computer: not a directory: ${current}`);
      }
    }
  }

  async readdir(path: string): Promise<string[]> {
    return (await ls(kernelPathFromJustBash(path))).map(({ name }) => name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return (await ls(kernelPathFromJustBash(path))).map((entry) => ({
      name: entry.name,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "directory",
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const admission = this.admission();
    const target = kernelPathFromJustBash(path);
    let targetStat;
    try {
      targetStat = await kernelStat(target);
    } catch (error) {
      if (options?.force && error instanceof FileSystemError && error.code === "ENOENT") return;
      throw error;
    }
    if (targetStat.kind === "directory" && !options?.recursive && (await ls(target)).length > 0) {
      throw new FileSystemError(`webmcp-computer: directory not empty: ${target}`, "ENOTEMPTY");
    }
    await kernelRemove(target, admission);
  }

  async cp(source: string, destination: string, options?: CpOptions): Promise<void> {
    await this.copy(source, destination, options, this.admission());
  }

  private async copy(
    source: string,
    destination: string,
    options: CpOptions | undefined,
    admission: MachineMutationAdmission,
  ): Promise<void> {
    const from = kernelPathFromJustBash(source);
    const to = kernelPathFromJustBash(destination);
    const sourceStat = await kernelStat(from);
    if (sourceStat.kind === "file") {
      await writeFileBytes(to, await readFileBytes(from), admission);
      return;
    }
    if (!options?.recursive) {
      throw new FileSystemError(`webmcp-computer: is a directory: ${from}`, "EISDIR");
    }
    if (to === from || to.startsWith(`${from}/`)) {
      throw new Error(`webmcp-computer: cannot copy ${from} into itself: ${to}`);
    }
    if (await missing(to)) await kernelMkdir(to, admission);
    for (const entry of await ls(from)) {
      await this.copy(
        justBashPathFromKernel(entry.path),
        justBashPathFromKernel(normalizePath(`${to}/${entry.name}`)),
        options,
        admission,
      );
    }
  }

  async mv(source: string, destination: string): Promise<void> {
    const admission = this.admission();
    await kernelMove(
      kernelPathFromJustBash(source),
      kernelPathFromJustBash(destination),
      admission,
      true,
    );
  }

  resolvePath(base: string, path: string): string {
    const shellPath = path === "~" ? JUST_BASH_HOME : path.startsWith("~/") ? path.slice(1) : path;
    return normalizePosix(shellPath.startsWith("/") ? shellPath : `${base}/${shellPath}`);
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string, _mode: number): Promise<void> {
    await kernelStat(kernelPathFromJustBash(path));
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new Error(`webmcp-computer: symbolic links are not supported: ${kernelPathFromJustBash(linkPath)}`);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const admission = this.admission();
    const destination = kernelPathFromJustBash(newPath);
    if (await kernelExists(destination)) {
      throw new FileSystemError(`webmcp-computer: file exists: ${destination}`, "EEXIST");
    }
    await writeFileBytes(
      destination,
      await readFileBytes(kernelPathFromJustBash(existingPath)),
      admission,
    );
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`webmcp-computer: not a symbolic link: ${kernelPathFromJustBash(path)}`);
  }

  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path);
  }

  async realpath(path: string): Promise<string> {
    const normalized = this.resolvePath(JUST_BASH_HOME, path);
    await kernelStat(kernelPathFromJustBash(normalized));
    return justBashPathFromKernel(kernelPathFromJustBash(normalized));
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const admission = this.admission();
    await touchFile(kernelPathFromJustBash(path), admission, mtime);
  }
}
