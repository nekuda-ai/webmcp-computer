export const SITE_TOOL_PREFIX = "site_";

export type SiteToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type SiteToolRegisterMessage = {
  kind: "site-tool-register";
  requestId: string;
  tool: SiteToolDescriptor;
};

export type SiteToolUnregisterMessage = {
  kind: "site-tool-unregister";
  name: string;
};

export type SiteToolResultMessage = {
  kind: "site-tool-result";
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type SiteToolRegistrationMessage = {
  kind: "site-tool-registration";
  requestId: string;
  ok: boolean;
  error?: string;
};

export type SiteToolCallMessage = {
  kind: "site-tool-call";
  callId: string;
  name: string;
  input: Record<string, unknown>;
};

export type SiteToolFrameMessage =
  | SiteToolRegisterMessage
  | SiteToolUnregisterMessage
  | SiteToolResultMessage;

export type SiteToolHostMessage = SiteToolRegistrationMessage | SiteToolCallMessage;

type SiteFrameTool = SiteToolDescriptor & {
  execute(input: Record<string, unknown>): unknown;
};

type SiteModelContextFacade = {
  registerTool(tool: SiteFrameTool, options?: { signal?: AbortSignal }): Promise<void>;
  getTools(): Array<SiteToolDescriptor & {
    annotations: {
      readOnlyHint: boolean;
      consequentialHint: boolean;
      untrustedContentHint: boolean;
    };
  }>;
};

type FacadeRegistration = {
  requestId: string;
  tool: SiteFrameTool;
  registered: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

/**
 * Kept dependency-free because its source is injected into opaque Preview frames.
 * Host code supplies the authenticated postMessage transport around it.
 */
export function createSiteModelContextFacade(
  send: (message: SiteToolFrameMessage) => void,
  receive: (listener: (message: SiteToolHostMessage) => void) => void,
): SiteModelContextFacade {
  const maxSiteToolResultBytes = 256 * 1_024;
  const messageForError = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const resultBytes = (result: unknown) => {
    const serialized = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return new TextEncoder().encode(serialized).byteLength;
  };
  const registrations = new Map<string, FacadeRegistration>();
  const requests = new Map<string, string>();
  let nextRequestId = 1;

  const unregister = (name: string, reason?: unknown) => {
    const registration = registrations.get(name);
    if (!registration) return;
    registrations.delete(name);
    requests.delete(registration.requestId);
    registration.signal?.removeEventListener("abort", registration.abort as EventListener);
    send({ kind: "site-tool-unregister", name });
    if (!registration.registered) {
      registration.reject(reason ?? new Error(`verbos: site tool registration aborted: ${name}`));
    }
  };

  receive((message) => {
    if (message.kind === "site-tool-registration") {
      const name = requests.get(message.requestId);
      const registration = name === undefined ? undefined : registrations.get(name);
      if (name === undefined || !registration || registration.requestId !== message.requestId) return;
      requests.delete(message.requestId);
      if (message.ok) {
        registration.registered = true;
        registration.resolve();
      } else {
        registrations.delete(name);
        registration.signal?.removeEventListener("abort", registration.abort as EventListener);
        registration.reject(new Error(message.error ?? `verbos: site tool registration failed: ${name}`));
      }
      return;
    }

    const registration = registrations.get(message.name);
    if (!registration) {
      send({
        kind: "site-tool-result",
        callId: message.callId,
        ok: false,
        error: `verbos: site tool is not registered: ${message.name}`,
      });
      return;
    }
    void Promise.resolve()
      .then(() => registration.tool.execute(message.input))
      .then((result) => {
        if (resultBytes(result) > maxSiteToolResultBytes) {
          send({
            kind: "site-tool-result",
            callId: message.callId,
            ok: false,
            error: `verbos: site tool result too large: ${message.name}`,
          });
          return;
        }
        send({ kind: "site-tool-result", callId: message.callId, ok: true, result });
      })
      .catch((error: unknown) => {
        try {
          send({
            kind: "site-tool-result",
            callId: message.callId,
            ok: false,
            error: messageForError(error),
          });
        } catch {
          // Frame is already gone; host timeout/teardown owns the pending call.
        }
      });
  });

  return Object.freeze({
    registerTool(tool, options = {}) {
      return new Promise<void>((resolve, reject) => {
        if (typeof tool !== "object" || tool === null || typeof tool.execute !== "function") {
          reject(new TypeError("verbos: site tool must provide an execute function"));
          return;
        }
        if (typeof tool.name !== "string" || typeof tool.description !== "string") {
          reject(new TypeError("verbos: site tool requires name and description strings"));
          return;
        }
        if (registrations.has(tool.name)) {
          reject(new Error(`verbos: site tool already registered: ${tool.name}`));
          return;
        }
        if (options.signal?.aborted) {
          reject(options.signal.reason ?? new Error(`verbos: site tool registration aborted: ${tool.name}`));
          return;
        }

        const requestId = `site-register-${nextRequestId++}`;
        const registration: FacadeRegistration = {
          requestId,
          tool,
          registered: false,
          resolve,
          reject,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const abort = () => unregister(tool.name, options.signal?.reason);
        registration.abort = abort;
        registrations.set(tool.name, registration);
        requests.set(requestId, tool.name);
        options.signal?.addEventListener("abort", abort, { once: true });

        try {
          send({
            kind: "site-tool-register",
            requestId,
            tool: {
              name: tool.name,
              ...(tool.title === undefined ? {} : { title: tool.title }),
              description: tool.description,
              ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            },
          });
        } catch (error) {
          registrations.delete(tool.name);
          requests.delete(requestId);
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
    },

    getTools() {
      return [...registrations.values()]
        .filter(({ registered }) => registered)
        .map(({ tool }) => ({
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          description: tool.description,
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          annotations: {
            readOnlyHint: false,
            consequentialHint: false,
            untrustedContentHint: true,
          },
        }));
    },
  });
}

type PendingSiteToolCall = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export type SiteToolProxy = {
  execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  receive(message: SiteToolResultMessage): void;
  reset(reason?: Error): void;
};

export function createSiteToolProxy(
  send: (message: SiteToolCallMessage) => void,
): SiteToolProxy {
  const pending = new Map<string, PendingSiteToolCall>();
  let nextCallId = 1;

  const reset = (reason = new Error("verbos: site tool bridge closed")) => {
    for (const call of pending.values()) {
      call.signal?.removeEventListener("abort", call.abort as EventListener);
      call.reject(reason);
    }
    pending.clear();
  };

  return {
    execute(name, input, signal) {
      if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error(`verbos: site tool call aborted: ${name}`));
      }
      const callId = `site-call-${nextCallId++}`;
      return new Promise((resolve, reject) => {
        const call: PendingSiteToolCall = {
          resolve,
          reject,
          ...(signal === undefined ? {} : { signal }),
        };
        const abort = () => {
          if (pending.delete(callId)) {
            reject(signal?.reason ?? new Error(`verbos: site tool call aborted: ${name}`));
          }
        };
        call.abort = abort;
        pending.set(callId, call);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          send({ kind: "site-tool-call", callId, name, input });
        } catch (error) {
          pending.delete(callId);
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
    },

    receive(message) {
      const call = pending.get(message.callId);
      if (!call) return;
      pending.delete(message.callId);
      call.signal?.removeEventListener("abort", call.abort as EventListener);
      if (message.ok) call.resolve(message.result);
      else call.reject(new Error(message.error ?? "verbos: site tool failed"));
    },

    reset,
  };
}

export function isSiteToolDescriptor(value: unknown): value is SiteToolDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return typeof tool.name === "string" &&
    typeof tool.description === "string" &&
    (tool.title === undefined || typeof tool.title === "string") &&
    (tool.inputSchema === undefined || (
      typeof tool.inputSchema === "object" && tool.inputSchema !== null && !Array.isArray(tool.inputSchema)
    ));
}
