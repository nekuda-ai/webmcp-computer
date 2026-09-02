# Agent-made apps

`ui_open` turns a plain HTML file into a shared WebMCP Computer app window. The file stays in
the filesystem, so the agent can build it and the human can inspect or edit it live.

## Opening an app

- `ui_open {name, html, allowTools?, x?, y?, width?, height?, focus?}` writes or
  replaces `~/apps/<name>.html`, then opens it.
- `ui_open {name, path, allowTools?, x?, y?, width?, height?, focus?}` opens an
  existing ~-rooted `.html` file. Pass exactly one of `html` or `path`.
- `name` is 1-40 letters, numbers, hyphens, or underscores and starts with a letter or
  number. Inline HTML is capped at 256 KB UTF-8. Up to 16 tool names may be requested.
- Agent-made App windows do not open through `app_open`. Their title is the HTML file's
  basename without `.html`; `ui_open` returns `{pid, path, rect, grantedTools}`.

Editing the backing file with `fs_write`, `fs_edit`, Editor, or the shell rebuilds the
frame after about 200 ms. Reloading WebMCP Computer restores the window and its file path.

## Calling WebMCP Computer from the app

The frame exposes one frozen object:

```js
const tools = await window.webmcpComputer.listTools();
const result = await window.webmcpComputer.callTool("fs_write", {
  path: "~/site/from-app.txt",
  content: "written from the app",
});
```

`listTools()` returns only granted descriptors: `name`, optional `title`, `description`,
and optional `inputSchema`. `callTool(name, input)` requires a plain object, resolves to
the tool result, and rejects with a `webmcp-computer: ...` error string when the host refuses or
the tool fails.

## Publishing WebMCP tools from the app

Agent-made apps receive the same frame-local `document.modelContext` facade as Preview:

```js
const controller = new AbortController();
await document.modelContext.registerTool({
  name: "site_app_status",
  description: "Return visible app status. Use when checking current app state.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute() {
    return { status: document.querySelector("#status")?.textContent ?? "unknown" };
  },
}, { signal: controller.signal });
```

Registered tools join WebMCP Computer's WebMCP surface, so the browser agent can invoke them.
Their `execute` functions run inside the app frame and can update visible UI. Abort the
signal to unregister; editing, reloading, or closing the app removes every registration.
Names start with `site_`. Each app may register 16 tools. Calls time out after 10 seconds;
descriptions, schemas, and results use Preview's 4 KB, 16 KB, and 256 KB limits.

## Grants and limits

`allowTools` is an explicit capability list. Omitting it creates a pure UI with an empty
grant. WebMCP Computer intersects requested names with the active tool catalog and silently drops
unknown names, transact-intent tools, every `site_*` tool, and `ui_open` itself. The
returned `grantedTools` is the truth.

Grants live only in memory for that PID. They are never saved in the session snapshot:
after a WebMCP Computer reload, the restored window has an empty grant. Re-run `ui_open` to create
and arm a new app window. Each window allows at most two calls in flight, gives each call
10 seconds, and rejects serialized results over 256 KB.

## Sandbox and trace

Apps run from a `srcdoc` document in an opaque iframe with exactly `sandbox="allow-scripts"`
and `referrerPolicy="no-referrer"`. They receive no same-origin or popup capability.
Published `site_*` tools do not expand the app's inward `allowTools` grant.

Every bridge attempt writes one `[app] ui_call` OS event with PID, tool name, and final
success or reason. The called OS tool also writes its normal `[agent]` event through
`runAgentAction`, so a successful call intentionally leaves both traces. App events stay
in Activity and `dmesg`; they do not light the CODEX presence cursor.
