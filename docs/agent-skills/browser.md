# Shared browser

Browser is one real Chrome session running in Cloudflare Browser Run. Human and agent
use the same tab: human clicks and types directly in the live-view frame while agent
calls WebMCP Computer browser tools over CDP. Open it with `browser_open`; Browser is a singleton.

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
  result up to 256 KB. Inner-site tools carry their own consequences; WebMCP Computer cannot
  classify them. Inspect tool description and input before calling, and have the human
  watch the live view while the inner-site call runs.

The seven `browser_*` controls after `browser_open` are dynamic. They exist only while
the Browser window is open and disappear when it closes.

## Session lifetime and recovery

Each machine gets at most 2 hours of remote Chrome time per 24-hour budget window.
WebMCP Computer sends a heartbeat every 60 seconds only after recent trusted human input,
either in the local OS or in the remote page, while the visible, focused tab holds the
confirmed exclusive machine Web Lock. Initial lock acquisition, confirmed conflict, lock
failure, and the explicit no-Web-Locks degraded mode are heartbeat-ineligible. Agent tools
may wake the screensaver but never refresh either human-presence signal. The Browser Session
Worker owns the lease and deletes Chrome after 5 minutes
without a heartbeat; Browser Run's 10-minute inactivity timeout is the final backstop.
Opening Browser again starts a new Chrome at the last remembered http(s) origin/path; URL
credentials, query, and fragment are deliberately discarded.

WebMCP Computer attempts one capability refresh after a WebSocket disconnect. If that
fails, the window shows `SESSION ENDED`; call `browser_open` or press `NEW SESSION` for a
fresh browser. Closing the window requests immediate deletion. The remote viewport follows
the Browser window's live-view content box after a short resize debounce, capped at 2048
pixels per side.

Budget, idle, ownership, and capacity errors say whether to reopen or when to retry.
Other common errors are `webmcp-computer: browser session unavailable: <reason>`,
`webmcp-computer: browser selector not found: <selector>`,
`webmcp-computer: this browser session has no WebMCP support`, and
`webmcp-computer: browser text exceeds 4 KB cap`.

## Honest limits and trace

The parent cannot inspect pointer or keyboard events inside the cross-origin live-view
frame. It counts the trusted focus transition into that frame once, then uses the existing
tab CDP connection at each heartbeat cadence to install or query a small listener in an
isolated world for a bounded set of up to 32 current page frames. Those listeners record
only trusted pointer, keyboard, wheel, and touch events and report a bounded monotonic age;
navigation creates new worlds and the next query installs them again. Merely querying the
page is not activity. This relies on the current Live View forwarding human controls through
Chromium's trusted input path and on `Runtime.evaluate`; page CSP does not normally block
DevTools evaluation. If that platform behavior changes or a query fails during navigation,
no remote activity is credited and the lease expires conservatively. DOM `.click()` and
`dispatchEvent()` calls remain untrusted and do not count.

Human page clicks and typing do not appear in `dmesg`; the live view itself is the human's
visible trace. Agent browser tools do flow through `runAgentAction` and appear in the normal
toast, presence cursor, Activity, and `dmesg` trace.

`browser_click` and `browser_type` use CSS selectors and DOM-generated events. They are
not trusted OS pointer or keyboard events, and pages may reject them. Downloads,
uploads, multiple tabs, multiple Browser windows, and session recording are unavailable.

Human right-clicks reach the remote page, so page-implemented context menus work. There
is no native browser context menu inside the remote session because Chrome is headless.

Some sites challenge datacenter or bot traffic. Browser Run is always identified as bot
traffic through cryptographically signed requests and offers no stealth mode. When a
challenge appears, tell the human instead of retrying so they can solve it directly in
the live view. WebMCP Computer does not build or integrate CAPTCHA bypass.
