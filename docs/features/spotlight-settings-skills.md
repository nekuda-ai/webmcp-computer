# Spotlight, Settings, and agent skills

Goal: the layer that makes judges lean in. Whole-OS search the agent can use, settings the agent can flip, the machine's own manual seeded for the agent, and the polish moments (man pages, dmesg, Tool Monitor, tooltips everywhere).

## Scope

0. **Agent skills folder**: seed `~/skills/` on first boot from `docs/agent-skills/*.md`
   (byte-exact, same read-from-docs pattern and test pin as the Aurora brief; six files:
   README, filesystem, terminal, windows, preview, conventions). Every skill file must be
   accurate against the SHIPPED tool surface — verify each claim (tool names, caps,
   timeouts, error strings) against the code and fix the doc or flag the mismatch. Add a
   `skills` hint to `sys_status`'s return (`skills: "~/skills"`) and one line to each
   fs/terminal tool description pointing at `~/skills` is NOT wanted — keep descriptions
   tight; the README seeding is enough.
1. **Terminal introspection tools** (static registry, next to term_exec):
   `term_state {term_pid?}` → `{pid, cwd, busy, running_command?, env: {...}}`;
   `term_history {term_pid?, limit?}` → structured `[{index, command}]` (shared session
   history, newest last, default limit 50). Both read the same session the human types
   into — no scrollback parsing.
2. **`os_manual {topic?}` tool** — the manual over WebMCP itself (the protocol has no
   resources/prompts channel, so the manual travels through the only channel there is:
   a tool). No topic → the skills README plus the topic list; with topic
   (`filesystem` | `terminal` | `windows` | `preview` | `conventions`) → that file's
   content verbatim from `~/skills/`. Description tells a stranger agent this is the
   place to start. `man <topic>` in the shell and `os_manual` must return the same
   bytes (both read the seeded files).

1. **Spotlight** (`⌘K` / `Ctrl+K`): overlay searching the whole OS — file names + file contents (FS), apps, settings, running processes, shell commands. Every result row carries its verb chip (`fs_read · ~/site/index.html`, `app_open · settings`, `settings_set · theme`). Enter acts on the result (open file in editor, open app, focus window). Tool: `os_search {query, limit?}` returns the same ranked results as structured data — the agent's eyes over the whole OS.
2. **Settings app** + tools: Appearance (theme light/dark, accent color from the 4 swatches, CRT scanlines on/off, syscall hints on/off), hostname (default `guest@webmcp-computer`, feeds prompt + sys_status). Persisted to FS (`~/.config/settings.json`) so it survives reload. Tools: `settings_get {}` → full settings, `settings_set {key, value}` with validated keys. Dark theme: dimmed wallpaper + stars per Details mock; all tokens flip via CSS custom properties.
3. **Tool Monitor**: Settings tab (not own window) listing currently registered tools grouped by owner (system / per-app with PID), flagging `+N JUST REGISTERED` for 5s after a dynamic batch lands. Reads the tool registry's own state — no bridge needed.
4. **man pages + dmesg polish**: `man <tool_name>` also works for tools (`man fs_read` renders `FS_READ(1) — WebMCP Computer syscalls` from the tool's description + schema). `dmesg` output gets `[agent]`/`[human]` prefixes and relative timestamps.
5. **VerbHint everywhere**: sweep all interactive controls (dock icons, window dots, menubar items, Files rows, Settings controls, Spotlight rows) — every one shows its target-first verb chip on hover. One modifier-free hover with 600ms delay; at most one is visible. `verb_hints` defaults on and disables all wrappers when false.
6. **Screensaver return**: after N minutes idle (settings key, default off in dev), screensaver returns; any tool call wakes + is processed (screensaver_wake implicit).

## Out of scope

npm/esbuild toolchain, deploy, submission assets.

## Acceptance

- Gates green. Cold boot exposes exactly 26 static tools after the six M5 additions;
  dynamic app tools remain registry-owned. `preview_get_console` keeps M4's shipped
  `{pid, url, lines, truncated, dropped}` shape. `os_search` unit tests over seeded FS
  (filename + content hits, ranking: exact name > name prefix > content).
- Harness: `settings_set {"key":"theme","value":"dark"}` flips the desktop visibly and `settings_get` agrees after reload; `os_search {"query":"aurora"}` finds `~/desktop/brief.md` by content; ⌘K human path mirrors it; Tool Monitor shows a dynamic batch appear/disappear as Editor opens/closes; `man fs_read` renders in terminal.
