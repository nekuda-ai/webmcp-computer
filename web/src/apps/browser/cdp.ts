export type BrowserWebSocket = Pick<WebSocket, "addEventListener" | "close" | "readyState" | "removeEventListener" | "send">;

export type CdpConnectionState = "open" | "closed" | "error";
export type CdpEvaluateOperation =
  | "identity"
  | "read"
  | "click"
  | "type"
  | "site_tools"
  | "site_call"
  | "heartbeat";

type CdpError = {
  code?: number;
  message?: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
};

type PendingCommand = {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

export type CdpClientOptions = {
  commandTimeoutMs?: number;
  onConnectionState?: (state: CdpConnectionState, reason?: string) => void;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const EVALUATE_MARKER = /^\/\*webmcp-computer:(identity|read|click|type|site_tools|site_call|heartbeat)\*\//;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function messageData(event: Event): unknown {
  return (event as MessageEvent<unknown>).data;
}

export class CdpClient {
  readonly #socket: BrowserWebSocket;
  readonly #commandTimeoutMs: number;
  readonly #onConnectionState: CdpClientOptions["onConnectionState"];
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Map<string, Set<(params: unknown) => void>>();
  #nextId = 1;
  #settled = false;

  constructor(socket: BrowserWebSocket, options: CdpClientOptions = {}) {
    this.#socket = socket;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#onConnectionState = options.onConnectionState;
    socket.addEventListener("message", this.#handleMessage);
    socket.addEventListener("close", this.#handleClose);
    socket.addEventListener("error", this.#handleError);
    this.#onConnectionState?.("open");
  }

  readonly #handleMessage = (event: Event): void => {
    let message: CdpMessage;
    try {
      const raw = messageData(event);
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      if (message.error) {
        pending.reject(new Error(`webmcp-computer: browser command failed: ${message.error.message ?? message.error.code ?? "unknown error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.#listeners.get(message.method) ?? []) {
      listener(message.params);
    }
  };

  readonly #handleClose = (): void => {
    this.#settleConnection("closed", "browser connection closed");
  };

  readonly #handleError = (event: Event): void => {
    this.#settleConnection("error", errorMessage((event as ErrorEvent).error ?? "browser connection error"));
  };

  #settleConnection(state: "closed" | "error", reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    const error = new Error(`webmcp-computer: ${reason}`);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#onConnectionState?.(state, reason);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("webmcp-computer: browser command aborted"));
    }
    if (this.#settled || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("webmcp-computer: browser connection is not open"));
    }
    if (method === "Runtime.evaluate") {
      const expression = params.expression;
      if (typeof expression !== "string" || !EVALUATE_MARKER.test(expression)) {
        return Promise.reject(new Error("webmcp-computer: browser evaluate expression is missing its operation marker"));
      }
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (pending?.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        reject(new Error(`webmcp-computer: browser command timed out: ${method}`));
      }, this.#commandTimeoutMs);
      const pending: PendingCommand = {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      };
      if (signal) {
        const abort = () => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          clearTimeout(timeout);
          reject(signal.reason instanceof Error ? signal.reason : new Error("webmcp-computer: browser command aborted"));
        };
        pending.signal = signal;
        pending.abort = abort;
      }
      this.#pending.set(id, pending);
      if (pending.signal && pending.abort) {
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        reject(new Error(`webmcp-computer: browser command failed: ${errorMessage(error)}`));
      }
    });
  }

  async evaluate<T>(
    operation: CdpEvaluateOperation,
    expression: string,
    signal?: AbortSignal,
    contextId?: number,
  ): Promise<T> {
    const result = await this.send<{
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      result?: { value?: T };
    }>("Runtime.evaluate", {
      expression: `/*webmcp-computer:${operation}*/${expression}`,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    }, signal);
    if (result.exceptionDetails) {
      throw new Error(
        `webmcp-computer: browser page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown error"}`,
      );
    }
    const value = result.result?.value;
    if (value === undefined) {
      throw new Error(`webmcp-computer: browser returned no value for ${operation}`);
    }
    return value;
  }

  async setViewport(width: number, height: number, signal?: AbortSignal): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    }, signal);
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  waitForEvent(
    method: string,
    timeoutMs = this.#commandTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("webmcp-computer: browser event aborted"));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        off();
        signal?.removeEventListener("abort", abort);
      };
      const off = this.on(method, (params) => {
        cleanup();
        resolve(params);
      });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`webmcp-computer: browser event timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("webmcp-computer: browser event aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  close(): void {
    this.#socket.removeEventListener("message", this.#handleMessage);
    this.#socket.removeEventListener("close", this.#handleClose);
    this.#socket.removeEventListener("error", this.#handleError);
    this.#settleConnection("closed", "browser connection closed");
    try {
      this.#socket.close();
    } catch {
      // Session DELETE remains the authoritative close.
    }
  }
}

export async function waitForWebSocketOpen(
  socket: BrowserWebSocket,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("webmcp-computer: browser connection closed before opening"));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("webmcp-computer: browser connection failed"));
    };
    const handleAbort = () => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The rejected open owns no live session.
      }
      reject(signal?.reason instanceof Error ? signal.reason : new Error("webmcp-computer: browser connection aborted"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("webmcp-computer: browser connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
