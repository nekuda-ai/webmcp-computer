# Terminal & shell

The Terminal runs `just-bash` entirely in the browser against the shared WebMCP Computer
filesystem. Your commands are TYPED VISIBLY into the terminal, character by character,
on an accent-tinted row with a `codex@webmcp-computer` prompt. The human sees the same output and
can use the same window. Each Terminal has its own session: cwd, exported environment,
exit status, and history persist between human and agent commands.

## Tools

- `term_exec {command, term_pid?, timeout_ms?}` → `{stdout, stderr, exit_code,
  truncated}`. Opens a terminal if none exists. Default timeout 30s (max 120s);
  stdout/stderr each capped at 256 KB with `truncated: true` past that.
- `term_read {term_pid?, lines?}` — the last N lines of the shared scrollback
  (2000-line buffer). Use it to see what the human typed or what you missed.
- `term_state {term_pid?}` → `{pid, cwd, busy, running_command?, env}` from the live
  shell session object — never parsed from scrollback.
- `term_history {term_pid?, limit?}` → `[{index, command}]`, newest last. It reads the
  same history the human sees; default 50, maximum 1000.
- `ps` — the real process table: windows AND transient running commands, with PIDs.
- `kill {pid}` — closes a window or aborts a running command. PID 1 is protected.

## Command surface

This is bash rather than the old simulated subset. It supports pipelines and file
descriptors, `>`, `>>`, `<`, `&&`, `||`, variables and parameter expansion, command
substitution and subshells, globs, loops, conditionals, functions, and real exit codes.

Bundled commands include:

- Files: `cat cp file find ln ls mkdir mv readlink rm rmdir stat touch tree`.
- Text: `awk cut diff grep head join paste printf rg sed sort tail tee tr uniq wc xargs`.
- Data: `jq`.
- Archives, checksums, and encodings: `base64 gzip gunzip md5sum sha1sum sha256sum`.
- Shell utilities: `alias bash date env export history seq sh sleep timeout which`.

WebMCP Computer adds `open`, `serve`, `cloud`, `ps`, `kill`, `dmesg`, `uname`, `whoami`, `hostname`,
`clear`, shared `history`, `man`, and `os_help`. Run `os_help` to list both bundled
and WebMCP Computer commands. A standalone top-level `help` or `help COMMAND` is an alias for
`os_help`; inside a pipeline or subshell, `help` is just-bash's native builtin and does
not include WebMCP Computer commands. Run `COMMAND --help` for command usage and
`man <topic|tool|OS-command>` for WebMCP Computer manuals.

## Paths and writes

WebMCP Computer tools use `~` paths. Bash has one POSIX root: kernel `~` is `/`, so `pwd` at
home prints `/`, `/site/x` is `~/site/x`, and no path exists above that root.
Redirects, appends, copies, moves, and command-created files all go
through the kernel with human/agent attribution, so Files, Editor, Preview live reload,
conflict bars, filesystem watches, and `dmesg` still see them.

Filesystem compatibility is intentionally limited: `ln SOURCE DEST` copies the source bytes
once rather than creating a real hard link, symbolic links are unsupported so `readlink`
fails, and `chmod` validates the path but is otherwise a no-op.

## Deliberately disabled

Browser shell keeps `curl` and all network configuration disabled, and has no Python or
JavaScript runtime. Use `cloud` for network access and Node.js or Python runtimes. Commands
without `cloud` stay local and offline.

## Tips

- `jq` and `awk` can process files created through `fs_write` immediately.
- `dmesg` prints the OS event log — everything you and the human did, attributed.
- `open <app-or-path>` opens WebMCP Computer windows; `serve <directory>` opens live Preview.
- Long agent commands accelerate visible typing (ceiling about 4s), but every character
  still appears.
- A command exceeding its timeout rejects with `webmcp-computer: command timed out after Ns`.
  Output produced before timeout stays visible; the human can also press Ctrl+C.
