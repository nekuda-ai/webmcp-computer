# Shared browser — Cloudflare Browser Run live view

> Historical implementation spec. Current protected demo deployment and
> self-host contract live in `docs/SELF_HOSTING.md` and supersede old open-CORS,
> embedded-account, and unauthenticated endpoint notes below.

## Goal

A Browser app whose window shows a **real Chrome running on Cloudflare's network**
(Browser Run). The human sees the live page and can click and type in it directly; the
agent drives the *same* browser session through new WebMCP tools over CDP. Two users,
one computer — now literally extended to the open web.

## Why (challenge framing)

The thesis made physical: human and agent share one real browser inside the OS, both
acting, both seeing everything. Bonus discovery from the spike: Browser Run's **lab pool
runs Chrome with WebMCP enabled**, so when the shared remote browser visits a
WebMCP-enabled site, the agent can list and call *that site's* tools through WebMCP Computer —
WebMCP driving WebMCP. Nothing else in the challenge field will look like this.

## Spike facts (verified live 2026-08-28 — build on these, do not re-derive)

- `POST https://api.cloudflare.com/client/v4/accounts/{acc}/browser-rendering/devtools/browser?keep_alive=<ms>&lab=true`
  (Bearer auth) → `{ sessionId, webSocketDebuggerUrl }`. The browser-level ws requires
  the Authorization header — server-side only.
- `PUT …/devtools/browser/{sessionId}/json/new?url=<enc>` (Bearer auth) → target JSON
  with `devtoolsFrontendUrl` (https://live.browser.run/ui/view?wss=…) and
  `webSocketDebuggerUrl` (wss://live.browser.run/api/devtools/browser/{sessionId}/p…?jwt=…).
  **The tab-level ws URL is capability-bearing: a plain browser `WebSocket` connects with
  no headers.** JWTs expire (~5 min default), so connect promptly after minting.
- `GET …/devtools/browser/{sessionId}/json/list` (Bearer) → same target shape; use it to
  re-mint fresh capability URLs for an existing session.
- `DELETE …/devtools/browser/{sessionId}` (Bearer) → `{ "status": "closed" }`.
- `https://live.browser.run/ui/view` responds `content-security-policy: frame-ancestors *`
  → **iframe embedding works**. The live view is interactive (human can click/type).
- On the tab-level ws, `Cloudflare.getLiveView { targetId?, mode: "tab", expiresInMs }`
  (max 1h) returns a fresh `devtoolsFrontendUrl`. `Page.captureScreenshot` works.
- Lab pool Chrome exposes `navigator.modelContextTesting` with `listTools()`,
  `executeTool(name, jsonString)`, `ontoolchange`. `listTools()` returns an array of
  tool descriptors. (`navigator.modelContext` is the page-author side; absent on
  opaque origins like `data:` URLs.)
- No account-level session-list or limits REST endpoint exists — cost control must be
  rate limiting + short keep_alive, not concurrency queries.

## Design

### Part 1 — session Worker (`workers/browser-session/`)

A deliberately tiny Cloudflare Worker whose job is to hold Browser Rendering credentials
and mint capability-bearing session handles for tabs.

- Own folder at repo root: `wrangler.jsonc` (name `webmcp-computer-browser-session`, no embedded
  account ID, `workers_dev: true`), `src/index.ts`,
  `package.json` (only `wrangler` + `@cloudflare/workers-types` dev-deps), `tsconfig.json`,
  `bun run check` = `tsc --noEmit`. Not wired into `web/` build.
- Secrets `CF_ACCOUNT_ID`, `BROWSER_RENDERING_API_TOKEN` (Browser Rendering Edit), and
  shared `GATEWAY_SIGNING_SECRET`. Never logged, never returned.
- Endpoints (JSON; CORS `Access-Control-Allow-Origin: *`, `OPTIONS` preflight handled —
  capability URLs are per-session and rate-limited, so open CORS is acceptable and keeps
  the static-host story simple):
  - `POST /session` with optional `{ url }` → create Browser Run session
    (`keep_alive=900000`, `lab=true`), open one tab (`url` validated http/https, default
    `about:blank`), respond
    `{ sessionId, liveViewUrl, tabWsUrl, targetId, keepAliveMs }` where `liveViewUrl` /
    `tabWsUrl` come from the target JSON.
  - `POST /session/{id}/refresh` → `json/list`, respond the same shape for the first
    page target (re-mints fresh JWT URLs after expiry/disconnect).
  - `DELETE /session/{id}` → close upstream, pass through `{ status }`.
  - Anything else → 404 `{ error }`.
- Cost control: Workers **Rate Limiting binding** — per-IP `{ limit: 4, period: 60 }` on
  `POST /session`; on trip respond 429 `{ error: "rate limited" }`. Combined with
  `keep_alive=900000` (15 min idle timeout) and explicit close-on-window-close this bounds
  worst-case concurrent sessions at demo scale. Refresh/delete use a second coarser
  per-IP limit of `{ limit: 30, period: 60 }`.
- Upstream non-2xx → pass status + a one-line `{ error }` through (client renders it).
- Session ids in paths validated as UUIDs before touching upstream.

### Part 2 — Browser app (`web/src/apps/browser/`)

- `AppId` gains `"browser"`. **Singleton** (one shared session per visitor — that is the
  demo story and the cost story). `APP_SIZES`: 960×640. Registry name `"Browser"`; new
  globe icon in `apps/icons.tsx` (consistent stroke style).
- Window content states (all rendered in OS chrome, design-token styled):
  1. `connecting` — mono microlabel while the Worker call + ws connect run.
  2. `live` — the live-view iframe fills the window
     (`referrerPolicy="no-referrer"`, `allow=""`, no sandbox attr — it is Cloudflare's
     own UI on a third-party origin; do NOT add `allow-same-origin` reasoning here, the
     frame is cross-origin by nature). Both REST and CDP live-view values must parse as
     http/https before becoming `src`. Human clicks/typing go straight into the remote
     Chrome — that is the human's half of the shared browser.
  3. `ended` — "SESSION ENDED" state with the reason (idle timeout, closed, error) and a
     hint that `browser_open` / the dock icon starts a fresh one. A human-clickable
     "NEW SESSION" button (with `VerbHint` for `browser_open`) restarts.
- Session lifecycle module `web/src/apps/browser/session.ts` (pure TS, no React):
  - `createBrowserSession(deps)` — fetch Worker `POST /session`, connect `tabWsUrl` via
    an injected WebSocket factory, then immediately
    `Cloudflare.getLiveView { mode: "tab", expiresInMs: 3600000 }` and use **that** URL
    for the iframe (1h ≫ session life, so no refresh loop needed).
  - On ws close/error: one `refresh` attempt (Worker `POST /session/{id}/refresh`,
    reconnect); if that fails → state `ended`. Idle keep_alive expiry lands here too.
  - Window close (`app_close`, dock, chrome ✕) → best-effort `DELETE /session/{id}` +
    ws close. Page `beforeunload`/`pagehide` also best-effort-DELETEs (keepalive fetch) —
    don't rely on it, keep_alive is the backstop.
  - A restored Browser window starts in `ended`; reload never creates a billable session
    until a human or agent explicitly starts one again.
  - Worker base URL resolution (in order): URL query `?browser_worker=<origin>` →
    `localStorage["webmcp_computer.browser_worker"]` → `import.meta.env.VITE_BROWSER_WORKER_URL`
    → hardcoded production default. Production builds accept query/storage overrides
    only for `127.0.0.1` or `localhost`. Document the override in the repo README dev
    section only (it is a dev/test hook, not a product surface).
- CDP client `web/src/apps/browser/cdp.ts` (pure TS): promise-per-id request/response
  over an injected WebSocket, event listeners, connection-state callbacks, 10s
  per-command timeout. Every `Runtime.evaluate` expression the client sends **starts
  with a marker comment** `/*webmcp-computer:<op>*/` (`identity`, `read`, `click`, `type`,
  `site_tools`, `site_call`) — this makes the e2e fake honest (it dispatches on the
  marker, not on fragile expression matching) and aids debugging in the remote console.

### Part 3 — tools

Static boot tool (in `src/tools/`, registered with the other boot tools):

- `browser_open` — intent `act`, stableKey `webmcp_computer.browser_open`. Input: `url?`
  (http/https), `x`/`y`/`width`/`height`/`focus` like `app_open`. If no Browser window:
  create session via Worker, spawn the singleton process, return
  `{ pid, url, keepAliveMs }`. If already open: focus it, `goto` when `url` given, and
  say so in the result. Worker/rate-limit errors surface as
  `webmcp-computer: browser session unavailable: <reason>`.

Per-app dynamic tools (registered while the Browser window is open, via the existing
`useAppTools` pattern; unregistered on close — the count change is the visible heartbeat):

- `browser_goto` (act) — `{ url }` http/https → `Page.navigate`, wait for load event
  (bounded), return `{ url, title }`.
- `browser_read` (ask) — `{ selector? }` → title, URL, and innerText of `selector`
  (default `body`) capped at 32KB with a `truncated: true` flag.
- `browser_click` (act) — `{ selector }` → element `.click()` via evaluate; error names
  the selector when nothing matches.
- `browser_type` (act) — `{ selector, text, submit? }` → focus + set value + input
  events (evaluate), `submit: true` presses Enter. Text ≤ 4KB.
- `browser_screenshot` (ask) — JPEG via `Page.captureScreenshot` (quality 50), returned
  as `{ dataUrl, width, height }`; if the payload would blow the 256KB result cap, retry
  once at quality 25, then error honestly.
- `browser_site_tools` (ask) — inner page's `navigator.modelContextTesting.listTools()`
  → `[{ name, description, inputSchema }]`. On non-lab/undefined API, error
  `webmcp-computer: this browser session has no WebMCP support`.
- `browser_site_call` (act) — `{ name, input }` →
  `executeTool(name, JSON.stringify(input))`, result passed through (≤ 256KB). The
  description must warn the agent that inner-site tools carry their *own* consequences
  and WebMCP Computer cannot classify them.

All descriptions follow house style (visible effect, what it returns, caps, error
voice `webmcp-computer: …`). Every tool call flows through `runAgentAction` → standard agent
event/trace/AgentPresence. The manual documents that the human's live-view interactions
happen inside Cloudflare's frame and are therefore *not* in dmesg — the live view IS the
human's hands, the tools are the agent's.

### Manual + docs

- New agent-skill `docs/agent-skills/browser.md` (seeded like the others): the shared-
  session model, the tool list, the site-tools passthrough, session lifetime (15 min
  idle), the honest limits (no dmesg for human clicks in the remote page; selectors are
  DOM-not-trusted-events).
- Manual topic `browser` in `osManualTool` enum + `manual.ts` + `manualContent.ts`.
- `docs/BRIEF.md` hard rule 2 gains the second documented exception: the Browser app
  talks to our session Worker and `live.browser.run`/`api.cloudflare.com`-minted
  capability URLs, only after a human or agent opens the Browser; the core OS stays
  local-first and static.
- `docs/testing/TEST-CHARTER.md` gains the third sanctioned seam (below).
- `os_search` includes the new tool names.

## Tests (charter rules apply)

New sanctioned seam (add to TEST-CHARTER in the same change): **the external browser
service boundary** — unit tests may inject a fake Worker fetch + fake WebSocket pair
into `session.ts`/`cdp.ts`; e2e must use a real `WebSocket` from the page to a local
fake Browser Run service. The OS's own internals get no new seams.

Unit (`bun test src`):
- `cdp.test.ts`: request/response id matching, command timeout, marker prefixes on
  every evaluate the client emits, event dispatch, close settles pending calls.
- `session.test.ts`: create → live URL comes from `getLiveView` not the 5-min REST URL;
  ws drop → one refresh attempt → ended; window close fires DELETE; worker URL
  resolution order (query > localStorage > env > default).
- `browserTools.test.ts`: schema validation (http/https only, selector required, text
  cap), singleton `browser_open` second-call behavior, screenshot cap retry logic (fake
  transport returning oversized then small), `browser_site_tools` no-WebMCP error,
  dynamic registration tied to window lifecycle (existing per-app tool test pattern).
- Worker logic: pure handlers factored so `bun test` can hit route validation
  (UUID check, url validation, 404, CORS headers) without wrangler; upstream calls
  injected. (Worker folder has its own minimal test run wired into `bun run check`
  there; repo root gate stays `web/` scripts.)

E2E (one dense scenario + `e2e/fakeBrowserRun.ts`):
- Fake service on an ephemeral port (Bun.serve, HTTP + ws): `POST /session` →
  local `liveViewUrl` (serves a visible stub page) + `ws://127.0.0.1:<port>/cdp/<id>`;
  ws speaks the exact protocol subset by dispatching on the `/*webmcp-computer:*/` markers +
  `Page.navigate`/`Page.captureScreenshot`/`Cloudflare.getLiveView`; internal fake page
  state: url, title, text, one clickable that mutates text, one typed field, a site-tool
  registry so `site_tools`/`site_call` round-trip.
- Scenario: `browser_open` with `?browser_worker=` pointing at the fake → window
  appears, iframe src is the fake live URL, dynamic tools appear in the catalog;
  `browser_goto` → `browser_read` reflects the fake page; `browser_click` then
  `browser_read` shows the mutation; `browser_type` + submit; `browser_site_tools`
  lists the fake's tool and `browser_site_call` executes it; `browser_screenshot`
  returns a `data:image/jpeg` URL; dmesg shows the calls; `app_close` → fake records
  the DELETE; tool catalog shrinks back (dynamic unregister).
- Keep the whole suite inside the 90s budget.

`bun test src`, `bun run build`, `bun run test:e2e` must all pass (builder runs the
first two; e2e is the lead's out-of-sandbox gate). `workers/browser-session` has its own
`bun run check` and it must pass.

## Out of scope (follow-ups)

- Multiple tabs / multiple Browser windows.
- Trusted input events (CDP `Input.*` coordinate clicks) — selector-based evaluate is
  v1; note the limitation in the manual.
- Multiple identity-provider adapters beyond provider-neutral `/api/session` contract.
- Session recording, downloads, uploads.
- Cloud kernel — see `cloud-kernel.md`.

## Deploy notes (lead-owned, not part of the build)

- `wrangler deploy` from `workers/browser-session/` on selected Cloudflare account;
  `BROWSER_RENDERING_API_TOKEN` secret must be a durable scoped API token (Account → Browser
  Rendering: Edit) — the interactive OAuth token expires hourly and cannot be the
  secret. Until the secret exists, local verification runs `wrangler dev` with
  `.dev.vars` (gitignored).
- `VITE_BROWSER_WORKER_URL` default points at the deployed workers.dev URL.
