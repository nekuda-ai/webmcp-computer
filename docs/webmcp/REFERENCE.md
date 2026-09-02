# WebMCP protocol reference (as WebMCP Computer uses it)

Spec: https://webmachinelearning.github.io/webmcp/ (W3C Web Machine Learning CG draft;
it churns monthly). WebMCP Computer never touches the raw API — `@nekuda/webmcp-sdk` pins a
spec version and absorbs the churn. This file records what the surface actually is, so
decisions here don't rest on memory of a moving draft.

## The live surface (verified empirically in Chrome 150+, 2026-08-26)

`document.modelContext` is an `EventTarget` with exactly four members:

- `registerTool(tool, { signal })` → Promise. The only way in. Unregistration is
  aborting the signal — there is no `unregisterTool`.
- `getTools()` — the page can enumerate its own registered tools.
- `executeTool(name, input)` — the page can invoke its own tools (agents come in
  through the browser/bridge, not through this).
- `ontoolchange` — fires when the tool list changes.

`navigator.modelContext` is absent in current Chrome (it was the 149 surface; the SDK
resolves `document ?? navigator` so both eras work). `window.agent` (the oldest
explainer shape) is dead.

Inside a served Preview or agent-made App frame, `document.modelContext` is WebMCP Computer's
injected facade, not Chrome's native surface. It proxies `registerTool` and abort-signal
unregistration to the WebMCP Computer host, while `getTools()` returns only that frame's
registrations. It does not expose system tools or `executeTool`.

## What the protocol does NOT have

No resources, no prompts, no instructions field, no context documents — nothing like
MCP's server-side extras. **A page's entire self-description to an agent is its tools:
names, descriptions, input schemas, annotations.** Consequences for WebMCP Computer:

1. Tool descriptions are load-bearing product surface, not comments. They are written
   for a stranger LLM and reviewed like API contracts.
2. There is no native way to hand an agent a manual — so WebMCP Computer ships its manual
   *through* the tool channel: the seeded `~/skills/` files (readable via `fs_read` /
   `cat`) and the `os_manual` tool that returns them directly.
3. Dynamic tools are first-class in the protocol (`ontoolchange` exists precisely for
   this) — our per-app registration leans on spec-supported behavior, not a bridge
   quirk. Verified both directions against the chrome-devtools bridge in
   `spike/dynamic.html`.

## House rules

- Only the SDK touches Chrome's real `document.modelContext` (BRIEF hard rule 1);
  `registry.ts` registers through the SDK's own `resolveModelContext()` surface
  (validation, telemetry, and unregistration remain the SDK's). Preview's frame-local
  facade above is not the real surface; its proxy still enters through registry → SDK.
  Even the Tool Monitor reads our own registry state, not `getTools()`.
- **The manual ships with the machine**: any change to a tool's name, schema,
  description, caps, or error strings updates `docs/agent-skills/` in the same change.
  The seed test pins the bytes; a skill claim that contradicts the shipped surface is a
  release blocker.
- When the SDK bumps its spec pin, re-verify this file's "live surface" section and the
  dynamic-registration spike.
- WebMCP calls its protocol-layer annotation `consequentialHint`; MCP calls the same
  concept `destructiveHint`. Chrome 154 normalizes `consequentialHint` to live-surface
  `annotations.consequential`, while Chrome 151 exposes no `consequential`. Chrome
  silently drops unknown annotation keys, including `destructiveHint` on this surface.
  The current SDK types do not declare `consequentialHint`, so `src/webmcp-sdk.d.ts`
  augments that interface until they do.

## Chrome bridge error transport

Chrome 151's `WebMCP.toolResponded` transport currently reports rejected tool calls with
`status: "Error"` and an empty `errorText`, while preserving the thrown error in
`exception.description`. A minimal repro with both a plain `Error` (`app_close` for a
missing PID) and a filesystem error (`fs_read` for a missing path) produced the same
shape, while the SDK's registered executor rethrew each original error unchanged. This
isolates the loss to Chrome's CDP bridge, not WebMCP Computer or `@nekuda/webmcp-sdk`.

Not every MCP-family bridge reads `exception.description`, so application error
messages cannot rely on that CDP fallback. Tool implementations still throw an `Error`
with the full `webmcp-computer:` message. The registry's registered-surface wrapper catches it
and returns MCP's tool-error result:

`{ content: [{ type: "text", text: "webmcp-computer: <cause>" }], isError: true }`

`isError: true` makes this a failure, not a shaped success. It also keeps the message in
the content path every MCP-family client already transports. The Puppeteer e2e pins
that exact bridge output; `errorText` / `exception.description` remain diagnostics for
native failures outside a tool implementation.
