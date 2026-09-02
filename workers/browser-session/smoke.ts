// Workerd shield gate. Uses fake Cloudflare API token: valid signed request must
// reach upstream auth failure, while missing/invalid capability must fail locally.

import { mintGatewayCapability } from "../../shared/gateway-capability";

const PORT = 8798;
const API = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://127.0.0.1:5173";
const SECRET = "webmcp-computer-local-development-gateway-secret-do-not-use-in-production";

const worker = Bun.spawn([
  "bunx", "wrangler@4.128.0", "dev", "--port", String(PORT), "--local",
  "--var", "CF_ACCOUNT_ID:00000000000000000000000000000000",
  "--var", "BROWSER_RENDERING_API_TOKEN:intentionally-invalid-smoke-token",
  "--var", `GATEWAY_SIGNING_SECRET:${SECRET}`,
], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });

async function ready(): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API}/`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await Bun.sleep(250);
    }
  }
  return false;
}

let failed = false;
function check(label: string, value: boolean, detail?: unknown) {
  console.log(`${value ? "  ok  " : "  FAIL"} ${label}${detail === undefined ? "" : ` — ${String(detail)}`}`);
  if (!value) failed = true;
}

try {
  if (!await ready()) throw new Error("browser Worker never became ready");
  const base = { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" } };
  const missing = await fetch(`${API}/session`, base);
  check("missing capability rejected", missing.status === 401, missing.status);

  const token = await mintGatewayCapability({
    secret: SECRET,
    subject: "local-smoke-subject",
    workspace: "0123456789abcdef0123456789abcdef",
    origin: ORIGIN,
    scopes: ["browser"],
  });
  const authorized = await fetch(`${API}/session`, {
    ...base,
    headers: { ...base.headers, Authorization: `Bearer ${token}` },
    body: "{}",
  });
  check("valid capability reaches Cloudflare API", authorized.status === 401 || authorized.status === 403, authorized.status);
  check("authorized CORS reflects bound origin", authorized.headers.get("Access-Control-Allow-Origin") === ORIGIN);

  const wrongOrigin = await fetch(`${API}/session`, {
    ...base,
    headers: { ...base.headers, Origin: "http://evil.test", Authorization: `Bearer ${token}` },
    body: "{}",
  });
  check("origin replay rejected", wrongOrigin.status === 401, wrongOrigin.status);
} finally {
  worker.kill();
}

process.exit(failed ? 1 : 0);
