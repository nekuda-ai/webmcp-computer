import {
  ensureWorkspaceId,
  resolveComputerWorkerUrl,
} from "./cloudFs";
import { hostedAuthorization } from "./hostedSession";
import { describeLimitError, limitErrorFromPayload } from "./activity";

export type CloudExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type CloudExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  pushed: number;
  pulled: number;
  applied: number;
  syncStatus: "complete" | "pending";
  truncated: boolean;
};

export type CloudExecDependencies = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  workerBaseUrl: string;
  workspaceId: string;
  authorization?: () => Promise<{ Authorization: string }>;
};

export type CloudExecRunOptions = {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type ExitEvent = {
  code: number;
  pushed: number;
  pulled: number;
  applied: number;
  syncStatus: "complete" | "pending";
};

export type CloudOutputBuffer = {
  chunks: string[];
  bytes: number;
  truncated: boolean;
};

const MAX_OUTPUT_BYTES = 256 * 1_024;
const outputEncoder = new TextEncoder();
const outputDecoder = new TextDecoder();

export function createCloudOutputBuffer(): CloudOutputBuffer {
  return { chunks: [], bytes: 0, truncated: false };
}

export function appendCloudOutput(buffer: CloudOutputBuffer, chunk: string): void {
  if (buffer.truncated || chunk === "") return;
  const bytes = outputEncoder.encode(chunk);
  const remaining = MAX_OUTPUT_BYTES - buffer.bytes;
  if (bytes.byteLength <= remaining) {
    buffer.chunks.push(chunk);
    buffer.bytes += bytes.byteLength;
    return;
  }
  if (remaining > 0) buffer.chunks.push(outputDecoder.decode(bytes.slice(0, remaining)));
  buffer.bytes = MAX_OUTPUT_BYTES;
  buffer.truncated = true;
}

export function cloudOutputText(buffer: CloudOutputBuffer): string {
  return buffer.chunks.join("");
}

export function defaultCloudExecDependencies(): CloudExecDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    workerBaseUrl: resolveComputerWorkerUrl(),
    workspaceId: ensureWorkspaceId(),
    authorization: () => hostedAuthorization("computer"),
  };
}

export function cloudCwdFromHome(cwd: string): string {
  if (cwd === "~") return "/workspace";
  if (cwd.startsWith("~/")) return `/workspace/${cwd.slice(2)}`;
  throw new Error("webmcp-computer: cloud can only run inside the home directory");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-+=:,./@%]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function failure(reason: string): Error {
  const detail = reason.replace(/[\r\n]+/g, " ").trim() || "unknown error";
  return new Error(`webmcp-computer: cloud exec failed: ${detail}`);
}

function requireExit(value: unknown): ExitEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure("computer Worker returned an invalid exit event");
  }
  const event = value as Partial<ExitEvent>;
  if (
    !Number.isInteger(event.code) || !Number.isInteger(event.pushed) ||
    !Number.isInteger(event.pulled) || !Number.isInteger(event.applied) ||
    (event.syncStatus !== "complete" && event.syncStatus !== "pending")
  ) {
    throw failure("computer Worker returned an invalid exit event");
  }
  return event as ExitEvent;
}

function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function parseFrame(frame: string): { event: string; data: unknown } | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    throw failure(`computer Worker returned invalid ${event} data`);
  }
}

/** Worker limit bodies (`{ error, code, retryAfterMs }`) become explanations a human can act on. */
function workerError(payload: unknown, fallback: string): Error {
  const limit = limitErrorFromPayload(payload);
  if (limit) return failure(describeLimitError(limit, "cloud"));
  const reason = payload !== null && typeof payload === "object"
    ? (payload as { error?: unknown }).error
    : undefined;
  return failure(typeof reason === "string" ? reason : fallback);
}

async function responseError(response: Response): Promise<Error> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return workerError(payload, `computer Worker returned ${response.status}`);
}

export async function executeCloudCommand(
  request: CloudExecRequest,
  dependencies: CloudExecDependencies = defaultCloudExecDependencies(),
  options: CloudExecRunOptions = {},
): Promise<CloudExecResult> {
  let response: Response;
  try {
    const authorization = await dependencies.authorization?.() ?? {};
    response = await dependencies.fetch(
      `${dependencies.workerBaseUrl.replace(/\/$/, "")}/ws/${dependencies.workspaceId}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify(request),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer: cloud exec failed:")) throw error;
    throw failure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw failure("computer Worker returned no event stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stdout = createCloudOutputBuffer();
  const stderr = createCloudOutputBuffer();
  let exit: ExitEvent | undefined;

  const consume = (frameText: string) => {
    const frame = parseFrame(frameText);
    if (!frame) return;
    if (frame.event === "stdout" || frame.event === "stderr") {
      if (typeof frame.data !== "string") throw failure(`computer Worker returned invalid ${frame.event} data`);
      if (frame.event === "stdout") {
        appendCloudOutput(stdout, frame.data);
        options.onStdout?.(frame.data);
      } else {
        appendCloudOutput(stderr, frame.data);
        options.onStderr?.(frame.data);
      }
      return;
    }
    if (frame.event === "notice") {
      const message = frame.data !== null && typeof frame.data === "object" &&
          typeof (frame.data as { message?: unknown }).message === "string"
        ? (frame.data as { message: string }).message
        : "webmcp-computer: cloud exec notice";
      const line = `${message}\n`;
      appendCloudOutput(stderr, line);
      options.onStderr?.(line);
      return;
    }
    if (frame.event === "exit") {
      exit = requireExit(frame.data);
      return;
    }
    if (frame.event === "error") {
      throw workerError(frame.data, "computer Worker reported an unknown error");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = frameBoundary(buffer);
      while (boundary) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = frameBoundary(buffer);
      }
      if (done) break;
    }
    if (buffer.trim() !== "") consume(buffer);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("webmcp-computer: cloud exec failed:")) throw error;
    throw failure(error instanceof Error ? error.message : String(error));
  } finally {
    reader.releaseLock();
  }

  if (!exit) throw failure("computer Worker event stream ended without exit");
  return {
    exitCode: exit.code,
    stdout: cloudOutputText(stdout),
    stderr: cloudOutputText(stderr),
    pushed: exit.pushed,
    pulled: exit.pulled,
    applied: exit.applied,
    syncStatus: exit.syncStatus,
    truncated: stdout.truncated || stderr.truncated,
  };
}
