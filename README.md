# VerbOS

An operating system a human and an agent use together. Every control is a WebMCP verb.

- `web/` — the OS. Vite + React + TypeScript. `cd web && bun install && bun run dev`.
- `spike/` — spike zero + dynamic-registration spike: prove e2e WebMCP registration through `@nekuda/webmcp-sdk`.
- `vendor/webmcp-sdk` — vendored build of `@nekuda/webmcp-sdk` (until it lands on npm).
- `workers/browser-session/` — token-holding Browser Run session Worker.
- `workers/computer/` — opt-in cloud-workspace and public-site Worker.
- `docs/` — build brief (`BRIEF.md`), feature specs (`features/`), the seeded agent manual (`agent-skills/`), testing charter, WebMCP reference.

Development Browser Run override: append `?browser_worker=http://127.0.0.1:<port>` to
the VerbOS URL, set `localStorage["verbos.browser_worker"]`, or set
`VITE_BROWSER_WORKER_URL` (resolved in that order). Production accepts query/storage
overrides only for `127.0.0.1` or `localhost`, then falls back to the deployed
`verbos-browser-session` workers.dev URL.

Development computer override: append `?computer_worker=http://127.0.0.1:<port>`, set
`localStorage["verbos.computer_worker"]`, or set `VITE_COMPUTER_WORKER_URL` (same
resolution order and production loopback-only override rule). Site uploads use the
browser-held capability route `POST /ws/{wsid}/publish`; no public `/publish` route exists.

**Network disclosure:** VerbOS registers its tools through `@nekuda/webmcp-sdk`, which sends anonymous, content-free usage beacons (SDK init / tool registration / tool call outcomes) to nekuda's telemetry endpoint by default. We keep that on deliberately — this project dogfoods the SDK end to end. It honors Global Privacy Control and `globalThis.__WEBMCP_TELEMETRY__ = false`. Opening Browser contacts the small `verbos-browser-session` Worker and Cloudflare Browser Run capability URLs to create one shared remote Chrome. Enabling `cloud_kernel` sends filesystem bytes to a capability-addressed `verbos-computer` Workspace after reboot; `cloud` and `cloud_exec` send requested commands and their output streams through that Worker's container on our Cloudflare account; `os_publish` sends selected text files to that Worker's public R2-backed site URL. Local kernel remains default, cloud failure falls back visibly to local, and neither Worker uses an account login in VerbOS.

Entry for the OpenAI WebMCP Challenge.
