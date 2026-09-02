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
Objects, and Containers access; Wrangler authenticated for that account; Docker
available for Computer image build.

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
bunx wrangler deploy
```

Wrangler configs declare required secrets, stable `ratelimits` bindings, logs,
SQLite Durable Object migration, Container, and R2 binding. Change Worker names,
rate-limit namespace IDs, R2 bucket, or container capacity before deploy when
sharing a Cloudflare account with another installation. R2 lifecycle rule is
required for product's advertised 30-day public-site deletion contract; verify it
with `bunx wrangler r2 bucket lifecycle list webmcp-computer-sites`.

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

Build locally with `cd web && bun install && bun run build`. Local Vite uses the
same anonymous session response; local Worker testing should run both Workers
with the same development gateway secret and URLs `127.0.0.1:8787` and
`127.0.0.1:8788`.

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
  broker before expiry.
- Rate limits key by pseudonymous signed subject plus client IP. Cloudflare rate
  limits are permissive and location-local; use them for abuse control, not exact
  billing quotas.
- Computer filesystem is authoritative in Durable Object SQLite. Container sync
  failures persist retry intent and schedule DO alarm with bounded backoff.
- Worker observability is enabled. Alert on 401 spikes, 429 spikes, Browser API
  failures, Container startup failures, and exhausted/lost sync retries.
- Rotate gateway secret across site and both Workers together. Existing
  fifteen-minute capabilities become invalid and clients fetch new ones.
- `@cloudflare/computer` is preview software. Keep dependency pinned, run workerd
  smoke tests before upgrades, and review Cloudflare release notes.
