import { configureSingle, fs as zenfs, InMemory } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import { useKernelStore } from "./store";
import type { FileSystemBackend } from "./types";
import { AGENT_SKILL_FILES, AGENT_SKILL_SHA256 } from "./manualContent";
import {
  cloudKernelPreference,
  createCloudFileSystem,
  ensureWorkspaceId,
  resolveComputerWorkerUrl,
  setCloudKernelPreference,
} from "./cloudFs";
import { hostedAuthorization, hostedSessionActive } from "./hostedSession";
import {
  assertMachineMutationAdmission,
  captureMachineMutationAdmission,
  type MachineMutationAdmission,
} from "./ownershipAdmission";

export const AURORA_BRIEF = `# Aurora Trails — landing page brief

You are inside WebMCP Computer. Build me a small landing page for **Aurora Trails**, a guided
night-hiking company in northern Norway. Put the site in \`~/site/\` and serve it when done
(\`serve site/\` in the terminal).

What I want:

- One page, \`index.html\`, self-contained CSS (a \`style.css\` next to it is fine). No frameworks.
- Hero: company name, one-line promise ("See the sky move. On foot."), a CTA button
  ("Book a night") that scrolls to the booking section.
- Three trail cards: *Lights Ridge* (easy, 3h), *Frozen Fjord* (moderate, 5h),
  *Polar Summit* (hard, 8h) — each with a short description and price (89 / 129 / 189 EUR).
- A booking section with a simple form (name, email, trail select, date) — no backend,
  just a friendly confirmation message on submit.
- Dark, aurora-inspired palette: deep navy background, teal-to-violet gradient accents.
  Readable typography, generous spacing. Subtle only — no animation overload.

When the preview renders clean (check the console!), leave the site served so I can look.
`;

export const PIZZA_DEMO_BRIEF = `# Slice/01 - pizza demo brief

## Goal

Inside WebMCP Computer, build a polished pizza-ordering page that humans and agents operate
through one shared cart. This is a local demo: no network, payment, or real order.

## Build

- Create \`~/pizza-demo/index.html\`; use plain HTML, CSS, and JavaScript.
- Show Slice/01 branding, three menu cards, size selection, cart, total, receipt, and
  visible agent-activity line.
- Menu: Margherita (14/19 USD), Pepperoni (17/23), Night Mushroom (18/24), small/large.
- Human buttons and agent tools must update the same in-page state.

## Dynamic WebMCP tools

Register these from the served page with \`document.modelContext.registerTool(...)\`:

- \`site_menu_get {}\` - return stable IDs, descriptions, sizes, and prices.
- \`site_pizza_add {pizza_id, size, quantity}\` - add 1-8 pizzas to visible cart.
- \`site_cart_get {}\` - return line items, item count, USD total, and currency.
- \`site_order_place {label?}\` - create local demo order ID, status, ETA, and receipt.

Use strict JSON schemas with \`additionalProperties: false\`. Tool descriptions must say
what changes and that placing an order sends nothing externally. Each executor returns
structured JSON and visibly updates shared UI. Tools exist only while Preview is open.

## Done

1. Run \`serve pizza-demo/\`.
2. Preview renders cleanly and console has no errors.
3. Four \`site_*\` tools appear dynamically.
4. Agent can read menu, add one large pepperoni, read a 23 USD cart, and place a demo
   order whose ID and ETA appear in receipt.
5. Leave Preview served for human handoff.
`;

const WELCOME_NOTE = `# Welcome to WebMCP Computer

Your notes live here as Markdown files. Human and agent edits share the same filesystem.
`;
const SEED_MARKER = "/.webmcp-computer-seeded";
const AGENT_SKILL_SEED_MARKER_PREFIX = "/.webmcp-computer-skills-";

// Every manual hash this product has ever shipped. A visitor's ~/skills file that still
// matches one of them was never edited, so it is replaced by the current manual; any other
// content is a visitor edit and is left alone. When the manual changes, append the outgoing
// AGENT_SKILL_SHA256 values here.
export const LEGACY_AGENT_SKILL_SHA256: ReadonlySet<string> = new Set([
  "103b28b4cfa1f62d259880f445c6269df13f8a7fec448d5d1f3ff50f36836dbd",
  "1071643cd3d990922650e56b08609c07fead0c362e3376a236b714e457650763",
  "10f945744725d80df55511a912268c16de86a11e07f0cfef05c47502f48bf90a",
  "1259e1fd4526eae32db91b0c3affb562cd3d108daf65f253a1fa34c1d921be0b",
  "146c762df05862b58bd07c88109228a676c3275f443117d75c3bd61740fa92d7",
  "23540bf387b02a3443d58803ce50fe9b9a86943ec1df15a109426f6a9e804526",
  "23747daceb02541e1513ec9b7da80c9783b223de3d600043dc66afb1d8fabfb7",
  "30ddbeaaf6023653f0b6819b808b3ecef7e4b73d7893d76918aa18b291449427",
  "424b03b439db115aa2182718b3dc1e8268f768806f42865e4341edba5d6ede92",
  "4bc26504589cc14b3330ecaa9d1b90ae9ee11a69274c3ad33199ce1af307a30d",
  "4cbb848863f3aa0c997cfc1d42fde34c9cbed8fbdc9bc27cbc9d5e610257ad61",
  "59c11bf05bac00ab193fcaff85dfe9b6d5df9e35b2ed3c7479cbe8a195f67bb6",
  "5f083b9b1018ea3545dc1701f3189151fcfb48fe8c6bfab56338a0818e0728a1",
  "6dc336a39b8b7ed36123b71087054250d1b1f9495b1f8364de3f53ed55e78657",
  "7202b7b8bdf3e75376bce40f6408d428fd425ae8c4b32650f40af2802e4951b6",
  "7ba030736a76531f87e290d826d99bc70152b63b66116c9157b44e5abb46f28b",
  "807500a99d0011503ffd2394d0d9a7bc19548b2aa62d4d6835faf38d637fd95f",
  "855acb0600becc65721caade0b5e0ba2d58641c9d58c53f2aad9f370964439ed",
  "912a53344e613a2e4dfa405bef916083342e264d54d8fff0f7d725dd1c6cfe14",
  "a58d9bbaa633bb673c0d5b5d7f15a62550ec3d5d9774f9e458eee62545206981",
  "a97add3b56113335c03d69c6b8a07461864dad7613f42dbb1f9eb0fcb56a9939",
  "b701f8204ffff831f36d74b217022c488bab368e55c8ae4003b55a718dd883bb",
  "bce24ac1da8da0c0d90985d6e7ba1a353bc30d8df3677ed58ffd635d943de819",
  "c0fdf102caffb42fc4070fcddb2d6cd8518ff95164f4b071c2148da53d32b0af",
  "d2bef8d10d3e51f2e652b2a0756f0ab0d4c2f193f6d65df21364f0825ff40625",
  "d4b4c50272f60ff68b2b9862c7e53d180717ac1a1c55aaba119a89b5395a2bbe",
  "de156320fe83ca3d718799d3a7bbd618d06a615b5e182c935c1e612ddb9efd3a",
  "e0604e5076e4217b34f5f5a718ef52ab915050af5432431aef83100625dac8a5",
  "e95623ba3711cc70379bf69f0cbb4eb894c1b0e5c0600894df47d71a3f6ae798",
  "eff251ae9e80dee5988116161838d6bf97ffa9e9f16861614bb7249803eb0d60",
  "eff2c30a8aabdfe5661d457085526acbabce4bf15d4c621cc7210eef27330c3d",
  "f1d2d527da48110c55041e892dca9590dd88bfd7d446deab074ca626a5edc14c",
  "f49f9d6e14113ba2be2ac358f23404cc360c18c10e3425d8f61539929f38cdac",
  "f4f15d1fe6b5b00ee1cf85de8612e9aecc3274771252a49649daba435fd28147",
  "f5512a38e082e98611a53af47912ebf5fc362e06b38d4d6426e390bc27f49e0f",
  "f61a81f66b7e41285cc652a120c59961325ebceb771c3edc6207bc7c28703ad2",
  "fdbc019861e6129beaa15c5a52d1411e50f47ffd33174d809fbd5f9573c05cd9",
  "ffb37ad856c26cebf506fb26911933f33a90dcc36b53795e357c9e12063c4d67",
  "1ac6b36339bf88ba2fffd3ecd8e0be0ab4e0c59b78b163b53487137ecc92e857",
  "bd81b91abd1039d42a9e6ae95287b5ced0ac26b873c275b92018a8082950d9f8",
  "671c006d533b9bd0c9f2524f3f719bb3d47382ef74c39ea8b27e5b3eb1e9160e",
  "2cc23e3df80db8e22afcd2b751ae94dd7b7f409477c3eff88e10fd2eb259fcfe",
]);

export type FileKind = "file" | "directory";

export type FileEntry = {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modifiedAt: number;
};

export type FileStat = Omit<FileEntry, "name">;

export type FileSystemChange = {
  operation: "write" | "mkdir" | "delete" | "move";
  path: string;
  from?: string;
  source: "agent" | "human" | "system";
};

export type FileSystemMutationAdmission =
  | FileSystemChange["source"]
  | MachineMutationAdmission;

type ChangeListener = (change: FileSystemChange) => void;

const listeners = new Set<ChangeListener>();
const mutationChains = new Map<string, Promise<void>>();
let ready: Promise<FileSystemBackend> | undefined;
let activeBackend: FileSystemBackend | undefined;

export const FILE_SYSTEM_WRITE_LOCK = "webmcp-computer-filesystem-write";

type LockRequester = Pick<LockManager, "request">;

type IndexedEntry = {
  data: number;
  ino: number;
  nlink: number;
};

export type FileSystemCheckReport = {
  repaired: string[];
  warnings: string[];
};

export type FileSystemCheckAdapter = {
  readdir(path: string): Promise<readonly string[]>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};

function browserLockManager(): LockRequester | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

export function assignUniqueFileSystemIds(
  entries: Iterable<readonly [string, IndexedEntry]>,
): void {
  let nextId = 1;
  for (const [path, inode] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    if (path === "/") continue;
    inode.ino = nextId;
    inode.data = nextId + 1;
    inode.nlink = 1;
    nextId += 2;
  }
}

export async function withFileSystemWriteLock<T>(
  mutation: () => Promise<T>,
  locks: LockRequester | undefined = browserLockManager(),
): Promise<T> {
  if (!locks) return await mutation();
  return await locks.request(FILE_SYSTEM_WRITE_LOCK, { mode: "exclusive" }, mutation);
}

function homePath(path: string): string {
  return path === "/" ? "~" : `~${path}`;
}

let fsckTempId = 0;

function fsckTemporaryPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const parent = slash <= 0 ? "" : path.slice(0, slash);
  return `${parent}/.webmcp-computer-fsck-${++fsckTempId}`;
}

function staleTemporaryName(name: string): boolean {
  return /^\.webmcp-computer-(?:write|fsck)-/.test(name);
}

async function checkNode(
  path: string,
  adapter: FileSystemCheckAdapter,
  report: FileSystemCheckReport,
): Promise<void> {
  let nodeStat: { isDirectory(): boolean } | undefined;
  try {
    nodeStat = await adapter.stat(path);
  } catch (error) {
    report.warnings.push(`${homePath(path)}: stat failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let names: readonly string[] | undefined;
  try {
    names = await adapter.readdir(path);
  } catch (error) {
    if (errorCode(error) !== "ENOTDIR") {
      report.warnings.push(
        `${homePath(path)}: directory check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else if (nodeStat.isDirectory()) {
      report.warnings.push(`${homePath(path)}: stat says directory but its children cannot be read`);
    }
    return;
  }

  if (!nodeStat.isDirectory()) {
    if (path === "/") {
      report.warnings.push("~: root is readable as a directory but stat reports a file");
    } else {
      const temporary = fsckTemporaryPath(path);
      let moved = false;
      try {
        await adapter.rename(path, temporary);
        moved = true;
        await adapter.rename(temporary, path);
        moved = false;
        const repairedStat = await adapter.stat(path);
        if (!repairedStat.isDirectory()) {
          throw new Error("metadata remained file-shaped after rename repair");
        }
        report.repaired.push(homePath(path));
      } catch (error) {
        if (moved) {
          try {
            await adapter.rename(temporary, path);
          } catch (rollbackError) {
            report.warnings.push(
              `${homePath(path)}: repair rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        report.warnings.push(
          `${homePath(path)}: readable directory reported as a file; repair failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  for (const name of names) {
    if (typeof name !== "string" || name === "." || name === "..") continue;
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    if (staleTemporaryName(name)) {
      try {
        await adapter.rm(childPath);
        report.repaired.push(homePath(childPath));
      } catch (error) {
        report.warnings.push(
          `${homePath(childPath)}: stale temporary cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    await checkNode(childPath, adapter, report);
  }
}

function zenfsCheckAdapter(): FileSystemCheckAdapter {
  return {
    async readdir(path) {
      const names = await zenfs.promises.readdir(path);
      return names.filter((name): name is string => typeof name === "string");
    },
    async rename(from, to) {
      await zenfs.promises.rename(from, to);
    },
    async rm(path) {
      await zenfs.promises.rm(path, { force: true, recursive: true });
    },
    async stat(path) {
      return await zenfs.promises.stat(path);
    },
  };
}

export async function checkFileSystem(
  adapter: FileSystemCheckAdapter = zenfsCheckAdapter(),
): Promise<FileSystemCheckReport> {
  const report: FileSystemCheckReport = { repaired: [], warnings: [] };
  await withFileSystemWriteLock(async () => await checkNode("/", adapter, report));
  return report;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export class FileSystemError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "FileSystemError";
    this.code = code;
  }
}

function fsError(error: unknown, path: string): Error {
  if (error instanceof FileSystemError) return error;
  const messages: Record<string, string> = {
    EACCES: "permission denied",
    EEXIST: "file exists",
    EISDIR: "is a directory",
    ENOENT: "no such file",
    ENOTDIR: "not a directory",
    ENOTEMPTY: "directory not empty",
    EPERM: "operation not permitted",
  };
  const code = errorCode(error);
  const message = code === undefined ? undefined : messages[code];
  const errorPath = error !== null && typeof error === "object" &&
    typeof (error as { path?: unknown }).path === "string"
    ? (error as { path: string }).path
    : path;
  const displayedPath = errorPath.startsWith("/") ? `~${errorPath}` : errorPath;
  if (message) return new FileSystemError(`webmcp-computer: ${message}: ${displayedPath}`, code);
  if (error instanceof Error) {
    const detail = error.message.startsWith("webmcp-computer:")
      ? error.message
      : `webmcp-computer: filesystem error: ${error.message}`;
    return new FileSystemError(detail, code);
  }
  return new FileSystemError(`webmcp-computer: filesystem error: ${String(error)}`, code);
}

function mutationAdmission(
  admission: FileSystemMutationAdmission,
): MachineMutationAdmission {
  return typeof admission === "string"
    ? captureMachineMutationAdmission(admission)
    : admission;
}

async function serializeMutation<T>(
  paths: readonly string[],
  admission: MachineMutationAdmission,
  mutation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(paths)].sort();
  const previous = Promise.all(keys.map((path) => mutationChains.get(path)));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  for (const key of keys) mutationChains.set(key, queued);

  await previous;
  try {
    return await withFileSystemWriteLock(async () => {
      assertMachineMutationAdmission(admission);
      return await mutation();
    });
  } finally {
    release();
    for (const key of keys) {
      if (mutationChains.get(key) === queued) mutationChains.delete(key);
    }
  }
}

function realPath(path: string): string {
  return path === "~" ? "/" : path.slice(1);
}

function emitChange(change: FileSystemChange): void {
  useKernelStore.getState().osEvent("system", "fs_change", { ...change });
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      console.error("WebMCP Computer filesystem watcher failed", error);
    }
  }
}

export function notifyFileSystemChange(
  path: string,
  source: FileSystemChange["source"],
): void {
  emitChange({ operation: "write", path: normalizePath(path), source });
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await zenfs.promises.stat(path);
    return true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

/** Marker written once the current manual bundle has been seeded into ~/skills. */
export async function agentSkillSeedMarkerPath(): Promise<string> {
  const bundle = await sha256(Object.values(AGENT_SKILL_SHA256).join("\n"));
  return `${AGENT_SKILL_SEED_MARKER_PREFIX}${bundle.slice(0, 16)}`;
}

async function seedFileSystemUnlocked(): Promise<void> {
  if (!(await markerExists(SEED_MARKER))) {
    await zenfs.promises.mkdir("/desktop", { recursive: true });
    await zenfs.promises.mkdir("/site", { recursive: true });
    await zenfs.promises.mkdir("/notes", { recursive: true });
    await writeSeedFileIfAbsent("/desktop/brief.md", AURORA_BRIEF);
    await writeSeedFileIfAbsent("/desktop/pizza-demo.md", PIZZA_DEMO_BRIEF);
    await writeSeedFileIfAbsent("/notes/welcome.md", WELCOME_NOTE);
    await zenfs.promises.writeFile(SEED_MARKER, "seeded\n", "utf8");
  }

  const skillsMarker = await agentSkillSeedMarkerPath();
  if (await markerExists(skillsMarker)) return;
  await zenfs.promises.mkdir("/skills", { recursive: true });
  for (const [name, content] of Object.entries(AGENT_SKILL_FILES)) {
    await migrateSeedFileIfUnchanged(`/skills/${name}`, content);
  }
  await zenfs.promises.writeFile(skillsMarker, `${Object.keys(AGENT_SKILL_FILES).length} manuals\n`, "utf8");
}

export async function seedFileSystem(): Promise<void> {
  await withFileSystemWriteLock(seedFileSystemUnlocked);
}

async function writeSeedFileIfAbsent(path: string, content: string): Promise<void> {
  try {
    await zenfs.promises.stat(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await zenfs.promises.writeFile(path, content, "utf8");
  }
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function migrateSeedFileIfUnchanged(path: string, content: string): Promise<void> {
  let current: string;
  try {
    current = await zenfs.promises.readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await zenfs.promises.writeFile(path, content, "utf8");
    return;
  }
  if (current === content) return;
  if (LEGACY_AGENT_SKILL_SHA256.has(await sha256(current))) {
    await zenfs.promises.writeFile(path, content, "utf8");
  }
}

async function configureMemory(): Promise<void> {
  await configureSingle({ backend: InMemory, label: "webmcp-computer-memory" });
}

export const CLOUD_MOUNT_TIMEOUT_MS = 8_000;

async function withDeadline<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`webmcp-computer: cloud filesystem mount timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function selectFileSystemBackend(
  mountOpfs: () => Promise<void>,
  mountMemory: () => Promise<void>,
  mountCloud?: () => Promise<void>,
  onCloudUnavailable?: (error: unknown) => void,
  cloudMountTimeoutMs = CLOUD_MOUNT_TIMEOUT_MS,
): Promise<FileSystemBackend> {
  if (mountCloud) {
    try {
      await withDeadline(mountCloud, cloudMountTimeoutMs);
      return "cloud";
    } catch (error) {
      console.warn("WebMCP Computer cloud backend unavailable; using local filesystem", error);
      onCloudUnavailable?.(error);
    }
  }
  try {
    await mountOpfs();
    return "opfs";
  } catch (error) {
    console.warn("WebMCP Computer OPFS unavailable; using in-memory filesystem", error);
    await mountMemory();
    return "memory";
  }
}

async function configurePreferredBackend(): Promise<FileSystemBackend> {
  const mountWarnings: string[] = [];
  let prefersCloud = false;
  try {
    prefersCloud = hostedSessionActive();
    setCloudKernelPreference(prefersCloud);
  } catch {
    prefersCloud = cloudKernelPreference();
  }
  const backend = await selectFileSystemBackend(
    async () => {
      const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
      if (!storage || typeof storage.getDirectory !== "function") {
        throw new Error("OPFS unavailable");
      }
      const handle = await storage.getDirectory();
      const webAccess = await WebAccess.create({ handle, disableHandleCache: true });
      // @zenfs/dom 2.6.5 reconstructs every discovered OPFS inode with ID 0. ZenFS's
      // vnode cache keys by inode ID, so existing files alias each other after reload.
      assignUniqueFileSystemIds(webAccess.index.entries());
      await configureSingle(webAccess);
    },
    configureMemory,
    prefersCloud
      ? async () => {
          const cloud = await createCloudFileSystem({
            fetch: globalThis.fetch.bind(globalThis),
            workerBaseUrl: resolveComputerWorkerUrl(),
            workspaceId: ensureWorkspaceId(),
            authorization: () => hostedAuthorization("computer"),
          });
          await configureSingle(cloud);
        }
      : undefined,
    (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      mountWarnings.push(`cloud backend unavailable; using local filesystem: ${reason}`);
    },
  );
  activeBackend = backend;
  await seedFileSystem();
  const check = await checkFileSystem();
  useKernelStore.getState().setFileSystemCheck({
    repaired: check.repaired,
    warnings: [...mountWarnings, ...check.warnings],
  });
  if (check.repaired.length > 0) {
    console.warn(`WebMCP Computer filesystem repaired: ${check.repaired.join(", ")}`);
  }
  for (const warning of check.warnings) console.error(`WebMCP Computer filesystem check: ${warning}`);
  return backend;
}

function trackBoot(task: () => Promise<FileSystemBackend>): Promise<FileSystemBackend> {
  useKernelStore.getState().setFileSystemState("mounting");
  const tracked = task()
    .then((backend) => {
      activeBackend = backend;
      useKernelStore.getState().setFileSystemState("ready", backend);
      return backend;
    })
    .catch((error: unknown) => {
      activeBackend = undefined;
      const message = error instanceof Error ? error.message : String(error);
      useKernelStore.getState().setFileSystemState("failed", undefined, message);
      throw error;
    });
  ready = tracked;
  return tracked;
}

function ensureReady(): void {
  if (
    activeBackend === undefined ||
    useKernelStore.getState().fileSystemStatus !== "ready"
  ) {
    throw new Error("webmcp-computer: filesystem not ready");
  }
}

export function bootFileSystem(): Promise<FileSystemBackend> {
  const init = (
    globalThis as typeof globalThis & {
      __WEBMCP_COMPUTER_INIT__?: { bootFileSystem?: () => Promise<FileSystemBackend> };
    }
  ).__WEBMCP_COMPUTER_INIT__;
  return ready ?? trackBoot(init?.bootFileSystem ?? configurePreferredBackend);
}

export function initializeMemoryFileSystem(): Promise<FileSystemBackend> {
  mutationChains.clear();
  activeBackend = undefined;
  return trackBoot(async () => {
    await configureMemory();
    activeBackend = "memory";
    await seedFileSystem();
    const check = await checkFileSystem();
    useKernelStore.getState().setFileSystemCheck(check);
    return "memory";
  });
}

export function fileSystemBackend(): FileSystemBackend | undefined {
  return activeBackend;
}

export function normalizePath(path: string): string {
  if (typeof path !== "string" || (path !== "~" && !path.startsWith("~/"))) {
    throw new Error(`webmcp-computer: path must start with ~/: ${String(path)}`);
  }
  if (path.includes("\0")) throw new Error(`webmcp-computer: invalid path: ${path}`);

  const normalized: string[] = [];
  for (const segment of path.slice(path === "~" ? 1 : 2).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) throw new Error(`webmcp-computer: path escapes home: ${path}`);
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length === 0 ? "~" : `~/${normalized.join("/")}`;
}

export function joinPath(directory: string, name: string): string {
  const parent = normalizePath(directory);
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`webmcp-computer: invalid file name: ${name}`);
  }
  return normalizePath(`${parent}/${name}`);
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "~") return "~";
  const slash = normalized.lastIndexOf("/");
  return slash <= 1 ? "~" : normalized.slice(0, slash);
}

export function isTextFile(path: string): boolean {
  return /\.(?:css|csv|html?|js|json|jsx|log|md|mjs|sh|svg|text|toml|ts|tsx|txt|xml|yaml|yml)$/i.test(path);
}

export async function readFile(path: string): Promise<string> {
  ensureReady();
  const normalized = normalizePath(path);
  try {
    const result = await zenfs.promises.stat(realPath(normalized));
    if (result.isDirectory()) throw new Error(`webmcp-computer: is a directory: ${normalized}`);
    return await zenfs.promises.readFile(realPath(normalized), "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
    throw fsError(error, normalized);
  }
}

export async function readFilePrefix(path: string, maxBytes: number): Promise<string> {
  ensureReady();
  const normalized = normalizePath(path);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("webmcp-computer: maxBytes must be a positive integer");
  }
  try {
    const result = await zenfs.promises.stat(realPath(normalized));
    if (result.isDirectory()) throw new Error(`webmcp-computer: is a directory: ${normalized}`);
    const length = Math.min(result.size, maxBytes);
    const buffer = new Uint8Array(length);
    const handle = await zenfs.promises.open(realPath(normalized), "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return new TextDecoder().decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
    throw fsError(error, normalized);
  }
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  ensureReady();
  const normalized = normalizePath(path);
  try {
    const result = await zenfs.promises.stat(realPath(normalized));
    if (result.isDirectory()) throw new Error(`webmcp-computer: is a directory: ${normalized}`);
    return Uint8Array.from(await zenfs.promises.readFile(realPath(normalized)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
    throw fsError(error, normalized);
  }
}

async function assertWritableFileTarget(path: string): Promise<void> {
  try {
    const target = await zenfs.promises.stat(realPath(path));
    if (target.isDirectory()) throw new Error(`webmcp-computer: is a directory: ${path}`);
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
    if (!isMissing(error)) throw fsError(error, path);
  }

  await assertDirectoryParent(path);
}

function temporaryWritePath(path: string): string {
  const parent = realPath(parentPath(path));
  const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${++fsckTempId}`;
  return `${parent === "/" ? "" : parent}/.webmcp-computer-write-${token}`;
}

async function replaceFileAtomically(
  normalized: string,
  content: string | Uint8Array,
  admission: MachineMutationAdmission,
): Promise<void> {
  await assertWritableFileTarget(normalized);
  assertMachineMutationAdmission(admission);
  const target = realPath(normalized);
  const temporary = temporaryWritePath(normalized);
  try {
    const empty = typeof content === "string" ? content.length === 0 : content.byteLength === 0;
    if (empty) {
      // @zenfs/dom does not create an OPFS handle for a zero-byte write. Materialize
      // the temp file first, then truncate it before the atomic replacement.
      await zenfs.promises.writeFile(temporary, Uint8Array.of(0));
      await zenfs.promises.truncate(temporary, 0);
    } else {
      await zenfs.promises.writeFile(temporary, content, typeof content === "string" ? "utf8" : undefined);
    }
    assertMachineMutationAdmission(admission);
    await zenfs.promises.rename(temporary, target);
  } catch (error) {
    try {
      await zenfs.promises.rm(temporary, { force: true });
    } catch {
      // Best-effort cleanup; original failure remains authoritative.
    }
    throw error;
  }
}

async function assertDirectoryParent(path: string): Promise<void> {
  const parent = parentPath(path);
  try {
    const targetParent = await zenfs.promises.stat(realPath(parent));
    if (!targetParent.isDirectory()) throw new Error(`webmcp-computer: not a directory: ${parent}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
    if (isMissing(error)) throw new Error(`webmcp-computer: no such directory: ${parent}`);
    throw fsError(error, parent);
  }
}

async function writeFileUnlocked(
  normalized: string,
  content: string,
  admission: MachineMutationAdmission,
): Promise<void> {
  try {
    await replaceFileAtomically(normalized, content, admission);
    emitChange({ operation: "write", path: normalized, source: admission.source });
  } catch (error) {
    throw fsError(error, normalized);
  }
}

export async function writeFile(
  path: string,
  content: string,
  source: FileSystemMutationAdmission,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  await serializeMutation(
    [normalized],
    admission,
    () => writeFileUnlocked(normalized, content, admission),
  );
}

export async function createFile(
  path: string,
  content: string,
  source: FileSystemMutationAdmission,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  await serializeMutation([normalized], admission, async () => {
    try {
      await zenfs.promises.stat(realPath(normalized));
    } catch (error) {
      if (!isMissing(error)) throw fsError(error, normalized);
      await writeFileUnlocked(normalized, content, admission);
      return;
    }
    throw new FileSystemError(`webmcp-computer: file exists: ${normalized}`, "EEXIST");
  });
}

export async function writeFileBytes(
  path: string,
  content: Uint8Array,
  source: FileSystemMutationAdmission,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  await serializeMutation([normalized], admission, async () => {
    try {
      await replaceFileAtomically(normalized, content, admission);
      emitChange({ operation: "write", path: normalized, source: admission.source });
    } catch (error) {
      throw fsError(error, normalized);
    }
  });
}

export async function touchFile(
  path: string,
  source: FileSystemMutationAdmission,
  modifiedAt = new Date(),
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  await serializeMutation([normalized], admission, async () => {
    let target;
    try {
      target = await zenfs.promises.stat(realPath(normalized));
    } catch (error) {
      if (!isMissing(error)) throw fsError(error, normalized);
      await writeFileUnlocked(normalized, "", admission);
      return;
    }
    if (target.isDirectory()) throw new Error(`webmcp-computer: is a directory: ${normalized}`);
    try {
      assertMachineMutationAdmission(admission);
      await zenfs.promises.utimes(realPath(normalized), modifiedAt, modifiedAt);
      emitChange({ operation: "write", path: normalized, source: admission.source });
    } catch (error) {
      throw fsError(error, normalized);
    }
  });
}

export async function updateFile(
  path: string,
  update: (current: string) => string | Promise<string>,
  source: FileSystemMutationAdmission,
  createIfMissing = false,
): Promise<string> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  return serializeMutation([normalized], admission, async () => {
    let current: string;
    try {
      current = await readFile(normalized);
    } catch (error) {
      if (!createIfMissing || !isMissing(error)) throw error;
      current = "";
    }
    const next = await update(current);
    await writeFileUnlocked(normalized, next, admission);
    return next;
  });
}

export async function whenPathIdle(path: string): Promise<void> {
  const normalized = normalizePath(path);
  while (true) {
    const current = mutationChains.get(normalized);
    if (!current) return;
    await current;
    if (mutationChains.get(normalized) === current) return;
  }
}

export async function ls(path: string): Promise<FileEntry[]> {
  ensureReady();
  const normalized = normalizePath(path);
  try {
    const names = await zenfs.promises.readdir(realPath(normalized));
    const entries = await Promise.all(
      names
        .filter((name): name is string => typeof name === "string" && !name.startsWith(".webmcp-computer-"))
        .map(async (name) => {
          const childPath = joinPath(normalized, name);
          const childStat = await zenfs.promises.stat(realPath(childPath));
          return {
            name,
            path: childPath,
            kind: childStat.isDirectory() ? "directory" : "file",
            size: childStat.size,
            modifiedAt: childStat.mtimeMs,
          } satisfies FileEntry;
        }),
    );
    return entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  } catch (error) {
    if (isMissing(error)) {
      throw new FileSystemError(`webmcp-computer: no such directory: ${normalized}`, "ENOENT");
    }
    throw fsError(error, normalized);
  }
}

export async function mkdir(
  path: string,
  source: FileSystemMutationAdmission,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  await serializeMutation([normalized], admission, async () => {
    try {
      const target = await zenfs.promises.stat(realPath(normalized));
      if (!target.isDirectory()) throw new Error(`webmcp-computer: is a file: ${normalized}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("webmcp-computer:")) throw error;
      if (!isMissing(error)) throw fsError(error, normalized);
      await assertDirectoryParent(normalized);
      try {
        assertMachineMutationAdmission(admission);
        await zenfs.promises.mkdir(realPath(normalized));
        emitChange({ operation: "mkdir", path: normalized, source: admission.source });
        return;
      } catch (mkdirError) {
        throw fsError(mkdirError, normalized);
      }
    }
    throw new Error(`webmcp-computer: file exists: ${normalized}`);
  });
}

export async function rm(
  path: string,
  source: FileSystemMutationAdmission,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalized = normalizePath(path);
  if (normalized === "~") throw new Error("webmcp-computer: cannot delete home directory: ~");
  await serializeMutation([normalized], admission, async () => {
    try {
      assertMachineMutationAdmission(admission);
      await zenfs.promises.rm(realPath(normalized), { recursive: true });
      emitChange({ operation: "delete", path: normalized, source: admission.source });
    } catch (error) {
      throw fsError(error, normalized);
    }
  });
}

export async function mv(
  from: string,
  to: string,
  source: FileSystemMutationAdmission,
  overwrite = false,
): Promise<void> {
  const admission = mutationAdmission(source);
  ensureReady();
  const normalizedFrom = normalizePath(from);
  const normalizedTo = normalizePath(to);
  if (normalizedFrom === "~") throw new Error("webmcp-computer: cannot move home directory: ~");
  if (normalizedTo === normalizedFrom || normalizedTo.startsWith(`${normalizedFrom}/`)) {
    throw new Error(`webmcp-computer: cannot move ${normalizedFrom} into itself: ${normalizedTo}`);
  }
  await serializeMutation([normalizedFrom, normalizedTo], admission, async () => {
    try {
      await zenfs.promises.stat(realPath(normalizedFrom));
    } catch (error) {
      throw fsError(error, normalizedFrom);
    }
    let destinationExists = false;
    try {
      await zenfs.promises.stat(realPath(normalizedTo));
      destinationExists = true;
    } catch (error) {
      if (!isMissing(error)) throw fsError(error, normalizedTo);
    }
    if (destinationExists && !overwrite) {
      throw new Error(`webmcp-computer: destination exists: ${normalizedTo}`);
    }
    await assertDirectoryParent(normalizedTo);
    try {
      assertMachineMutationAdmission(admission);
      await zenfs.promises.rename(realPath(normalizedFrom), realPath(normalizedTo));
      emitChange({
        operation: "move",
        path: normalizedTo,
        from: normalizedFrom,
        source: admission.source,
      });
    } catch (error) {
      throw fsError(error, normalizedTo);
    }
  });
}

export async function stat(path: string): Promise<FileStat> {
  ensureReady();
  const normalized = normalizePath(path);
  try {
    const result = await zenfs.promises.stat(realPath(normalized));
    return {
      path: normalized,
      kind: result.isDirectory() ? "directory" : "file",
      size: result.size,
      modifiedAt: result.mtimeMs,
    };
  } catch (error) {
    throw fsError(error, normalized);
  }
}

export async function exists(path: string): Promise<boolean> {
  ensureReady();
  const normalized = normalizePath(path);
  try {
    await zenfs.promises.stat(realPath(normalized));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw fsError(error, normalized);
  }
}

export function watch(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
