import { describe, expect, test } from "bun:test";
import { BROWSER_IDLE_MS, BUDGET_WINDOW_MS, BROWSER_BUDGET_MS } from "../../../shared/session-limits";
import { handleRequest, type Env } from "./worker";
import { BrowserLease, type BrowserLeaseLike } from "./lease";
import { memoryLeaseStorage } from "./lease.test";
import { browserRunUpstream } from "./upstream";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

function env(
  createSuccess = true,
  actionSuccess = true,
  options: { createIpSuccess?: boolean; actionIpSuccess?: boolean } = {},
): Env {
  return {
    CF_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    BROWSER_RENDERING_API_TOKEN: "test-token",
    GATEWAY_SIGNING_SECRET: "test-only-gateway-secret-with-at-least-32-characters",
    SESSION_RATE: { async limit() { return { success: createSuccess }; } },
    SESSION_RATE_IP: { async limit() { return { success: options.createIpSuccess ?? true }; } },
    SESSION_ACTION_RATE: { async limit() { return { success: actionSuccess }; } },
    SESSION_ACTION_RATE_IP: { async limit() { return { success: options.actionIpSuccess ?? true }; } },
  };
}

function target() {
  return {
    id: "target-1",
    type: "page",
    devtoolsFrontendUrl: "https://live.browser.run/ui/view?wss=fresh",
    webSocketDebuggerUrl: "wss://live.browser.run/api/devtools/page?jwt=fresh",
  };
}

function injectedFetch(responses: Array<Response>, clock: { now: number } = { now: 0 }) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("test: unexpected upstream fetch");
    return response;
  };
  // One in-memory lease per fixture: the Worker only ever sees one workspace in a test.
  const leases = new Map<string, BrowserLeaseLike>();
  const memory = memoryLeaseStorage();
  return {
    calls,
    fetch: fetcher as typeof fetch,
    alarm: memory.alarm,
    lease(workspace: string, leaseEnv: Env) {
      let lease = leases.get(workspace);
      if (!lease) {
        lease = new BrowserLease(memory.storage, browserRunUpstream(leaseEnv, fetcher), { now: () => clock.now });
        leases.set(workspace, lease);
      }
      return lease;
    },
    async authenticate() {
      return {
        audience: "verbos-cloudflare" as const,
        expiresAt: 2_000,
        issuedAt: 1_000,
        origin: "https://app.test",
        scopes: ["browser" as const],
        subject: "subject-1",
        version: 1 as const,
        workspace: "0123456789abcdef0123456789abcdef",
      };
    },
  };
}

describe("browser session worker", () => {
  test("creates one validated tab and returns capability URLs with CORS", async () => {
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json(target()),
    ]);
    const response = await handleRequest(
      new Request("https://worker.test/session", {
        method: "POST",
        headers: { "CF-Connecting-IP": "192.0.2.1", Origin: "https://app.test" },
        body: JSON.stringify({ url: "https://example.com/path" }),
      }),
      env(),
      upstream,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.test");
    expect(await response.json() as Record<string, unknown>).toEqual({
      sessionId: SESSION_ID,
      liveViewUrl: target().devtoolsFrontendUrl,
      tabWsUrl: target().webSocketDebuggerUrl,
      targetId: "target-1",
      keepAliveMs: 600_000,
      idleTimeoutMs: BROWSER_IDLE_MS,
      budget: { remainingMs: BROWSER_BUDGET_MS, usedMs: 0, windowResetsAt: BUDGET_WINDOW_MS },
    });
    expect(upstream.alarm()).toBe(BROWSER_IDLE_MS);
    expect(upstream.calls).toHaveLength(2);
    // Browser Run caps keep_alive at ten minutes; asking for more was silently clamped.
    expect(upstream.calls[0]?.input).toContain("keep_alive=600000&lab=true");
    expect(upstream.calls[0]?.init?.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(upstream.calls[1]?.input).toContain("json/new?url=https%3A%2F%2Fexample.com%2Fpath");
  });

  test("fails closed when the Browser Rendering token is not configured", async () => {
    const upstream = injectedFetch([]);
    const missingTokenEnv = env();
    missingTokenEnv.BROWSER_RENDERING_API_TOKEN = undefined;

    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      missingTokenEnv,
      upstream,
    );

    expect(response.status).toBe(502);
    expect(await response.json() as unknown).toEqual({ error: "browser rendering API token is not configured" });
    expect(upstream.calls).toEqual([]);
  });

  test("rejects non-http URLs before upstream", async () => {
    const upstream = injectedFetch([]);
    const response = await handleRequest(
      new Request("https://worker.test/session", {
        method: "POST",
        body: JSON.stringify({ url: "file:///etc/passwd" }),
      }),
      env(),
      upstream,
    );
    expect(response.status).toBe(400);
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "url must use http or https" });
    expect(upstream.calls).toEqual([]);
  });

  test("rate limits create without touching upstream", async () => {
    const upstream = injectedFetch([]);
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(false),
      upstream,
    );
    expect(response.status).toBe(429);
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "rate limited" });
  });

  test("rate limits heartbeat, refresh, and delete without touching upstream", async () => {
    for (const [method, path] of [
      ["POST", `/session/${SESSION_ID}/heartbeat`],
      ["POST", `/session/${SESSION_ID}/refresh`],
      ["DELETE", `/session/${SESSION_ID}`],
    ] as const) {
      const upstream = injectedFetch([]);
      const response = await handleRequest(
        new Request(`https://worker.test${path}`, { method }),
        env(true, false),
        upstream,
      );
      expect(response.status).toBe(429);
      expect(await response.json() as Record<string, unknown>).toEqual({ error: "rate limited" });
      expect(upstream.calls).toEqual([]);
    }
  });

  test("validates heartbeat, refresh, and delete UUIDs before upstream", async () => {
    for (const [method, path] of [
      ["POST", "/session/not-a-uuid/heartbeat"],
      ["POST", "/session/not-a-uuid/refresh"],
      ["DELETE", "/session/not-a-uuid"],
    ] as const) {
      const upstream = injectedFetch([]);
      const response = await handleRequest(
        new Request(`https://worker.test${path}`, { method }),
        env(),
        upstream,
      );
      expect(response.status).toBe(400);
      expect(await response.json() as Record<string, unknown>).toEqual({ error: "invalid session id" });
      expect(upstream.calls).toEqual([]);
    }
  });

  test("refresh selects page target and delete passes status for the held session", async () => {
    const clock = { now: 0 };
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json(target()),
      Response.json([{ id: "worker" }, target()]),
      Response.json({ status: "closed" }),
    ], clock);
    expect((await handleRequest(new Request("https://worker.test/session", { method: "POST" }), env(), upstream)).status).toBe(200);

    clock.now = 60_000;
    const refreshed = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}/refresh`, { method: "POST" }),
      env(),
      upstream,
    );
    const refreshedBody = await refreshed.json() as { targetId: string; budget: { usedMs: number } };
    expect(refreshedBody.targetId).toBe("target-1");
    expect(refreshedBody.budget.usedMs).toBe(60_000);

    const deleted = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}`, { method: "DELETE" }),
      env(),
      upstream,
    );
    expect(await deleted.json() as Record<string, unknown>).toEqual({
      status: "closed",
      budget: { remainingMs: BROWSER_BUDGET_MS - 60_000, usedMs: 60_000, windowResetsAt: BUDGET_WINDOW_MS },
    });
    expect(upstream.alarm()).toBeNull();
  });

  test("heartbeat extends the held session and reports EIDLE once the server released it", async () => {
    const clock = { now: 0 };
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json(target()),
      Response.json({ status: "closed" }),
    ], clock);
    await handleRequest(new Request("https://worker.test/session", { method: "POST" }), env(), upstream);

    clock.now = 4 * 60_000;
    const beat = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}/heartbeat`, { method: "POST" }),
      env(),
      upstream,
    );
    expect(beat.status).toBe(200);
    expect(await beat.json() as unknown).toEqual({
      idleTimeoutMs: BROWSER_IDLE_MS,
      budget: { remainingMs: BROWSER_BUDGET_MS - 4 * 60_000, usedMs: 4 * 60_000, windowResetsAt: BUDGET_WINDOW_MS },
    });
    expect(upstream.alarm()).toBe(9 * 60_000);

    // Silence: the lease's alarm deletes the upstream Chrome; the next heartbeat learns that.
    clock.now = 9 * 60_000;
    const lease = upstream.lease("0123456789abcdef0123456789abcdef", env()) as BrowserLease;
    expect(await lease.onAlarm()).toBe("stopped-idle");
    expect(upstream.calls.at(-1)?.init?.method).toBe("DELETE");
    const late = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}/heartbeat`, { method: "POST" }),
      env(),
      upstream,
    );
    expect(late.status).toBe(404);
    expect(await late.json() as unknown).toEqual({ error: "browser session is no longer held; start a new one", code: "EIDLE" });
  });

  test("refuses actions on a session this machine does not hold without touching upstream", async () => {
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json(target()),
    ]);
    await handleRequest(new Request("https://worker.test/session", { method: "POST" }), env(), upstream);
    for (const [method, path] of [
      ["POST", `/session/${OTHER_SESSION_ID}/heartbeat`],
      ["POST", `/session/${OTHER_SESSION_ID}/refresh`],
      ["DELETE", `/session/${OTHER_SESSION_ID}`],
    ] as const) {
      const response = await handleRequest(new Request(`https://worker.test${path}`, { method }), env(), upstream);
      expect(response.status).toBe(403);
      expect(await response.json() as unknown).toEqual({ error: "browser session belongs to another machine", code: "EOWNER" });
    }
    expect(upstream.calls).toHaveLength(2);
  });

  test("refuses a new session with 429 EBUDGET and Retry-After once the machine's budget is spent", async () => {
    const clock = { now: 0 };
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json(target()),
      Response.json({ status: "closed" }),
    ], clock);
    await handleRequest(new Request("https://worker.test/session", { method: "POST" }), env(), upstream);
    clock.now = BROWSER_BUDGET_MS + 1;
    const refused = await handleRequest(new Request("https://worker.test/session", { method: "POST" }), env(), upstream);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe(String(Math.ceil((BUDGET_WINDOW_MS - BROWSER_BUDGET_MS - 1) / 1_000)));
    const body = await refused.json() as { code: string };
    expect(body.code).toBe("EBUDGET");
    expect(upstream.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  test("rate limits per IP even when the signed subject is fresh", async () => {
    const create = injectedFetch([]);
    const created = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(true, true, { createIpSuccess: false }),
      create,
    );
    expect(created.status).toBe(429);
    expect(create.calls).toEqual([]);

    const action = injectedFetch([]);
    const beat = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}/heartbeat`, { method: "POST" }),
      env(true, true, { actionIpSuccess: false }),
      action,
    );
    expect(beat.status).toBe(429);
    expect(action.calls).toEqual([]);
  });

  test("returns 404 and preflight CORS without upstream", async () => {
    const upstream = injectedFetch([]);
    const missing = await handleRequest(
      new Request("https://worker.test/unknown"),
      env(),
      upstream,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json() as Record<string, unknown>).toEqual({ error: "not found" });
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const preflight = await handleRequest(
      new Request("https://worker.test/session", { method: "OPTIONS", headers: { Origin: "https://app.test" } }),
      env(),
      upstream,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  test("passes upstream status with a one-line error", async () => {
    const upstream = injectedFetch([
      Response.json({ errors: [{ message: "quota\nexceeded" }] }, { status: 503 }),
    ]);
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      upstream,
    );
    expect(response.status).toBe(503);
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "quota exceeded" });
  });

  test("truncates upstream errors to 200 characters", async () => {
    const upstream = injectedFetch([
      Response.json({ error: `quota\n${"x".repeat(300)}` }, { status: 503 }),
    ]);
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      upstream,
    );
    const body = await response.json() as { error: string };
    expect(body.error).toHaveLength(200);
    expect(body.error).not.toContain("\n");
  });

  test("turns thrown upstream failures into a CORS JSON 502", async () => {
    const exploding = (async () => {
      throw new Error("upstream exploded");
    }) as unknown as typeof fetch;
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST", headers: { Origin: "https://app.test" } }),
      env(),
      {
        ...injectedFetch([]),
        fetch: exploding,
        lease: (_workspace, leaseEnv) => new BrowserLease(memoryLeaseStorage().storage, browserRunUpstream(leaseEnv, exploding)),
      },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.test");
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "upstream exploded" });
  });

  test("rejects missing capability before rate limits or upstream", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/session", {
        method: "POST",
        headers: { Origin: "https://app.test" },
      }),
      env(),
    );
    expect(response.status).toBe(401);
    expect(await response.json() as unknown).toEqual({ error: "unauthorized" });
  });

  test("retains and retries a session when failed setup cannot clean it up", async () => {
    const clock = { now: 0 };
    const upstream = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json({ error: "tab failed" }, { status: 503 }),
      Response.json({ error: "close failed" }, { status: 500 }),
      Response.json({ status: "closed" }),
    ], clock);
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      upstream,
    );
    expect(response.status).toBe(503);
    expect(upstream.alarm()).toBe(30_000);

    clock.now = 30_000;
    const lease = upstream.lease("0123456789abcdef0123456789abcdef", env()) as BrowserLease;
    expect(await lease.onAlarm()).toBe("stopped-requested");
    expect(upstream.calls[3]?.init?.method).toBe("DELETE");
    expect(upstream.alarm()).toBeNull();
  });

  test("cleans up a created session when tab creation or payload validation fails", async () => {
    const failedTarget = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json({ error: "tab failed" }, { status: 503 }),
      Response.json({ status: "closed" }),
    ]);
    const failedResponse = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      failedTarget,
    );
    expect(failedResponse.status).toBe(503);
    expect(failedTarget.calls[2]?.init?.method).toBe("DELETE");

    const invalidTarget = injectedFetch([
      Response.json({ sessionId: SESSION_ID }),
      Response.json({ ...target(), devtoolsFrontendUrl: "javascript:alert(1)" }),
      Response.json({ status: "closed" }),
    ]);
    const invalidResponse = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      invalidTarget,
    );
    expect(invalidResponse.status).toBe(502);
    expect(invalidTarget.calls[2]?.init?.method).toBe("DELETE");
  });
});
