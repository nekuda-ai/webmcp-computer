# Apps, windows, processes

Windows ARE processes: every open window has a PID (shown in its titlebar chip), and
`ps`/`app_list` read the same table. PID 1 is the screensaver; window PIDs start at 2.

## Tools

- `app_open {appId, path?, x?, y?, width?, height?, focus?}` — built-in apps: `files`,
  `editor`, `terminal`, `notes`, `preview`, `settings`. Settings, Notes, and Preview are singletons: opening one already
  running applies any supplied placement to its existing window and returns its PID with
  `reused: true`. Files, Terminal, and Editor stay multi-instance. `path` (editor only)
  opens a file directly. `focus` defaults to true; false preserves current focus and
  places a new window below the focused window. Returns `{pid, appId, path?, rect,
  reused}`, where `rect` is applied geometry after clamping.
- `ui_open` — create or open an agent-made HTML App window. Read `~/skills/apps.md`;
  these windows do not open through `app_open`.
- `browser_open` — start or focus the singleton shared Cloudflare Chrome window. Read
  `~/skills/browser.md`; Browser does not open through agent `app_open`.
- `app_list {}` — every window with PID, rect, z-index, focus state, and minimized state.
- `app_close {pid}` / `kill {pid}` — close a window.
- `window_focus {pid}`, `window_move {pid, x, y}`, `window_resize {pid, width, height}`.
  Coordinates are relative to the work area (origin just below the 38px menu bar);
  targets are clamped so the left-side close controls stay reachable, and every window
  is re-clamped when the viewport shrinks. The returned rect is the truth.
- `editor_open_file {path}` — Editor on a specific text file.
- `files_reveal {path}` — show a file or directory in an already-open Files window.
- `notes_append {note, text}` — append to a markdown note under `~/notes/`.
- `notes_stick {title_or_index, sticky}` — show or remove an existing markdown note as
  a movable desktop card. Identify it by title, full path, or 1-based Notes-list index.
  Sticky state and card position persist in this tab's session.

## Dynamic tools

Some tools exist only while their app is open. A minimized window remains open and keeps
its tools registered. Opening Notes registers `notes_append`, `notes_preview`, and
`notes_stick`; Editor registers `editor_open_file`; Files registers `files_reveal`;
Preview brings its own three tools; Browser brings seven browser tools.
Your tool list is alive — re-list
after opening or closing apps if a tool seems missing.

## Placement and restore

New windows cascade 24px right and down from the last opened window, wrapping near the
work-area origin before they would leave the visible area. Explicit `app_open` geometry
overrides that new-window position and uses the same clamps as `window_move` and
`window_resize`. Reused singleton windows move or resize in place. Reload restores this
tab's open windows, rectangles, z-order, focus, Editor/Notes paths, and Terminal cwd;
Terminal scrollback and shell history end at reload. Restored rectangles never cascade
and clamp to the current viewport so their titlebars stay reachable. Filesystem and
settings persist separately. Restore drops exact-duplicate windows and logs one system
event for each drop. It also drops extra instances of single-instance apps and logs one
system event for each drop.

## Deliberate parity decisions

- Editor has no unsaved-buffer tool: its short autosave makes filesystem bytes canonical.
- Agents may wake but not start the screensaver; this asymmetry is accepted.
- Zoom does not exist for either user. The final titlebar dot is inert decoration.

## Human context menus

Right-click the desktop background, desktop icons, Files rows or background, window
titlebars, or Dock icons for OS-native menus. Each tool-backed item shows its
registered syscall; Minimize and Copy path stay human-only because no registered agent
tool matches them.
Minimize CSS-hides the mounted window, keeping its process, buffers, and dynamic tools
alive; Dock Focus or agent `window_focus` restores it.
Text inputs, textareas, and contenteditable bodies keep the browser's native context menu
for clipboard access.

## Presence

Everything you do renders for the human: a glowing CODEX cursor moves to the window you
touched, a toast shows `AGENT RAN: <arg> · <verb>` when a target exists (otherwise
`AGENT RAN: <verb>`). Failures show `AGENT FAILED: <verb> · <reason>`. The menu bar
shows AGENT ONLINE while you're active. The CODEX cursor fades 8 seconds after your
latest action. Arrange windows considerately — the human is using the same desktop.
