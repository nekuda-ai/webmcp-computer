// Runtime smoke gate: boots the Worker on real workerd (`wrangler dev --local`) and
// exercises every route end to end.
//
// This exists because unit tests inject a plain-object workspace fake at the SDK
// boundary, so they cannot see whether the real Durable Object / RPC path works. Two
// runtime-only defects have shipped past a fully green suite:
//   - an unbound `{ fetch }` dependency ("Illegal invocation")
//   - `Reflect.get(fs, name).bind(fs)` on an RPC stub, which killed every cloud
//     operation with "Could not serialize object of type RpcProperty"
// Every filesystem op is called here for that reason: each one is a separate RPC method,
// and a detached stub method fails only when it is actually invoked.
//
// Usage: bun run smoke   (no network or Cloudflare account needed — DO + R2 are local)

import { mintGatewayCapability } from "../../shared/gateway-capability";

const PORT = 8799;
const API = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://127.0.0.1:5173";
const GATEWAY_SECRET = "webmcp-computer-local-development-gateway-secret-do-not-use-in-production";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

let capability: string | undefined;

async function post(path: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(capability === undefined ? {} : { Authorization: `Bearer ${capability}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const encode = (text: string): string => Buffer.from(text).toString("base64");
const decode = (data: string): string => Buffer.from(data, "base64").toString();

const worker = Bun.spawn(
  [
    "bunx", "wrangler@4.128.0", "dev", "--port", String(PORT), "--local",
    "--var", `GATEWAY_SIGNING_SECRET:${GATEWAY_SECRET}`,
  ],
  { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
);

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API}/`, { signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

try {
  // Cold Docker pulls and first container-image builds can exceed one minute.
  // This gate should fail on Worker readiness, not local image-cache warmth.
  if (!await waitForReady(180_000)) {
    console.error("smoke: worker never became ready");
    process.exit(1);
  }

  const ws = crypto.randomUUID().replaceAll("-", "");
  const fs = (body: unknown) => post(`/ws/${ws}/fs`, body);
  const text = "cloud kernel lives 🌍\n";

  console.log("\nauthentication:");
  check("missing capability rejected", (await fs({ op: "exists", path: "/" })).status === 401);
  capability = await mintGatewayCapability({
    secret: GATEWAY_SECRET,
    subject: "local-smoke-subject",
    workspace: ws,
    origin: ORIGIN,
    scopes: ["computer"],
  });

  console.log("\nfilesystem (every op — each is a distinct RPC method):");
  check("write", (await fs({ op: "write", path: "/a.txt", data: encode(text) })).json?.ok === true);
  const read = await fs({ op: "read", path: "/a.txt" });
  check("read round-trips byte-exact", decode(read.json?.data ?? "") === text, read.json);
  check("exists", (await fs({ op: "exists", path: "/a.txt" })).json?.exists === true);
  const stat = await fs({ op: "stat", path: "/a.txt" });
  check("stat", stat.json?.stat?.isFile === true, stat.json);
  check("mkdir", (await fs({ op: "mkdir", path: "/site", recursive: true })).json?.ok === true);
  const dir = await fs({ op: "readdir", path: "/" });
  check(
    "readdir",
    Array.isArray(dir.json?.entries) && dir.json.entries.some((e: any) => e.name === "site"),
    dir.json,
  );
  check(
    "rename (emulated: SDK has no rename)",
    (await fs({ op: "rename", path: "/a.txt", to: "/site/index.html" })).json?.ok === true,
  );
  check("renamed file readable", decode((await fs({ op: "read", path: "/site/index.html" })).json?.data ?? "") === text);
  check("rm", (await fs({ op: "rm", path: "/site/index.html" })).json?.ok === true);

  console.log("\ncontainer exec + durable sync:");
  const executed = await post(`/ws/${ws}/exec`, {
    command: "printf 'exec-ok' && printf 'synced from container\\n' > /workspace/from-exec.txt",
    cwd: "/workspace",
    timeoutMs: 120_000,
  });
  check(
    "exec streams stdout and zero exit",
    executed.status === 200 && executed.text.includes('event: stdout') &&
      executed.text.includes('exec-ok') && executed.text.includes('"code":0'),
    executed.text,
  );
  const synced = await fs({ op: "read", path: "/from-exec.txt" });
  check("container write syncs to durable workspace", decode(synced.json?.data ?? "") === "synced from container\n", synced.json);

  console.log("\nerror contracts:");
  const missing = await fs({ op: "read", path: "/nope.txt" });
  check("missing file → ENOENT", missing.json?.code === "ENOENT", missing.json);
  const traversal = await fs({ op: "read", path: "/../../etc/passwd" });
  check("traversal rejected", traversal.status === 400 && traversal.json?.code === "EINVAL", traversal.json);
  const badBase64 = await fs({ op: "write", path: "/b.txt", data: "not base64!" });
  check("invalid base64 rejected", badBase64.status === 400, badBase64.json);

  console.log("\nbatch:");
  const batch = await post(`/ws/${ws}/fs/batch`, [
    { op: "readdir", path: "/" },
    { op: "exists", path: "/site" },
  ]);
  check(
    "batch executes every op",
    Array.isArray(batch.json) && batch.json.length === 2 && batch.json.every((r: any) => !r.error),
    batch.json,
  );
  const oversized = await post(
    `/ws/${ws}/fs/batch`,
    Array.from({ length: 129 }, (_, index) => ({ op: "exists", path: `/x${index}` })),
  );
  check("batch cap enforced", oversized.status === 400, oversized.json);

  console.log("\npublish + serve:");
  const anon = await post("/publish", { files: [{ path: "index.html", content: "<h1>anon</h1>" }] });
  check("unscoped publish rejected", anon.status === 404, anon.status);
  const published = await post(`/ws/${ws}/publish`, {
    files: [
      { path: "index.html", content: "<h1>built in WebMCP Computer</h1>" },
      { path: "sub/index.html", content: "<h1>nested</h1>" },
    ],
  });
  check("capability publish", typeof published.json?.url === "string", published.json);
  const url: string = published.json?.url ?? "";
  if (url) {
    const served = await fetch(url);
    const body = await served.text();
    check("served content", served.status === 200 && body.includes("built in WebMCP Computer"));
    check("content-type", (served.headers.get("content-type") ?? "").includes("text/html"));
    check("nosniff", served.headers.get("x-content-type-options") === "nosniff");
    check("directory URL serves index", (await fetch(`${url}sub/`)).status === 200);
    check("traversal on serve route", (await fetch(`${url}../../../etc/passwd`)).status === 404);
  }
  check("unknown site 404s", (await fetch(`${API}/s/zzzzzzzz/`)).status === 404);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) console.log("\nA failure here means the Worker is broken at runtime even if unit tests pass.");
} finally {
  worker.kill();
}

process.exit(failures > 0 ? 1 : 0);
