import { describe, expect, test } from "bun:test";
import { handleRequest, type Env } from "./index";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function env(createSuccess = true, actionSuccess = true): Env {
  return {
    CF_API_TOKEN: "test-token",
    SESSION_RATE: { async limit() { return { success: createSuccess }; } },
    SESSION_ACTION_RATE: { async limit() { return { success: actionSuccess }; } },
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

function injectedFetch(responses: Array<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("test: unexpected upstream fetch");
    return response;
  };
  return { calls, fetch: fetcher as typeof fetch };
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
        headers: { "CF-Connecting-IP": "192.0.2.1" },
        body: JSON.stringify({ url: "https://example.com/path" }),
      }),
      env(),
      upstream,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json() as Record<string, unknown>).toEqual({
      sessionId: SESSION_ID,
      liveViewUrl: target().devtoolsFrontendUrl,
      tabWsUrl: target().webSocketDebuggerUrl,
      targetId: "target-1",
      keepAliveMs: 300_000,
    });
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0]?.input).toContain("keep_alive=300000&lab=true");
    expect(upstream.calls[0]?.init?.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(upstream.calls[1]?.input).toContain("json/new?url=https%3A%2F%2Fexample.com%2Fpath");
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

  test("rate limits refresh and delete without touching upstream", async () => {
    for (const [method, path] of [
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

  test("validates refresh and delete UUIDs before upstream", async () => {
    for (const [method, path] of [
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

  test("refresh selects page target and delete passes status", async () => {
    const refreshUpstream = injectedFetch([Response.json([{ id: "worker" }, target()])]);
    const refreshed = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}/refresh`, { method: "POST" }),
      env(),
      refreshUpstream,
    );
    expect((await refreshed.json() as { targetId: string }).targetId).toBe("target-1");

    const deleteUpstream = injectedFetch([Response.json({ status: "closed" })]);
    const deleted = await handleRequest(
      new Request(`https://worker.test/session/${SESSION_ID}`, { method: "DELETE" }),
      env(),
      deleteUpstream,
    );
    expect(await deleted.json() as Record<string, unknown>).toEqual({ status: "closed" });
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
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const preflight = await handleRequest(
      new Request("https://worker.test/session", { method: "OPTIONS" }),
      env(),
      upstream,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
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
    const response = await handleRequest(
      new Request("https://worker.test/session", { method: "POST" }),
      env(),
      {
        fetch: (async () => {
          throw new Error("upstream exploded");
        }) as unknown as typeof fetch,
      },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "upstream exploded" });
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
