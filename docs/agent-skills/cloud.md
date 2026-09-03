# Cloud kernel & publishing

WebMCP Computer boots local-first. By default, home lives in browser OPFS (or memory when OPFS is
unavailable). `cloud_kernel` opts this browser into a durable Cloudflare Computer
workspace. Terminal, Files, Editor, Preview, and every `fs_*` tool keep the same
contracts; only where home bytes live changes.

## Switch and reboot

- `settings_set {key: "cloud_kernel", value: true}` persists the preference and returns
  `note: "reboot required — the machine restarts to remount its filesystem"`.
- Reload after the write settles. `sys_status {}` then reports `fs_backend: "cloud"`,
  and the menu bar shows `CLOUD`.
- Set it to `false`, wait for the result, then reload to return to `local (opfs)` or
  `local (memory)`.
- Cloud mode starts with a fresh home. WebMCP Computer does not copy local files into it, and
  switching back reveals the unchanged local home. Move wanted text explicitly.
- If cloud mount fails, WebMCP Computer visibly warns and continues on local storage. Boot never
  depends on the preview SDK or network.
- If the browser cannot persist the boot mirror, `settings_set` leaves the settings file
  unchanged and returns `webmcp-computer: cloud_kernel boot mirror is unavailable` or
  `webmcp-computer: could not persist cloud_kernel boot mirror: <reason>`.

Workspace ID is a browser-held capability. There is no account or handoff UI. Do not
copy `localStorage["webmcp_computer.workspace"]` into notes, sites, logs, or messages.

## Execute in the cloud container

The boundary is explicit: `cloud <command...>` runs one non-interactive Linux command
in the cloud container. Commands without the `cloud` prefix stay in the browser shell;
OS verbs never auto-route to the container. Cloud execution requires the cloud kernel to
be active after reboot.

Pipes never straddle browser and container shells. Put a pipeline, redirect, or compound
command inside one remote command, for example
`cloud sh -lc 'cat package.json | grep scripts'`. Do not expect
`cloud cat package.json | grep scripts` to feed the browser-side `grep`.

The human command starts in the current home-relative directory, mapped from `~` to
`/workspace`. It refuses cwd outside home. Agents use
`cloud_exec {command, cwd?, timeoutMs?}`; `cwd` defaults to `/workspace` and must remain
below it. The tool types a visible `cloud` command into Terminal, streams stdout and
stderr there in order, and returns
`{exitCode, stdout, stderr, pushed, pulled, truncated}`. Returned stdout and stderr are
each capped at 256 KB; `truncated` reports either cap.

`cloud_exec` is a **transact** tool because arbitrary code execution and unrestricted
container egress can expose workspace bytes and incur billed work. Inspect the command first.

Cold execution usually takes about 4 seconds while the container boots and mounts the
workspace; warm execution is normally sub-second. Timeout defaults to 5 minutes and caps
at 10 minutes. One command may run per workspace at a time. Each machine gets at most
2 hours of container runtime per 24-hour budget window. The server destroys the container
5 minutes after the last command finishes, and the next command restarts it transparently;
workspace files persist in the Durable Object. Ctrl-C disconnects the local stream so the
shell does not hang, but it does not cancel the remote process; that process can continue
until its timeout.

Budget and capacity refusals explain when to retry. Write, exec, and publish actions are
rate-limited both per signed subject + IP and per IP, so clearing browser state cannot
multiply that address's per-minute allowance.

Regular files sync both directions. Packages installed into `node_modules` work inside
the live container but do not appear through Files, Editor, or `fs_*`. A container
restart loses those installed dependencies, so rerun `cloud npm install`. This is not a
package cache or an interactive shell.

## Publish a site

`os_publish {path?}` publishes a text directory to a public internet URL. `path`
defaults to `~/site`; publishing works in local and cloud kernel modes. Allowed
extensions: html, htm, css, js, json, svg, txt, md. Caps: 64 files, 256 KB per file,
2 MB total, and 20 successful publishes per machine per 24-hour accounting window.

Publishing uses the same browser-held workspace capability at
`POST /ws/{wsid}/publish`; local mode mints and reuses one only for this scoped request.

This is a **transact** tool: uploaded bytes become public to anyone with the returned
URL. Inspect the tree first. Published files are deleted after 30 days and served from the
Computer Worker's separate `workers.dev` origin with `X-Robots-Tag: noindex` and a CSP
sandbox. R2 bucket lifecycle enforcement owns this retention window; the app does not delete
them itself. A small manifest records a pseudonymous publisher subject and IP hash for abuse
response. The result is `{url, expiresInDays, files, bytes}`. A visible toast shows the URL,
retention window, and QR code so the human can open the same site on a phone. The URL and
expiry also land in the `os_publish` `dmesg` trace.

Common failures name the cause: `webmcp-computer: publish path is not a directory: <path>`,
`webmcp-computer: os_publish rejects non-text file: <path>`, cap errors, or
`webmcp-computer: site publish failed: <Worker reason>`. When the daily publish allowance is
exhausted, the tool says how long remains before its fixed accounting window resets; the
Worker response uses stable code `EPUBLISHQUOTA` with `retryAfterMs`. `.webmcp-computer-site`
is reserved and cannot be included in a published tree.
