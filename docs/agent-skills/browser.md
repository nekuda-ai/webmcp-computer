# Shared browser

Browser is one real Chrome session running in Cloudflare Browser Run. Human and agent
use the same tab: human clicks and types directly in the live-view frame while agent
calls VerbOS browser tools over CDP. Open it with `browser_open`; Browser is a singleton.

## Tools

- `browser_open {url?, x?, y?, width?, height?, focus?}` starts the session and opens
  the window. `url` must use http or https. Reopening focuses the same window and
  navigates it when `url` is supplied.
- `browser_goto {url}` navigates, waits for a bounded load event, and returns URL/title.
- `browser_read {selector?}` returns page title, URL, and matching `innerText`. Selector
  defaults to `body`; text is capped at 32 KB and reports `truncated`.
- `browser_click {selector}` calls `.click()` on the first CSS match.
- `browser_type {selector, text, submit?}` focuses a field, replaces its value, emits
  DOM input/change events, and optionally emits Enter plus form submission. Text is
  capped at 4 KB.
- `browser_screenshot {}` returns a JPEG data URL and dimensions. It retries once at
  lower quality before failing if the 256 KB result cap would be exceeded.
- `browser_site_tools {}` lists WebMCP tools exposed by the inner page.
- `browser_site_call {name, input}` calls one inner-page tool and passes through its
  result up to 256 KB. Inner-site tools carry their own consequences; VerbOS cannot
  classify them. Inspect tool description and input before calling, and have the human
  watch the live view while the inner-site call runs.

The seven `browser_*` controls after `browser_open` are dynamic. They exist only while
the Browser window is open and disappear when it closes.

## Session lifetime and recovery

Browser Run keeps an idle session for five minutes. VerbOS attempts one capability
refresh after a WebSocket disconnect. If that fails, the window shows `SESSION ENDED`;
call `browser_open` or press `NEW SESSION` for a fresh browser. Closing the window sends
a best-effort close immediately, with the idle timeout as cost-control backstop.
The remote viewport follows the Browser window's live-view content box after a short
resize debounce, capped at 2048 pixels per side.

Common errors are `verbos: browser session unavailable: <reason>`,
`verbos: browser selector not found: <selector>`,
`verbos: this browser session has no WebMCP support`, and
`verbos: browser text exceeds 4 KB cap`.

## Honest limits and trace

Human actions inside Cloudflare's cross-origin live-view frame are not visible to
VerbOS, so human page clicks and typing do not appear in `dmesg`. The live view itself
is the human's visible trace. Agent browser tools do flow through `runAgentAction` and
appear in the normal toast, presence cursor, Activity, and `dmesg` trace.

`browser_click` and `browser_type` use CSS selectors and DOM-generated events. They are
not trusted OS pointer or keyboard events, and pages may reject them. Downloads,
uploads, multiple tabs, multiple Browser windows, and session recording are unavailable.

Human right-clicks reach the remote page, so page-implemented context menus work. There
is no native browser context menu inside the remote session because Chrome is headless.

Some sites challenge datacenter or bot traffic. Browser Run is always identified as bot
traffic through cryptographically signed requests and offers no stealth mode. When a
challenge appears, tell the human instead of retrying so they can solve it directly in
the live view. VerbOS does not build or integrate CAPTCHA bypass.
