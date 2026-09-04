# Privacy-bounded usage analytics

Usage analytics and session replay are optional build-time features. The computer boots and
works normally when analytics is unavailable or unconfigured.

## Activation

Both public Vite values must be present at build time:

```sh
VITE_POSTHOG_KEY=<public project key>
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

Omitting either value disables initialization. These values are public browser configuration,
not secrets. Deployments should still keep them in environment configuration rather than
hard-coding project-specific values.

## Event contract

The app emits one fixed event, `webmcp_usage`, derived from settled OS events. It contains only:

- `actor`: `human`, `agent`, or `embedded_app`
- `family`: a fixed coarse subsystem
- `action`: a fixed coarse operation category
- `app`: a known app identifier or `none`
- `succeeded`: boolean

Commands, arguments, paths, file contents, terminal output, URLs, selectors, typed text, error
messages, and arbitrary event properties are never copied into analytics events. Person profiles,
autocapture, page views, exceptions, surveys, heatmaps, campaign parameters, and feature-flag
requests are disabled. The client respects Do Not Track.

## Session replay boundary

Replay masks all inputs and element attributes. Terminal, editor, iframe, and explicitly marked
sensitive surfaces are blocked. Canvas capture, cross-origin iframe recording, console logs,
request/response bodies, headers, and useful network URLs are disabled or redacted.

A fail-closed `before_send` filter drops every payload except the fixed usage event and the
minimum fields required for replay snapshots. It also strips person-profile mutation fields.
Analytics initialization and capture errors are swallowed so telemetry cannot break the OS.

The hosted demo discloses this behavior in the README and privacy section of the self-hosting
documentation. Per the hosted-demo policy, it does not add a separate analytics-consent screen.
Self-hosters are responsible for determining whether their jurisdiction or deployment requires
additional consent or disabling replay entirely.

## Verification

`web/src/analytics.test.ts` locks the event allowlist, payload filter, disabled collection
features, replay masking, optional initialization, and failure isolation. Run:

```sh
cd web
bun test src/analytics.test.ts
```
