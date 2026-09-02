# Cloud kernel + os_publish — cloudflare/computer

## Goal

Two independent capabilities behind one Worker:

1. **`os_publish`** — the site the human and agent built goes live on the internet, on
   screen, in seconds: publish `~/site` to a real public URL, shown in the OS with a QR
   code. Works in *both* kernel modes.
2. **Cloud kernel** — a settings toggle. When on, the OS home directory is a
   `@cloudflare/computer` **Workspace** (Durable Object + SQLite) on our account instead
   of browser storage: the machine survives the tab.

## Architecture decision (locked — deviates from the ticket deliberately)

The ticket said "terminal exec via the worker-shell backend". We do **not** move exec.
The just-bash engine stays in the browser and keeps running against `kernel/fs`; cloud
mode swaps the **zenfs backend** underneath it. Terminal behavior, OS custom verbs
(open/dmesg/ps/man/help), traces, and every tool contract stay byte-identical — only
where bytes live changes. Worker-shell/container exec is the stretch, not the base.

Safety rule from the ticket stands: **local stays the default**; if the cloud backend
fails at boot we fall back to local with a visible warning. The demo loses a feature,
never its life. The computer SDK is PREVIEW — pin its exact version.

## Design

### Part 1 — Worker (`workers/computer/`)

Same shape as `workers/browser-session/` (own folder, wrangler.jsonc on the nekuda.ai
account, `workers_dev: true`, pure injected route handlers, rate-limit binding, CORS `*`,
`bun run check` green). Needs `compatibility_flags: ["nodejs_compat"]`, a Durable Object
binding + sqlite migration for the Workspace class, and an R2 bucket binding
(`webmcp-computer-sites`) for publishing. No API-token secret at all — everything is native
bindings.

Durable Object `WebMCPComputerWorkspace` = `withWorkspace` mixin from `@cloudflare/computer`
(see packages/computer README).

**Verified SDK surface (0.2.1, inspected in `workers/computer/node_modules` — build against
this, not the README):** `withWorkspace(Base, (self) => ({ storage: self.ctx.storage }))`
and `getWorkspace(handle): Promise<WorkspaceClient>` are the two entry points.
`ws.fs` (`WorkspaceFilesystemStub`) provides `readFile(path)` / `readFile(path, "utf8")`,
`writeFile(path, content, options?)`, `exists`, `stat`/`statOrNull`, `lstat`, `readdir(path,
options?)` → `WorkspaceDirentResult[]`, `rm(path, options?)`, `mkdir(path, options?)`,
`ls(prefix)`, `find`, `grep`, `chmod`, `symlink`, `readlink`. **There is no `rename`** —
implement move as read + write + rm in the Worker handler (the work order already allows
this). Stubs are `RpcTarget`s with `[Symbol.dispose]`, so use `using` where the SDK
examples do. Assets: `import { createAssets } from "@cloudflare/computer/assets"` →
`createAssets(env.Bucket)`, and the R2 bucket binding type is `R2PutBucket`.
`ws.runtime.exec` exists but is **out of scope** (see the architecture decision above). Workspace id = client-minted 128-bit hex capability
(`idFromName(wsid)`); knowing the id IS the auth (ephemeral per-visitor workspaces, no
login — ticket).

Endpoints:

- `POST /ws/{wsid}/fs` with `{ op, path, to?, data?, recursive? }` where
  `op ∈ read | write | mkdir | readdir | rm | rename | stat | exists`. Thin mapping onto
  `ws.fs.*`; `rename` = read+write+rm if the SDK lacks it. Paths must be absolute,
  normalized, no `..`. Errors come back as `{ error, code }` with POSIX-ish codes
  (`ENOENT`, `EISDIR`, `ENOTDIR`, `EEXIST`) so the client backend can rethrow faithfully.
  Batched variant `POST /ws/{wsid}/fs/batch` accepting an array of ops, executed in
  order, responses positional — the boot/seed path uses this to keep latency sane.
- `POST /ws/{wsid}/publish` with `{ files: [{ path, content }] }` (text only; ≤ 64 files,
  ≤ 256KB/file, ≤ 2MB total; paths relative, normalized, no `..`) → writes to R2 under
  `sites/{id}/…` (id = 8-char random slug) → returns `{ url, id, expiresInDays: 30 }`
  where url is `https://<worker-host>/s/{id}/`. Published objects have a 30-day
  retention window enforced by the R2 bucket lifecycle, not application deletion.
- `GET /s/{id}/{path...}` → serve from R2 with a small extension→content-type map,
  `/` → `index.html`, 404 as plain text. Immutable cache headers.
- Rate limits (create-shaped ops only): `POST /ws/{wsid}/publish` 4/min per IP; workspace **write**
  ops 60/min per IP (reads unlimited); 429 `{ error: "rate limited" }`.

### Part 2 — cloud zenfs backend (`web/src/kernel/cloudFs.ts`)

- `FileSystemBackend` union gains `"cloud"`.
- A zenfs async backend (the same contract `@zenfs/dom`'s WebAccess fulfills) whose
  store calls the Worker fs endpoints via `fetch`. Injected fetch for unit tests
  (charter seam 3). All of `zenfs.promises` used by `fs.ts` (readFile, writeFile, mkdir,
  readdir, rm, rename, stat) must work, because seeds/fsck call zenfs directly.
- Mount decision at boot, before anything touches the fs — settings live *in* the fs, so
  the toggle is mirrored to `localStorage["webmcp_computer.cloud_kernel"]` (plus
  `localStorage["webmcp_computer.workspace"]` for the wsid, minted on first enable):
  `configurePreferredBackend` order becomes: cloud (if flag set) → OPFS → memory. Cloud
  mount failure logs the existing "backend unavailable" pattern, falls through to OPFS,
  and surfaces a visible OS banner/toast so the human knows they're local.
- Seeding runs unchanged against whichever backend mounted (fresh workspace seeds
  itself; the manual documents that cloud mode starts fresh — no migration of local
  files in v1).
- Latency is accepted (demo scale). No watch protocol: this client is the only writer;
  all mutations flow through the page, so existing change events keep working.

### Part 3 — settings + tools

- `SETTING_KEYS` gains `cloud_kernel` (boolean, default false). `settings_set` writes
  the file AND the localStorage mirror, and its result must say a reboot applies it
  (`{ …, note: "reboot required — the machine restarts to remount its filesystem" }` —
  match existing result shapes). The Settings app gets the toggle with a visible
  "REBOOT" affordance (VerbHint `cloud_kernel · settings_set`); flipping it triggers a
  clean `window.location.reload()` after the write settles.
- `sys_status` (or the existing status surface) reports the active backend in both
  `fs_backend` and ready-state `fs_status`
  (`local (opfs)` / `local (memory)` / `cloud`), and the MenuBar shows a small mono
  `CLOUD` chip when the cloud backend is live — the human must be able to see where
  their machine lives.
- New tool `os_publish` — intent **transact** (`consequentialHint: true` — it makes
  content public; third transact tool after `fs_delete` and `kill`, taxonomy pins update). stableKey
  `webmcp_computer.os_publish`. Input: `path?` (default `~/site`, must be an existing
  directory). Reads the tree via kernel fs (works in both modes), rejects non-text
  files by extension allowlist (html/css/js/json/svg/txt/md), enforces the same caps as
  the Worker, POSTs, returns `{ url, expiresInDays, files, bytes }`. Visible trace + a
  publish toast showing the URL, 30-day retention window, **and a QR code** so a phone
  can open it on camera. QR: generate
  in-page with a tiny zero-dependency MIT QR encoder module (`web/src/shared/qr.ts`,
  vendored ~200-line implementation with its license header — no new npm dependency, no
  network). The toast/window is also the human's proof of what just went public.
- `os_publish` uses the same Worker-URL resolution pattern as the Browser app
  (query `?computer_worker=` → localStorage → `VITE_COMPUTER_WORKER_URL` → prod default).

### Manual + docs

- `docs/agent-skills/` new skill `cloud.md` (seeded + byte-pinned + migration marker,
  following the M9 browser.md pattern): cloud kernel model, the reboot rule, fresh-start
  caveat, `os_publish` contract and its public-ness, QR story.
- Manual topic `cloud`; os_search includes `os_publish`.
- BRIEF hard rule 2: extend the M9 exception list with the computer Worker origin
  (kernel bytes + published sites), still opt-in per human/agent action, core OS still
  local-first by default.
- README: network disclosure + the two Worker deploys.

## Tests (charter rules apply; seam 3 already covers external service fakes)

Unit (`bun test src`):
- `cloudFs.test.ts`: backend ops against an injected fetch fake speaking the Worker
  protocol — read/write/mkdir/readdir/rm/rename/stat round-trips, POSIX error rethrow
  (ENOENT et al.), batch path used by seeding, mount-failure fallback order
  (cloud → opfs → memory) via `selectFileSystemBackend`-style injection.
- `settings.test.ts` additions: `cloud_kernel` validation, localStorage mirror written,
  reboot note in result.
- `osPublish.test.ts`: tree collection (nested dirs), default `~/site`, extension
  rejection naming the file, cap enforcement (file count/size/total), result shape, URL
  in trace; Worker publish handler: path traversal rejected, caps, content-type map,
  slug uniqueness (injected randomness), R2 writes via injected store.
- Taxonomy pins: third transact tool — update counts and pin `os_publish`'s
  annotations.
- Worker `workers/computer`: pure handler tests like browser-session's (7-test shape).

E2E (extend seam-3 fake, budget-conscious — reuse one dense scenario):
- `e2e/fakeComputer.ts`: Bun.serve delegates to the real Worker handler with an in-memory
  WorkspaceHandle + SiteStore, including scoped publish, and returns a local `/s/<id>/`
  URL it actually serves.
- Scenario: enable `cloud_kernel` via `settings_set` (with `?computer_worker=` pointing
  at the fake) → reload through the harness → assert backend reports cloud + MenuBar
  chip; `fs_write` + `term_exec` (`echo cloud > ~/notes/proof.txt`, `cat` it back) land
  in the fake's tree (assert server-side); build a tiny `~/site/index.html` via
  `fs_write`; `os_publish` over WebMCP → result URL is the fake's, fetching it returns
  the html; publish toast visible with QR canvas/svg present; dmesg shows
  `[agent] os_publish`; flip the setting off → reload → backend local again, cloud
  files gone from the local tree (fresh-start honesty).

`bun test src`, `bun run build`, `bun run test:e2e` all green (builder runs the first
two; e2e is the lead's gate). `workers/computer` `bun run check` green.

## Out of scope (stretch / follow-ups)

- Worker-shell or container exec backends (`workspace.runtime.exec`); real
  `npm install`/`vite build` in the cloud.
- Cross-device workspace handoff UI (the wsid capability makes it *possible*; no UI).
- Local→cloud home migration on first enable.
- Application-managed publish TTL/unpublish tooling; custom domains. Retention remains
  bucket-lifecycle-owned.

## Deploy notes (lead-owned)

- `bun install` in `workers/computer` needs the network — the lead preinstalls
  (including the pinned `@cloudflare/computer` — 0.2.1 at time of writing, pin exact)
  before dispatching the builder.
- Deploy: create R2 bucket `webmcp-computer-sites`, then `wrangler deploy` (DO migration rides
  along). No secrets needed. `VITE_COMPUTER_WORKER_URL` default set to the deployed
  workers.dev URL.
- Configure the R2 bucket lifecycle to delete `sites/` objects after 30 days before
  production exposure. This rule is lead/deploy-owned and is not applied by application
  code; application-side unpublish remains out of scope for M10.
