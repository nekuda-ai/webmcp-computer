import {
  bearerGatewayCapability,
  verifyGatewayCapability,
  type GatewayCapabilityClaims,
} from "../../../shared/gateway-capability";
import type { BrowserLeaseLike, LeaseFailure, LeaseResult } from "./lease";
import { oneLine, validHttpUrl, type Fetcher, type UpstreamEnv } from "./upstream";
import type { BrowserLeaseObject } from "./index";

export type { BrowserLeaseLike, LeaseResult } from "./lease";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
} as const;

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = UpstreamEnv & {
  GATEWAY_SIGNING_SECRET: string;
  // Each action is limited per signed subject+IP and per IP alone: a subject is free to
  // mint by clearing cookies, an IP is not.
  SESSION_RATE: RateLimitBinding;
  SESSION_RATE_IP: RateLimitBinding;
  SESSION_ACTION_RATE: RateLimitBinding;
  SESSION_ACTION_RATE_IP: RateLimitBinding;
  LEASES?: DurableObjectNamespace<BrowserLeaseObject>;
};

export type WorkerDependencies = {
  fetch: Fetcher;
  authenticate(request: Request, env: Env): Promise<GatewayCapabilityClaims>;
  /** The per-machine lease; production resolves the Durable Object, tests inject memory. */
  lease?(workspace: string, env: Env): BrowserLeaseLike;
};

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  return {
    ...CORS_HEADERS,
    ...(origin === null ? {} : { "Access-Control-Allow-Origin": origin, Vary: "Origin" }),
  };
}

function json(request: Request, body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request), ...headers },
  });
}

function failureResponse(request: Request, failure: LeaseFailure): Response {
  const retryAfterMs = "retryAfterMs" in failure.error ? failure.error.retryAfterMs : undefined;
  return json(
    request,
    failure.error,
    failure.status,
    retryAfterMs === undefined ? {} : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) },
  );
}

function leaseResponse<T>(request: Request, result: LeaseResult<T>): Response {
  return result.ok ? json(request, result.value) : failureResponse(request, result);
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

export async function authenticateBrowserRequest(
  request: Request,
  env: Env,
): Promise<GatewayCapabilityClaims> {
  return await verifyGatewayCapability(bearerGatewayCapability(request), {
    secret: env.GATEWAY_SIGNING_SECRET,
    scope: "browser",
    origin: request.headers.get("Origin"),
  });
}

function durableLease(workspace: string, env: Env): BrowserLeaseLike {
  if (!env.LEASES) throw new Error("LEASES Durable Object binding is not configured");
  const stub = env.LEASES.get(env.LEASES.idFromName(workspace));
  return {
    create: (url) => stub.create(url),
    heartbeat: (sessionId) => stub.heartbeat(sessionId),
    refresh: (sessionId) => stub.refresh(sessionId),
    close: (sessionId) => stub.close(sessionId),
  };
}

const defaultDependencies: WorkerDependencies = {
  fetch: (...args) => fetch(...args),
  authenticate: authenticateBrowserRequest,
  lease: durableLease,
};

async function rateLimited(
  perSubject: RateLimitBinding,
  perIp: RateLimitBinding,
  claims: GatewayCapabilityClaims,
  request: Request,
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [subject, address] = await Promise.all([
    perSubject.limit({ key: `${claims.subject}:${ip}` }),
    perIp.limit({ key: ip }),
  ]);
  return !subject.success || !address.success;
}

type SessionAction = "heartbeat" | "refresh" | "close";

function sessionAction(request: Request, pathname: string): { id: string; action: SessionAction } | undefined {
  const match = /^\/session\/([^/]+)(?:\/(heartbeat|refresh))?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  const id = match[1];
  if (request.method === "DELETE" && match[2] === undefined) return { id, action: "close" };
  if (request.method === "POST" && (match[2] === "heartbeat" || match[2] === "refresh")) return { id, action: match[2] };
  return undefined;
}

export async function handleRequest(
  request: Request,
  env: Env,
  // Workers rejects an unbound global fetch with "Illegal invocation".
  dependencies: WorkerDependencies = defaultDependencies,
): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    const { pathname } = new URL(request.url);
    const resolveLease = dependencies.lease ?? durableLease;

    if (request.method === "POST" && pathname === "/session") {
      let claims: GatewayCapabilityClaims;
      try {
        claims = await dependencies.authenticate(request, env);
      } catch {
        return json(request, { error: "unauthorized" }, 401);
      }
      if (await rateLimited(env.SESSION_RATE, env.SESSION_RATE_IP, claims, request)) {
        return json(request, { error: "rate limited" }, 429);
      }
      let url: string;
      try {
        url = await parseOptionalUrl(request);
      } catch (error) {
        return json(request, { error: oneLine(error instanceof Error ? error.message : error) }, 400);
      }
      return leaseResponse(request, await resolveLease(claims.workspace, env).create(url));
    }

    const action = sessionAction(request, pathname);
    if (action) {
      if (!UUID_PATTERN.test(action.id)) return json(request, { error: "invalid session id" }, 400);
      let claims: GatewayCapabilityClaims;
      try {
        claims = await dependencies.authenticate(request, env);
      } catch {
        return json(request, { error: "unauthorized" }, 401);
      }
      if (await rateLimited(env.SESSION_ACTION_RATE, env.SESSION_ACTION_RATE_IP, claims, request)) {
        return json(request, { error: "rate limited" }, 429);
      }
      const lease = resolveLease(claims.workspace, env);
      switch (action.action) {
        case "heartbeat":
          return leaseResponse(request, await lease.heartbeat(action.id));
        case "refresh":
          return leaseResponse(request, await lease.refresh(action.id));
        case "close":
          return leaseResponse(request, await lease.close(action.id));
      }
    }

    return json(request, { error: "not found" }, 404);
  } catch (error) {
    return json(request, { error: oneLine(error instanceof Error ? error.message : error) }, 502);
  }
}
