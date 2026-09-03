# WebMCP Computer

**A full computer that lives inside a browser tab, with WebMCP as its native control layer.**

Today agents operate computers by imitating humans: screenshots, mouse coordinates, typing
into interfaces built for eyes and hands. WebMCP Computer is a computer built for agents as
first-class citizens. Files, processes, applications, windows, and the terminal are exposed
directly as WebMCP tools. The agent gets a sandboxed machine it can understand and control
natively, and the human watches and intervenes through a familiar desktop GUI on the same
screen.

Entry for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

- **Live:** <https://computer.webmcp.com> (open in ChatGPT's browser or Chrome with
  `--enable-features=WebMCP`)
- **License:** MIT (see [LICENSE](./LICENSE))

## What a human and an agent can do together

- Give a coding agent a fresh machine: edit files, run scripts in the in-browser shell,
  serve a folder, and preview the result in a sandboxed window the human can see.
- Run agent-generated code without giving the agent your real computer. Preview and
  agent-made apps run in opaque sandboxed frames inside the tab.
- Let the agent inspect `dmesg`, list and kill processes, change settings, and repair a
  wedged workspace while the human watches every action land.
- Build a small site inside the OS, then let that site register its own WebMCP tools which
  the agent calls through the same surface (WebMCP inside WebMCP).
- Drive a shared remote Chrome from the OS's Browser app and call the remote site's own
  WebMCP tools from inside the sandbox.
- Opt into a real Linux container (git, node, python) for cloning repos and running test
  suites; the human sees the streamed output in Terminal.
- Publish a folder to a public URL with one call, and open it on a phone from the QR toast.

Every control a human can click has a verb an agent can call. Every agent action leaves a
visible trace: an agent cursor jumps to the touched window, an activity toast names the
verb, and agent-written terminal rows are tinted.

## Why WebMCP

WebMCP gives a page one channel to describe itself to an agent: tools with names,
descriptions, JSON schemas, and annotations. WebMCP Computer treats that channel as a
syscall table. Instead of one page exposing a form or two, the whole operating system is
the tool surface, so an agent operating the machine never needs a screenshot or a
coordinate.

The protocol's dynamism is load-bearing here. Per-app tools register when a window opens and
unregister (abort-signal) when it closes. Pages served inside the OS register `site_*` tools
through an injected `document.modelContext` facade that proxies to the host registry.
Chrome's `ontoolchange` is what makes both possible.

## Tool vocabulary

Wire names are `snake_case` verbs. Each declares an invocation class through annotations:
**ask** (read-only), **act** (reversible, visible), **transact** (consequential).

| Domain | Tools |
|---|---|
| Apps and windows | `app_open` `app_close` `app_list` `window_focus` `window_move` `window_resize` |
| Filesystem | `fs_read` `fs_write` `fs_edit` `fs_list` `fs_search` `fs_mkdir` `fs_delete` `fs_move` |
| Terminal and processes | `term_exec` `term_read` `term_state` `term_history` `ps` `kill` |
| System | `sys_status` `os_manual` `os_search` `settings_get` `settings_set` `screensaver_wake` |
| Browser (remote Chrome) | `browser_open` `browser_goto` `browser_click` `browser_type` `browser_read` `browser_screenshot` `browser_site_tools` `browser_site_call` |
| Cloud (opt-in) | `cloud_exec` `os_publish` |
| Agent-made apps | `ui_open` |
| Per-app, while the window is open | `editor_open_file` `files_reveal` `notes_append` `notes_preview` `notes_stick` `preview_get_console` `preview_get_url` `preview_reload` |
| Dynamic, from served pages | `site_*` (registered by the page itself; capped at 16 per Preview) |

The manual ships with the machine: `docs/agent-skills/` is seeded into `~/skills/` and served
by `os_manual`, because WebMCP has no resources channel besides tools.

## How it's built

- **Registration:** all tools go through [`@nekuda/webmcp-sdk`](https://www.npmjs.com/package/@nekuda/webmcp-sdk)
  (`defineTool` + `registerTools`), which resolves the live `document.modelContext` surface
  and pins the spec version. Errors are returned as MCP `{ content, isError: true }` results.
- **Kernel:** Zustand store in pure TypeScript. Process table, window registry, event bus.
  Every tool call and human action emits an OS event that AgentPresence, `dmesg`, and the
  Tool Monitor all read.
- **Shell:** [just-bash](https://www.npmjs.com/package/just-bash), a bash interpreter in
  JavaScript with coreutils, `awk`, and `jq`. The browser shell keeps network commands and
  language runtimes off; those live in the opt-in cloud container.
- **Filesystem:** ZenFS on OPFS, in-memory fallback. Session restore across reloads.
- **Preview:** a virtual HTTP server in the tab serves `~` folders into a sandboxed frame and
  bridges the frame's `site_*` tool registrations to the host.
- **Browser app:** one shared remote Chrome via Cloudflare Browser Run, controlled over CDP
  through a token-holding session Worker.
- **Cloud kernel (opt-in):** a Cloudflare Worker plus container (Debian, git, node 22,
  python3) mounts the workspace, executes `cloud_exec` commands, and publishes sites to R2.
- **Stack:** Vite, React 18, TypeScript strict, hand-rolled CSS. No UI kit.

See `docs/BRIEF.md` for the build brief, `docs/webmcp/REFERENCE.md` for the WebMCP surface
as empirically verified, and `docs/features/` for per-feature specs.

## Repository layout

- `web/` — the OS. `cd web && bun install && bun run dev`
- `workers/browser-session/` — token-holding Browser Run session Worker.
- `workers/computer/` — opt-in cloud-workspace and public-site Worker: Durable Object
  filesystem, Container execution, R2 publishing.
- `shared/gateway-capability.ts` — provider-neutral signed capability contract shared by
  the site and both Workers.
- `shared/session-limits.ts` — the visitor budgets (2 h remote Chrome and 2 h cloud
  container per machine per 24-hour accounting window, 5-minute idle stops) that the site, both Workers, and
  the client all enforce and display from one place.
- `docs/` — build brief, feature specs, seeded agent manual (`agent-skills/`), testing
  charter, WebMCP reference, demo briefs (`demo/`), [`SELF_HOSTING.md`](docs/SELF_HOSTING.md),
  and the on-call runbook [`OPERATIONS.md`](docs/OPERATIONS.md).
- [`SECURITY.md`](./SECURITY.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md) · CI in `.github/workflows/`.

## Running and testing

```sh
cd web
bun install
bun run dev          # http://localhost:5173
bun run build        # tsc --noEmit && vite build
bun test             # unit tests
bun run test:e2e     # needs Chrome 151+ with native WebMCP; see docs/testing/README.md
```

## Self-hosting

See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). Templates contain no account ID, API
token, gateway secret, or user data. Wrangler validates required secrets before deployment.

Worker URL resolution in the browser, in order:

1. `?browser_worker=` / `?computer_worker=` query override, or
   `localStorage["webmcp_computer.browser_worker"]` /
   `localStorage["webmcp_computer.computer_worker"]`. Production accepts these only for
   `127.0.0.1` or `localhost`.
2. The signed demo-session configuration returned by the site's `/api/session`.
3. `VITE_BROWSER_WORKER_URL` / `VITE_COMPUTER_WORKER_URL` baked in at build time.

With none configured, cloud features fail with a visible error and the OS stays local.
Site uploads use the browser-held capability route `POST /ws/{wsid}/publish`; no public
`/publish` route exists.

## Network disclosure

When both `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` are set at build time, the web app
sends pseudonymous, content-free typed usage events and privacy-masked session replay to that
PostHog project. Autocapture, page views, person profiles, console/error capture, network
payload capture, surveys, canvas, inputs, app content, and user-site frames are excluded; DNT and
Global Privacy Control are honored. With either value absent, PostHog is not initialized.
The public PostHog project key is browser configuration, not a secret. No project key is
committed here.

WebMCP Computer registers its tools through `@nekuda/webmcp-sdk`, which sends anonymous,
content-free usage beacons (SDK init, tool registration, tool call outcomes) to nekuda's
telemetry endpoint by default. It honors Global Privacy Control and
`globalThis.__WEBMCP_TELEMETRY__ = false`. Every demo visitor receives a random,
cookie-backed machine with short-lived (15-minute, auto-renewed) capabilities; no provider
identity is requested or stored.
Opening Browser contacts the `webmcp-computer-browser-session` Worker, which creates one
remote Chrome per machine on Cloudflare Browser Run and hands back session-scoped URLs; the
client heartbeats only while you are active and the tab is visible, and the Worker deletes
the Chrome after 5 idle minutes. Enabling `cloud_kernel` sends filesystem bytes to a
capability-addressed workspace on the `webmcp-computer-cloud` Worker after reboot; `cloud`
and `cloud_exec` send requested commands and their output streams through that Worker's
container, which is stopped 5 minutes after the last command; `os_publish` sends selected
text files to that Worker's public R2-backed site URL (served `noindex` and sandboxed,
deleted after 30 days; the manifest keeps a pseudonymous publisher record for takedowns).
Each machine may complete 20 publishes, gets 2 hours of remote Chrome, and gets 2 hours of
container time per 24-hour accounting window.
The site backend stores only the gateway signing secret and Worker URLs; the Browser Worker
alone stores the Browser Rendering API token. Local kernel remains the default, and cloud
failure falls back visibly to local.

## Scope notes

One WebMCP Computer machine runs per browser profile (a second tab is blocked unless the
human explicitly selects **Take over**), and its local filesystem persists in OPFS between visits. Git,
node, and real test runners are available only through the opt-in cloud kernel; the
in-browser shell has no git.
