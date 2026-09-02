// Local development helper: run Browser Worker using current Wrangler OAuth
// credentials without writing or printing token. Ctrl-C stops Worker.

async function jsonCommand(args: string[]): Promise<any> {
  const child = Bun.spawn(args, { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
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
if (typeof accountId !== "string") throw new Error("Set CF_ACCOUNT_ID when Wrangler login has multiple accounts");

const worker = Bun.spawn(
  ["bunx", "wrangler@4.128.0", "dev", "--port", process.env.PORT ?? "8787", "--local"],
  {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CF_ACCOUNT_ID: accountId,
      BROWSER_RENDERING_API_TOKEN: auth.token,
      GATEWAY_SIGNING_SECRET:
        process.env.GATEWAY_SIGNING_SECRET ??
        "webmcp-computer-local-development-gateway-secret-do-not-use-in-production",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

const stop = () => worker.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exit(await worker.exited);
