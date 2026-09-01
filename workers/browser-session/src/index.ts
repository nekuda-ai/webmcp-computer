const ACCOUNT_ID = "cf3d5b1eddd4c74d217780cdb7e55d07";
const KEEP_ALIVE_MS = 300_000;
const API_ROOT =
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering/devtools/browser`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
} as const;

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
  CF_API_TOKEN: string;
  SESSION_RATE: RateLimitBinding;
  SESSION_ACTION_RATE: RateLimitBinding;
};

export type WorkerDependencies = {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
};

type SessionTarget = {
  id?: unknown;
  targetId?: unknown;
  type?: unknown;
  devtoolsFrontendUrl?: unknown;
  webSocketDebuggerUrl?: unknown;
};

type SessionResponse = {
  sessionId: string;
  liveViewUrl: string;
  tabWsUrl: string;
  targetId: string;
  keepAliveMs: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function oneLine(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function validHttpUrl(value: unknown): string {
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

async function upstreamError(response: Response): Promise<Response> {
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
  return json({ error: message }, response.status);
}

function sessionPayload(sessionId: string, target: SessionTarget): SessionResponse {
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
    keepAliveMs: KEEP_ALIVE_MS,
  };
}

async function closeUpstreamSession(
  sessionId: string,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<void> {
  try {
    await dependencies.fetch(
      `${API_ROOT}/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", headers: bearer(env.CF_API_TOKEN) },
    );
  } catch {
    // keep_alive remains the cost-control backstop when best-effort cleanup fails.
  }
}

async function parseOptionalUrl(request: Request): Promise<string> {
  const text = await request.text();
  if (text.trim() === "") return "about:blank";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be an object");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "url")) throw new Error("body contains unknown fields");
  const url = (body as { url?: unknown }).url;
  return url === undefined ? "about:blank" : validHttpUrl(url);
}

async function createSession(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rate = await env.SESSION_RATE.limit({ key: clientIp });
  if (!rate.success) return json({ error: "rate limited" }, 429);

  let url: string;
  try {
    url = await parseOptionalUrl(request);
  } catch (error) {
    return json({ error: oneLine(error instanceof Error ? error.message : error) }, 400);
  }

  const created = await dependencies.fetch(
    `${API_ROOT}?keep_alive=${KEEP_ALIVE_MS}&lab=true`,
    { method: "POST", headers: bearer(env.CF_API_TOKEN) },
  );
  if (!created.ok) return await upstreamError(created);
  const createdBody = await created.json() as { sessionId?: unknown };
  if (typeof createdBody.sessionId !== "string") {
    return json({ error: "browser service returned an invalid session" }, 502);
  }

  try {
    const targetResponse = await dependencies.fetch(
      `${API_ROOT}/${encodeURIComponent(createdBody.sessionId)}/json/new?url=${encodeURIComponent(url)}`,
      { method: "PUT", headers: bearer(env.CF_API_TOKEN) },
    );
    if (!targetResponse.ok) {
      await closeUpstreamSession(createdBody.sessionId, env, dependencies);
      return await upstreamError(targetResponse);
    }
    const target = await targetResponse.json() as SessionTarget;
    return json(sessionPayload(createdBody.sessionId, target));
  } catch (error) {
    await closeUpstreamSession(createdBody.sessionId, env, dependencies);
    return json({ error: oneLine(error instanceof Error ? error.message : error) }, 502);
  }
}

async function refreshSession(
  sessionId: string,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<Response> {
  const response = await dependencies.fetch(
    `${API_ROOT}/${encodeURIComponent(sessionId)}/json/list`,
    { headers: bearer(env.CF_API_TOKEN) },
  );
  if (!response.ok) return await upstreamError(response);
  try {
    const targets = await response.json() as SessionTarget[];
    const target = targets.find(({ type }) => type === "page") ?? targets[0];
    if (!target) throw new Error("browser service returned no page target");
    return json(sessionPayload(sessionId, target));
  } catch (error) {
    return json({ error: oneLine(error instanceof Error ? error.message : error) }, 502);
  }
}

async function deleteSession(
  sessionId: string,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<Response> {
  const response = await dependencies.fetch(
    `${API_ROOT}/${encodeURIComponent(sessionId)}`,
    { method: "DELETE", headers: bearer(env.CF_API_TOKEN) },
  );
  if (!response.ok) return await upstreamError(response);
  try {
    const payload = await response.json() as { status?: unknown };
    return json({ status: typeof payload.status === "string" ? payload.status : "closed" });
  } catch {
    return json({ status: "closed" });
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  // Workers rejects an unbound global fetch with "Illegal invocation".
  dependencies: WorkerDependencies = { fetch: (...args) => fetch(...args) },
): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/session") {
      return await createSession(request, env, dependencies);
    }

    const refreshMatch = /^\/session\/([^/]+)\/refresh$/.exec(pathname);
    if (request.method === "POST" && refreshMatch) {
      const sessionId = refreshMatch[1] ?? "";
      if (!UUID_PATTERN.test(sessionId)) return json({ error: "invalid session id" }, 400);
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const rate = await env.SESSION_ACTION_RATE.limit({ key: clientIp });
      if (!rate.success) return json({ error: "rate limited" }, 429);
      return await refreshSession(sessionId, env, dependencies);
    }

    const deleteMatch = /^\/session\/([^/]+)$/.exec(pathname);
    if (request.method === "DELETE" && deleteMatch) {
      const sessionId = deleteMatch[1] ?? "";
      if (!UUID_PATTERN.test(sessionId)) return json({ error: "invalid session id" }, 400);
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const rate = await env.SESSION_ACTION_RATE.limit({ key: clientIp });
      if (!rate.success) return json({ error: "rate limited" }, 429);
      return await deleteSession(sessionId, env, dependencies);
    }

    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: oneLine(error instanceof Error ? error.message : error) }, 502);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
