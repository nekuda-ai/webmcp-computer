export type HostedSessionState =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "active";
      machineId: string;
      workspaceId: string;
      capability: string;
      expiresAt: number;
      browserWorkerUrl: string;
      computerWorkerUrl: string;
    };

export type HostedCapabilityScope = "browser" | "computer";

export type HostedSessionClient = {
  load(force?: boolean): Promise<HostedSessionState>;
  snapshot(): HostedSessionState;
  subscribe(listener: () => void): () => void;
  authorization(scope: HostedCapabilityScope): Promise<{ Authorization: string }>;
  workspaceId(): string;
  workerUrl(kind: HostedCapabilityScope): string;
  machineId(): string | undefined;
};

type HostedSessionDependencies = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
};

const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const REFRESH_SKEW_SECONDS = 30;
export const MACHINE_ID_STORAGE_KEY = "webmcp_computer.machine.id";

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function normalizeWorkerUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing Worker URL");
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Worker URL must use HTTPS or loopback HTTP");
  }
  return url.origin;
}

function parseSession(value: unknown, now: number): HostedSessionState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session payload");
  const session = value as Record<string, unknown>;
  if (
    session.active !== true ||
    typeof session.machineId !== "string" || !WORKSPACE_ID.test(session.machineId) ||
    typeof session.workspaceId !== "string" || !WORKSPACE_ID.test(session.workspaceId) ||
    typeof session.capability !== "string" || session.capability.length < 16 ||
    !Number.isInteger(session.expiresAt) || (session.expiresAt as number) <= now
  ) throw new Error("invalid active session payload");
  return {
    status: "active",
    machineId: session.machineId,
    workspaceId: session.workspaceId,
    capability: session.capability,
    expiresAt: session.expiresAt as number,
    browserWorkerUrl: normalizeWorkerUrl(session.browserWorkerUrl),
    computerWorkerUrl: normalizeWorkerUrl(session.computerWorkerUrl),
  };
}

export function createHostedSessionClient(dependencies: HostedSessionDependencies): HostedSessionClient {
  let state: HostedSessionState = { status: "loading" };
  let pending: Promise<HostedSessionState> | undefined;
  const listeners = new Set<() => void>();
  const storage = dependencies.storage ?? defaultStorage();
  let rememberedMachineId: string | undefined;
  try {
    const stored = storage?.getItem(MACHINE_ID_STORAGE_KEY);
    if (stored && WORKSPACE_ID.test(stored)) rememberedMachineId = stored;
  } catch {
    // The signed HttpOnly cookie remains authoritative when local storage is unavailable.
  }

  const publish = (next: HostedSessionState) => {
    state = next;
    for (const listener of listeners) listener();
    return state;
  };

  const request = async () => {
    try {
      const response = await dependencies.fetch("/api/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`session broker returned ${response.status}`);
      const next = parseSession(await response.json(), dependencies.now());
      if (next.status === "active") {
        rememberedMachineId = next.machineId;
        try {
          storage?.setItem(MACHINE_ID_STORAGE_KEY, next.machineId);
        } catch {
          // Identity remains available from the in-memory session and signed cookie.
        }
      }
      return publish(next);
    } catch {
      return publish({ status: "unavailable" });
    }
  };

  return {
    async load(force = false) {
      if (!force && state.status !== "loading") return state;
      pending ??= request().finally(() => { pending = undefined; });
      return await pending;
    },
    snapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async authorization(scope) {
      if (state.status === "loading") await this.load();
      if (
        state.status === "active" &&
        state.expiresAt <= dependencies.now() + REFRESH_SKEW_SECONDS
      ) await this.load(true);
      if (state.status !== "active") {
        throw new Error(`webmcp-computer: hosted ${scope} session is unavailable`);
      }
      return { Authorization: `Bearer ${state.capability}` };
    },
    workspaceId() {
      if (state.status !== "active") throw new Error("webmcp-computer: cloud workspace session is unavailable");
      return state.workspaceId;
    },
    workerUrl(kind) {
      if (state.status !== "active") throw new Error(`webmcp-computer: hosted ${kind} session is unavailable`);
      return kind === "browser" ? state.browserWorkerUrl : state.computerWorkerUrl;
    },
    machineId() {
      return state.status === "active" ? state.machineId : rememberedMachineId;
    },
  };
}

const hostedSessionClient = createHostedSessionClient({
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Math.floor(Date.now() / 1_000),
});

export function initializeHostedSession(): Promise<HostedSessionState> {
  return hostedSessionClient.load();
}

export function hostedSessionSnapshot(): HostedSessionState {
  return hostedSessionClient.snapshot();
}

export function subscribeHostedSession(listener: () => void): () => void {
  return hostedSessionClient.subscribe(listener);
}

export function hostedAuthorization(scope: HostedCapabilityScope): Promise<{ Authorization: string }> {
  return hostedSessionClient.authorization(scope);
}

export function hostedWorkspaceId(): string {
  return hostedSessionClient.workspaceId();
}

export function hostedWorkerUrl(kind: HostedCapabilityScope): string {
  return hostedSessionClient.workerUrl(kind);
}

export function hostedMachineId(): string | undefined {
  return hostedSessionClient.machineId();
}

export function hostedSessionActive(): boolean {
  return hostedSessionClient.snapshot().status === "active";
}
