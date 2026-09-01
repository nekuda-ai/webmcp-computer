# VerbOS — build brief

Entry for the OpenAI WebMCP Challenge (deadline Sep 3, 2026). Read this whole file before writing code.

## What this is

VerbOS is a desktop operating system that runs entirely in one browser tab — and every control in it is a **WebMCP tool**. The window manager, the filesystem, the terminal, the settings panel: each exposes its verbs (`app_open`, `fs_read`, `term_exec`, `settings_set`…) through the page's WebMCP surface, so an external agent (OpenAI Codex, via its browser) inhabits the OS as a second user. The human sees everything the agent does, live, on the same screen.

**Mental model: the OS is the computer, WebMCP tools are its syscalls, the agent is a user at the second keyboard.**

The wow moment we are building toward: a human opens VerbOS, the agent joins, and together they build and preview a small website inside the OS — the agent typing in the terminal, opening windows, and editing files while the human watches and interferes at will.

## Hard rules

1. **All WebMCP registration goes through `@nekuda/webmcp-sdk`** (vendored at `vendor/webmcp-sdk`, imported as `@nekuda/webmcp-sdk`). Never touch `document.modelContext` / `navigator.modelContext` directly — except through VerbOS's own in-frame Preview and agent-app facades defined by their opaque-frame shims, as documented in `docs/webmcp/REFERENCE.md` — because the SDK resolves the real host surface, pins the spec, and absorbs draft churn. Use `defineTool` + `registerTools`; unregistration = `registration.unregister()` (abort-signal semantics).
2. **Local-first, browser-only.** No general backend of our own, no accounts. State lives in memory + (later milestones) OPFS. The app must be deployable as a static site (Cloudflare Pages). Three deliberate, documented exceptions: the vendored `@nekuda/webmcp-sdk` ships its default-on anonymous usage telemetry (fire-and-forget beacons to nekuda's `/v1/telemetry`; no user content, standard opt-outs honored — GPC, `globalThis.__WEBMCP_TELEMETRY__ = false`); only after a human or agent opens Browser, that app talks to our token-holding session Worker plus `live.browser.run` and `api.cloudflare.com`-minted capability URLs for one shared remote Chrome; and only when `cloud_kernel` is enabled or `os_publish` is called, the computer Worker stores kernel bytes in a capability-addressed workspace or selected public-site bytes in R2. Every network action stays opt-in per human/agent action, local kernel remains the default, and cloud mount failure falls back visibly to local. We keep SDK telemetry on so VerbOS dogfoods the SDK end to end. Disclose these exceptions in the README; the core OS remains local-first and static.
3. **Every user-visible control has a verb.** If a human can click it, an agent can call it. When adding a UI control, add or map its tool in the same change.
4. **The human always sees agent actions.** Any state change caused by a tool call renders a visible trace (activity toast, tinted row, animated cursor — per design system).
5. Keep dependencies minimal and boring. No UI kit, no CSS framework. Hand-rolled CSS with the design tokens below.
6. **The manual ships with the machine.** `docs/agent-skills/` is the OS's own manual, seeded as `~/skills/` and served by `os_manual` (M5). Any change to a tool's name, schema, description, caps, or error strings updates the skills files in the same change — the seed byte-pin makes a stale manual a red build. The WebMCP protocol has no channel besides tools (see `docs/webmcp/REFERENCE.md`), so descriptions and the manual ARE the product's documentation surface.

## Tool vocabulary (the syscall table)

Names are `snake_case` verbs, dot-namespaced `stableKey`s (`verbos.<domain>_<action>` shape is invalid — stableKey segments are `[a-z0-9_]+` joined by dots, e.g. stableKey `verbos.app_open`, wire name `app_open`). Grouped by domain:

- **apps/windows**: `app_open`, `app_close`, `app_list`, `window_focus`, `window_move`, `window_resize`
- **fs** (M2): `fs_read`, `fs_write`, `fs_list`, `fs_mkdir`, `fs_delete`, `fs_move`
- **terminal** (M3/M5): `term_exec`, `term_read`, `term_state`, `term_history`, `ps`, `kill`
- **system**: `sys_status`, `os_manual`, `os_search`, `settings_get`, `settings_set`,
  `screensaver_wake`
- Per-app dynamic tools (M4): registered when the app's window opens, unregistered when it closes — e.g. `notes_append`, `editor_open_file`, `preview_get_console`. This dynamism is the differentiating ace; the architecture must make it trivial.

Every tool: precise `description` written for an agent (what it does, what it returns), tight `inputSchema`, and returns either a string or a small JSON-serializable object. Implementations throw `Error` with a human-readable message (`verbos: <what went wrong>`); the registry transports it as MCP's `{content, isError: true}` tool-error result.

Every tool also declares its invocation class through `intent` and annotations:

- **ask** — read-only data (`intent: answer`, `readOnlyHint: true`,
  `consequentialHint: false`); no UI obligation unless its contract says otherwise.
- **act** — reversible visible state change (`intent: act`, `readOnlyHint: false`,
  `consequentialHint: false`); always leaves a human-visible trace.
- **transact** — consequential or irreversible change (`intent: transact`,
  `readOnlyHint: false`, `consequentialHint: true`); deserves a second thought.

## Architecture

```
web/                    Vite + React 18 + TypeScript (strict)
  src/
    kernel/             OS state: process table, window registry, event bus.
                        Zustand store(s). Pure TS — no React imports in logic.
    tools/              Tool registry: wraps @nekuda/webmcp-sdk.
                        registerSystemTools() at boot; scoped registries for
                        per-app tools keyed to window lifecycle.
    apps/               Each app = { id, name, icon, component, tools? }.
                        files/, editor/, terminal/, notes/, settings/, preview/
    desktop/            Desktop, Window (chrome + drag/resize), MenuBar, Dock,
                        Screensaver, AgentPresence (cursor/toast), Tooltip.
    styles/             tokens.css (design tokens), base.css
```

- **Process model**: opening an app spawns a process (incrementing PID, shown in window chrome). Windows are processes. `app_list`/`ps` read the same table.
- **Event bus**: every tool call and every human action emits an OS event (`{source: 'agent'|'human', verb, args, ts}`). AgentPresence renders agent events (toast + cursor move to the affected window). Later, `dmesg` and the Tool Monitor read the same log.
- **Window manager**: `react-rnd` for drag/resize with custom chrome. Z-order managed in kernel store. Focused window: full opacity + deeper shadow; idle: 88% opacity.

## Design system (from `docs/design/*.dc.html` — open these, they are the mock)

Fonts (Google Fonts): **Space Grotesk** (UI: 600 titles, 500 window chrome, 400 body), **IBM Plex Mono** (terminal, PID chips, microlabels 9–11px with 0.12–0.2em tracking), **Doto** 900 (the `verbOS` wordmark only — no dot mark beside it).

Palette: SKY01 `#f6fafd`, SKY02 `#e4edf7`, ACCENT `#2e9ff3`, NAVY `#16283d`, PHOSPHOR `#9fd8ff`, OK `#7ee0a3`, INK `#17222e`, CORAL `#ff7a59` (close button hover / errors). Desktop background: sky gradient + `public/wallpaper.jpg` (nekuda mountains) at the bottom + subtle SVG feTurbulence grain overlay (see mock). Optional CRT scanline overlay (settings toggle, default on, subtle).

Window chrome: frosted white `rgba(255,255,255,0.9)`, 1px border `rgba(23,34,46,0.10)`, 12px radius, shadow `0 18px 44px rgba(36,66,98,0.13)`, 38px titlebar, three 9px dot controls (idle `#cfdded`, hover `#8fa3b8`, close-hover `#ff7a59`), title Space Grotesk 500 13px, right-aligned mono PID chip (`PID 4`).

MenuBar: `verbOS` wordmark in Doto, `~/GUEST`, right side: `AGENT ONLINE` with pulsing accent dot (only when an agent has called a tool in the last 30s, else `AGENT —`), clock.

Agent presence: glowing accent cursor dot + `CODEX` tag that animates to the window a tool call touched; activity toast (`AGENT RAN: files · app_open`); agent-caused terminal rows tinted `rgba(46,159,243,0.16)`.

Syscall tooltips: hovering any control shows a small mono chip with its target first (`files · app_open`). At most one is visible, and persisted `verb_hints` defaults on. Implement as one shared `<VerbHint verb="app_open" arg="files">` wrapper so it is trivial to apply everywhere.

Screensaver (boot state): dark radial background, bouncing `verbOS` Doto wordmark with phosphor glow, ghost trails, pixel grid + grain + scanlines + vignette. **Hue changes ONLY on wall contact** (never mid-flight); randomize bounce periods after each corner hit. Microlabels top-left/right, blinking `PRESS ANY KEY — OR CALL ANY TOOL` bottom-center. Any keypress, click, or WebMCP tool call wakes the OS.

## Working agreements

- TypeScript strict; no `any` unless annotated why.
- Small files, one concern each. Kernel logic unit-testable without DOM.
- Tests: `bun test` for kernel + tools (registry lifecycle, process table). UI verified in browser (the harness drives real WebMCP calls against the dev server).
- Conventional commits. Each milestone lands as one coherent commit series on `main`.
