// Live Browser Run gate. Reuses current Wrangler login in memory; never writes or
// prints its token. Creates one short-lived session, drives CDP, then closes it.

import { mintGatewayCapability } from "../../shared/gateway-capability";
import { createBrowserSession } from "../../web/src/apps/browser/session";

const PORT = 8798;
const API = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://127.0.0.1:5173";
const SECRET = "webmcp-computer-local-development-gateway-secret-do-not-use-in-production";

async function jsonCommand(args: string[]): Promise<any> {
  const process = Bun.spawn(args, { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `${args.join(" ")} failed`);
  return JSON.parse(stdout);
}

const [auth, identity] = await Promise.all([
  jsonCommand(["bunx", "wrangler@4.128.0", "auth", "token", "--json"]),
  jsonCommand(["bunx", "wrangler@4.128.0", "whoami", "--json"]),
]);
if ((auth.type !== "oauth" && auth.type !== "api_token") || typeof auth.token !== "string") {
  throw new Error("Wrangler login did not provide a bearer token");
}
const accountId = process.env.CF_ACCOUNT_ID ??
  (Array.isArray(identity.accounts) && identity.accounts.length === 1 ? identity.accounts[0]?.id : undefined);
if (typeof accountId !== "string") {
  throw new Error("Set CF_ACCOUNT_ID when Wrangler login has zero or multiple accounts");
}

const worker = Bun.spawn(
  ["bunx", "wrangler@4.128.0", "dev", "--port", String(PORT), "--local"],
  {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CF_ACCOUNT_ID: accountId,
      BROWSER_RENDERING_API_TOKEN: auth.token,
      GATEWAY_SIGNING_SECRET: SECRET,
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);

async function ready(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API}/`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("browser Worker never became ready");
}

let session: Awaited<ReturnType<typeof createBrowserSession>> | undefined;
try {
  await ready();
  const capability = await mintGatewayCapability({
    secret: SECRET,
    subject: "local-live-subject",
    workspace: "0123456789abcdef0123456789abcdef",
    origin: ORIGIN,
    scopes: ["browser"],
  });
  session = await createBrowserSession({
    workerBaseUrl: API,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", ORIGIN);
      return fetch(input, { ...init, headers });
    },
    authorization: async () => ({ Authorization: `Bearer ${capability}` }),
    createWebSocket: (url) => new WebSocket(url),
    commandTimeoutMs: 20_000,
  }, "https://example.com/");

  await session.cdp.send("Page.enable");
  const loaded = session.cdp.waitForEvent("Page.loadEventFired", 20_000);
  await session.cdp.send("Page.navigate", { url: "https://example.com/" });
  await loaded;
  const title = await session.cdp.evaluate<string>("identity", "document.title");
  const screenshot = await session.cdp.send<{ data?: string }>("Page.captureScreenshot", {
    format: "jpeg",
    quality: 25,
  });
  if (title !== "Example Domain") throw new Error(`unexpected page title: ${title}`);
  if (typeof screenshot.data !== "string" || screenshot.data.length < 100) {
    throw new Error("browser screenshot was empty");
  }
  if (session.state.status !== "live" || !session.state.liveViewUrl.startsWith("https://")) {
    throw new Error("browser live view was unavailable");
  }
  console.log("live Browser Run: create, CDP navigate, evaluate, screenshot, live view, close — ok");
} finally {
  await session?.close();
  worker.kill();
}
