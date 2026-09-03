// Live smoke against a deployed Computer Worker: mints a capability with the deployment's
// gateway secret and exercises fs, a real container exec (lease + cold start), the exit
// frame's budget, and a publish round-trip on the public site route.
//
// Usage:
//   COMPUTER_WORKER_URL=https://cloud-staging.webmcp.com \
//   GATEWAY_SIGNING_SECRET="<matching-deployment-secret>" \
//   SMOKE_ORIGIN=http://localhost:5173 bun smoke-live.ts
//
// Costs: one container start (seconds of standard-1) and a few KB of R2.

import { mintGatewayCapability } from "../../shared/gateway-capability";

const API = (process.env.COMPUTER_WORKER_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.GATEWAY_SIGNING_SECRET ?? "";
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://localhost:5173";
if (!API || !SECRET) {
  console.error("COMPUTER_WORKER_URL and GATEWAY_SIGNING_SECRET are required");
  process.exit(2);
}

const workspace = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const capability = await mintGatewayCapability({
  secret: SECRET,
  subject: "smoke-live",
  workspace,
  origin: ORIGIN,
  scopes: ["computer"],
  ttlSeconds: 600,
});

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures += 1;
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Authorization: `Bearer ${capability}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json, headers: response.headers };
}

console.log(`smoke-live → ${API} (workspace ${workspace})`);

const unauthorized = await fetch(`${API}/ws/${workspace}/fs`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
check("rejects a request without a capability", unauthorized.status === 401);

const mkdir = await post(`/ws/${workspace}/fs`, { op: "mkdir", path: "/smoke", recursive: true });
check("fs mkdir", mkdir.status === 200 && mkdir.json?.ok === true, mkdir.text);
const write = await post(`/ws/${workspace}/fs`, { op: "write", path: "/smoke/hello.txt", data: btoa("hello from smoke\n") });
check("fs write", write.status === 200, write.text);
const tooBig = await post(`/ws/${workspace}/fs`, { op: "write", path: "/smoke/big.bin", data: "A".repeat(3 * 1_024 * 1_024) });
check("fs write over 2 MB is refused with 413", tooBig.status === 413 && tooBig.json?.code === "EFBIG", tooBig.text);

console.log("  …   exec (container cold start; may take 10-40 s)");
const startedAt = Date.now();
const exec = await post(`/ws/${workspace}/exec`, { command: "cat /workspace/smoke/hello.txt && node --version && python3 --version", timeoutMs: 120_000 });
const elapsed = Math.round((Date.now() - startedAt) / 1_000);
check(`exec streams SSE (${elapsed}s)`, exec.status === 200 && exec.headers.get("content-type")?.startsWith("text/event-stream") === true, exec.text.slice(0, 300));
check("exec stdout contains the file we wrote", exec.text.includes("hello from smoke"), exec.text.slice(0, 500));
const exitLine = exec.text.split("\n").find((line) => line.startsWith("data: {\"code\""));
const exit = exitLine ? JSON.parse(exitLine.slice("data: ".length)) : undefined;
check("exit frame carries code 0 and a budget snapshot", exit?.code === 0 && typeof exit?.budget?.remainingMs === "number", exit ?? exec.text.slice(-400));
if (exit?.budget) console.log(`       budget: ${Math.round(exit.budget.remainingMs / 60_000)} min left, ${Math.round(exit.budget.usedMs / 1_000)} s used`);

const publish = await post(`/ws/${workspace}/publish`, {
  files: [{ path: "index.html", content: "<!doctype html><title>smoke</title><h1>smoke ok</h1>" }],
});
check("publish returns a site URL", publish.status === 200 && typeof publish.json?.url === "string", publish.text);
if (publish.json?.url) {
  const site = await fetch(publish.json.url);
  check("published site is served", site.status === 200 && (await site.text()).includes("smoke ok"));
  check("published site is noindex + sandboxed", site.headers.get("x-robots-tag")?.includes("noindex") === true && site.headers.get("content-security-policy")?.startsWith("sandbox") === true);
  console.log(`       site: ${publish.json.url}`);
}

console.log(failures === 0 ? "smoke-live: all checks passed" : `smoke-live: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
