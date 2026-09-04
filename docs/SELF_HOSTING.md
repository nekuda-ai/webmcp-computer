# Self-host WebMCP Computer

WebMCP Computer separates public UI hosting, session brokering, and Cloudflare runtime
resources. Repository contains both OpenAI Sites adapter and Cloudflare Worker
templates. No deployment credential or visitor identifier belongs in source.

## Architecture

```text
browser
  | same-origin /api/session
  v
site backend + anonymous session broker
  | short-lived HMAC capability
  +--------------------------+
  |                          |
  v                          v
Browser Session Worker       Computer Worker
  |                          |-- Durable Object SQLite workspace
  v                          |-- Cloudflare Container
Cloudflare Browser Run       +-- R2 published sites
```

Every visitor receives a random, cookie-backed workspace and a 15-minute
capability bound to the site origin. No sign-in or provider identity is used.
Browser and Computer Workers verify signature, expiry, scope, origin, and
workspace before touching paid resources. Public `GET /s/{id}/...` URLs remain
readable without authorization by design.

## 1. Create shared gateway secret

Generate one high-entropy value:

```sh
openssl rand -base64 48
```

Store same value as `GATEWAY_SIGNING_SECRET` in:

- site backend secret store;
- Browser Session Worker secret store;
- Computer Worker secret store.

Never use a `VITE_` variable for this secret. `VITE_` values ship to browser.

## 2. Deploy Cloudflare resources

Prerequisites: Cloudflare account with Workers, Browser Rendering, R2, Durable
Objects, and Containers access; Wrangler authenticated for that account; a Docker-
compatible daemon for the Computer image build (Docker Desktop or Colima both work;
wrangler builds for `linux/amd64`).

Both Wrangler configs carry a top-level (production) target and an `env.staging`
target with its own Worker name (`-staging` suffix), custom domain, Durable Object
namespace, R2 bucket, and rate-limit namespaces. Add `--env staging` to every
`wrangler secret put` and `wrangler deploy` below to provision staging instead. Change
the `routes` patterns to hostnames on a zone in your account, or delete them to use
`workers.dev` only. Set `PUBLIC_SITE_ORIGIN` to that environment's exact `workers.dev`
HTTPS origin (for example, `https://<worker>.<account-subdomain>.workers.dev`, with no
path, query, fragment, or trailing slash). The Worker rejects custom domains here so
anonymous user content can never inherit your trusted app domain. Only local development
requests on localhost/loopback and automated requests on `.test` hosts may omit the value
and deliberately use their request origin.

Create Browser Rendering API token with only Browser Rendering Edit permission.
This runtime token is separate from Wrangler deployment authentication.

```sh
cd workers/browser-session
bun install
bunx wrangler secret put CF_ACCOUNT_ID
bunx wrangler secret put BROWSER_RENDERING_API_TOKEN
bunx wrangler secret put GATEWAY_SIGNING_SECRET
bunx wrangler deploy
```

Create R2 bucket named by `workers/computer/wrangler.jsonc`, then deploy Computer:

```sh
bunx wrangler r2 bucket create webmcp-computer-sites
bunx wrangler r2 bucket lifecycle add webmcp-computer-sites webmcp-computer-published-site-retention sites/ --expire-days 30
cd workers/computer
bun install
bunx wrangler secret put GATEWAY_SIGNING_SECRET
bunx wrangler secret put PUBLIC_SITE_ORIGIN # this environment's https://<worker>.<subdomain>.workers.dev origin
bunx wrangler deploy
```

Wrangler configs declare required secrets, stable `ratelimits` bindings, logs,
SQLite Durable Object migrations, Container, and R2 binding. Change Worker names,
rate-limit namespace IDs, R2 bucket, or container capacity before deploy when
sharing a Cloudflare account with another installation. The workspace Durable Object
also enforces 20 successful publishes per machine per fixed 24-hour accounting window.
R2 lifecycle rule is
required for product's advertised 30-day public-site deletion contract; verify it
with `bunx wrangler r2 bucket lifecycle list webmcp-computer-sites`.

After deploying, run the live smoke against the Computer Worker (one container start,
a few KB of R2):

```sh
cd workers/computer
COMPUTER_WORKER_URL=https://cloud-staging.example GATEWAY_SIGNING_SECRET=... bun smoke-live.ts
```

### Visitor budgets and idle stops

Every paid resource is leased per machine by a Durable Object, with the numbers in
`shared/session-limits.ts` (change them there; site, Workers, and client all import it):

- Remote Chrome: at most one per machine; 2 h per 24-hour accounting window; deleted server-side after
  5 min without a client heartbeat (the client only heartbeats while the human is active
  and the tab is visible). Browser Run's own `keep_alive` is set to its 10-minute maximum
  as a backstop.
- Cloud container: 2 h of running time per 24-hour accounting window; destroyed 5 min after the last
  exec finishes, restarted transparently by the next exec (the filesystem lives in the
  Durable Object, so nothing durable is lost). Cleanup waits for any pending container-to-DO
  filesystem sync, and failed destroys are durably retried while runtime continues charging.
- Every action is rate-limited per signed subject + IP and per IP alone.

Refusals are JSON `{ error, code, retryAfterMs? }` with `code` in `EBUDGET`, `EIDLE`,
`EOWNER`, `ECAPACITY`; the client turns them into plain-language messages.

For custom domains, add each Worker hostname through Cloudflare dashboard or a
Wrangler `routes` entry with `custom_domain: true`. Example hosted-demo names:
`browser.agentlane.dev` and `computer.agentlane.dev`. Use final HTTPS origins in
site backend settings.

## 3. Host site and session broker

### OpenAI Sites

Repository's `web/` app implements the OpenAI Sites adapter:

- `/api/session` creates a random 128-bit workspace without requiring sign-in;
- a signed, HttpOnly, same-site cookie keeps that workspace stable across reloads;
- the response returns Worker URLs, workspace ID, and a 15-minute capability;
- no ChatGPT account identifier, email, or name is requested or stored;
- `web/.openai/hosting.json` needs no D1 binding for the demo session.

Committed `project_id` identifies hosted WebMCP Computer demo. For a separate OpenAI Sites
deployment, create/import your own Site and replace that value with your project ID.
Other hosts ignore `.openai/hosting.json` and can start from `web/.env.example`.

Configure these backend secrets in OpenAI Sites:

| Name | Value |
| --- | --- |
| `GATEWAY_SIGNING_SECRET` | Same generated secret used by both Workers |
| `BROWSER_WORKER_URL` | Browser Worker HTTPS origin |
| `COMPUTER_WORKER_URL` | Computer Worker HTTPS origin |

For a restricted staging deployment, keep the OpenAI Site private and invite only the
accounts that should test it. Access control remains the hosting platform's responsibility;
the application does not interpret identity headers.

Build locally with `cd web && bun install && bun run build`. `bun run dev` serves the
same `/api/session` broker and reads `web/.env` (see `web/.env.example`): point
`VITE_BROWSER_WORKER_URL` / `VITE_COMPUTER_WORKER_URL` at deployed staging Workers and
set `WEBMCP_COMPUTER_DEV_GATEWAY_SIGNING_SECRET` to their gateway secret, or run both
Workers locally on `127.0.0.1:8787` / `127.0.0.1:8788` with the development secret.

### Optional PostHog analytics

Set both `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` in the frontend build environment to
enable pseudonymous typed usage analytics and privacy-masked session replay. If either is
empty, PostHog is not initialized. The project key is intentionally public browser
configuration; never put a personal or administrative PostHog token in a `VITE_` value.
The SDK is bundled (including replay), so no PostHog script origin is needed in CSP; allow
the configured ingestion host in `connect-src`. The integration honors DNT/GPC and does
not expose an application consent setting. See the repository README network disclosure
for the captured/excluded categories.

### Another host

Keep browser contract in `web/src/kernel/hostedSession.ts`. Implement same-origin
`GET /api/session` with the same active-session response shape. Server must:

1. create a random 32-hex workspace ID for a new visitor session;
2. keep it stable with a signed, HttpOnly, same-site cookie;
3. mint a 15-minute capability using `shared/gateway-capability.ts`;
4. return Worker HTTPS origins and capability (plain HTTP is accepted only for
   loopback development).

Never mint capabilities in browser. Never send Cloudflare API token to site host.
Only Browser Worker needs `BROWSER_RENDERING_API_TOKEN`; Computer uses native bindings.

## 4. Operations

- Demo capabilities expire after fifteen minutes; browser refreshes through same-origin
  broker before expiry. That is a token lifetime, not a session limit; the resource
  limits are the per-machine budgets above.
- Rate limits key by pseudonymous signed subject plus client IP, and by client IP
  alone. Cloudflare rate limits are permissive and location-local; use them for abuse
  control, not exact billing quotas.
- See `docs/OPERATIONS.md` for the runbook: deploys, cutover, secrets rotation,
  capacity, cost model, alerts, and published-site takedown.
- Computer filesystem is authoritative in Durable Object SQLite. Container sync
  failures persist retry intent and schedule DO alarm with bounded backoff. Runtime cleanup
  is deferred to that sync deadline and never destroys the container while an intent remains.
- Worker observability is enabled. Alert on 401 spikes, 429 spikes, Browser API
  failures, Container startup failures, and exhausted/lost sync retries.
- Rotate gateway secret across site and both Workers together. Existing
  fifteen-minute capabilities become invalid and clients fetch new ones.
- `@cloudflare/computer` is preview software. Keep dependency pinned, run workerd
  smoke tests before upgrades, and review Cloudflare release notes.
