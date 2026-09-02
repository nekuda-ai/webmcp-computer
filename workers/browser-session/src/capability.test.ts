import { describe, expect, test } from "bun:test";
import {
  deriveGatewaySubject,
  mintGatewayCapability,
  verifyGatewayCapability,
} from "../../../shared/gateway-capability";

const SECRET = "test-only-gateway-secret-with-at-least-32-characters";
const WORKSPACE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://webmcp-computer.example";

describe("gateway capability", () => {
  test("round-trips signed, origin-bound, scoped claims", async () => {
    const token = await mintGatewayCapability({
      secret: SECRET,
      subject: "subject-1",
      workspace: WORKSPACE,
      origin: ORIGIN,
      scopes: ["browser", "computer"],
      now: 1_000,
      ttlSeconds: 900,
    });

    expect(await verifyGatewayCapability(token, {
      secret: SECRET,
      scope: "computer",
      origin: ORIGIN,
      workspace: WORKSPACE,
      now: 1_100,
    })).toEqual({
      audience: "verbos-cloudflare",
      expiresAt: 1_900,
      issuedAt: 1_000,
      origin: ORIGIN,
      scopes: ["browser", "computer"],
      subject: "subject-1",
      version: 1,
      workspace: WORKSPACE,
    });
  });

  test("rejects tampering, expiry, wrong scope, origin, and workspace", async () => {
    const token = await mintGatewayCapability({
      secret: SECRET,
      subject: "subject-1",
      workspace: WORKSPACE,
      origin: ORIGIN,
      scopes: ["browser"],
      now: 1_000,
      ttlSeconds: 60,
    });
    const checks = [
      () => verifyGatewayCapability(`${token.slice(0, -1)}x`, { secret: SECRET, scope: "browser", origin: ORIGIN, now: 1_010 }),
      () => verifyGatewayCapability(token, { secret: SECRET, scope: "browser", origin: ORIGIN, now: 1_061 }),
      () => verifyGatewayCapability(token, { secret: SECRET, scope: "computer", origin: ORIGIN, now: 1_010 }),
      () => verifyGatewayCapability(token, { secret: SECRET, scope: "browser", origin: "https://evil.example", now: 1_010 }),
      () => verifyGatewayCapability(token, { secret: SECRET, scope: "browser", origin: ORIGIN, workspace: "fedcba9876543210fedcba9876543210", now: 1_010 }),
    ];
    for (const check of checks) await expect(check()).rejects.toThrow("invalid gateway capability");
  });

  test("derives a stable pseudonymous subject without exposing session ID", async () => {
    const first = await deriveGatewaySubject(SECRET, "demo-session-123");
    expect(await deriveGatewaySubject(SECRET, "demo-session-123")).toBe(first);
    expect(await deriveGatewaySubject(SECRET, "demo-session-456")).not.toBe(first);
    expect(first).not.toContain("demo-session-123");
  });
});
