import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  browserSessionState,
  closeBrowserSession,
  createBrowserSession,
  ensureBrowserSession,
  resetBrowserSessionForTests,
  resolveBrowserWorkerUrl,
  viewportForContainer,
  type BrowserSessionDependencies,
} from "./session";
import type { BrowserWebSocket } from "./cdp";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeSocket extends EventTarget implements BrowserWebSocket {
  readyState: number = WebSocket.OPEN;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly liveViewUrl = "https://live.test/fresh-hour-view") {
    super();
  }

  send(data: string): void {
    const request = JSON.parse(data) as typeof this.sent[number];
    this.sent.push(request);
    if (request.method === "Cloudflare.getLiveView") {
      queueMicrotask(() => this.receive({
        id: request.id,
        result: { devtoolsFrontendUrl: this.liveViewUrl },
      }));
    }
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function descriptor() {
  return {
    sessionId: SESSION_ID,
    liveViewUrl: "https://live.test/rest-five-minute-view",
    tabWsUrl: "ws://browser.test/cdp",
    targetId: "target-1",
    keepAliveMs: 300_000,
  };
}

function setup(responses: Response[], liveViewUrl?: string): {
  calls: Array<{ url: string; init?: RequestInit }>;
  dependencies: BrowserSessionDependencies;
  sockets: FakeSocket[];
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sockets: FakeSocket[] = [];
  return {
    calls,
    sockets,
    dependencies: {
      workerBaseUrl: "http://worker.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        const response = responses.shift();
        if (!response) throw new Error("test: unexpected fetch");
        return response;
      }) as typeof fetch,
      createWebSocket() {
        const socket = new FakeSocket(liveViewUrl);
        sockets.push(socket);
        return socket;
      },
      commandTimeoutMs: 50,
    },
  };
}

afterEach(async () => {
  jest.useRealTimers();
  await resetBrowserSessionForTests();
});

describe("browser session", () => {
  test("uses Cloudflare.getLiveView URL instead of short REST URL", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies, "https://example.com");
    expect(session.state).toEqual({
      status: "live",
      liveViewUrl: "https://live.test/fresh-hour-view",
      sessionId: SESSION_ID,
      targetId: "target-1",
      keepAliveMs: 300_000,
    });
    expect(fake.sockets[0]?.sent[0]).toEqual({
      id: 1,
      method: "Cloudflare.getLiveView",
      params: { mode: "tab", expiresInMs: 3_600_000 },
    });
    await session.close();
  });

  test("rejects non-http live-view URLs from both Worker and CDP", async () => {
    const badWorker = setup([
      Response.json({ ...descriptor(), liveViewUrl: "data:text/html,<script>alert(1)</script>" }),
    ]);
    await expect(createBrowserSession(badWorker.dependencies)).rejects.toThrow(
      "verbos: browser Worker returned an invalid live view URL",
    );
    expect(badWorker.sockets).toEqual([]);

    const badCdp = setup([
      Response.json(descriptor()),
      Response.json({ status: "closed" }),
    ], "javascript:alert(1)");
    await expect(createBrowserSession(badCdp.dependencies)).rejects.toThrow(
      "verbos: browser service returned an invalid live view",
    );
    expect(badCdp.calls.at(-1)?.init?.method).toBe("DELETE");
  });

  test("one websocket drop makes one refresh attempt then ends on failure", async () => {
    const fake = setup([
      Response.json(descriptor()),
      Response.json({ error: "session expired" }, { status: 404 }),
      Response.json({ status: "closed" }),
    ]);
    const session = await createBrowserSession(fake.dependencies);
    const ended = new Promise<string>((resolve) => {
      session.subscribe((state) => {
        if (state.status === "ended") resolve(state.reason);
      });
    });
    fake.sockets[0]?.close();
    expect(await ended).toBe("session expired");
    expect(fake.calls.filter(({ url }) => url.endsWith("/refresh"))).toHaveLength(1);
    await session.close();
  });

  test("close sends best-effort DELETE with keepalive", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies);
    await session.close({ keepalive: true });
    expect(fake.calls.at(-1)).toEqual({
      url: `http://worker.test/session/${SESSION_ID}`,
      init: { method: "DELETE", keepalive: true },
    });
  });

  test("debounces viewport bursts, clamps dimensions, and suppresses no-op sends", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies);
    jest.useFakeTimers();

    session.setViewport(640, 480);
    session.setViewport(4_096, 2_500);
    session.setViewport(3_000, 2_100);
    jest.advanceTimersByTime(299);
    expect(fake.sockets[0]?.sent).toHaveLength(1);
    jest.advanceTimersByTime(1);

    const resize = fake.sockets[0]?.sent[1];
    expect(resize).toEqual({
      id: 2,
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 2_048, height: 2_048, deviceScaleFactor: 0, mobile: false },
    });
    fake.sockets[0]?.receive({ id: resize?.id, result: {} });
    await Promise.resolve();
    await Promise.resolve();

    session.setViewport(3_000, 2_100);
    jest.advanceTimersByTime(300);
    expect(fake.sockets[0]?.sent).toHaveLength(2);
    await session.close();
  });

  test("cancels a pending viewport resize", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies);
    jest.useFakeTimers();

    const cancelResize = session.setViewport(1_000, 700);
    cancelResize();
    jest.advanceTimersByTime(300);

    expect(fake.sockets[0]?.sent).toHaveLength(1);
    await session.close();
  });

  test("retries the same viewport after an override fails", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies);
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    jest.useFakeTimers();

    session.setViewport(1_000, 700);
    jest.advanceTimersByTime(300);
    const firstResize = fake.sockets[0]?.sent[1];
    fake.sockets[0]?.receive({
      id: firstResize?.id,
      error: { message: "viewport unavailable" },
    });
    await Promise.resolve();
    await Promise.resolve();

    session.setViewport(1_000, 700);
    jest.advanceTimersByTime(300);
    const retry = fake.sockets[0]?.sent[2];
    expect(retry?.method).toBe("Emulation.setDeviceMetricsOverride");
    fake.sockets[0]?.receive({ id: retry?.id, result: {} });
    await Promise.resolve();

    warning.mockRestore();
    await session.close();
  });

  test("keeps the session live when a viewport override fails", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies);
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    jest.useFakeTimers();

    session.setViewport(1_000, 700);
    jest.advanceTimersByTime(300);
    const resize = fake.sockets[0]?.sent[1];
    fake.sockets[0]?.receive({
      id: resize?.id,
      error: { message: "viewport unavailable" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.state.status).toBe("live");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("viewport unavailable"),
    );
    warning.mockRestore();
    await session.close();
  });

  test("warns once per connection when viewport overrides fail", async () => {
    const fake = setup([
      Response.json(descriptor()),
      Response.json(descriptor()),
      Response.json({ status: "closed" }),
    ]);
    const session = await createBrowserSession(fake.dependencies);
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    jest.useFakeTimers();

    session.setViewport(1_000, 700);
    jest.advanceTimersByTime(300);
    fake.sockets[0]?.receive({
      id: fake.sockets[0]?.sent[1]?.id,
      error: { message: "first viewport failure" },
    });
    await Promise.resolve();
    await Promise.resolve();

    session.setViewport(1_100, 700);
    jest.advanceTimersByTime(300);
    fake.sockets[0]?.receive({
      id: fake.sockets[0]?.sent[2]?.id,
      error: { message: "second viewport failure" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledTimes(1);

    const reconnected = new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe((state) => {
        if (state.status === "live" && fake.sockets.length === 2) {
          unsubscribe();
          resolve();
        }
      });
    });
    fake.sockets[0]?.close();
    await reconnected;

    session.setViewport(1_200, 700);
    jest.advanceTimersByTime(300);
    fake.sockets[1]?.receive({
      id: fake.sockets[1]?.sent[1]?.id,
      error: { message: "reconnected viewport failure" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledTimes(2);

    warning.mockRestore();
    await session.close();
  });

  test("runtime close after window lifecycle sends DELETE", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    await ensureBrowserSession(undefined, fake.dependencies);
    await closeBrowserSession();
    expect(fake.calls.at(-1)?.url).toBe(`http://worker.test/session/${SESSION_ID}`);
    expect(fake.calls.at(-1)?.init?.method).toBe("DELETE");
  });

  test("runtime state is ended after ensure then close", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    await ensureBrowserSession(undefined, fake.dependencies);
    await closeBrowserSession();
    expect(browserSessionState()).toEqual({ status: "ended", reason: "closed" });
  });

  test("starts ended so a restored Browser window cannot create a session", async () => {
    await resetBrowserSessionForTests();
    expect(browserSessionState()).toEqual({
      status: "ended",
      reason: "session must be started again after reload",
    });
  });

  test("resolves Worker URL by query, storage, env, then default", () => {
    const storage = { getItem: () => "https://stored.test/path" };
    expect(resolveBrowserWorkerUrl({
      search: "?browser_worker=http%3A%2F%2Fquery.test%3A8787",
      storage,
      envUrl: "https://env.test",
      defaultUrl: "https://default.test",
    })).toBe("http://query.test:8787");
    expect(resolveBrowserWorkerUrl({ search: "", storage, envUrl: "https://env.test" }))
      .toBe("https://stored.test");
    expect(resolveBrowserWorkerUrl({
      search: "",
      storage: { getItem: () => null },
      envUrl: "https://env.test/path",
    })).toBe("https://env.test");
    expect(resolveBrowserWorkerUrl({
      search: "",
      storage: { getItem: () => null },
      envUrl: "",
      defaultUrl: "https://default.test/path",
    })).toBe("https://default.test");
  });

  test("allows only loopback query and storage overrides in production", () => {
    expect(resolveBrowserWorkerUrl({
      production: true,
      search: "?browser_worker=http%3A%2F%2F127.0.0.1%3A8787",
      storage: { getItem: () => "https://stored.test" },
      envUrl: "https://env.test",
    })).toBe("http://127.0.0.1:8787");
    expect(resolveBrowserWorkerUrl({
      production: true,
      search: "?browser_worker=https%3A%2F%2Fevil.test",
      storage: { getItem: () => "https://stored.test" },
      envUrl: "https://env.test/path",
    })).toBe("https://env.test");
  });
});

describe("viewportForContainer", () => {
  test("subtracts the live viewer chrome from the container height", () => {
    expect(viewportForContainer(1200, 800)).toEqual({ width: 1200, height: 744 });
  });

  test("returns undefined when the container cannot fit the viewer chrome", () => {
    expect(viewportForContainer(1200, 56)).toBeUndefined();
    expect(viewportForContainer(1200, 20)).toBeUndefined();
  });
});
