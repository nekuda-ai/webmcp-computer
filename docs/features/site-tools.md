# Site tools — served sites register WebMCP tools (M6.5)

Product ruling (2026-08-26, overriding M6 item 9's paragraph): served content MUST be
able to register WebMCP tools. The threat model that forbade it was wrong — the agent
authoring the site already has full browser control through its bridge; there is no
privilege to escalate. This is the showcase: the agent builds a site inside VerbOS and
the site itself joins the tool surface.

## Design

The iframe sandbox stays exactly as is (`allow-scripts` only, opaque origin,
`allow-same-origin` remains FORBIDDEN — that boundary is plumbing, not policy). Served
content reaches the surface over the existing token-validated postMessage channel:

1. **Facade in the shim.** The injected shim exposes a `modelContext`-compatible facade
   to the served page (`document.modelContext` shape inside the frame: `registerTool`
   with abort-signal unregistration, `getTools` over its own registrations). Tool
   handlers run inside the iframe.
2. **Proxy registration.** The Preview host receives register/unregister messages and
   registers through OUR tool registry → the SDK (BRIEF rule 1 intact; the served page
   never touches the real surface). Registered under the preview window's dynamic
   scope: reload or close tears them down via the existing lifecycle. `ontoolchange`
   fires naturally — external agents just see the tools appear.
3. **Identity + honesty on the wire.** Site tool wire names get the `site_` prefix
   (collision-proof against system tools); Tool Monitor shows them grouped under the
   served site with the "+N JUST REGISTERED" flash; ALL site tools carry
   `untrustedContentHint: true` (site-authored results — the protocol's own label) and
   descriptions pass through verbatim. Taxonomy class: act by default (their effects
   are site-internal); the classification test gains a rule for the `site_` namespace
   rather than per-tool entries.
4. **Execution path.** Agent calls `site_*` → host postMessages the call (id, input)
   into the frame → shim runs the handler → result back → host resolves. 10s timeout
   (`verbos: site tool timed out: <name>`), thrown/rejected handlers convert to the
   standard isError transport, results size-capped 256KB like everything else. Cap 16
   registered site tools per preview (`verbos: site tool limit reached`).
5. **Visible trace (rule 4).** Site tool calls toast like any agent action
   (`AGENT RAN: site_book_night · preview`) and tint nothing outside the preview.
6. **Demo fixture + manual.** The Aurora Trails e2e/demo fixture registers
   `site_book_night {name}` proving the loop end to end: serve → tools grow → agent
   calls the site's own tool → visible effect in the page. preview.md REWRITES the M6
   "served content cannot register tools" paragraph into the new contract (how to
   register from a served page, the `site_` prefix, the caps, the untrusted label) —
   written for the visiting agent audience. REFERENCE.md notes the facade is VerbOS's,
   not Chrome's, inside the frame.

## Out of scope

`getTools` over SYSTEM tools from inside the frame (the site sees only its own);
site-initiated `executeTool` of system tools (the site is a product, not a user —
revisit only with a real use case); hover-tooltip introspection of site DOM (Tool
Monitor's group + flash is the visibility).

## Acceptance

Gates green both Chromes. e2e: serve a fixture that registers a tool → bridge sees
`site_hello` with `untrustedContent: true` → executeTool returns the site's answer →
reload → tool re-registers → close → gone. Unit: cap, timeout, teardown, prefix
enforcement, facade signal semantics. Byte-pin honored for preview.md.
