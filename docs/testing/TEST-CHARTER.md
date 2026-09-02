# WebMCP Computer test charter

Two suites, one philosophy: **every test asserts a behavior a user or agent depends on.**
No snapshot dumps, no testing implementation details, no mocks beyond the three sanctioned
seams below. A test that cannot fail when the behavior breaks is worse than no test.

## Suites

1. **Unit** (`web/src/**/*.test.ts`, bun test, runs in `bun test src` — fast, no browser).
   Sanctioned seams: the injected `modelContext` fake (SDK's `RegisterToolsOptions.modelContext`)
   the in-memory FS backend, and the external browser service boundary. Browser unit tests
   may inject fake Worker fetch and fake WebSocket pairs into `session.ts` / `cdp.ts`.
   Nothing else gets mocked — no mocking of `fs.ts` internals, kernel store, or tool modules.
2. **E2E** (`web/e2e/*.e2e.ts`, `bun run test:e2e` — real Chrome, real WebMCP surface,
   NOT part of the default `bun test`). Boots the **production build** (`vite build` +
   `vite preview` on an ephemeral port — dev-server-only bugs like import-analysis breakage
   must not hide), launches Chrome headless via `puppeteer-core` (dev dependency; never full
   puppeteer — no bundled browser download), and calls tools through the **browser's own
   WebMCP surface over CDP** — the same layer the chrome-devtools MCP bridge (and the
   judges) use. In-page `evaluate` that reaches around the registration layer to call a
   tool's `execute` directly is forbidden for tool calls; `evaluate` is fine for DOM
   assertions and for human-side simulation (typing, clicking).
   Browser e2e uses a real page `WebSocket` to a local fake Browser Run service; this is
   the external-service seam, not a new seam into WebMCP Computer internals.

## E2E mechanics (discover, don't guess)

- How to list/execute WebMCP tools over CDP: read the installed `chrome-devtools-mcp`
  package source on this machine (a running copy shows in `ps`; the package resolves via
  npx cache or global install) and replicate the minimal CDP traffic it does for
  `list_webmcp_tools` / `execute_webmcp_tool`. If replicating is disproportionate, the
  sanctioned fallback is spawning `chrome-devtools-mcp` itself as a child MCP server over
  stdio and driving those two tools — that is literally the judge path.
- Chrome binary: `WEBMCP_COMPUTER_CHROME` env var, defaulting to the system Chrome. Launch with
  whatever flag the WebMCP surface needs (discover empirically: launch, probe
  `document.modelContext !== undefined`, iterate). **If the surface is absent the suite
  FAILS with a message naming `WEBMCP_COMPUTER_CHROME` and the required Chrome — it never skips
  silently.** A green e2e run must mean "an agent can drive this OS in this browser."
- One shared fixture: boot server + browser once per run; each test gets a fresh page
  (fresh OPFS via a unique `--user-data-dir` per run; state leakage between tests is a bug
  in the test).
- Budget: the whole e2e suite under 90 seconds. Prefer fewer, denser scenario tests over
  many tiny ones — but each scenario asserts its steps explicitly.

## The regression contract — every review-caught defect is pinned forever

These bugs shipped and were caught by review, not tests. Each gets a test that would have
been red on the day it existed, in the cheapest suite that can express it:

| Defect | Suite | Assertion |
|---|---|---|
| B1 dirty-clobber | e2e | open editor, type (real keystrokes), `fs_write` same path via WebMCP → conflict bar visible, textarea still holds the typed text, status UNSAVED |
| B2 write-onto-directory | unit | `fs_write ~/desktop` throws `is a directory`; `fs_list ~/desktop` still works after |
| M1 concurrent `notes_append` | unit | two parallel appends → both texts present |
| M2 `fs_read` on directory | unit | throws `is a directory`, never returns backend internals |
| M3 missing-parent error | unit | `fs_write ~/a/b/c.txt` names `~/a/b` as the missing directory |
| M4 `fs_move` error attribution | unit | bad destination names the destination |
| M5 binary/size guard | unit | `.png` read rejected naming the file; >256KB read returns `truncated: true` |
| M7 boot resilience | e2e | page with FS boot forced to fail (env/init hook) still renders desktop + a visible failure state; fs tools throw `filesystem not ready`, app tools still work |
| N1 zero-param input | unit | `app_list`/`sys_status`/`screensaver_wake` `execute(undefined)` and `execute(null)` succeed |
| sys_status health shape | unit | reports hostname, uptime, processes, filesystem state, and skills path |
| move/resize clamps | unit | `x:999999` clamps to workarea; return value carries the clamped rect |
| z-index bounded | unit | 300 spawn/focus cycles → z-indices stay `0..n-1` |
| VerbHint setting toggle | e2e | wrapper, ref-bearing terminal host, and attached xterm keep node identity across off/on flips |
| VerbHint mounted lifecycle | e2e | enabled hover renders a chip; a new claim leaves one chip; unmount removes the active chip |
| blank verb detail | unit | empty and whitespace-only details render the verb without a dangling separator |
| shared verb order | e2e | failure toasts are verb-first with reason after; Spotlight rows use target-first shared formatting |
| screensaver hue rule | unit | (already pinned) hue steps only on wall contact |
| seed exactness + idempotency | unit | (already pinned) byte-match vs docs/demo/aurora-brief.md; re-seed never reverts edits |
| traversal battery | unit | (already pinned) the 13 escape shapes stay rejected |

Where "already pinned" — verify the existing test actually covers it; strengthen if thin,
do not duplicate.

## E2E core scenarios (beyond the regression pins)

1. **Cold boot contract**: fresh profile → screensaver visible → `list` shows exactly the
   18 registered tools (assert the full name list — a lost registration must redden) →
   any tool call wakes the OS.
2. **Agent drives the desktop**: `app_open files` → window in DOM with PID chip →
   `window_move`/`window_resize` → DOM geometry matches the returned rect → `app_close` →
   window gone, `AGENT RAN` toast text appeared for each call.
3. **The shared-file loop** (the product thesis): `fs_write ~/site/index.html` → Files
   window (if open) shows it live → `editor_open_file` → agent `fs_edit` → editor
   live-reloads with the edit (buffer clean case) → human types → agent writes → conflict
   bar (B1 pin lives here) → reload the tab → `fs_read` proves persistence (real OPFS).
4. **Honest failure**: `app_close {pid: 99}` → error surfaced to the caller AND
   `AGENT FAILED` toast with the reason visible in DOM.

## Working rules for the test engineer

- Read the existing 52 tests first; extend files where a home exists, create
  `web/e2e/` fresh. Do not weaken or rewrite a passing assertion to make room.
- Every helper lives in `web/e2e/harness.ts` (server boot, browser boot, tool-call
  wrapper, DOM helpers). Scenario files read like the scenario.
- Flake discipline: no bare sleeps — wait on conditions (DOM state, tool result). A test
  that needs a fixed sleep is asserting the wrong signal.
- `package.json`: `"test": "bun test src"` (unit only — keep CI-fast),
  `"test:e2e": "bun test e2e --timeout 90000"`. `bunx tsc --noEmit` must stay green
  including the e2e sources.
- Gates for this work: unit suite green, e2e suite green on this machine, tsc green,
  and `bun run build` untouched-green. Conventional commits on main, no push.
