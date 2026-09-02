# Desktop shell — scaffold, window manager, first live tools

Goal: a running WebMCP Computer desktop at `bun run dev` (in `web/`) where an agent can already open, move, and close windows via WebMCP — and the human sees it happen.

## Scope

1. **Scaffold** `web/` with Vite + React 18 + TypeScript strict. Package manager: bun. Dependency on published `@nekuda/webmcp-sdk`. Runtime deps allowed: `react`, `react-dom`, `react-rnd`, `zustand`. Nothing else without a reason in the commit message.
2. **Design tokens** in `src/styles/tokens.css` (CSS custom properties for the full palette/typography/chrome spec in BRIEF.md), Google Fonts loaded in `index.html`.
3. **Kernel** (`src/kernel/`): zustand store with process table (`pid`, `appId`, `windowRect`, `zIndex`, `focused`), spawn/kill/focus/move/resize actions, plus an OS event log (`osEvent(source, verb, args)`) capped at 500 entries.
4. **Window manager** (`src/desktop/`): `Desktop` (background per design), `Window` (custom chrome per design, react-rnd drag/resize wired to kernel), `MenuBar`, `Dock` (apps with inline SVG icons), `VerbHint` tooltip wrapper.
5. **Apps as stubs** (`src/apps/`): registry of `{id, name, icon, component}` for `files`, `editor`, `terminal`, `notes`, `settings`. Each renders a placeholder body ("coming in M2/M3") inside a real window. Dock click opens them (spawns process).
6. **Screensaver** as boot state per BRIEF.md (hue steps only on wall contact; wake on key/click/tool-call).
7. **Tools** (`src/tools/`): registry module wrapping `@nekuda/webmcp-sdk` (`defineTool`/`registerTools`). At boot register: `app_open`, `app_close`, `app_list`, `window_focus`, `window_move`, `window_resize`, `sys_status`, `screensaver_wake`. Every tool call: wakes screensaver if active, appends to OS event log with `source: 'agent'`, and returns useful data (e.g. `app_open` returns `{pid, appId, rect}`; `app_list` returns the process table; `sys_status` returns `{hostname: 'guest@webmcp-computer', uptime_s, processes, agent_seen: bool}`).
8. **AgentPresence** (`src/desktop/`): watches the event log; on agent events shows the glowing cursor + `CODEX` tag animating to the affected window and a toast (`AGENT RAN: <arg> · <verb>`); flips MenuBar to `AGENT ONLINE` for 30s.

## Out of scope (do not build)

Real filesystem, real terminal/shell, notes/editor content, spotlight, settings values, per-app dynamic tools, deploy config.

## Acceptance (will be verified by the reviewer + harness)

- `cd web && bun install && bun run dev` serves the OS; `bun run build` passes; `bunx tsc --noEmit` clean.
- Boot shows screensaver; keypress wakes to desktop.
- Human path: dock click opens Files window with correct chrome, drag/resize/focus/close work.
- Agent path (via chrome-devtools MCP bridge): `list_webmcp_tools` shows the 8 system tools; `execute_webmcp_tool app_open {"appId":"files"}` opens the window, the cursor/toast presence plays, `app_list` reflects it, `window_move` visibly moves it, `app_close` closes it.
- Tool descriptions are agent-grade (a stranger LLM could use them unaided).
- `bun test` covers kernel spawn/kill/focus/z-order and tool registry lifecycle (register/unregister via injected `modelContext` fake — see `RegisterToolsOptions.modelContext`).
