# Real bash terminal — just-bash on the WebMCP Computer filesystem

## Goal

The Terminal stops being a simulation. `just-bash` (Vercel Labs, pure-TS bash) runs
fully in the browser against the real WebMCP Computer filesystem, giving the human and the agent
~100 real commands (grep, awk, sed, jq, sort, head, tar…), pipes, redirects, subshells,
and variables — while every write still flows through the kernel so conflict detection,
watch-driven live reload (Preview, ui apps), and source attribution keep working.

## Why

"Real bash in a browser tab with zero backend" is a visceral demo beat, and it uses
sponsor tech (Vercel Labs) without hosting anything. The agent's `terminal_run` verb
becomes genuinely powerful (jq over files the agent just wrote, grep across ~/notes).

## Verified API facts (spike: `spike/justbash/`, all green in a real browser)

- `new Bash({ fs?: IFileSystem, cwd?, env? })`; `bash.exec(cmd, { signal?, cwd?, env? })`
  → `{ stdout, stderr, exitCode }`. Shell state persists per instance; fs is injectable.
- `IFileSystem` is fully **async** (Promise-based: readFile/readFileBuffer/writeFile/
  appendFile/exists/stat/readdir/mkdir/rm/…): an adapter over `kernel/fs` is a
  straight mapping, no sync bridge needed.
- `defineCommand(name, run)` adds custom commands — the seam for OS verbs.
- Browser bundle needs a `node:zlib` shim: alias to an `fflate`-based module
  (gunzipSync/gzipSync/constants) in `vite.config.ts` — proven in the spike, copy it.
- Network (`curl`) stays OFF: never pass network config (BRIEF: no other network call).
- Optional Python/JS engines stay OFF (bundle size, scope).

## Design

### Engine swap behind the existing seams

- `executeShell()` in `kernel/shell/engine.ts` keeps its public signature
  (`source`, `onStdout`/`onStderr`/`onClear`, `signal`) but delegates to a just-bash
  `Bash` instance. TerminalApp, `terminalSessions`, and `terminalTools` contracts do
  not change shape.
- One `Bash` instance per terminal session (env vars, cwd, shell state persist across
  commands in a window, matching just-bash semantics). `terminal_run` (agentless
  window? check current behavior) uses the session of the targeted terminal PID —
  preserve whatever pairing exists today.
- cwd: after each exec, read the Bash cwd and sync it to the kernel store
  (`setProcessCwd`) so the prompt and `terminal_get_cwd`-style behavior stay truthful.
  Kernel-initiated cwd (spawn with cwd) seeds the instance.

### Filesystem adapter (`kernel/shell/justBashFs.ts` or similar)

- Implements just-bash `IFileSystem` over `kernel/fs` (zenfs). All writes call the
  kernel write path **with the execution's source** ("human" | "agent") so conflict
  bars, watch events, and traces behave exactly as before. The adapter is
  per-execution-bound to a source (factory takes the source, or context threads it).
- Path mapping: WebMCP Computer paths are `~`-rooted; just-bash cwd is POSIX. Map `~` ↔ `/home/user`
  (or whatever just-bash defaults to) consistently in the adapter and in prompt display;
  pick the minimal mapping that keeps existing `~`-rooted outputs stable.
- Binary/size guards from `kernel/fs` still apply (kernel pins). Errors surface with the
  kernel's message text where tests pin them.

### OS verbs as shell commands

- Re-register the OS-specific commands from `kernel/shell/commands/system.ts`
  (open/app/window/settings-style verbs — whatever exists today) via `defineCommand`
  so `open ~/notes/todo.md` still works in the new shell. Text/filesystem commands that
  just-bash covers natively (cat, ls, grep…) are dropped from our registry — just-bash
  wins; keep ours only where it does something OS-specific just-bash cannot.
- `help` remains: list just-bash's command set + our OS verbs; `--help` behavior may
  change to just-bash's own; update the manual accordingly.

### Behavior changes (accepted, tests updated to pin the NEW behavior)

- Error texts become just-bash's (`command not found` phrasing, exit codes 127/2/1
  semantics per just-bash). `engine.test.ts` is rewritten to pin the new engine's
  behavior through the same seam — same scenarios, updated expectations, plus new pins:
  pipes, `&&`/`||`, variables, subshell, jq/awk round-trip on OS files.
- Old parser/`sh-syntax`/options/registry modules die if nothing else uses them
  (`registry.ts` may survive for OS-verb `defineCommand` wiring + help). Remove the
  `sh-syntax` dependency if it becomes unused.
- Terminal output sanitizer and layout logic stay (they operate on text, not engine).

### Bundle + build

- `just-bash@3.4.2` + `fflate` added to `web/package.json`. Vite alias `node:zlib` →
  fflate shim (copy `spike/justbash/zlib-shim.ts` in as `web/src/kernel/shell/zlibShim.ts`).
- Lazy-load the engine: just-bash (~374KB gz) must load with the Terminal app chunk,
  not the boot bundle. Verify with `vite build` output.

## Tests

Unit:
- New/updated `engine.test.ts` through the public `executeShell` seam: echo/redirect/
  append, pipes, grep/awk/sed/jq on kernel files, cd + cwd sync to store, `&&`/`||`,
  exit codes, command-not-found, abort mid-pipeline (signal), OS verb command still
  opens an app (store assertion), write-attribution: a human-source exec write triggers
  the same conflict/watch behavior the old engine did (assert via fs watch event or
  fileBuffer conflict seam — whichever existing tests use).
- Adapter tests: `IFileSystem` conformance over the in-memory backend (read/write/
  stat/readdir/mkdir/rm/append, missing-file error text, is-a-directory error text,
  binary guard passthrough).
- Regression pins that reference shell behavior (early error texts) reviewed:
  keep kernel-level pins intact; shell-level texts may change with the engine.

E2E:
- Existing `terminal.e2e.ts` scenarios keep passing (update typed commands/expected
  output where the engine legitimately changed them).
- One new dense scenario: human types a pipeline (`printf … | grep … | sort`) → output
  visible; agent `terminal_run` a jq command over a file it wrote via `fs_write` →
  result returned over WebMCP; `echo x > file` in terminal → Files/watch-driven
  behavior proves the write hit the real kernel fs (e.g. fs_read over WebMCP).

`bun test src`, `bun run build`, `bun run test:e2e` all green; e2e budget stays <90s.

## Out of scope

- curl/network config (BRIEF hard rule — never enable).
- Python (CPython wasm) and QuickJS optional engines.
- Replacing terminal UI/xterm wiring; sessions model unchanged.
