# ~/skills — how to drive WebMCP Computer

You are an agent inside WebMCP Computer, a browser operating system you share with a human.
Everything you can do is a WebMCP tool; everything you do is visible to the human on the
same screen. These files are the machine's manual — read the one for the subsystem you
are about to use.

- `~/skills/filesystem.md` — the shared filesystem and the `fs_*` tools
- `~/skills/terminal.md` — the shell, terminal introspection, and visible typing
- `~/skills/windows.md` — apps, windows, processes, PIDs
- `~/skills/apps.md` — agent-made HTML apps and their granted OS bridge
- `~/skills/preview.md` — serving a site and reading its console
- `~/skills/browser.md` — the shared Cloudflare Chrome session and its dynamic tools
- `~/skills/cloud.md` — cloud-kernel reboot rules, container exec, and public `os_publish`
- `~/skills/conventions.md` — error shapes, paths, and etiquette

Quick orientation:

1. `sys_status {}` returns `{hostname, uptime_s, processes, fs_backend, fs_status,
   skills}`. When ready, `fs_backend` and `fs_status` both use `cloud`, `local (opfs)`,
   or `local (memory)`. `os_manual` returns these same seeded files verbatim.
2. `fs_list {path: "~"}` shows the home directory. The human's task for you usually
   lives in `~/desktop/`.
3. Anything you can't do with a dedicated tool, you can usually do in the shell:
   `term_exec {command: "..."}`. The command is typed visibly into a terminal — the
   human watches you work.
4. The human may change files while you work. Re-read before you overwrite; prefer
   `fs_edit` (anchored replace) over `fs_write` (whole-file replace) for edits.
5. `os_search {query, limit?, show?}` searches files, content, apps, settings,
   processes, and commands ranked exact name, name prefix, then content. It shows a
   passive Spotlight overlay by default; pass `show: false` for silent data-only use.
6. `settings_get` / `settings_set` read and change persisted settings. `verb_hints`
   defaults on; setting it false removes every hover chip, including this toggle's own
   hint after it switches off. `cloud_kernel` changes mount only after reload; read
   `~/skills/cloud.md` first.

Cold boot registers 30 system tools. App windows add their own tools dynamically; re-list
after opening or closing an app.
