# Filesystem

One shared filesystem. It persists in browser OPFS by default or in a Cloudflare
Computer workspace after the cloud-kernel reboot described in `~/skills/cloud.md`.
The human sees it in Files and Editor; you see it through `fs_*` tools and the shell.
Same bytes, live in both directions.

## Paths

Always `~`-rooted: `~/desktop/brief.md`, `~/site/index.html`. There is nothing outside
`~`. Non-home paths are rejected with `verbos: path must start with ~/`; traversal that
escapes `~` is rejected with `verbos: path escapes home`.

## Tools

- `fs_list {path}` — directory listing (dirs first, with size + mtime).
- `fs_read {path}` — text files only; >256 KB comes back truncated with
  `truncated: true`. Binary files are refused with their size.
- `fs_write {path, content}` — create or replace a whole file. Empty content truncates
  it to zero bytes. Parent must exist (`fs_mkdir` first; error names the missing
  directory).
- `fs_edit {path, old_string, new_string, replace_all?}` — anchored replace.
  `old_string` must match exactly once unless `replace_all: true`; zero matches report
  `old_string not found`, while multiple matches tell you to pass `replace_all` or use
  a longer anchor. Prefer this for edits — cheaper and safer than rewriting the file.
- `fs_search {query, path?, max_results?}` — case-insensitive content search,
  returns `{path, line, text}` rows. Your grep without a terminal.
- `fs_move {from, to}`, `fs_delete {path}`, `fs_mkdir {path}`.

## Living with the human

- Every write you make shows up live in their open Files/Editor windows.
- Human Editor and Notes changes autosave after about 500ms; Editor shows a blue dirty
  dot while bytes are pending. Files under `~/desktop/` also appear as live desktop
  icons and open in Editor on double-click.
- If they have pending edits in Editor or Notes when you write the same file, your
  version does NOT clobber their buffer: they get a "CHANGED ON DISK — Reload / Keep
  mine" choice. If they keep theirs, autosave replaces your write — re-read before
  building on it.
- The shell sees the same filesystem: `term_exec {command: "cat ~/x"}` ≡ `fs_read`.
