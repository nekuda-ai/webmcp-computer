import { describe, expect, test } from "bun:test";
import { createHostedSessionClient } from "./hostedSession";

const active = {
  active: true,
  machineId: "0123456789abcdef0123456789abcdef",
  workspaceId: "0123456789abcdef0123456789abcdef",
  capability: "v1.payload.signature",
  expiresAt: 1_900,
  browserWorkerUrl: "https://browser.example",
  computerWorkerUrl: "https://computer.example",
};

function responses(values: unknown[]) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (async () => {
      calls += 1;
      const value = values.shift();
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      return Response.json(value);
    }),
  };
}

describe("hosted demo session client", () => {
  test("loads an active anonymous session and authorizes hosted features", async () => {
    const fixture = responses([active]);
    const client = createHostedSessionClient({ fetch: fixture.fetch, now: () => 1_000 });
    expect(await client.load()).toEqual({
      status: "active",
      machineId: active.machineId,
      workspaceId: active.workspaceId,
      capability: active.capability,
      expiresAt: active.expiresAt,
      browserWorkerUrl: active.browserWorkerUrl,
      computerWorkerUrl: active.computerWorkerUrl,
    });
    expect(await client.authorization("browser")).toEqual({ Authorization: "Bearer v1.payload.signature" });
  });

  test("remembers the public machine ID locally without storing the compute capability", async () => {
    const values = new Map<string, string>();
    const fixture = responses([active]);
    const client = createHostedSessionClient({
      fetch: fixture.fetch,
      now: () => 1_000,
      storage: {
        getItem(key: string) { return values.get(key) ?? null; },
        setItem(key: string, value: string) { values.set(key, value); },
      },
    });

    await client.load();

    expect(values.get("webmcp_computer.machine.id")).toBe(active.machineId);
    expect([...values.values()]).not.toContain(active.capability);
  });

  test("caches the session and refreshes near expiry", async () => {
    let now = 1_000;
    const fixture = responses([active, { ...active, capability: "v1.refreshed.signature", expiresAt: 2_775 }]);
    const client = createHostedSessionClient({ fetch: fixture.fetch, now: () => now });
    expect(await client.authorization("computer")).toEqual({ Authorization: "Bearer v1.payload.signature" });
    expect(fixture.calls()).toBe(1);

    now = 1_875;
    expect(await client.authorization("browser")).toEqual({ Authorization: "Bearer v1.refreshed.signature" });
    expect(fixture.calls()).toBe(2);
  });

  test("fails safe when the broker is unavailable", async () => {
    const fixture = responses([new Response("offline", { status: 503 })]);
    const client = createHostedSessionClient({ fetch: fixture.fetch, now: () => 1_000 });
    expect(await client.load()).toEqual({ status: "unavailable" });
    await expect(client.authorization("browser")).rejects.toThrow("hosted browser session is unavailable");
  });

  test("rejects malformed active payloads", async () => {
    const fixture = responses([
      { ...active, workspaceId: "not-a-workspace" },
      { ...active, browserWorkerUrl: "http://browser.example" },
    ]);
    const client = createHostedSessionClient({ fetch: fixture.fetch, now: () => 1_000 });
    expect(await client.load()).toEqual({ status: "unavailable" });
    expect(await client.load(true)).toEqual({ status: "unavailable" });
  });

  test("permits plain HTTP only for loopback development Workers", async () => {
    const fixture = responses([{
      ...active,
      browserWorkerUrl: "http://127.0.0.1:8787",
      computerWorkerUrl: "http://localhost:8788",
    }]);
    const client = createHostedSessionClient({ fetch: fixture.fetch, now: () => 1_000 });
    expect(await client.load()).toEqual(expect.objectContaining({
      status: "active",
      browserWorkerUrl: "http://127.0.0.1:8787",
      computerWorkerUrl: "http://localhost:8788",
    }));
  });
});
