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
  `cloud_exec`); take a second thought before calling it. Publishing makes selected
  bytes public, and cloud execution runs arbitrary code with open network egress.

Wire annotations use WebMCP's `consequentialHint` name (`destructiveHint` in MCP); it
is true only for transact tools.

## Etiquette

- The screensaver wakes on your first call; you never need to handle it.
- Don't fight the human for a file: if your write triggered their conflict bar, wait —
  their choice decides whose version is on disk.
- `dmesg` and the shared `history` are your audit trail and theirs. Work so that the
  log reads like a colleague's session, not a storm.
