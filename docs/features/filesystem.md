# Filesystem — real FS, fs tools, Files/Editor/Notes (M2)

Goal: VerbOS has a persistent per-visitor filesystem (OPFS), the agent reads/writes it through `fs_*` tools, and the human sees the same bytes in Files/Editor/Notes.

## Scope

1. **FS layer** (`src/kernel/fs.ts`): ZenFS (`@zenfs/core` + `@zenfs/dom`) mounted on OPFS at `/`, with an in-memory fallback when OPFS is unavailable (private windows) — the app must still boot. Expose a thin promise API (`readFile`, `writeFile`, `ls`, `mkdir`, `rm`, `mv`, `stat`, `watch`-style change events on the OS event bus). ZenFS stays a dependency (LGPL) — never vendor or fork it.
2. **Seed content** on first boot: `~/desktop/brief.md` (the demo brief: "build a small landing page for Aurora Trails…"), `~/site/` empty dir, `~/notes/welcome.md`. Idempotent (marker file).
3. **fs tools**: `fs_read {path}`, `fs_write {path, content}`, `fs_list {path}`, `fs_mkdir {path}`, `fs_delete {path}`, `fs_move {from, to}`. Paths are `~`-rooted virtual paths; validate + normalize; errors `verbos: no such file: <path>` style. Every write emits an FS change event.
4. **Files app**: real browser of the FS (list, navigate, create folder, rename, delete; double-click opens Editor for text files). Live-updates on FS change events (agent writes appear without refresh).
5. **Editor app**: opens a file (from Files double-click, `app_open {appId:'editor', path}`, or its own open dialog), textarea-based editor (CodeMirror NOT yet — keep deps flat), saves with Cmd/Ctrl+S, shows dirty state, live-reloads if the same file changes on disk underneath (agent wrote it) with a subtle tinted flash on the changed content.
6. **Notes app**: markdown notes stored as files under `~/notes/`; list + edit + rendered preview toggle.
7. Per-app tool additions to the boot registry (still static in M2): `editor_open_file {path}`, `notes_append {note, text}`.

## Out of scope

Shell/terminal, spotlight, settings, preview app, dynamic (window-lifecycle) registration — M3/M4.

## Acceptance

- Type/build/test gates green as in M1.
- Harness: `fs_write` a file → Files window shows it live → `fs_read` round-trips; human edits in Editor + saves → `fs_read` returns the edit; agent `fs_write` to the open file → Editor live-reloads with flash. Reload the tab → content persists (OPFS).
- `bun test`: fs API against in-memory backend (path normalization, errors, events); seed idempotency.
