import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { BROWSER_IDLE_MS } from "../../../../shared/session-limits";
import {
  BROWSER_LAST_URL_KEY,
  browserSessionState,
  closeBrowserSession,
  createBrowserSession,
  ensureBrowserSession,
  isRecentRemoteActivity,
  rememberBrowserUrl,
  remoteActivityProbeExpression,
  rememberedBrowserUrl,
  resetBrowserSessionForTests,
  resolveBrowserWorkerUrl,
  viewportForContainer,
  type BrowserSessionDependencies,
  type BrowserUrlStorage,
} from "./session";
import type { BrowserWebSocket } from "./cdp";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeSocket extends EventTarget implements BrowserWebSocket {
  readyState: number = WebSocket.OPEN;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly liveViewUrl = "https://live.test/fresh-hour-view") {
    super();
  }

  frameId = "frame-1";
  childFrameIds: string[] = [];
  readonly remoteActivityAgeByFrame = new Map<string, number | null>();
  readonly #contexts = new Map<string, number>();
  readonly #contextFrames = new Map<number, string>();

  send(data: string): void {
    const request = JSON.parse(data) as typeof this.sent[number];
    this.sent.push(request);
    if (request.method === "Cloudflare.getLiveView") {
      queueMicrotask(() => this.receive({
        id: request.id,
        result: { devtoolsFrontendUrl: this.liveViewUrl },
      }));
    }
    if (request.method === "Page.getFrameTree") {
      queueMicrotask(() => this.receive({
        id: request.id,
        result: {
          frameTree: {
            frame: { id: this.frameId },
            childFrames: this.childFrameIds.map((id) => ({ frame: { id } })),
          },
        },
      }));
    }
    if (request.method === "Page.createIsolatedWorld") {
      const frameId = String(request.params.frameId);
      let executionContextId = this.#contexts.get(frameId);
      if (executionContextId === undefined) {
        executionContextId = this.#contexts.size + 10;
        this.#contexts.set(frameId, executionContextId);
        this.#contextFrames.set(executionContextId, frameId);
      }
      queueMicrotask(() => this.receive({ id: request.id, result: { executionContextId } }));
    }
    if (request.method === "Runtime.evaluate") {
      queueMicrotask(() => this.receive({
        id: request.id,
        result: {
          result: {
            value: {
              url: this.pageUrl,
              trustedActivityAgeMs: this.remoteActivityAgeByFrame.get(
                this.#contextFrames.get(Number(request.params.contextId)) ?? "",
              ) ?? this.remoteActivityAgeMs,
            },
          },
        },
      }));
    }
  }

  pageUrl = "https://example.com/current";
  remoteActivityAgeMs: number | null = null;

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
    liveViewUrl: "https://live.test/rest-fifteen-minute-view",
    tabWsUrl: "ws://browser.test/cdp",
    targetId: "target-1",
    keepAliveMs: 900_000,
  };
}

function memoryStorage(initial: Record<string, string> = {}): BrowserUrlStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

type FakeTimers = {
  intervals: Array<{ callback: () => void; ms: number }>;
  cleared: unknown[];
  tick(): Promise<void>;
};

function fakeTimers(): FakeTimers & Pick<BrowserSessionDependencies, "setInterval" | "clearInterval"> {
  const intervals: FakeTimers["intervals"] = [];
  const cleared: unknown[] = [];
  return {
    intervals,
    cleared,
    setInterval(callback, ms) {
      const handle = { callback, ms };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
      const index = intervals.indexOf(handle as FakeTimers["intervals"][number]);
      if (index >= 0) intervals.splice(index, 1);
    },
    async tick() {
      for (const { callback } of [...intervals]) callback();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

function setup(
  responses: Response[],
  liveViewUrl?: string,
  extra: Partial<BrowserSessionDependencies> = {},
): {
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
      isEligible: () => true,
      ...extra,
    },
  };
}

type RemoteInputListener = (event: { isTrusted: boolean }) => void;

class FakeRemotePage {
  clock = 0;
  readonly listeners = new Map<string, RemoteInputListener[]>();
  readonly location: { href: string };
  readonly performance = { now: () => this.clock };

  constructor(href: string) {
    this.location = { href };
  }

  addEventListener(type: string, listener: RemoteInputListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  input(type: string, isTrusted: boolean): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ isTrusted });
  }
}

function runRemoteProbe(page: FakeRemotePage, expression: string): unknown {
  return Function("globalThis", `return (${expression});`)(page);
}

afterEach(async () => {
  jest.useRealTimers();
  await resetBrowserSessionForTests();
});

describe("browser session", () => {
  test("remote activity probe accepts only recent trusted input and reinstalls after navigation", () => {
    const expression = remoteActivityProbeExpression(
      "__webmcpComputerTrustedActivity_test",
    );
    const page = new FakeRemotePage("https://example.com/one");

    expect(runRemoteProbe(page, expression)).toEqual({
      url: "https://example.com/one",
      trustedActivityAgeMs: null,
    });
    page.input("pointerdown", false); // DOM .click()/dispatchEvent-style agent input.
    page.input("keydown", false);
    expect(isRecentRemoteActivity(runRemoteProbe(page, expression))).toBe(false);
    expect(page.listeners.get("pointerdown")).toHaveLength(1);

    page.clock = 100;
    page.input("pointermove", true);
    page.clock = 200;
    const recent = runRemoteProbe(page, expression);
    expect(recent).toEqual({ url: "https://example.com/one", trustedActivityAgeMs: 100 });
    expect(isRecentRemoteActivity(recent)).toBe(true);

    page.clock = 100 + BROWSER_IDLE_MS;
    expect(isRecentRemoteActivity(runRemoteProbe(page, expression))).toBe(false);
    expect(isRecentRemoteActivity({ trustedActivityAgeMs: -1 })).toBe(false);
    expect(isRecentRemoteActivity({ trustedActivityAgeMs: Number.NaN })).toBe(false);

    // A navigation gets a new global. The same heartbeat expression installs there,
    // then observes subsequent trusted wheel/touch/pointer/keyboard input.
    const navigated = new FakeRemotePage("https://example.com/two");
    expect(runRemoteProbe(navigated, expression)).toEqual({
      url: "https://example.com/two",
      trustedActivityAgeMs: null,
    });
    navigated.clock = 50;
    navigated.input("wheel", true);
    navigated.clock = 75;
    expect(runRemoteProbe(navigated, expression)).toEqual({
      url: "https://example.com/two",
      trustedActivityAgeMs: 25,
    });
  });

  test("opens webmcp.com for a fresh session unless an explicit URL is supplied", async () => {
    const homepage = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const homepageSession = await createBrowserSession(homepage.dependencies);
    expect(homepage.calls[0]?.init?.body).toBe(JSON.stringify({ url: "https://webmcp.com/" }));
    await homepageSession.close();

    const explicit = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const explicitSession = await createBrowserSession(explicit.dependencies, "https://example.com/path");
    expect(explicit.calls[0]?.init?.body).toBe(JSON.stringify({ url: "https://example.com/path" }));
    await explicitSession.close();
  });

  test("uses Cloudflare.getLiveView URL instead of short REST URL", async () => {
    const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const session = await createBrowserSession(fake.dependencies, "https://example.com");
    expect(session.state).toEqual({
      status: "live",
      liveViewUrl: "https://live.test/fresh-hour-view",
      sessionId: SESSION_ID,
      targetId: "target-1",
      keepAliveMs: 900_000,
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
      "webmcp-computer: browser Worker returned an invalid live view URL",
    );
    expect(badWorker.sockets).toEqual([]);

    const badCdp = setup([
      Response.json(descriptor()),
      Response.json({ status: "closed" }),
    ], "javascript:alert(1)");
    await expect(createBrowserSession(badCdp.dependencies)).rejects.toThrow(
      "webmcp-computer: browser service returned an invalid live view",
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

  test("accepts and exposes idleTimeoutMs and budget when the Worker sends them", async () => {
    const budget = { remainingMs: 1_000, usedMs: 2_000, windowResetsAt: 3_000 };
    const fake = setup([
      Response.json({ ...descriptor(), idleTimeoutMs: 300_000, budget }),
      Response.json({ status: "closed" }),
    ]);
    const session = await createBrowserSession(fake.dependencies);
    expect(session.idleTimeoutMs).toBe(300_000);
    expect(session.budget).toEqual(budget);
    await session.close();

    const legacy = setup([Response.json(descriptor()), Response.json({ status: "closed" })]);
    const legacySession = await createBrowserSession(legacy.dependencies);
    expect(legacySession.idleTimeoutMs).toBeUndefined();
    expect(legacySession.budget).toBeUndefined();
    await legacySession.close();
  });

  test("explains an exhausted browser budget when the Worker refuses a new session", async () => {
    const fake = setup([
      Response.json(
        { error: "budget exhausted", code: "EBUDGET", retryAfterMs: 65 * 60_000 },
        { status: 429 },
      ),
    ]);
    await expect(createBrowserSession(fake.dependencies)).rejects.toThrow(
      "browser time budget (2 h per 24 h) is used up; resets in 1 h 5 min",
    );
    const capacity = setup([Response.json({ error: "no slots", code: "ECAPACITY" }, { status: 503 })]);
    await expect(createBrowserSession(capacity.dependencies)).rejects.toThrow(
      "browser service is at capacity right now; try again in a minute",
    );
  });

  describe("heartbeat", () => {
    test("posts a heartbeat and one CDP activity query each tick while the human is active", async () => {
      const timers = fakeTimers();
      const storage = memoryStorage();
      let active = true;
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ idleTimeoutMs: 300_000, budget: { remainingMs: 10, usedMs: 5, windowResetsAt: 99 } }),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => active, storage });
      const session = await createBrowserSession(fake.dependencies);
      expect(timers.intervals).toHaveLength(1);
      expect(timers.intervals[0]?.ms).toBe(60_000);

      await timers.tick();
      expect(fake.calls[1]).toEqual({
        url: `http://worker.test/session/${SESSION_ID}/heartbeat`,
        init: expect.objectContaining({ method: "POST" }),
      });
      expect(fake.sockets[0]?.sent[1]?.method).toBe("Page.getFrameTree");
      expect(fake.sockets[0]?.sent[2]?.method).toBe("Page.createIsolatedWorld");
      expect(fake.sockets[0]?.sent[2]?.params.worldName).toStartWith(
        "__webmcpComputerTrustedActivity_",
      );
      expect(fake.sockets[0]?.sent[3]?.method).toBe("Runtime.evaluate");
      expect(fake.sockets[0]?.sent[3]?.params.contextId).toBe(10);
      const expression = String(fake.sockets[0]?.sent[3]?.params.expression);
      expect(expression).toStartWith("/*webmcp-computer:heartbeat*/");
      expect(expression).toContain("event?.isTrusted === true");
      expect(expression).toContain("pointermove");
      expect(session.budget).toEqual({ remainingMs: 10, usedMs: 5, windowResetsAt: 99 });
      expect(storage.data.get(BROWSER_LAST_URL_KEY)).toBe("https://example.com/current");

      active = false;
      await timers.tick();
      expect(fake.calls).toHaveLength(2);
      expect(fake.sockets[0]?.sent).toHaveLength(7);
      expect(fake.sockets[0]?.sent[6]?.method).toBe("Runtime.evaluate");
      expect(session.state.status).toBe("live");

      await session.close();
      expect(timers.intervals).toHaveLength(0);
      expect(timers.cleared).toHaveLength(1);
    });

    test("remote recent activity authorizes a beat while stale, absent, and invalid ages do not", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ idleTimeoutMs: BROWSER_IDLE_MS }),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => false });
      const session = await createBrowserSession(fake.dependencies);
      const socket = fake.sockets[0];

      socket!.remoteActivityAgeMs = null;
      await timers.tick();
      socket!.frameId = "frame-after-navigation";
      socket!.remoteActivityAgeMs = BROWSER_IDLE_MS;
      await timers.tick();
      socket!.remoteActivityAgeMs = -1;
      await timers.tick();
      expect(fake.calls).toHaveLength(1);

      socket!.remoteActivityAgeMs = BROWSER_IDLE_MS;
      socket!.childFrameIds = ["child-frame"];
      socket!.remoteActivityAgeByFrame.set("child-frame", BROWSER_IDLE_MS - 1);
      await timers.tick();
      expect(fake.calls[1]?.url).toEndWith(`/session/${SESSION_ID}/heartbeat`);
      const evaluations = fake.sockets[0]?.sent.filter(
        ({ method }) => method === "Runtime.evaluate",
      ) ?? [];
      expect(evaluations).toHaveLength(5);
      expect(evaluations.map(({ params }) => params.contextId)).toEqual([
        10,
        11,
        11,
        11,
        12,
      ]);
      await session.close();
    });

    test("does not query remote activity while the tab is hidden, unfocused, or not owner", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ status: "closed" }),
      ], undefined, {
        ...timers,
        isActive: () => true,
        isEligible: () => false,
      });
      const session = await createBrowserSession(fake.dependencies);
      await timers.tick();
      expect(fake.calls).toHaveLength(1);
      expect(fake.sockets[0]?.sent).toHaveLength(1);
      expect(fake.sockets[0]?.sent[0]?.method).toBe("Cloudflare.getLiveView");
      await session.close();
    });

    test("heartbeats immediately when activity resumes near the idle deadline", async () => {
      const timers = fakeTimers();
      let now = 0;
      let activity = () => {};
      let unsubscribed = false;
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ idleTimeoutMs: 300_000 }),
        Response.json({ status: "closed" }),
      ], undefined, {
        ...timers,
        now: () => now,
        isActive: () => true,
        subscribeActivity(callback) {
          activity = callback;
          return () => { unsubscribed = true; };
        },
      });
      const session = await createBrowserSession(fake.dependencies);
      now = 60_000;
      activity();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(fake.calls[1]?.url).toEndWith(`/session/${SESSION_ID}/heartbeat`);

      // Ordinary activity inside the cadence is throttled.
      now = 60_001;
      activity();
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
      expect(fake.calls).toHaveLength(2);
      await session.close();
      expect(unsubscribed).toBe(true);
    });

    test("aborts an in-flight heartbeat as soon as the tab loses eligibility", async () => {
      const timers = fakeTimers();
      let eligible = true;
      let activity = () => {};
      let heartbeatSignal: AbortSignal | undefined;
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ status: "closed" }),
      ], undefined, {
        ...timers,
        isActive: () => true,
        isEligible: () => eligible,
        subscribeActivity(callback) {
          activity = callback;
          return () => {};
        },
      });
      const baseFetch = fake.dependencies.fetch;
      fake.dependencies.fetch = (async (input, init) => {
        if (String(input).endsWith("/heartbeat")) {
          heartbeatSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            heartbeatSignal?.addEventListener("abort", () => reject(heartbeatSignal?.reason), { once: true });
          });
        }
        return await baseFetch(input, init);
      }) as typeof fetch;
      const session = await createBrowserSession(fake.dependencies);

      await timers.tick();
      expect(heartbeatSignal?.aborted).toBe(false);
      eligible = false;
      activity();
      expect(heartbeatSignal?.aborted).toBe(true);

      await session.close();
    });

    test("ends the session with an idle explanation when the Worker answers EIDLE", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ error: "session released", code: "EIDLE" }, { status: 404 }),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => true });
      const session = await createBrowserSession(fake.dependencies);
      await timers.tick();
      expect(session.state).toEqual({
        status: "ended",
        reason: "browser stopped after 5 minutes of inactivity; open it again to continue",
      });
      expect(timers.intervals).toHaveLength(0);
      expect(fake.calls.filter(({ url }) => url.endsWith("/refresh"))).toHaveLength(0);
      await session.close();
    });

    test("ends the session with the budget reset time when the Worker answers EBUDGET", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ error: "budget", code: "EBUDGET", retryAfterMs: 2 * 60 * 60_000 + 30_000 }, { status: 429 }),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => true });
      const session = await createBrowserSession(fake.dependencies);
      await timers.tick();
      expect(session.state).toEqual({
        status: "ended",
        reason: "browser time budget (2 h per 24 h) is used up; resets in 2 h 1 min",
      });
      await session.close();
    });

    test("keeps the session live across a transient heartbeat failure", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json({ error: "upstream hiccup" }, { status: 502 }),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => true });
      const session = await createBrowserSession(fake.dependencies);
      await timers.tick();
      expect(session.state.status).toBe("live");
      await session.close();
    });

    test("restarts the heartbeat after a refresh reconnect", async () => {
      const timers = fakeTimers();
      const fake = setup([
        Response.json(descriptor()),
        Response.json(descriptor()),
        Response.json({ status: "closed" }),
      ], undefined, { ...timers, isActive: () => true });
      const session = await createBrowserSession(fake.dependencies);
      const first = timers.intervals[0];
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
      expect(timers.cleared).toContain(first);
      expect(timers.intervals).toHaveLength(1);
      expect(timers.intervals[0]).not.toBe(first);
      await session.close();
    });
  });

  describe("last URL", () => {
    test("remembers only sanitized http(s) URLs", () => {
      const storage = memoryStorage();
      rememberBrowserUrl("https://user:pass@example.com/a?token=secret#callback", storage);
      expect(rememberedBrowserUrl(storage)).toBe("https://example.com/a");
      expect(storage.data.get(BROWSER_LAST_URL_KEY)).toBe("https://example.com/a");
      rememberBrowserUrl("javascript:alert(1)", storage);
      rememberBrowserUrl("about:blank", storage);
      rememberBrowserUrl(42, storage);
      expect(rememberedBrowserUrl(storage)).toBe("https://example.com/a");
      expect(rememberedBrowserUrl(memoryStorage({ [BROWSER_LAST_URL_KEY]: "data:text/html,x" }))).toBeUndefined();
      expect(rememberedBrowserUrl(memoryStorage())).toBeUndefined();
      expect(rememberedBrowserUrl(undefined)).toBeUndefined();
    });

    test("ensureBrowserSession resumes at the remembered URL when none is supplied", async () => {
      const storage = memoryStorage({ [BROWSER_LAST_URL_KEY]: "https://example.com/resume" });
      const fake = setup([Response.json(descriptor()), Response.json({ status: "closed" })], undefined, { storage });
      await ensureBrowserSession(undefined, fake.dependencies);
      expect(fake.calls[0]?.init?.body).toBe(JSON.stringify({ url: "https://example.com/resume" }));
      await closeBrowserSession();

      const explicit = setup([Response.json(descriptor()), Response.json({ status: "closed" })], undefined, { storage });
      await ensureBrowserSession("https://example.com/explicit", explicit.dependencies);
      expect(explicit.calls[0]?.init?.body).toBe(JSON.stringify({ url: "https://example.com/explicit" }));
      await closeBrowserSession();

      const fresh = setup([Response.json(descriptor()), Response.json({ status: "closed" })], undefined, {
        storage: memoryStorage(),
      });
      await ensureBrowserSession(undefined, fresh.dependencies);
      expect(fresh.calls[0]?.init?.body).toBe(JSON.stringify({ url: "https://webmcp.com/" }));
      await closeBrowserSession();
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

test("fails loudly when no Worker URL is configured", () => {
  expect(() => resolveBrowserWorkerUrl({
    search: "",
    storage: { getItem: () => null },
    envUrl: "",
  })).toThrow("webmcp-computer: no browser Worker URL is configured");
});
