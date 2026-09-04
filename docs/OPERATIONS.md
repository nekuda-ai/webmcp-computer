# Operations runbook

For maintainers and self-hosters. Commands first, prose second. The checked-in Wrangler
configs use the hosted demo's resource names and `webmcp.com` routes; self-hosters must
replace those names and routes before deploying.

Wrangler is pinned. Supply the target account through the environment—never commit an
account ID or deployment token.

```sh
export CLOUDFLARE_ACCOUNT_ID="<32-character-account-id>"
alias wr='bunx wrangler@4.128.0'
```

---

## 1. Environments

| | Staging | Production |
| --- | --- | --- |
| Computer Worker | `webmcp-computer-cloud-staging` | `webmcp-computer-cloud` |
| Computer domain | `cloud-staging.webmcp.com` | `cloud.webmcp.com` |
| Browser Worker | `webmcp-computer-browser-session-staging` | `webmcp-computer-browser-session` |
| Browser domain | `browser-staging.webmcp.com` | `browser.webmcp.com` |
| R2 bucket | `webmcp-computer-sites-staging` | `webmcp-computer-sites` |
| Container `max_instances` | 5 | 25 |
| Wrangler flag | `--env staging` | none (top-level config) |

The Site selects Workers through server-side `BROWSER_WORKER_URL` and
`COMPUTER_WORKER_URL` settings. Keep staging private at the hosting layer. Published user
content must use a separate, untrusted origin: set `PUBLIC_SITE_ORIGIN` to the Computer
Worker's exact HTTPS `workers.dev` origin rather than its custom application domain. The
value must have no path, query, fragment, port, or trailing slash; the Worker rejects all
non-`workers.dev` hostnames.

Both R2 buckets must carry a 30-day lifecycle rule on prefix `sites/`:

```sh
wr r2 bucket lifecycle list webmcp-computer-sites
wr r2 bucket lifecycle list webmcp-computer-sites-staging
# if missing:
wr r2 bucket lifecycle add <bucket> webmcp-computer-published-site-retention sites/ --expire-days 30
```

---

## 2. Deploy

### Preferred: GitHub Actions

Actions -> **Deploy Workers** -> Run workflow -> pick `environment` (`staging` |
`production`) and `worker` (`both` | `computer` | `browser-session`). The GitHub environment
of the same name gates the run (require reviewers on `production`). Needs environment
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

### Manual, from a laptop

The computer Worker builds `workers/computer/Dockerfile` at deploy time. You need a Docker
daemon: locally that is Colima (`colima start`); `docker version` must succeed. The
browser-session Worker needs no Docker.

```sh
# staging
cd workers/browser-session && bun install --frozen-lockfile && bun run check && wr deploy --env staging
cd workers/computer        && bun install --frozen-lockfile && bun run check && wr deploy --env staging

# production
cd workers/browser-session && bun install --frozen-lockfile && bun run check && wr deploy
cd workers/computer        && bun install --frozen-lockfile && bun run check && wr deploy
```

First deploy of an environment: set secrets first (section 4) or Wrangler refuses
(`secrets.required` in `wrangler.jsonc`).

### Post-deploy smoke

```sh
# Workers answer and reject unsigned protected calls (expect 401, not 5xx)
WS=00000000000000000000000000000000
curl -si -X POST "https://cloud-staging.webmcp.com/ws/$WS/exec" \
  -H 'Content-Type: application/json' --data '{}' | head -1
curl -si -X POST https://browser-staging.webmcp.com/session \
  -H 'Content-Type: application/json' --data '{}' | head -1

# Watch logs while you click through the OS pointed at staging (see CONTRIBUTING.md)
wr tail webmcp-computer-cloud --env staging
wr tail webmcp-computer-browser-session --env staging
```

Then in the OS: open Browser (creates remote Chrome), enable `cloud_kernel`, run a
`cloud_exec`, `os_publish` a folder and open the `/s/{id}/` URL.

### Rollback

```sh
wr deployments list [--env staging]          # in the Worker directory
wr rollback [--env staging]                  # previous deployment; add --message
```

Container image changes: rollback re-points to the previous image; existing container
instances keep running until idle-stopped.

---

## 3. Production cutover

Keep deployment-specific legacy resource names in a private change record, not this public
repository. Do these steps in order and do not skip observation.

- [ ] **Staging green.** Deploy both Workers with `--env staging`; run the live smoke and
      exercise Browser, `cloud_exec`, idle/resume, second-tab takeover, and publishing from
      the private staging Site.
- [ ] **Production prerequisites.** Set `GATEWAY_SIGNING_SECRET` on both Workers and the
      Site; set `CF_ACCOUNT_ID` + `BROWSER_RENDERING_API_TOKEN` on browser-session; set
      `PUBLIC_SITE_ORIGIN` on the Computer Worker; create the production R2 bucket and its
      lifecycle rule.
- [ ] **Deploy production Workers.** Deploy both top-level configs, then smoke their HTTPS
      origins directly before changing the Site.
- [ ] **Flip atomically.** Deploy the matching web build and update the Site's
      `BROWSER_WORKER_URL` / `COMPUTER_WORKER_URL` settings together. Do not pair the new
      heartbeat-capable client with an old Browser Worker.
- [ ] **Confirm `/api/session`.** Verify it returns the expected Worker origins without
      copying the capability into logs or chat.
- [ ] **Observe.** Tail both Workers for at least one capability lifetime (15 minutes).
      Watch for 401 spikes, Browser API failures, container starts, capacity refusals, and
      sync-retry errors. Roll back the Site and both Workers together if necessary.
- [ ] **Grace period.** Preserve the previous publishing origin and bucket for at least the
      advertised retention period so existing URLs remain valid.
- [ ] **Decommission.** After the grace period, delete the previous Workers, container
      application, bucket objects, bucket, and any unshared API token. Verify names against
      the private change record before deleting anything.

---

## 4. Secrets and rotation

| Secret | Where | Notes |
| --- | --- | --- |
| `GATEWAY_SIGNING_SECRET` | site backend (OpenAI Sites), browser Worker, computer Worker | >= 32 bytes. `openssl rand -base64 48`. Must be identical on all three per environment. |
| `CF_ACCOUNT_ID` | browser Worker | Cloudflare's 32-character account ID; set as a secret, not source. |
| `BROWSER_RENDERING_API_TOKEN` | browser Worker | Cloudflare API token, permission **Browser Rendering: Edit** only. |
| `PUBLIC_SITE_ORIGIN` | computer Worker | Exact untrusted `https://<worker>.<account-subdomain>.workers.dev` origin, without a trailing slash; custom domains are rejected. |
| `BROWSER_WORKER_URL`, `COMPUTER_WORKER_URL` | site backend | HTTPS origins of the Workers. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub environments `staging`, `production` | Deploy-only; never a runtime secret. |

Set:

```sh
cd workers/browser-session
wr secret put GATEWAY_SIGNING_SECRET        [--env staging]
wr secret put CF_ACCOUNT_ID                 [--env staging]
wr secret put BROWSER_RENDERING_API_TOKEN   [--env staging]
cd ../computer
wr secret put GATEWAY_SIGNING_SECRET        [--env staging]
wr secret put PUBLIC_SITE_ORIGIN             [--env staging]

wr secret list [--env staging]              # names only; values are never readable
```

### Rotate the gateway secret

Rotating invalidates every outstanding capability. Capabilities are 15-minute HMAC tokens
and the browser re-mints via `/api/session` automatically, so visitors see at most a brief
burst of 401s and recover without reload. Do all three within a few minutes:

```sh
NEW=$(openssl rand -base64 48); echo "$NEW" | pbcopy
( cd workers/browser-session && echo "$NEW" | wr secret put GATEWAY_SIGNING_SECRET )
( cd workers/computer        && echo "$NEW" | wr secret put GATEWAY_SIGNING_SECRET )
# then: OpenAI Sites -> computer.webmcp.com -> backend secrets -> GATEWAY_SIGNING_SECRET = $NEW
unset NEW
```

Order: Workers first, then site. In between, the site mints tokens the Workers reject
(401); after, everything re-mints. Expect a 401 spike of up to ~15 minutes; that is normal.

### Rotate the Browser Rendering token

Create a new token (Browser Rendering: Edit), `wr secret put BROWSER_RENDERING_API_TOKEN` on
the browser Worker, verify Browser opens in the OS, then revoke the old token in the
dashboard. Existing remote Chrome sessions are unaffected until they idle out.

---

## 5. Capacity knobs

| Knob | Where | Staging | Production | Effect |
| --- | --- | --- | --- | --- |
| Container `max_instances` | `workers/computer/wrangler.jsonc` `containers[].max_instances` | 5 | 25 | Concurrent cloud containers. Beyond it, visitors get `ECAPACITY`. Change + redeploy. |
| Container `instance_type` | same | `standard-1` | `standard-1` | 1/2 vCPU, 4 GiB RAM, 8 GB disk. |
| Browser Run concurrency | Cloudflare account limit | 200 hard cap | 200 hard cap | 10 included, then billed per browser. 3 launches/s. |
| Rate limits | `ratelimits[]` in each `wrangler.jsonc` | same as prod | see table below | Change + redeploy. Namespace IDs must stay unique across Workers in the account. |
| Per-machine budgets | `shared/session-limits.ts` | same | same | Change + redeploy **both** Workers and the site. |

Check what is running:

```sh
wr containers list
wr containers info <id>
wr containers images list
```

Rate limits as configured (per signed subject+IP and per IP alone; Cloudflare `ratelimits`
are approximate and location-local). Anonymous visitors can reset cookie-backed machine
identity, so budgets are not an anti-Sybil boundary; IP rates plus platform/container
capacity remain the deployment-wide cost backstops:

| Worker | Binding | Limit |
| --- | --- | --- |
| browser-session | `SESSION_RATE` / `SESSION_RATE_IP` | 4 / 4 per 60 s |
| browser-session | `SESSION_ACTION_RATE` / `SESSION_ACTION_RATE_IP` | 30 / 30 per 60 s |
| computer | `EXEC_RATE` / `EXEC_RATE_IP` | 6 / 6 per 60 s |
| computer | `PUBLISH_RATE` / `PUBLISH_RATE_IP` | 4 / 4 per 60 s |
| computer | `WORKSPACE_WRITE_RATE` / `WORKSPACE_WRITE_RATE_IP` | 300 / 900 per 60 s |

---

## 6. Limits and cost model

### Per-machine limits (`shared/session-limits.ts`)

| Limit | Value | Error code |
| --- | --- | --- |
| Budget window | fixed 24 h from first use | |
| Remote Chrome (Browser Run) time | 2 h / window | `EBUDGET` |
| Cloud container runtime | 2 h / window | `EBUDGET` |
| Successful anonymous publishes | 20 / window | `EPUBLISHQUOTA` |
| Remote Chrome idle | deleted after 5 min without heartbeat | `EIDLE` |
| Container idle | stopped after 5 min without exec | `EIDLE` |
| Client heartbeat | every 60 s after recent trusted local or remote-page input while the owning tab is visible and focused | |
| Browser Run `keep_alive` max | 10 min | |
| Platform full | | `ECAPACITY` |
| Wrong owner | | `EOWNER` |

### Published sites

| Limit | Value |
| --- | --- |
| Files per site | 64 |
| Per file | 256 KB |
| Per site | 2 MB |
| Filesystem API read/copy | 2 MB per file; oversized container-created files return HTTP 413 with `code: EFBIG` and rename refuses them before deleting the source |
| Exec request body | 16 KB streamed limit; command remains capped at 8 KB |
| Per machine/workspace | 20 successful publishes per fixed 24-hour accounting window (workspace Durable Object ledger) |
| Quota response | HTTP 429 JSON with `code: EPUBLISHQUOTA` and `retryAfterMs` |
| Reservation safety | Caller-ID retries are idempotent; abandoned pre-upload reservations stop blocking after 5 min. Immediately before the first R2 put they become active and cannot expire within that accounting window. Any attempted put is conservatively committed because bytes may have become public. |
| Retention | 30 days (R2 lifecycle on `sites/`) |
| Headers | `X-Robots-Tag: noindex`, CSP `sandbox` |
| Manifest | `sites/{id}/.webmcp-computer-site` — JSON `{ id, publishedAt, subject, ipHash, files, bytes }`; `ipHash` is an HMAC of the IP under the gateway secret, so the IP itself is never stored |

### Cost (Workers Paid, Cloudflare list prices; verify against current docs)

| Resource | Included | Then | Notes |
| --- | --- | --- | --- |
| Browser Run concurrent browsers | 10 | $2 / browser | monthly-averaged daily peak |
| Browser Run browser-hours | 10 h / month | $0.09 / browser-hour | hard cap 200 concurrent, 3 launches/s |
| Container `standard-1` | | ~$0.07 / hour running | account limits 1,500 vCPU / 6 TiB |
| DO SQLite storage | | $0.20 / GB-month | one DO per workspace |
| R2 | | negligible at this scale | 30-day lifecycle |

**Worst case per machine per accounting window:** 2 h x ($0.09 + $0.07) ~= **$0.32**.
A bad window with N abusive machines costs about $0.32 x N plus Browser Run concurrency overage. Container
count is hard-capped by `max_instances`; Browser Run is capped at 200 concurrent.

---

## 7. Observability

Both Workers have `observability.enabled` with `head_sampling_rate: 1`.

```sh
wr tail webmcp-computer-cloud                        # production
wr tail webmcp-computer-cloud --env staging
wr tail webmcp-computer-browser-session
wr tail webmcp-computer-browser-session --env staging
wr tail <name> --status error                        # only errors
wr tail <name> --search "sync retry"                 # substring filter
wr tail <name> --ip <addr>                           # one client
```

Dashboard: Workers & Pages -> `<worker>` -> **Logs** (Workers Logs, queryable), **Metrics**
(requests by status, CPU, errors), **Settings -> Domains & Routes**. Containers:
Workers & Pages -> Containers. R2: R2 -> `<bucket>`. Browser Rendering: Compute ->
Browser Rendering (session count, usage).

### Alerts (not configured yet; set up in Notifications)

Dashboard -> Notifications -> Add. Use "Workers Logs"-based or "Workers error rate"
notifications (verify the exact product name available on the account). Recommended:

| Alert | Signal | Likely cause |
| --- | --- | --- |
| 401 spike on either Worker | status 401 rate up | gateway secret mismatch (site vs Workers), bad rotation, or token forgery attempts |
| 429 spike | status 429 rate up | abuse or a client loop; check per-IP |
| Browser API failures | browser Worker 5xx, log lines mentioning Browser Rendering / session creation | token revoked, Browser Run concurrency cap (200) or launch rate (3/s), Cloudflare incident |
| Container start failures | computer Worker `ECAPACITY` responses or container errors | `max_instances` reached, image rollout, account vCPU limit |
| Exhausted / lost sync retries | log `WebMCP Computer workspace sync retry` with a failed result, or `sync retry rescheduled` repeating | container unreachable; cleanup remains deferred while durable retry intent exists, preserving the container copy for investigation/recovery |
| Repeated `cleanup-retry` lease outcomes | log `WebMCP Computer runtime lease` | container destroy is failing; the DO keeps charging runtime and durably schedules another cleanup attempt |
| Budget/cost | Cloudflare billing threshold notification | runaway usage |

---

## 8. Abuse

### Take down a published site

Given a URL `https://<origin>/s/<id>/...`:

```sh
BUCKET=webmcp-computer-sites        # or the staging/previous deployment bucket
ID=<id>

# 1. Read the manifest (publisher subject + IP hash). Keep a copy for the record.
wr r2 object get "$BUCKET/sites/$ID/.webmcp-computer-site" --file "/tmp/$ID.manifest"
cat "/tmp/$ID.manifest"

# 2. List every key under the prefix. wrangler has no recursive list/delete:
#    use the dashboard (R2 -> bucket -> prefix sites/<id>/) or the S3 API with an R2
#    S3 token, e.g.:
#    aws s3 ls "s3://$BUCKET/sites/$ID/" --recursive --endpoint-url "https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"

# 3. Delete each key. Delete the manifest LAST so the id stays reserved until the files
#    are gone.
wr r2 object delete "$BUCKET/sites/$ID/<key>"
# ...
wr r2 object delete "$BUCKET/sites/$ID/.webmcp-computer-site"

# 4. Verify
curl -sI "https://<origin>/s/$ID/" | head -1        # expect 404
```

With an S3 token, `aws s3 rm "s3://$BUCKET/sites/$ID/" --recursive --endpoint-url ...` does
steps 2-3 in one go.

Then, if the publisher should be blocked: the manifest's IP hash cannot be reversed. Search
Workers Logs for the publish request to `/ws/<wsid>/publish` around the site's creation
time to recover the client IP, then block it (below).

### Block an IP

Custom domains put the Workers behind the `webmcp.com` zone, so a WAF custom rule applies:

Dashboard -> `webmcp.com` -> Security -> WAF -> Custom rules -> Create:

- Expression: `(ip.src eq 203.0.113.7)` or `(ip.src in {203.0.113.0/24})`, optionally
  `and (http.host in {"cloud.webmcp.com" "browser.webmcp.com"})`
- Action: Block

The `workers.dev` origin (published sites and any previous Workers) is **not** in the zone and
is not covered by that rule. For those, add a check in the Worker or accept that the
abuser can still read (not write) published content until retention expires.

Temporary alternative: a Worker-level deploy is not required to block; prefer WAF.

### Rotate the gateway secret

If a capability was leaked or the secret is suspected compromised, follow section 4. This
invalidates all outstanding capabilities in ~0 s and cuts off anyone holding a stolen one.

### Kill a runaway resource

```sh
# remote Chrome sessions: Browser Rendering dashboard, or wait for the 5-min idle delete
# containers:
wr containers list
wr containers info <id>
# wrangler 4.128 has no per-instance kill; every container is idle-stopped by its
# workspace's Durable Object alarm 5 min after the last exec (verified live: the exit
# frame's budget.usedMs books ~300 s). To shed load faster, lower max_instances and redeploy.
```

---

## 9. Incident quick-checks

Run these in order; each takes seconds.

```sh
# Which Workers is the live site handing out? (camelCase JSON fields)
curl -s https://computer.webmcp.com/api/session | jq '{active, browserWorkerUrl, computerWorkerUrl, expiresAt}'
# never paste the `capability` field anywhere; it is a live 15-minute token

# Is the site itself up?
curl -sI https://computer.webmcp.com/ | head -1

# Are the Workers up? Their root route intentionally returns 404; 5xx or timeout is not healthy.
for h in cloud.webmcp.com browser.webmcp.com cloud-staging.webmcp.com browser-staging.webmcp.com; do
  printf '%-48s ' "$h"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "https://$h/"
done

# Live errors right now
wr tail webmcp-computer-cloud --status error
wr tail webmcp-computer-browser-session --status error

# Container pressure
wr containers list

# Cloudflare itself?
open https://www.cloudflarestatus.com/
```

Symptom -> first suspect:

| Symptom | Check |
| --- | --- |
| Everything 401 | Gateway secret differs between site and Workers. Compare rotation timestamps; re-put the secret on all three. |
| Browser app fails to open, Workers otherwise fine | `BROWSER_RENDERING_API_TOKEN` revoked/expired, or Browser Run concurrency cap. Browser Rendering dashboard. |
| `cloud_exec` returns `ECAPACITY` | `max_instances` reached. `wr containers list`; raise and redeploy if legitimate. |
| `cloud_exec` hangs, then `EIDLE` | Container start failure or sync retry loop. `wr tail --search "sync retry"`. |
| Published site 404 immediately after publish | R2 binding/bucket name mismatch in the deployed env, or lifecycle rule misconfigured. `wr r2 bucket lifecycle list`. |
| Site up, OS says "cloud failure, staying local" | Worker URLs the site hands out are wrong or the Workers are down. First command above. |
| 429s for one IP | Client loop or abuse. WAF block (section 8). |
| Container image deploy fails in CI | Docker unavailable or Dockerfile broke. Re-run locally with Colima. |
