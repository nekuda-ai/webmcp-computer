# Conventions

## Errors

Every WebMCP Computer runtime error starts `webmcp-computer: ` and says what actually failed, on the failing side.
Shell usage errors keep their command-native form (for example, `kill: invalid PID 'x'`) and
return exit code 2. Runtime examples:
`webmcp-computer: no such file: ~/x`, `webmcp-computer: no such directory: ~/site/css`, `webmcp-computer: is a
directory: ~/desktop`, `webmcp-computer: path escapes home`, `webmcp-computer: not a text file: ~/a.png
(12 bytes)`, `bash: missing-command: command not found`, `webmcp-computer: command timed out after
30s`, `webmcp-computer: pid 1 is the screensaver; window pids start at 2`. Trust the message —
it names the real cause, not a generic failure.

WebMCP tool failures arrive as
`{ content: [{ type: "text", text: "webmcp-computer: <cause>" }], isError: true }`. Treat
`isError: true` as failure; the text block carries the implementation's exact message.

## Truncation

Reads and command output are capped at 256 KB and marked `truncated: true`. Never treat
a truncated result as the whole file. `os_search` indexes only the first 256 KB of each
text file and returns skipped unreadable locations in `warnings`. Scrollback keeps the
last 2000 lines.

## Sequencing

Tool calls resolve when their effect is on screen, including the visible typing — you
can chain calls without sleeping. Concurrent `term_exec` calls on one terminal queue in
order. Parallel `fs_*` writes to one path are serialized safely, but last write wins:
sequence your own writes to a file. Browser tabs share OPFS, so mutations also take an
exclusive Web Lock across tabs. Persisted settings self-repair invalid keys and broken
JSON to safe defaults before the next read or write.

## Invocation classes

- **ask** returns data without changing state; it has no UI obligation unless the tool
  says otherwise. `os_search` is the composable exception: it shows passive Spotlight
  by default, while `show: false` is silent.
- **act** changes visible, reversible state and always leaves a human-visible trace.
- **transact** is consequential or irreversible (`fs_delete`, `kill`, `os_publish`,
  `cloud_exec`, `machine_take_over`); take a second thought before calling it. Publishing
  makes selected bytes public, cloud execution runs arbitrary code with open network
  egress, and takeover interrupts another tab's control.

Wire annotations use WebMCP's `consequentialHint` name (`destructiveHint` in MCP); it
is true only for transact tools.

## Ownership

A tab starts in **acquiring control**: the desktop is inert, ordinary tools fail before
starting, and Browser heartbeat is ineligible until its exclusive Web Lock is granted.
A confirmed competing tab shows **Take over**. `machine_take_over {}` is the only
blocked-state exception and is deliberately consequential: it invokes the same ownership
steal as the visible button and returns `{taken_over: boolean}`. Losing ownership aborts
agent work and every active human Terminal command, and queued human Terminal commands are
canceled before they start. Human and agent filesystem mutations retain their admission
ownership epoch through locks, preflight, and async update callbacks; an old mutation stays
invalid even if this tab later reacquires ownership. Pending Editor and Notes autosaves fail
without marking stale snapshots saved. System seed and repair writes remain allowed during
initial ownership acquisition. Remote work already accepted or completed may still finish;
takeover cannot undo it, though the old tab cancels its transport and does not report stale
success.

Strict multi-tab enforcement requires Web Locks. BroadcastChannel presence only confirms a
contended lock after a short reload grace period; it is not a mutex and cannot safely replace
Web Locks because suspended tabs may not answer. A browser without Web Locks remains usable
in an explicitly warned single-tab degraded mode, but Browser heartbeat stays disabled and
the user must not open a second machine tab.

## Etiquette

- The screensaver wakes on your first call; you never need to handle it.
- Don't fight the human for a file: if your write triggered their conflict bar, wait —
  their choice decides whose version is on disk.
- `dmesg` and the shared `history` are your audit trail and theirs. Work so that the
  log reads like a colleague's session, not a storm.
