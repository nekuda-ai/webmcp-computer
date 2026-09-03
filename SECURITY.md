# Security policy

## Supported versions

Only the `main` branch and the hosted deployment at `https://computer.webmcp.com` are
supported. There are no tagged releases; fixes land on `main` and are deployed from it.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting form:
<https://github.com/nekuda-ai/webmcp-computer/security/advisories/new>.

Do not open a public GitHub issue for security problems. Private vulnerability reporting
is enabled for this repository.

Include:

- what you found and where (site, `workers/browser-session`, `workers/computer`, `shared/`);
- steps to reproduce, or a proof of concept;
- impact as you understand it (data exposure, cost exposure, escape from a sandbox, etc.);
- whether you have already tested it against the hosted deployment.

Response targets:

| Step | Target |
| --- | --- |
| Acknowledge report | 3 business days |
| Triage and severity | 7 days |
| Fix or mitigation for high/critical | 30 days |
| Public disclosure | coordinated with you, after a fix is deployed |

## Scope

In scope:

- the site at `https://computer.webmcp.com` and its `/api/session` broker (`web/`);
- the Browser Session Worker (`workers/browser-session`, `browser.webmcp.com`);
- the Computer Worker (`workers/computer`, `cloud.webmcp.com`), including the Durable
  Object workspace, the container, and published sites served under `/s/{id}/`;
- the shared capability contract (`shared/gateway-capability.ts`) and the budget
  contract (`shared/session-limits.ts`).

Especially interesting:

- forging, replaying, or extending a capability token;
- reaching another visitor's workspace, remote Chrome, or container;
- leaking `BROWSER_RENDERING_API_TOKEN` or `GATEWAY_SIGNING_SECRET` from a Worker;
- escaping the sandboxed Preview / published-site frame into the OS origin;
- bypassing per-machine budgets or rate limits to run up Cloudflare cost;
- getting a published site served without `X-Robots-Tag: noindex` or the CSP `sandbox`.

Out of scope:

- vulnerabilities in Chrome, Cloudflare, or OpenAI Sites themselves (report upstream);
- the in-browser shell being "escapable" into the tab's own JavaScript: the local kernel
  runs in the visitor's own tab and has no privileges beyond it;
- denial of service that only consumes your own machine's budget;
- findings that require a visitor to paste a capability token somewhere.

## Abuse and takedowns for published sites

`os_publish` lets anonymous visitors publish small static sites to a public URL
(`/s/{id}/` on the Computer Worker's configured `workers.dev` origin); the same paths are
refused on its trusted custom API domain. Each machine may complete 20 publishes per
24-hour accounting window. Sites are limited to 64 files, 256 KB per file, 2 MB total,
expire after 30 days, and are served with `X-Robots-Tag: noindex` and a CSP `sandbox`.

To report abusive, illegal, or infringing content on a published site, use the private
reporting form above with the full URL and prefix the title with `Abuse report`. Each site's
non-public manifest records a pseudonymous publisher subject and an IP hash, which we use to
remove the site and block the publisher.
See `docs/OPERATIONS.md` for the takedown procedure.

## Safe harbour

We will not pursue legal action against, or report to law enforcement, anyone who:

- researches in good faith within the scope above;
- avoids privacy violations, data destruction, and service degradation for other visitors;
- does not exploit a finding beyond what is needed to demonstrate it;
- gives us reasonable time to fix before disclosing publicly.

If you are unsure whether something is covered, ask first at the address above.

## Trust model in plain language

- **Anonymous sessions.** Every visitor gets a random workspace ID kept in a signed,
  HttpOnly cookie. No email, name, or provider identity is requested or stored.
- **Capabilities, not logins.** The site backend mints a 15-minute HMAC-signed capability
  (`shared/gateway-capability.ts`) bound to the workspace, the site origin, and a scope.
  The browser presents it to the Workers; the browser never holds the signing secret and
  cannot mint its own. Capabilities re-mint automatically before expiry.
- **Workers verify before spending.** Both Workers check signature, expiry, scope, origin,
  and workspace before touching any paid resource (remote Chrome, container, R2).
- **Cloudflare tokens stay in Workers.** `BROWSER_RENDERING_API_TOKEN` lives only in the
  Browser Session Worker. The Computer Worker uses native bindings and holds no API token.
  The site backend holds only the gateway secret and the two Worker URLs.
- **Budgets and capacity bound cost.** Per machine per 24-hour accounting window: 2 h of
  remote Chrome and 2 h of container runtime. Idle resources are released after 5 minutes.
  Anonymous machine identity is cookie-backed and can be reset, so the same action limits
  also apply per IP and deployment-level Browser/Container capacity is the final hard bound.
- **Agent code runs in sandboxes.** Preview and published sites run in opaque sandboxed
  frames; the cloud container is an isolated Cloudflare Container per workspace.
- **Telemetry.** `@nekuda/webmcp-sdk` sends anonymous, content-free usage beacons by default;
  it honours Global Privacy Control and `globalThis.__WEBMCP_TELEMETRY__ = false`.
