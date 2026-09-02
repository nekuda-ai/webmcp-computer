# Dynamic per-app tools — Preview app and `serve`

Goal: the OS's tool surface breathes. Opening an app registers its tools; closing it unregisters them. The demo becomes possible end-to-end: agent writes a site in `~/site/`, runs `serve site/`, a Preview window opens rendering it, and the agent reads the preview's console.

## Scope

1. **Dynamic registration** (`src/tools/`): extend the registry with `registerAppTools(pid, tools)` → SDK `registerTools` batch whose lifetime is tied to the process: window close / `kill` aborts the registration (SDK `unregister()`). Tool names stay global (`editor_open_file`), but their descriptions mention the owning window when multiple instances exist; when two windows of one app are open, tools target the focused instance unless given `pid`.
2. Move `editor_open_file`, `notes_append` from the static boot set to dynamic (registered by Editor/Notes on mount). Add per-app: Files `files_reveal {path}`; Terminal already has its `term_*` set — leave static (terminal may be closed when agent wants `term_exec`; it self-opens).
3. **Preview app**: sandboxed `<iframe>` rendering `~/site/` via an in-page virtual server (Service Worker if simple, else blob URLs + `<base>` rewriting for relative assets). Address bar shows `webmcp-computer://site/`. Live-reloads on FS change under the served root. Captures the iframe's console (postMessage shim injected into served HTML) into a ring buffer.
4. **`serve <dir>` command** in the shell: spawns a Preview process serving that dir, prints `serving ~/site/ → preview (pid N)`. Re-`serve` of same dir focuses existing window.
5. **Preview dynamic tools**: `preview_get_console {pid?}` → captured console lines; `preview_reload {pid?}`; `preview_get_url`.
6. **Demo content**: replace `~/desktop/brief.md` seed with the Aurora Trails landing-page brief (goal, sections, copy hints, palette) — the exact task we'll hand Codex in the demo video.

## Out of scope

Spotlight, settings, Tool Monitor, npm/esbuild toolchain.

## Acceptance

- Gates green. Registry tests: registerAppTools batch aborts on kill; double-open targets focused instance.
- Harness (bridge): `list_webmcp_tools` BEFORE opening Editor lacks `editor_open_file`; after `app_open editor` it appears; after `app_close` it's gone — this is the headline proof, screenshot/record it.
- Full demo path via tools only: `fs_write ~/site/index.html` → `term_exec "serve site/"` → Preview opens rendering it → `fs_write` an update → Preview live-reloads → inject a `console.log`/error in the page → `preview_get_console` returns it.
