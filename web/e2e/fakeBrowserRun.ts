const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SCREENSHOT_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==";

type SocketData = { sessionId: string };

export type FakeBrowserRunState = {
  url: string;
  title: string;
  text: string;
  clickCount: number;
  typedValue: string;
  submitted: boolean;
  siteCallCount: number;
  deleted: boolean;
};

export type FakeBrowserRun = {
  origin: string;
  liveViewUrl: string;
  state: FakeBrowserRunState;
  stop(): Promise<void>;
  waitForDelete(): Promise<void>;
};

const CORS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

function requireExpressionValue(expression: string, value: string, operation: string): void {
  if (!expression.includes(JSON.stringify(value))) {
    throw new Error(`Fake Browser Run ${operation} expression omitted ${JSON.stringify(value)}`);
  }
}

function parseExpressionString(expression: string, prefix: string): string {
  const start = expression.indexOf(prefix);
  const literal = start === -1
    ? undefined
    : /^("(?:\\.|[^"\\])*")/.exec(expression.slice(start + prefix.length))?.[1];
  if (!literal) throw new Error(`Fake Browser Run could not parse expression after ${prefix}`);
  return JSON.parse(literal) as string;
}

function parseExpressionBoolean(expression: string, prefix: string): boolean {
  const start = expression.lastIndexOf(prefix);
  const literal = start === -1
    ? undefined
    : /^(true|false)/.exec(expression.slice(start + prefix.length))?.[1];
  if (!literal) throw new Error(`Fake Browser Run could not parse expression after ${prefix}`);
  return literal === "true";
}

export function startFakeBrowserRun(): FakeBrowserRun {
  const state: FakeBrowserRunState = {
    url: "about:blank",
    title: "Fake Browser Run",
    text: "Fake Browser Run ready",
    clickCount: 0,
    typedValue: "",
    submitted: false,
    siteCallCount: 0,
    deleted: false,
  };
  const deleteWaiters = new Set<() => void>();
  let port = 0;

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (url.pathname === `/cdp/${SESSION_ID}`) {
        if (bunServer.upgrade(request, { data: { sessionId: SESSION_ID } })) return;
        return new Response("websocket upgrade failed", { status: 400, headers: CORS });
      }
      if (request.method === "GET" && url.pathname === "/live") {
        return new Response(
          "<!doctype html><html><head><title>Fake Browser Run</title></head>" +
            "<body style=\"font-family:monospace;background:#e4edf7;color:#16283d\">" +
            "<h1>FAKE BROWSER RUN</h1><p>Visible shared-browser stub</p></body></html>",
          { headers: { "Content-Type": "text/html", ...CORS } },
        );
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await request.json().catch(() => ({})) as { url?: unknown };
        if (typeof body.url === "string") {
          state.url = body.url;
          state.title = `Fake page: ${new URL(body.url).hostname}`;
          state.text = `Fake page loaded at ${body.url}`;
        }
        return json({
          sessionId: SESSION_ID,
          liveViewUrl: `http://127.0.0.1:${port}/rest-live`,
          tabWsUrl: `ws://127.0.0.1:${port}/cdp/${SESSION_ID}`,
          targetId: "fake-target",
          keepAliveMs: 300_000,
        });
      }
      if (request.method === "POST" && url.pathname === `/session/${SESSION_ID}/refresh`) {
        return json({
          sessionId: SESSION_ID,
          liveViewUrl: `http://127.0.0.1:${port}/rest-live-refresh`,
          tabWsUrl: `ws://127.0.0.1:${port}/cdp/${SESSION_ID}`,
          targetId: "fake-target",
          keepAliveMs: 300_000,
        });
      }
      if (request.method === "DELETE" && url.pathname === `/session/${SESSION_ID}`) {
        state.deleted = true;
        for (const resolve of deleteWaiters) resolve();
        deleteWaiters.clear();
        return json({ status: "closed" });
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      message(socket, rawMessage) {
        const request = JSON.parse(String(rawMessage)) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        const respond = (result: unknown) => {
          socket.send(JSON.stringify({ id: request.id, result }));
        };
        if (request.method === "Cloudflare.getLiveView") {
          respond({ devtoolsFrontendUrl: `http://127.0.0.1:${port}/live` });
          return;
        }
        if (request.method === "Page.enable") {
          respond({});
          return;
        }
        if (request.method === "Page.navigate") {
          const nextUrl = request.params?.url;
          if (typeof nextUrl === "string") {
            state.url = nextUrl;
            state.title = `Fake page: ${new URL(nextUrl).hostname}`;
            state.text = `Fake page loaded at ${nextUrl}`;
          }
          respond({ frameId: "fake-frame" });
          socket.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }));
          return;
        }
        if (request.method === "Page.getLayoutMetrics") {
          respond({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } });
          return;
        }
        if (request.method === "Page.captureScreenshot") {
          respond({ data: SCREENSHOT_JPEG_BASE64 });
          return;
        }
        if (request.method !== "Runtime.evaluate") {
          socket.send(JSON.stringify({
            id: request.id,
            error: { code: -32601, message: `unsupported fake CDP method: ${request.method}` },
          }));
          return;
        }

        const expression = request.params?.expression;
        const expressionText = typeof expression === "string" ? expression : "";
        const operation = typeof expression === "string"
          ? /^\/\*verbos:([^*]+)\*\//.exec(expressionText)?.[1]
          : undefined;
        let value: unknown;
        switch (operation) {
          case "identity":
            value = { title: state.title, url: state.url };
            break;
          case "read":
            requireExpressionValue(expressionText, "body", "read");
            value = {
              found: true,
              title: state.title,
              url: state.url,
              text: state.text,
              truncated: false,
            };
            break;
          case "click":
            requireExpressionValue(expressionText, "#mutate", "click");
            state.clickCount += 1;
            state.text = "Fake page clicked";
            value = true;
            break;
          case "type":
            requireExpressionValue(expressionText, "#query", "type");
            state.typedValue = parseExpressionString(expressionText, "element.value = ");
            state.submitted = parseExpressionBoolean(expressionText, "if (");
            value = true;
            break;
          case "site_tools":
            value = {
              supported: true,
              tools: [{
                name: "site_fake_echo",
                description: "Echo one message through fake Browser Run.",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                  additionalProperties: false,
                },
              }],
            };
            break;
          case "site_call":
            state.siteCallCount += 1;
            value = { echoed: "hello from inner site" };
            break;
          default:
            socket.send(JSON.stringify({
              id: request.id,
              error: { code: -32602, message: "missing verbos evaluate marker" },
            }));
            return;
        }
        respond({ result: { value } });
      },
    },
  });
  if (server.port === undefined) {
    void server.stop(true);
    throw new Error("Fake Browser Run did not bind a TCP port");
  }
  port = server.port;

  return {
    origin: `http://127.0.0.1:${port}`,
    liveViewUrl: `http://127.0.0.1:${port}/live`,
    state,
    async waitForDelete() {
      if (state.deleted) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          deleteWaiters.delete(done);
          reject(new Error("Fake Browser Run did not receive session DELETE"));
        }, 10_000);
        const done = () => {
          clearTimeout(timeout);
          resolve();
        };
        deleteWaiters.add(done);
      });
    },
    async stop() {
      await server.stop(true);
    },
  };
}
