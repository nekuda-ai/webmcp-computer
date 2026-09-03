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
      pending.reject(error);
    }
    this.#pending.clear();
    this.#onConnectionState?.(state, reason);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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
        this.#pending.delete(id);
        reject(new Error(`webmcp-computer: browser command timed out: ${method}`));
      }, this.#commandTimeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(new Error(`webmcp-computer: browser command failed: ${errorMessage(error)}`));
      }
    });
  }

  async evaluate<T>(operation: CdpEvaluateOperation, expression: string): Promise<T> {
    const result = await this.send<{
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      result?: { value?: T };
    }>("Runtime.evaluate", {
      expression: `/*webmcp-computer:${operation}*/${expression}`,
      awaitPromise: true,
      returnByValue: true,
    });
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

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
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

  waitForEvent(method: string, timeoutMs = this.#commandTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timeout);
        off();
        resolve(params);
      });
      const timeout = setTimeout(() => {
        off();
        reject(new Error(`webmcp-computer: browser event timed out: ${method}`));
      }, timeoutMs);
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
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
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
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("webmcp-computer: browser connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
  });
}
