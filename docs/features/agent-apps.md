# Agent-made apps — `ui_open` + UI host bridge

## Goal

The agent can create a real, windowed app at runtime from HTML it writes itself. The app
lives in the WebMCP Computer filesystem, renders in a sandboxed OS window, and — when explicitly
granted — can call OS verbs back through a host bridge (MCP-Apps-style `tools/call`
direction). Human and agent share the same app: the agent builds it, the human clicks it,
either one edits the file and the window live-reloads. Everything is traced, sandboxed,
and survives session restore.

## Why (challenge framing)

This is the highest-leverage WebMCP demonstration we have: the agent doesn't just drive
the OS — it extends the OS with new UI at runtime, and that UI is itself a first-class
collaborative surface. No backend, static deploy unchanged.

## Design

### New app: `ui`

- `AppId` gains `"ui"`. Non-singleton (many agent apps at once). `APP_SIZES`: 520×420.
- App name in the registry: `"App"`. Window title bar shows the file's basename without
  `.html` (special-case in `Window.tsx` like terminal's hostname title); the aria-label
  stays the standard `${app.name} window, PID ${pid}` pattern.
- New icon in `apps/icons.tsx` (simple "window with spark/asterisk" mark, consistent
  stroke style with the existing set).
- `ProcessRecord.path` = the `~`-rooted HTML file. Session snapshots already persist
  appId + path, so restore re-opens the window for free. Verify `sessionSnapshot`
  validation accepts the new appId via `APP_IDS`.
- `app_open` keeps its editor-only `path` rule; ui windows open via `ui_open` (document
  this in the `app_open` description only if it already enumerates app ids — do not
  reword otherwise).

### Storage

- `ui_open` with inline `html` writes `~/apps/<name>.html` (create `~/apps` if missing;
  overwrite an existing file — the agent iterates). With `path` it opens an existing
  `.html` file instead. Exactly one of `html` | `path` is required.
- The file is a plain OS file: visible in Files, editable in Editor, searchable. That is
  the collaboration story — do not hide it in app state.

### Rendering (UiApp.tsx)

- Read the file, build a self-contained document the same way Preview does for a single
  file (reuse `buildSelfContainedDocument` with one virtual file at `index.html`, or a
  minimal shared seam — do NOT fork the rewriting logic).
- Console capture works exactly like Preview (same injected console hooks — reuse).
- Then inject the **UI host bridge** script (below) into the head.
- Render in `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer">` from a blob
  URL. Never `allow-same-origin`, never `allow-popups`, never a real origin.
- Watch the file; on change, rebuild + swap the frame with a ~200ms debounce (reuse the
  preview scheduling helpers if they fit; a fresh token per rebuild like Preview).
- Site-tool *registration* from ui frames (the Preview `site_` direction) is **out of
  scope** — the ui frame's message handler must ignore/reject `site-tool-register`.
  One collaboration direction per app type in v1; noted as follow-up.

### UI host bridge (`src/apps/ui/uiBridge.ts`)

Mirrors `siteToolBridge.ts` structure: a dependency-free injectable frame-side factory
plus a host-side proxy, both unit-testable with a fake postMessage pair.

Frame side (injected):
- `window.webmcpComputer = Object.freeze({ listTools(), callTool(name, input) })`.
- `listTools()` resolves the granted tool descriptors (name, title, description,
  inputSchema) delivered by the host at init.
- `callTool(name, input)` posts `{kind:"ui-call", callId, name, input}` and resolves with
  the tool result or rejects with the host's error string.
- Message envelope identical in spirit to Preview: `__webmcpComputerUi: true`, `pid`, `token`
  checked on every message, both directions.

Host side (in UiApp's message handler):
- Answers `{kind:"ui-init"}` with the granted descriptors.
- On `ui-call`: validate the envelope, check the grant, look up
  `getActiveToolDefinition(name)`, execute, post `{kind:"ui-result", callId, ok, ...}`.
- Emits one OS event per bridged call: source `"app"`, verb `ui_call`, args
  `{pid, tool}`, settled ok/reason. `EventSource` gains `"app"`; verify ActivityLog and
  any source-based rendering handle it (AgentPresence filters `"agent"` only, so an app
  call must NOT light agent presence). The underlying tool still logs its own `agent`
  event via `runAgentAction`; that double trace is accepted and documented in the manual.

Hard guardrails (all enforced host-side, none trusted to the frame):
- Grant = `allowTools` ∩ active catalog, always excluding: `intent === "transact"`,
  names starting `site_`, and `ui_open` itself. Unknown names are dropped silently and
  the returned `grantedTools` reflects reality.
- `allowTools` omitted → empty grant (pure UI). Grants live in a per-pid module map
  (like the preview runtime), are NOT persisted, and a restored window comes back with
  an empty grant — safe default, documented; the agent re-runs `ui_open` to re-arm.
- Per window: max 2 in-flight bridged calls, 10s timeout per call, result ≤ 256KB
  (Preview parity), input must be a plain object.

### Tool: `ui_open` (`src/tools/uiTools.ts`, registered in bootTools)

- Intent `act`, `ACT_ANNOTATIONS`. `stableKey: "webmcp_computer.ui_open"`.
- Input: `name` (required, 1–40 chars, `[a-z0-9][a-z0-9-_]*` case-insensitive),
  `html` (string ≤ 256KB) XOR `path` (`~`-rooted existing `.html` text file),
  `allowTools` (string[], ≤ 16), `x`/`y`/`width`/`height` (numbers, clamped like
  `app_open`), `focus` (boolean).
- Behavior: resolve/write the file, spawn the `ui` process with path + placement, store
  the grant for that pid, return
  `{pid, path, rect, grantedTools, focus applied like app_open}`.
- Description must follow the house style: explains what happens visibly, names the
  sandbox, states the transact exclusion and the empty-grant default, tells the agent
  the human can edit the file live.
- Errors follow existing voice: `webmcp-computer: ...` with the offending thing named.

### Manual + docs

- Add manual topic `apps` (`osManualTool` enum + `manual.ts` + `manualContent.ts`):
  what `ui_open` does, the bridge API (`window.webmcpComputer.callTool`), grants and their
  restore behavior, the sandbox, the trace story.
- Update README tool table if it enumerates tools.

## Tests (charter rules apply — no new mock seams)

Unit (`bun test src`):
- `uiTools.test.ts`: happy path writes the file and spawns with the right rect/path;
  grant intersection drops transact/site_/ui_open/unknown; empty grant when omitted;
  name validation errors; html size cap; html XOR path enforced both ways; `path` to a
  missing/non-html file errors naming it; grants map empty for a restored/unknown pid.
- `uiBridge.test.ts`: init handshake delivers granted descriptors; call round-trip via a
  fake postMessage pair; ungranted call rejected; timeout rejects and settles the event;
  oversized result rejected; concurrency cap queues or rejects the 3rd call (pick one,
  assert it); token/pid mismatch messages ignored.
- Any test touched by the `EventSource` union change.

E2E (dense single scenario in the existing suite structure, budget-conscious):
1. `ui_open` over the real WebMCP surface with html containing a button whose onclick
   `webmcp_computer.callTool("fs_write", …)` writes a file and renders the result into the DOM;
   `allowTools: ["fs_write", "fs_read"]`.
2. Window visible with the standard aria-label; iframe `sandbox` attribute is exactly
   `allow-scripts`.
3. Human path: click the button inside the frame (puppeteer frame handle), then
   `fs_read` over WebMCP proves the write landed; the frame shows the success text.
4. Denied path: a second button calls a non-granted tool and the frame renders the
   error.
5. Live edit: `fs_write` the app's HTML over WebMCP → frame content updates (debounced
   reload).
6. Restore: reload WebMCP Computer → the window comes back; the same button now fails (empty
   grant after restore).

`bun test src`, `bun run test:e2e`, and `bun run build` (tsc) must all pass.

## Out of scope (follow-ups)

- Site-tool registration from ui frames (outward direction).
- Full MCP Apps JSON-RPC (`ui/initialize` et al.) wire compatibility; our envelope is
  MCP-Apps-shaped but OS-native. Revisit if we host real third-party widgets.
- Desktop icons for `~/apps` entries.
