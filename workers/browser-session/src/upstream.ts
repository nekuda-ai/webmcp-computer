// Cloudflare Browser Run session-management API. This is the only module that holds the
// account API token; everything it returns to callers is session-scoped.
import { BROWSER_RUN_KEEP_ALIVE_MS } from "../../../shared/session-limits";

export type UpstreamEnv = {
  CF_ACCOUNT_ID: string;
  BROWSER_RENDERING_API_TOKEN?: string;
};

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SessionTarget = {
  id?: unknown;
  targetId?: unknown;
  type?: unknown;
  devtoolsFrontendUrl?: unknown;
  webSocketDebuggerUrl?: unknown;
};

export type SessionDescriptor = {
  sessionId: string;
  liveViewUrl: string;
  tabWsUrl: string;
  targetId: string;
  keepAliveMs: number;
};

/** An HTTP failure from Browser Run, already reduced to a status and a one-line message. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Tab setup failed and rollback could not confirm that the allocated Chrome was closed. */
export class OrphanedSessionError extends Error {
  readonly sessionId: string;
  readonly failure: UpstreamError;

  constructor(sessionId: string, failure: UpstreamError) {
    super(failure.message);
    this.sessionId = sessionId;
    this.failure = failure;
  }
}

export function oneLine(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function apiRoot(env: UpstreamEnv): string {
  if (!/^[0-9a-f]{32}$/i.test(env.CF_ACCOUNT_ID)) throw new Error("invalid Cloudflare account ID");
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/devtools/browser`;
}

function bearer(env: UpstreamEnv): HeadersInit {
  const token = env.BROWSER_RENDERING_API_TOKEN;
  if (!token) throw new Error("browser rendering API token is not configured");
  return { Authorization: `Bearer ${token}` };
}

export function validHttpUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("url must be a string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must use http or https");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  return parsed.href;
}

async function upstreamError(response: Response): Promise<UpstreamError> {
  let message = `browser service returned ${response.status}`;
  try {
    const payload = await response.json() as {
      error?: unknown;
      message?: unknown;
      errors?: Array<{ message?: unknown }>;
    };
    const candidate = payload.error ?? payload.message ?? payload.errors?.[0]?.message;
    if (candidate !== undefined) message = oneLine(candidate).slice(0, 200);
  } catch {
    // Keep status-derived message when upstream did not return JSON.
  }
  const retryAfter = Number(response.headers.get("Retry-After"));
  return new UpstreamError(
    response.status,
    message,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined,
  );
}

export function sessionPayload(sessionId: string, target: SessionTarget): SessionDescriptor {
  const targetId = typeof target.id === "string"
    ? target.id
    : typeof target.targetId === "string"
      ? target.targetId
      : undefined;
  if (
    !targetId ||
    typeof target.devtoolsFrontendUrl !== "string" ||
    typeof target.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("browser service returned an invalid page target");
  }
  return {
    sessionId,
    liveViewUrl: validHttpUrl(target.devtoolsFrontendUrl),
    tabWsUrl: target.webSocketDebuggerUrl,
    targetId,
    keepAliveMs: BROWSER_RUN_KEEP_ALIVE_MS,
  };
}

export type Upstream = {
  /** Create a session and one page tab. Cleans up the session if the tab fails. */
  create(url: string): Promise<SessionDescriptor>;
  list(sessionId: string): Promise<SessionTarget[]>;
  close(sessionId: string): Promise<{ status: string }>;
};

export function browserRunUpstream(env: UpstreamEnv, fetcher: Fetcher): Upstream {
  const close = async (sessionId: string): Promise<{ status: string }> => {
    const response = await fetcher(
      `${apiRoot(env)}/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", headers: bearer(env) },
    );
    if (!response.ok) throw await upstreamError(response);
    try {
      const payload = await response.json() as { status?: unknown };
      return { status: typeof payload.status === "string" ? payload.status : "closed" };
    } catch {
      return { status: "closed" };
    }
  };

  return {
    async create(url) {
      const created = await fetcher(
        `${apiRoot(env)}?keep_alive=${BROWSER_RUN_KEEP_ALIVE_MS}&lab=true`,
        { method: "POST", headers: bearer(env) },
      );
      if (!created.ok) throw await upstreamError(created);
      const createdBody = await created.json() as { sessionId?: unknown };
      if (typeof createdBody.sessionId !== "string") {
        throw new UpstreamError(502, "browser service returned an invalid session");
      }
      const sessionId = createdBody.sessionId;
      try {
        const targetResponse = await fetcher(
          `${apiRoot(env)}/${encodeURIComponent(sessionId)}/json/new?url=${encodeURIComponent(url)}`,
          { method: "PUT", headers: bearer(env) },
        );
        if (!targetResponse.ok) throw await upstreamError(targetResponse);
        return sessionPayload(sessionId, await targetResponse.json() as SessionTarget);
      } catch (error) {
        const failure = error instanceof UpstreamError
          ? error
          : new UpstreamError(502, oneLine(error instanceof Error ? error.message : error));
        try {
          await close(sessionId);
        } catch {
          // The caller must retain and retry this session instead of ending accounting.
          throw new OrphanedSessionError(sessionId, failure);
        }
        throw failure;
      }
    },
    async list(sessionId) {
      const response = await fetcher(
        `${apiRoot(env)}/${encodeURIComponent(sessionId)}/json/list`,
        { headers: bearer(env) },
      );
      if (!response.ok) throw await upstreamError(response);
      return await response.json() as SessionTarget[];
    },
    close,
  };
}
