// Wire contract: the site signs this audience into every capability and every deployed
// Worker verifies it. Change it only together with a redeploy of the site AND both Workers.
export const GATEWAY_CAPABILITY_AUDIENCE = "verbos-cloudflare";
export const MAX_GATEWAY_CAPABILITY_TTL_SECONDS = 900;

export type GatewayScope = "browser" | "computer";

export type GatewayCapabilityClaims = {
  version: 1;
  audience: typeof GATEWAY_CAPABILITY_AUDIENCE;
  subject: string;
  workspace: string;
  origin: string;
  scopes: GatewayScope[];
  issuedAt: number;
  expiresAt: number;
};

export type MintGatewayCapabilityOptions = {
  secret: string;
  subject: string;
  workspace: string;
  origin: string;
  scopes: GatewayScope[];
  now?: number;
  ttlSeconds?: number;
};

export type VerifyGatewayCapabilityOptions = {
  secret: string;
  scope: GatewayScope;
  origin: string | null;
  workspace?: string;
  now?: number;
};

type WireClaims = {
  v: 1;
  aud: typeof GATEWAY_CAPABILITY_AUDIENCE;
  sub: string;
  ws: string;
  org: string;
  scp: GatewayScope[];
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const SUBJECT = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function invalid(): Error {
  return new Error("invalid gateway capability");
}

function requireSecret(secret: string): Uint8Array {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32) throw new Error("gateway signing secret must be at least 32 bytes");
  return bytes;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid();
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== value) {
    throw invalid();
  }
  return parsed.origin;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw invalid();
  }
}

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmac(secret: string, value: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    cryptoBytes(requireSecret(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, cryptoBytes(value)));
}

async function verifyHmac(secret: string, value: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    cryptoBytes(requireSecret(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify("HMAC", key, cryptoBytes(signature), cryptoBytes(value));
}

function requireScopes(value: unknown): GatewayScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) throw invalid();
  const scopes = value.filter((scope): scope is GatewayScope => scope === "browser" || scope === "computer");
  if (scopes.length !== value.length || new Set(scopes).size !== scopes.length) throw invalid();
  return scopes;
}

function parseClaims(value: unknown): WireClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const claims = value as Partial<WireClaims>;
  if (
    claims.v !== 1 || claims.aud !== GATEWAY_CAPABILITY_AUDIENCE ||
    typeof claims.sub !== "string" || !SUBJECT.test(claims.sub) ||
    typeof claims.ws !== "string" || !WORKSPACE_ID.test(claims.ws) ||
    typeof claims.org !== "string" ||
    !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
  ) throw invalid();
  return { ...claims, org: normalizeOrigin(claims.org), scp: requireScopes(claims.scp) } as WireClaims;
}

export async function deriveGatewaySubject(secret: string, providerUserId: string): Promise<string> {
  if (providerUserId.trim() === "") throw new Error("provider user ID is required");
  return base64Url(await hmac(secret, encoder.encode(`webmcp-computer-subject:v1:${providerUserId}`)));
}

export async function mintGatewayCapability(options: MintGatewayCapabilityOptions): Promise<string> {
  if (!SUBJECT.test(options.subject) || !WORKSPACE_ID.test(options.workspace)) throw invalid();
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const ttlSeconds = options.ttlSeconds ?? 300;
  if (!Number.isInteger(now) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_GATEWAY_CAPABILITY_TTL_SECONDS) {
    throw invalid();
  }
  const claims: WireClaims = {
    v: 1,
    aud: GATEWAY_CAPABILITY_AUDIENCE,
    sub: options.subject,
    ws: options.workspace,
    org: normalizeOrigin(options.origin),
    scp: requireScopes(options.scopes),
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = encoder.encode(`v1.${payload}`);
  return `v1.${payload}.${base64Url(await hmac(options.secret, signingInput))}`;
}

export async function verifyGatewayCapability(
  token: string,
  options: VerifyGatewayCapabilityOptions,
): Promise<GatewayCapabilityClaims> {
  try {
    const match = TOKEN.exec(token);
    if (!match?.[1] || !match[2]) throw invalid();
    const signingInput = encoder.encode(`v1.${match[1]}`);
    if (!await verifyHmac(options.secret, signingInput, decodeBase64Url(match[2]))) throw invalid();
    const claims = parseClaims(JSON.parse(decoder.decode(decodeBase64Url(match[1]))) as unknown);
    const now = options.now ?? Math.floor(Date.now() / 1_000);
    if (
      claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_GATEWAY_CAPABILITY_TTL_SECONDS ||
      !claims.scp.includes(options.scope) ||
      options.origin === null || claims.org !== normalizeOrigin(options.origin) ||
      (options.workspace !== undefined && claims.ws !== options.workspace)
    ) throw invalid();
    return {
      version: claims.v,
      audience: claims.aud,
      subject: claims.sub,
      workspace: claims.ws,
      origin: claims.org,
      scopes: claims.scp,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("gateway signing secret")) throw error;
    throw invalid();
  }
}

export function bearerGatewayCapability(request: Request): string {
  const authorization = request.headers.get("Authorization");
  const match = authorization === null ? null : /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match?.[1]) throw invalid();
  return match[1];
}
