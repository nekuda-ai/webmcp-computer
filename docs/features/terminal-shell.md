# Terminal — shell engine and term tools

Goal: a real-feeling POSIX-ish shell inside WebMCP Computer. The human types in a terminal; the agent runs `term_exec` and its keystrokes are VISIBLY typed into the same terminal. Both operate on the M2 filesystem.

## Scope

1. **Shell engine** (`src/kernel/shell/`): parse with `sh-syntax` (mvdan/sh WASM); hand-written async interpreter over the AST supporting: command + args, quoting, `;`, `&&`, `||`, pipelines `|`, redirections `>`, `>>`, `<`, env var expansion `$VAR` + `export`, simple `*` globbing, `~` expansion. Anything else (subshells, functions, loops): `webmcp-computer: not supported yet: <construct>`. Engine is pure TS against the FS API + an injected process context — unit-testable headless, no xterm import.
2. **Command registry**: each command = `{name, summary, usage, flags, run(ctx)}`. `--help` is auto-generated GNU-style from the metadata for every command; `help` lists all; `man <cmd>` renders a fuller page (`FS_READ(1)`-style headers per the design mock).
3. **Commands** (30 total): `ls` (-l -a), `cd`, `pwd`, `cat`, `echo` (-n), `mkdir` (-p), `rm` (-r -f), `mv`, `cp` (-r), `touch`, `head`/`tail` (-n), `grep` (-i -n -r), `find` (-name), `wc` (-l -w -c), `which`, `env`, `export`, `history`, `clear`, `date`, `whoami` (`guest`), `hostname` (`webmcp-computer`), `uname` (-a → `WebMCP Computer 1.0 wasm32 (browser)`), `ps`, `kill`, `open <app|path>` (spawns app windows via kernel), `dmesg` (dumps the OS event log), `help`, `man`. Unknown command: `webmcp-computer: command not found: <cmd>` (and a hint to try `help`).
4. **Terminal app**: `@xterm/xterm` with prompt `guest@webmcp-computer:~$` (path-aware), line editing (local-echo style: arrows, history, Ctrl+C/L), phosphor-on-dark theme per design, streaming output. Multiple terminal windows = separate shell sessions with own cwd/env/history.
5. **Agent visible typing**: `term_exec {command, term_pid?}` types the command into the terminal character-by-character (~20ms/char, accent-tinted row + CODEX cursor near the prompt), then executes, then returns `{stdout, stderr, exit_code}` (combined output also mirrored on screen). If no terminal is open, it opens one first. `term_read {term_pid?, lines?}` returns the last N lines of the scrollback (default 50).
6. **Kernel integration**: `ps`/`kill` operate on the real process table (windows are processes; a running pipeline is a transient process entry). `kill <pid>` of a window closes it.

## Out of scope

`serve`/Preview app, npm/build toolchain, spotlight, settings — M4/M5.

Dynamic per-app registration already has its lifecycle pattern in `notes_preview`; later milestones extend that pattern to more apps.

## Acceptance

- Gates green (tsc/build/test). Shell engine tests headless: parsing/exec of pipelines (`ls | grep .md | wc -l`), redirections, `&&`/`||` short-circuit, globbing, `--help` autogen for every registered command (assert every command's `--help` exits 0 and prints usage), `webmcp-computer: not supported yet` on a `for` loop.
- Harness: `term_exec {"command":"echo shalom > ~/hi.txt && cat ~/hi.txt"}` returns exit 0 with `shalom`, typing is visible, `fs_read ~/hi.txt` agrees; `term_exec` `uname -a` shows the WebMCP Computer string; human types `ls` in the same terminal and sees the agent's file; `ps` lists windows, `kill` closes one, `dmesg` shows the agent's calls.
