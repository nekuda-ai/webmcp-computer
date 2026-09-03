import { defineTool } from "@nekuda/webmcp-sdk";
import { ls, normalizePath, readFile, stat, type FileEntry, type FileStat } from "../kernel/fs";
import { ensureWorkspaceId, resolveComputerWorkerUrl } from "../kernel/cloudFs";
import { runAgentAction } from "./agentAction";
import { TRANSACT_ANNOTATIONS } from "./taxonomy";
import { PUBLISH_QUOTA_LIMIT } from "../../../shared/session-limits";
import { PUBLISHED_SITE_RETENTION_DAYS } from "../../../workers/computer/src/protocol";
import { hostedAuthorization } from "../kernel/hostedSession";

export const MAX_PUBLISH_FILES = 64;
export const MAX_PUBLISH_FILE_BYTES = 256 * 1_024;
export const MAX_PUBLISH_TOTAL_BYTES = 2 * 1_024 * 1_024;

const PUBLISH_EXTENSION = /\.(?:html?|css|js|json|svg|txt|md)$/i;
const encoder = new TextEncoder();

type OsPublishInput = { path?: string };
type PublishFile = { path: string; content: string };

export type OsPublishResult = {
  url: string;
  expiresInDays: number;
  files: number;
  bytes: number;
};

export type OsPublishFileSystem = {
  stat(path: string): Promise<FileStat>;
  ls(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
};

export type OsPublishDependencies = {
  fileSystem: OsPublishFileSystem;
  fetch: typeof fetch;
  workerBaseUrl: string;
  workspaceId: string;
  authorization?: () => Promise<{ Authorization: string }>;
};

const defaultFileSystem: OsPublishFileSystem = { stat, ls, readFile };

function defaultDependencies(): OsPublishDependencies {
  return {
    fileSystem: defaultFileSystem,
    fetch: globalThis.fetch.bind(globalThis),
    workerBaseUrl: resolveComputerWorkerUrl(),
    workspaceId: ensureWorkspaceId(),
    authorization: () => hostedAuthorization("computer"),
  };
}

function relativePath(root: string, path: string): string {
  return path.slice(root === "~" ? 2 : root.length + 1);
}

export async function collectPublishFiles(
  inputPath: string | undefined,
  fileSystem: OsPublishFileSystem,
): Promise<{ root: string; files: PublishFile[]; bytes: number }> {
  const root = normalizePath(inputPath ?? "~/site");
  const rootStat = await fileSystem.stat(root);
  if (rootStat.kind !== "directory") throw new Error(`webmcp-computer: publish path is not a directory: ${root}`);

  const files: PublishFile[] = [];
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fileSystem.ls(directory)) {
      if (entry.kind === "directory") {
        await visit(entry.path);
        continue;
      }
      const relative = relativePath(root, entry.path);
      if (!PUBLISH_EXTENSION.test(entry.name)) {
        throw new Error(`webmcp-computer: os_publish rejects non-text file: ${entry.path}`);
      }
      if (files.length >= MAX_PUBLISH_FILES) {
        throw new Error(`webmcp-computer: os_publish exceeds ${MAX_PUBLISH_FILES}-file cap`);
      }
      const content = await fileSystem.readFile(entry.path);
      const fileBytes = encoder.encode(content).byteLength;
      if (fileBytes > MAX_PUBLISH_FILE_BYTES) {
        throw new Error(`webmcp-computer: os_publish file exceeds 256 KB: ${entry.path}`);
      }
      bytes += fileBytes;
      if (bytes > MAX_PUBLISH_TOTAL_BYTES) {
        throw new Error("webmcp-computer: os_publish exceeds 2 MB total cap");
      }
      files.push({ path: relative, content });
    }
  };
  await visit(root);
  if (files.length === 0) throw new Error(`webmcp-computer: os_publish found no text files: ${root}`);
  return { root, files, bytes };
}

function requirePublishedUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("webmcp-computer: computer Worker returned an invalid publish URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("webmcp-computer: computer Worker returned an invalid publish URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("webmcp-computer: computer Worker returned an invalid publish URL");
  }
  return parsed.href;
}

function requirePublishedRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("webmcp-computer: computer Worker returned an invalid publish expiry");
  }
  return value;
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^webmcp-computer:\s*/, "");
}

function retryDelay(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} minutes`}`;
}

function publishFailure(payload: unknown, status: number): string {
  const failure = payload !== null && typeof payload === "object"
    ? payload as { error?: unknown; code?: unknown; retryAfterMs?: unknown }
    : undefined;
  if (failure?.code === "EPUBLISHQUOTA") {
    const explanation =
      `publishing limit reached for this machine (${PUBLISH_QUOTA_LIMIT} successful publishes per 24-hour accounting window)`;
    return typeof failure.retryAfterMs === "number" && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0
      ? `${explanation}; try again in ${retryDelay(failure.retryAfterMs)}`
      : `${explanation}; try again after the accounting window resets`;
  }
  return typeof failure?.error === "string" ? failure.error : `Worker returned ${status}`;
}

export function createOsPublishTool(
  dependencies?: OsPublishDependencies,
) {
  return defineTool<OsPublishInput>({
    stableKey: "webmcp_computer.os_publish",
    name: "os_publish",
    title: "Publish site",
    description:
      `Publish a text-only directory to a public internet URL and show that URL with a QR code. Published files are public and deleted after ${PUBLISHED_SITE_RETENTION_DAYS} days. Anonymous machines may successfully publish ${PUBLISH_QUOTA_LIMIT} times per 24-hour accounting window. path defaults to ~/site and must be a directory. Allows html, css, js, json, svg, txt, and md; maximum 64 files, 256 KB each, 2 MB total. This is consequential because anyone with the returned URL can read the uploaded content.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to publish; defaults to ~/site." },
      },
      additionalProperties: false,
    },
    annotations: TRANSACT_ANNOTATIONS,
    intent: "transact",
    execute(input) {
      const path = input?.path;
      return runAgentAction("os_publish", { path: path ?? "~/site" }, async () => {
        // Resolve defaults at invocation time so a bad optional override becomes a
        // traced tool failure instead of breaking boot while tools register.
        const runtime = dependencies ?? defaultDependencies();
        const collected = await collectPublishFiles(path, runtime.fileSystem);
        let response: Response;
        try {
          const authorization = await runtime.authorization?.() ?? {};
          response = await runtime.fetch(
            `${runtime.workerBaseUrl}/ws/${runtime.workspaceId}/publish`,
            {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authorization },
            body: JSON.stringify({ files: collected.files }),
            },
          );
        } catch (error) {
          throw new Error(`webmcp-computer: site publish failed: ${reason(error)}`);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        if (!response.ok) {
          throw new Error(`webmcp-computer: site publish failed: ${publishFailure(payload, response.status)}`);
        }
        const url = requirePublishedUrl(
          payload && typeof payload === "object" ? (payload as { url?: unknown }).url : undefined,
        );
        const expiresInDays = requirePublishedRetentionDays(
          payload && typeof payload === "object"
            ? (payload as { expiresInDays?: unknown }).expiresInDays
            : undefined,
        );
        return { url, expiresInDays, files: collected.files.length, bytes: collected.bytes };
      }, {
        resultArgs: (result) => ({
          url: result.url,
          expiresInDays: result.expiresInDays,
          files: result.files,
          bytes: result.bytes,
        }),
      });
    },
  });
}

export const osPublishTool = createOsPublishTool();
