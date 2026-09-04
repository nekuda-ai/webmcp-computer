import { describe, expect, test } from "bun:test";
import { verifyGatewayCapability } from "../../shared/gateway-capability";
import { handleRequest } from "./index.js";

const SECRET = "test-only-gateway-secret-with-at-least-32-characters";
const WORKSPACE_ID = "0123456789abcdef0123456789abcdef";

function env() {
  return {
    ASSETS: { fetch: () => new Response("asset") },
    GATEWAY_SIGNING_SECRET: SECRET,
    BROWSER_WORKER_URL: "https://browser.example",
    COMPUTER_WORKER_URL: "https://computer.example",
  };
}

function sessionRequest(cookie?: string, origin = "https://webmcp-computer.example"): Request {
  return new Request(`${origin}/api/session`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .join("; ");
}

describe("Sites demo session broker", () => {
  test("starts a protected 15-minute session without ChatGPT identity", async () => {
    const response = await handleRequest(sessionRequest(), env(), {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=900");
    expect(response.headers.get("Set-Cookie")).toContain("webmcp_computer_machine=");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(body).toEqual(expect.objectContaining({
      active: true,
      browserWorkerUrl: "https://browser.example",
      computerWorkerUrl: "https://computer.example",
      expiresAt: 1_900,
      machineId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
    }));
    expect(JSON.stringify(body)).not.toContain("ChatGPT");
    expect(await verifyGatewayCapability(String(body.capability), {
      secret: SECRET,
      scope: "computer",
      origin: "https://webmcp-computer.example",
      workspace: WORKSPACE_ID,
      now: 1_100,
    })).toEqual(expect.objectContaining({
      workspace: WORKSPACE_ID,
      expiresAt: 1_900,
    }));
  });

  test("starts a fresh compute lease for the same machine and workspace after capability expiry", async () => {
    const first = await handleRequest(sessionRequest(), env(), {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    const firstBody = await first.clone().json() as Record<string, unknown>;
    const restarted = await handleRequest(sessionRequest(cookieHeader(first)), env(), {
      now: () => 1_901,
      randomWorkspaceId: () => "fedcba9876543210fedcba9876543210",
    });
    const restartedBody = await restarted.json() as Record<string, unknown>;

    expect(restartedBody.workspaceId).toBe(WORKSPACE_ID);
    expect(restartedBody.machineId).toBe(WORKSPACE_ID);
    expect(restartedBody.capability).not.toBe(firstBody.capability);
    expect(restartedBody.expiresAt).toBe(2_801);
  });

  test("does not accept a tampered long-lived machine identity", async () => {
    const first = await handleRequest(sessionRequest(), env(), {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    const machine = cookieHeader(first).split("; ").find((cookie) => cookie.startsWith("webmcp_computer_machine="));
    if (!machine) throw new Error("test: missing machine identity cookie");
    const replacement = machine.endsWith("A") ? "B" : "A";
    const tampered = `${machine.slice(0, -1)}${replacement}`;
    const nextWorkspace = "fedcba9876543210fedcba9876543210";

    const response = await handleRequest(sessionRequest(tampered), env(), {
      now: () => 1_100,
      randomWorkspaceId: () => nextWorkspace,
    });

    expect((await response.json() as { workspaceId: string }).workspaceId).toBe(nextWorkspace);
  });

  test("reuses the same anonymous session across reloads", async () => {
    const first = await handleRequest(sessionRequest(), env(), {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    const firstBody = await first.clone().json() as Record<string, unknown>;
    const second = await handleRequest(sessionRequest(cookieHeader(first)), env(), { now: () => 1_100 });
    const secondBody = await second.json() as Record<string, unknown>;

    expect(secondBody.workspaceId).toBe(WORKSPACE_ID);
    expect(secondBody.capability).toBe(firstBody.capability);
    expect(secondBody.expiresAt).toBe(1_900);
    expect(second.headers.get("Set-Cookie")).toBeNull();
  });

  test("renews a nearly-expired capability without changing workspace", async () => {
    const first = await handleRequest(sessionRequest(), env(), {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    const firstBody = await first.clone().json() as Record<string, unknown>;
    const renewed = await handleRequest(sessionRequest(cookieHeader(first)), env(), { now: () => 1_875 });
    const renewedBody = await renewed.json() as Record<string, unknown>;

    expect(renewedBody.workspaceId).toBe(WORKSPACE_ID);
    expect(renewedBody.capability).not.toBe(firstBody.capability);
    expect(renewedBody.expiresAt).toBe(2_775);
    expect(renewed.headers.get("Set-Cookie")).toContain("Max-Age=900");
  });

  test("replaces invalid cookies with a clean demo session", async () => {
    const response = await handleRequest(
      sessionRequest("webmcp_computer_demo_session=invalid"),
      env(),
      { now: () => 1_000, randomWorkspaceId: () => WORKSPACE_ID },
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { workspaceId: string }).workspaceId).toBe(WORKSPACE_ID);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=900");
  });

  test("fails closed when signed Worker configuration is incomplete", async () => {
    const broken = env();
    broken.GATEWAY_SIGNING_SECRET = "short";
    const response = await handleRequest(sessionRequest(), broken, {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "demo session broker is unavailable" });

    const insecure = env();
    insecure.COMPUTER_WORKER_URL = "http://computer.example";
    const insecureResponse = await handleRequest(sessionRequest(), insecure, {
      now: () => 1_000,
      randomWorkspaceId: () => WORKSPACE_ID,
    });
    expect(insecureResponse.status).toBe(500);
  });

  test("passes assets through and rejects non-GET session requests", async () => {
    const asset = await handleRequest(new Request("https://webmcp-computer.example/app.js"), env());
    expect(await asset.text()).toBe("asset");

    const method = await handleRequest(new Request("https://webmcp-computer.example/api/session", {
      method: "POST",
    }), env());
    expect(method.status).toBe(405);
    expect(await method.json()).toEqual({ error: "method not allowed" });
  });
});

describe("Sites response hardening", () => {
  test("adds security headers to assets and API responses", async () => {
    const asset = await handleRequest(new Request("https://webmcp-computer.example/app.js"), env());
    expect(asset.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(asset.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const session = await handleRequest(sessionRequest(), env());
    expect(session.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
  });

});
