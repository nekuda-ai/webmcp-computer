import { CdpClient, waitForWebSocketOpen, type BrowserWebSocket } from "./cdp";
import { resolveWorkerUrl } from "../../shared/workerUrl";
import {
  hostedAuthorization,
  hostedSessionSnapshot,
  hostedWorkerUrl,
} from "../../kernel/hostedSession";

export const BROWSER_HOME_URL = "https://webmcp.com/";

export type BrowserSessionDescriptor = {
  sessionId: string;
  liveViewUrl: string;
  tabWsUrl: string;
  targetId: string;
  keepAliveMs: number;
};

export type BrowserSessionState =
  | { status: "connecting" }
  | {
      status: "live";
      liveViewUrl: string;
      sessionId: string;
      targetId: string;
      keepAliveMs: number;
    }
  | { status: "ended"; reason: string };

export type BrowserSessionDependencies = {
  fetch: typeof fetch;
  createWebSocket(url: string): BrowserWebSocket;
  workerBaseUrl: string;
  authorization?: () => Promise<{ Authorization: string }>;
  commandTimeoutMs?: number;
};

export type BrowserSession = {
  readonly cdp: CdpClient;
  readonly keepAliveMs: number;
  readonly sessionId: string;
  readonly state: BrowserSessionState;
  close(options?: { keepalive?: boolean; reason?: string }): Promise<void>;
  setViewport(width: number, height: number): () => void;
  subscribe(listener: (state: BrowserSessionState) => void): () => void;
};

export type BrowserWorkerResolutionOptions = {
  search?: string;
  storage?: Pick<Storage, "getItem">;
  envUrl?: string;
  defaultUrl?: string;
  production?: boolean;
};

type WorkerErrorBody = { error?: unknown };

const VIEWPORT_DEBOUNCE_MS = 300;

// The live viewer draws its own URL bar inside our iframe, so its screencast
// canvas is shorter than the container; match the canvas aspect or the stream
// letterboxes with side margins (verified against live.browser.run).
const VIEWER_CHROME_PX = 56;

export function viewportForContainer(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  const canvasHeight = height - VIEWER_CHROME_PX;
  if (canvasHeight < 1) return undefined;
  return { width, height: canvasHeight };
}
const MAX_VIEWPORT_DIMENSION = 2_048;

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function requireHttpUrl(value: unknown, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(error);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(error);
  }
  return parsed.href;
}

function viewportDimension(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_VIEWPORT_DIMENSION, Math.round(value));
}

export function resolveBrowserWorkerUrl(
  options: BrowserWorkerResolutionOptions = {},
): string {
  if (hostedSessionSnapshot().status === "active") return hostedWorkerUrl("browser");
  return resolveWorkerUrl({
    queryKey: "browser_worker",
    storageKey: "webmcp_computer.browser_worker",
    label: "browser",
    ...(options.defaultUrl === undefined ? {} : { defaultUrl: options.defaultUrl }),
    envUrl: options.envUrl ?? import.meta.env.VITE_BROWSER_WORKER_URL,
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.production === undefined ? {} : { production: options.production }),
  });
}

function defaultDependencies(): BrowserSessionDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    createWebSocket: (url) => new WebSocket(url),
    workerBaseUrl: resolveBrowserWorkerUrl(),
    authorization: () => hostedAuthorization("browser"),
  };
}

function validateDescriptor(value: unknown): BrowserSessionDescriptor {
  if (value === null || typeof value !== "object") {
    throw new Error("browser Worker returned an invalid session");
  }
  const descriptor = value as Partial<BrowserSessionDescriptor>;
  if (
    typeof descriptor.sessionId !== "string" ||
    typeof descriptor.liveViewUrl !== "string" ||
    typeof descriptor.tabWsUrl !== "string" ||
    typeof descriptor.targetId !== "string" ||
    typeof descriptor.keepAliveMs !== "number"
  ) {
    throw new Error("browser Worker returned an invalid session");
  }
  return {
    ...(descriptor as BrowserSessionDescriptor),
    liveViewUrl: requireHttpUrl(
      descriptor.liveViewUrl,
      "webmcp-computer: browser Worker returned an invalid live view URL",
    ),
  };
}

async function workerRequest(
  dependencies: BrowserSessionDependencies,
  path: string,
  init: RequestInit,
): Promise<BrowserSessionDescriptor> {
  const headers = new Headers(init.headers);
  if (dependencies.authorization) {
    const authorization = await dependencies.authorization();
    headers.set("Authorization", authorization.Authorization);
  }
  const response = await dependencies.fetch(`${dependencies.workerBaseUrl}${path}`, { ...init, headers });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const reason = payload && typeof payload === "object"
      ? (payload as WorkerErrorBody).error
      : undefined;
    throw new Error(typeof reason === "string" ? reason : `Worker returned ${response.status}`);
  }
  return validateDescriptor(payload);
}

class BrowserSessionImpl implements BrowserSession {
  readonly #dependencies: BrowserSessionDependencies;
  readonly #listeners = new Set<(state: BrowserSessionState) => void>();
  #descriptor: BrowserSessionDescriptor;
  #state: BrowserSessionState = { status: "connecting" };
  #cdp: CdpClient | undefined;
  #generation = 0;
  #refreshAttempted = false;
  #recovering = false;
  #closed = false;
  #viewportTimeout: ReturnType<typeof setTimeout> | undefined;
  #lastViewport: string | undefined;
  #viewportWarned = false;

  constructor(descriptor: BrowserSessionDescriptor, dependencies: BrowserSessionDependencies) {
    this.#descriptor = descriptor;
    this.#dependencies = dependencies;
  }

  get cdp(): CdpClient {
    if (!this.#cdp || this.#state.status !== "live") {
      throw new Error("webmcp-computer: browser session is not live");
    }
    return this.#cdp;
  }

  get keepAliveMs(): number {
    return this.#descriptor.keepAliveMs;
  }

  get sessionId(): string {
    return this.#descriptor.sessionId;
  }

  get state(): BrowserSessionState {
    return this.#state;
  }

  subscribe(listener: (state: BrowserSessionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setViewport(width: number, height: number): () => void {
    if (this.#state.status !== "live" || this.#closed) return () => undefined;
    const viewportWidth = viewportDimension(width);
    const viewportHeight = viewportDimension(height);
    if (viewportWidth === undefined || viewportHeight === undefined) return () => undefined;

    this.#cancelViewportResize();
    const viewport = `${viewportWidth}x${viewportHeight}`;
    if (viewport === this.#lastViewport) return () => undefined;
    const timeout = setTimeout(() => {
      this.#viewportTimeout = undefined;
      if (this.#state.status !== "live" || this.#closed || !this.#cdp) return;
      void this.#cdp.setViewport(viewportWidth, viewportHeight).then(
        () => {
          this.#lastViewport = viewport;
        },
        (error: unknown) => {
          if (this.#viewportWarned) return;
          this.#viewportWarned = true;
          const reason = message(error).replace(/^webmcp-computer: browser command failed: /, "");
          console.warn(`WebMCP Computer browser viewport resize failed: ${reason}`);
        },
      );
    }, VIEWPORT_DEBOUNCE_MS);
    this.#viewportTimeout = timeout;
    return () => {
      if (this.#viewportTimeout === timeout) this.#cancelViewportResize();
    };
  }

  #cancelViewportResize(): void {
    if (this.#viewportTimeout === undefined) return;
    clearTimeout(this.#viewportTimeout);
    this.#viewportTimeout = undefined;
  }

  #publish(state: BrowserSessionState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  async initialize(): Promise<void> {
    await this.#connect(this.#descriptor);
  }

  async #connect(descriptor: BrowserSessionDescriptor): Promise<void> {
    const generation = ++this.#generation;
    const socket = this.#dependencies.createWebSocket(descriptor.tabWsUrl);
    await waitForWebSocketOpen(socket, this.#dependencies.commandTimeoutMs);
    if (this.#closed || generation !== this.#generation) {
      socket.close();
      return;
    }
    const cdp = new CdpClient(socket, {
      ...(this.#dependencies.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: this.#dependencies.commandTimeoutMs }),
      onConnectionState: (state, reason) => {
        if (state === "open" || generation !== this.#generation || this.#closed) return;
        void this.#recover(reason ?? "browser connection ended");
      },
    });
    this.#cdp = cdp;
    this.#lastViewport = undefined;
    this.#viewportWarned = false;
    const liveView = await cdp.send<{ devtoolsFrontendUrl?: unknown }>(
      "Cloudflare.getLiveView",
      { mode: "tab", expiresInMs: 3_600_000 },
    );
    const liveViewUrl = requireHttpUrl(
      liveView.devtoolsFrontendUrl,
      "webmcp-computer: browser service returned an invalid live view",
    );
    this.#descriptor = descriptor;
    this.#publish({
      status: "live",
      liveViewUrl,
      sessionId: descriptor.sessionId,
      targetId: descriptor.targetId,
      keepAliveMs: descriptor.keepAliveMs,
    });
  }

  async #recover(reason: string): Promise<void> {
    if (this.#recovering || this.#closed || this.#state.status === "ended") return;
    if (this.#refreshAttempted) {
      this.#end(reason);
      return;
    }
    this.#refreshAttempted = true;
    this.#recovering = true;
    this.#cancelViewportResize();
    this.#publish({ status: "connecting" });
    try {
      const descriptor = await workerRequest(
        this.#dependencies,
        `/session/${encodeURIComponent(this.sessionId)}/refresh`,
        { method: "POST" },
      );
      this.#generation += 1;
      this.#cdp?.close();
      await this.#connect(descriptor);
    } catch (error) {
      this.#end(message(error));
    } finally {
      this.#recovering = false;
    }
  }

  #end(reason: string): void {
    if (this.#state.status === "ended") return;
    this.#cancelViewportResize();
    this.#generation += 1;
    this.#cdp?.close();
    this.#cdp = undefined;
    this.#publish({ status: "ended", reason });
  }

  async close(options: { keepalive?: boolean; reason?: string } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelViewportResize();
    this.#generation += 1;
    this.#cdp?.close();
    this.#cdp = undefined;
    this.#publish({ status: "ended", reason: options.reason ?? "closed" });
    try {
      const authorization = await this.#dependencies.authorization?.() ?? {};
      await this.#dependencies.fetch(
        `${this.#dependencies.workerBaseUrl}/session/${encodeURIComponent(this.sessionId)}`,
        {
          method: "DELETE",
          ...(Object.keys(authorization).length === 0 ? {} : { headers: authorization }),
          keepalive: options.keepalive ?? false,
        },
      );
    } catch {
      // Browser Run keep_alive is the cost-control backstop when best-effort close fails.
    }
  }
}

export async function createBrowserSession(
  dependencies: BrowserSessionDependencies,
  url?: string,
): Promise<BrowserSession> {
  const descriptor = await workerRequest(dependencies, "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url ?? BROWSER_HOME_URL }),
  });
  const session = new BrowserSessionImpl(descriptor, dependencies);
  try {
    await session.initialize();
    return session;
  } catch (error) {
    await session.close({ reason: message(error) });
    throw error;
  }
}

let activeSession: BrowserSession | undefined;
let pendingSession: Promise<BrowserSession> | undefined;
const RESTORED_SESSION_REASON = "session must be started again after reload";
let runtimeState: BrowserSessionState = { status: "ended", reason: RESTORED_SESSION_REASON };
let activeUnsubscribe: (() => void) | undefined;
const runtimeListeners = new Set<(state: BrowserSessionState) => void>();

function publishRuntime(state: BrowserSessionState): void {
  runtimeState = state;
  for (const listener of runtimeListeners) listener(state);
}

export function browserSessionState(): BrowserSessionState {
  return runtimeState;
}

export function subscribeBrowserSession(
  listener: (state: BrowserSessionState) => void,
): () => void {
  runtimeListeners.add(listener);
  listener(runtimeState);
  return () => runtimeListeners.delete(listener);
}

export async function ensureBrowserSession(
  url?: string,
  dependencies: BrowserSessionDependencies = defaultDependencies(),
): Promise<BrowserSession> {
  if (activeSession?.state.status === "live") return activeSession;
  if (pendingSession) return await pendingSession;
  if (activeSession) {
    const stale = activeSession;
    activeSession = undefined;
    activeUnsubscribe?.();
    activeUnsubscribe = undefined;
    await stale.close({ reason: "replaced by a new session" });
  }
  publishRuntime({ status: "connecting" });
  pendingSession = createBrowserSession(dependencies, url)
    .then((session) => {
      activeUnsubscribe?.();
      activeSession = session;
      activeUnsubscribe = session.subscribe(publishRuntime);
      return session;
    })
    .catch((error) => {
      publishRuntime({ status: "ended", reason: message(error) });
      throw error;
    })
    .finally(() => {
      pendingSession = undefined;
    });
  return await pendingSession;
}

export function getBrowserSession(): BrowserSession {
  if (!activeSession || activeSession.state.status !== "live") {
    throw new Error("webmcp-computer: browser session is not live");
  }
  return activeSession;
}

export async function closeBrowserSession(keepalive = false): Promise<void> {
  const inFlight = pendingSession;
  const session = activeSession ?? await inFlight?.catch(() => undefined);
  activeSession = undefined;
  activeUnsubscribe?.();
  activeUnsubscribe = undefined;
  publishRuntime({ status: "ended", reason: "closed" });
  if (session) await session.close({ keepalive });
}

export async function restartBrowserSession(
  url?: string,
  dependencies: BrowserSessionDependencies = defaultDependencies(),
): Promise<BrowserSession> {
  await closeBrowserSession();
  return await ensureBrowserSession(url, dependencies);
}

export function attachBrowserPageLifecycle(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const close = () => void closeBrowserSession(true);
  target.addEventListener("beforeunload", close);
  target.addEventListener("pagehide", close);
  return () => {
    target.removeEventListener("beforeunload", close);
    target.removeEventListener("pagehide", close);
  };
}

export async function resetBrowserSessionForTests(): Promise<void> {
  await closeBrowserSession();
  pendingSession = undefined;
  runtimeState = { status: "ended", reason: RESTORED_SESSION_REASON };
  runtimeListeners.clear();
}
