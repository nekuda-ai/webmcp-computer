export type PreviewConsoleLevel = "log" | "info" | "warn" | "error";

export type PreviewConsoleLine = {
  level: PreviewConsoleLevel;
  message: string;
  ts: number;
};

type PreviewRuntime = {
  root: string;
  url: string;
  lines: PreviewConsoleLine[];
  dropped: number;
  reload: () => Promise<void>;
  onConsole: (lines: readonly PreviewConsoleLine[]) => void;
  cancelFlush: (() => void) | undefined;
};

const MAX_CONSOLE_LINES = 200;
const runtimes = new Map<number, PreviewRuntime>();

export function previewUrl(root: string): string {
  const name = root === "~" ? "home" : root.split("/").at(-1) ?? "site";
  return `webmcp-computer://${name}/`;
}

export function mountPreviewRuntime(
  pid: number,
  root: string,
  reload: () => Promise<void>,
  onConsole: (lines: readonly PreviewConsoleLine[]) => void,
): () => void {
  const runtime: PreviewRuntime = {
    root,
    url: previewUrl(root),
    lines: [],
    dropped: 0,
    reload,
    onConsole,
    cancelFlush: undefined,
  };
  runtimes.set(pid, runtime);
  return () => {
    if (runtimes.get(pid) !== runtime) return;
    runtime.cancelFlush?.();
    runtimes.delete(pid);
  };
}

export function updatePreviewRuntime(
  pid: number,
  root: string,
  reload: () => Promise<void>,
  onConsole: (lines: readonly PreviewConsoleLine[]) => void,
): void {
  const runtime = runtimes.get(pid);
  if (!runtime) return;
  runtime.root = root;
  runtime.url = previewUrl(root);
  runtime.reload = reload;
  runtime.onConsole = onConsole;
}

function scheduleConsoleFlush(pid: number, runtime: PreviewRuntime): void {
  if (runtime.cancelFlush) return;
  let cancelled = false;
  const flush = () => {
    runtime.cancelFlush = undefined;
    if (cancelled || runtimes.get(pid) !== runtime) return;
    runtime.onConsole([...runtime.lines]);
  };
  if (typeof globalThis.requestAnimationFrame === "function") {
    const frame = globalThis.requestAnimationFrame(flush);
    runtime.cancelFlush = () => {
      cancelled = true;
      globalThis.cancelAnimationFrame(frame);
    };
    return;
  }
  queueMicrotask(flush);
  runtime.cancelFlush = () => {
    cancelled = true;
  };
}

export function recordPreviewConsole(
  pid: number,
  level: PreviewConsoleLevel,
  message: string,
): PreviewConsoleLine | undefined {
  const runtime = runtimes.get(pid);
  if (!runtime) return undefined;
  const line = {
    level,
    message: truncatePreviewConsoleMessage(message),
    ts: Date.now(),
  } satisfies PreviewConsoleLine;
  runtime.lines.push(line);
  const overflow = runtime.lines.length - MAX_CONSOLE_LINES;
  if (overflow > 0) {
    runtime.lines.splice(0, overflow);
    runtime.dropped += overflow;
  }
  scheduleConsoleFlush(pid, runtime);
  return line;
}

export function recordPreviewWarnings(pid: number, warnings: readonly string[]): void {
  for (const warning of warnings) recordPreviewConsole(pid, "warn", warning);
}

export function dropPreviewConsoleLines(pid: number, count = 1): void {
  const runtime = runtimes.get(pid);
  if (!runtime || count <= 0) return;
  runtime.dropped += count;
}

export function getPreviewRuntime(pid: number): PreviewRuntime {
  const runtime = runtimes.get(pid);
  if (!runtime) throw new Error(`webmcp-computer: preview PID ${pid} is not ready`);
  return runtime;
}
import { truncatePreviewConsoleMessage } from "./consoleMessage";
