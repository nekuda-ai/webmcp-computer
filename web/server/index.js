import {
  deriveGatewaySubject,
  mintGatewayCapability,
  verifyGatewayCapability,
} from "../../shared/gateway-capability.ts";

const DEMO_SESSION_TTL_SECONDS = 900;
const DEMO_SESSION_RENEWAL_SKEW_SECONDS = 30;
const DEMO_SESSION_COOKIE = "webmcp_computer_demo_session";
const MACHINE_IDENTITY_TTL_SECONDS = 30 * 24 * 60 * 60;
const MACHINE_IDENTITY_COOKIE = "webmcp_computer_machine";
const MACHINE_IDENTITY_TOKEN = /^v1\.([0-9a-f]{32})\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{32,64})$/;

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function randomWorkspaceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function endpoint(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  return parsed.origin;
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return undefined;
  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim();
  }
  return undefined;
}

function sessionCookie(request, capability) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${DEMO_SESSION_COOKIE}=${capability}; Max-Age=${DEMO_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function machineCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${MACHINE_IDENTITY_COOKIE}=${token}; Max-Age=${MACHINE_IDENTITY_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

async function machineSignature(secret, origin, workspaceId, issuedAt, expiresAt) {
  return await deriveGatewaySubject(
    secret,
    `machine:v1:${origin}:${workspaceId}:${issuedAt}:${expiresAt}`,
  );
}

async function mintMachineIdentity(request, env, now, workspaceId) {
  const expiresAt = now + MACHINE_IDENTITY_TTL_SECONDS;
  const signature = await machineSignature(
    env.GATEWAY_SIGNING_SECRET,
    new URL(request.url).origin,
    workspaceId,
    now,
    expiresAt,
  );
  return `v1.${workspaceId}.${now}.${expiresAt}.${signature}`;
}

function signaturesMatch(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyMachineIdentity(request, env, token, now) {
  const match = MACHINE_IDENTITY_TOKEN.exec(token);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw new Error("invalid machine identity");
  const issuedAt = Number(match[2]);
  const expiresAt = Number(match[3]);
  if (
    !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
    issuedAt > now + 30 || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt > MACHINE_IDENTITY_TTL_SECONDS
  ) throw new Error("invalid machine identity");
  const expected = await machineSignature(
    env.GATEWAY_SIGNING_SECRET,
    new URL(request.url).origin,
    match[1],
    issuedAt,
    expiresAt,
  );
  if (!signaturesMatch(expected, match[4])) throw new Error("invalid machine identity");
  return { workspaceId: match[1] };
}

async function mintDemoSession(request, env, now, workspaceId, subject) {
  const workspace = workspaceId ?? randomWorkspaceId();
  const sessionSubject = subject ?? await deriveGatewaySubject(
    env.GATEWAY_SIGNING_SECRET,
    `demo:${workspace}`,
  );
  const capability = await mintGatewayCapability({
    secret: env.GATEWAY_SIGNING_SECRET,
    subject: sessionSubject,
    workspace,
    origin: new URL(request.url).origin,
    scopes: ["browser", "computer"],
    now,
    ttlSeconds: DEMO_SESSION_TTL_SECONDS,
  });
  return {
    capability,
    expiresAt: now + DEMO_SESSION_TTL_SECONDS,
    subject: sessionSubject,
    workspaceId: workspace,
  };
}

async function demoSession(request, env, dependencies, now) {
  const existing = cookieValue(request, DEMO_SESSION_COOKIE);
  let existingClaims;
  if (existing) {
    try {
      const claims = await verifyGatewayCapability(existing, {
        secret: env.GATEWAY_SIGNING_SECRET,
        scope: "browser",
        origin: new URL(request.url).origin,
        now,
      });
      if (!claims.scopes.includes("computer")) throw new Error("incomplete demo capability");
      existingClaims = claims;
    } catch {
      // An expired compute capability does not expire the anonymous machine.
    }
  }

  const existingMachine = cookieValue(request, MACHINE_IDENTITY_COOKIE);
  let workspaceId;
  let identityToken = existingMachine;
  let identityRenewed = false;
  if (existingMachine) {
    try {
      workspaceId = (await verifyMachineIdentity(request, env, existingMachine, now)).workspaceId;
    } catch {
      identityToken = undefined;
    }
  }
  workspaceId ??= existingClaims?.workspace;
  workspaceId ??= dependencies.randomWorkspaceId?.() ?? randomWorkspaceId();
  if (!identityToken) {
    identityToken = await mintMachineIdentity(request, env, now, workspaceId);
    identityRenewed = true;
  }

  if (
    existing && existingClaims?.workspace === workspaceId &&
    existingClaims.expiresAt > now + DEMO_SESSION_RENEWAL_SKEW_SECONDS
  ) {
    return {
      capability: existing,
      expiresAt: existingClaims.expiresAt,
      machineId: workspaceId,
      machineToken: identityToken,
      identityRenewed,
      workspaceId,
      renewed: false,
    };
  }
  return {
    ...await mintDemoSession(request, env, now, workspaceId),
    machineId: workspaceId,
    machineToken: identityToken,
    identityRenewed,
    renewed: true,
  };
}

async function sessionResponse(request, env, dependencies) {
  try {
    const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
    const browserWorkerUrl = endpoint(env.BROWSER_WORKER_URL, "BROWSER_WORKER_URL");
    const computerWorkerUrl = endpoint(env.COMPUTER_WORKER_URL, "COMPUTER_WORKER_URL");
    const session = await demoSession(request, env, dependencies, now);
    const response = json({
      active: true,
      machineId: session.machineId,
      workspaceId: session.workspaceId,
      capability: session.capability,
      expiresAt: session.expiresAt,
      browserWorkerUrl,
      computerWorkerUrl,
    });
    if (session.renewed) response.headers.append("Set-Cookie", sessionCookie(request, session.capability));
    if (session.identityRenewed) {
      response.headers.append("Set-Cookie", machineCookie(request, session.machineToken));
    }
    return response;
  } catch (error) {
    console.error("WebMCP Computer demo session broker failed", error);
    return json({ error: "demo session broker is unavailable" }, 500);
  }
}

export async function handleRequest(request, env, dependencies = {}) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/api/session") return env.ASSETS.fetch(request);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  return await sessionResponse(request, env, dependencies);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
