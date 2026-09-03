# Contributing

WebMCP Computer is MIT licensed. By contributing you agree your work is released under
the same licence (see `LICENSE`).

## Layout

| Path | What | Package root |
| --- | --- | --- |
| `web/` | The OS: Vite + React 18 app, plus the `/api/session` broker in `web/server/` | yes |
| `workers/browser-session/` | Token-holding Browser Run session Worker | yes |
| `workers/computer/` | Cloud workspace Worker: DO SQLite filesystem, Container, R2 publishing | yes |
| `shared/` | Capability and budget contracts imported by all three | no (imported by path) |
| `docs/` | Brief, feature specs, seeded agent manual, testing charter, WebMCP reference | no |

Three independent package roots, three lockfiles. There is no root workspace.

## Setup

Requires Bun 1.3.x.

```sh
cd web && bun install --frozen-lockfile && cd ..
cd workers/computer && bun install --frozen-lockfile && cd ../..
cd workers/browser-session && bun install --frozen-lockfile && cd ../..
```

Run the OS locally:

```sh
cd web && bun run dev     # http://localhost:5173
```

Native WebMCP needs Chrome 151+ started with `--enable-features=WebMCP`, or ChatGPT's
browser. Without it the OS still renders and tools still register through the SDK's
fallback, but agent calls will not arrive.

## Tests and typecheck

Run exactly what CI runs (`.github/workflows/ci.yml`):

```sh
cd web && bun test src server && bunx tsc --noEmit && bun run build
cd workers/computer && bun test src && bunx tsc --noEmit        # or: bun run check
cd workers/browser-session && bun test src && bunx tsc --noEmit # or: bun run check
```

`bun run check` in each Worker runs tests then `tsc --noEmit`.

End-to-end tests (`cd web && bun run test:e2e`) need a local Chrome with native WebMCP; see
`docs/testing/README.md`. They are not run in CI.

## Conventions

- **TypeScript strict** everywhere. No `any` unless quarantined with a comment.
- **Wire names are `snake_case`** for tools, tool arguments, and JSON fields sent over the
  network (`cloud_exec`, `retry_after_ms` style). Internal TypeScript uses `camelCase`.
- **Every tool declares an invocation class** via annotations: `ask` (read-only), `act`
  (reversible, visible), `transact` (consequential). Register through
  `@nekuda/webmcp-sdk` (`defineTool` + `registerTools`); return errors as MCP
  `{ content, isError: true }` results, not thrown exceptions.
- **Tests next to code.** `foo.ts` is covered by `foo.test.ts` in the same directory.
  Bun's test runner picks them up from `src` (and `server` in `web/`).
- **No UI kit.** Hand-rolled CSS, React 18, Zustand. Do not add component libraries.
- **Shared contract changes are coordinated.** Anything in `shared/` is imported by the
  site and both Workers; change it together and note it in the PR so both Workers are
  redeployed with the site.
- **No secrets in source.** Wrangler configs declare required secrets; values are set with
  `wrangler secret put`. Never put a secret behind a `VITE_` variable.
- **Docs are part of the change.** Feature behaviour lives in `docs/features/`; anything an
  agent needs to know lives in `docs/agent-skills/` (seeded into `~/skills/` in the OS).
- Keep the Cloudflare pins: `bunx wrangler@4.128.0` and `@cloudflare/computer` at the
  version in `workers/computer/package.json`.

## Running the OS against staging Workers

The local Vite server serves `/api/session` itself (see `sitesLocalApi` in
`web/vite.config.ts`). It mints capabilities with
`WEBMCP_COMPUTER_DEV_GATEWAY_SIGNING_SECRET` and hands out
`VITE_BROWSER_WORKER_URL` / `VITE_COMPUTER_WORKER_URL`.

Copy `web/.env.example` to `web/.env` and set:

```sh
# web/.env
WEBMCP_COMPUTER_DEV_GATEWAY_SIGNING_SECRET=<the staging GATEWAY_SIGNING_SECRET>
VITE_BROWSER_WORKER_URL=https://browser-staging.webmcp.com
VITE_COMPUTER_WORKER_URL=https://cloud-staging.webmcp.com
```

The dev secret must equal the `GATEWAY_SIGNING_SECRET` set on the staging Workers, or every
Worker call returns 401. Ask a maintainer for it; never commit it. `web/.env` is
gitignored.

Alternatively, point at local Workers: run `bunx wrangler@4.128.0 dev` in each Worker
directory (ports 8787 and 8788 by default), leave `web/.env` at the example defaults, and
set the same dev secret on both Workers via `.dev.vars`.

You can also override Worker URLs at runtime with `?browser_worker=` /
`?computer_worker=` query parameters or the `webmcp_computer.browser_worker` /
`webmcp_computer.computer_worker` localStorage keys. Production accepts these only when
they point at `127.0.0.1` or `localhost`.

## Pull requests

- Branch from `main`; target `main`. Keep PRs focused; split unrelated changes.
- Fill in `.github/PULL_REQUEST_TEMPLATE.md`. The checklist there is the review gate.
- CI must be green on all three jobs.
- Changes to Worker names, rate-limit namespace IDs, R2 buckets, `max_instances`, or
  anything in `shared/session-limits.ts` need a maintainer review and an
  `docs/OPERATIONS.md` update.
- Deploys are manual (`.github/workflows/deploy-workers.yml`) and maintainer-only.

## Reporting security issues

See `SECURITY.md`. Do not open public issues for vulnerabilities.

## Embedding the demo video in the README

GitHub strips `<iframe>` and `<video>` tags from Markdown, so there are two working
options:

1. **Native player (best):** open any issue or PR in this repo, drag the `.mp4` (or
   `.mov`, ≤ 100 MB) into the comment box, and copy the generated
   `https://github.com/user-attachments/assets/…` URL. Paste that URL on its own line in
   `README.md`; GitHub renders an inline player. You do not need to submit the comment.
2. **YouTube:** a clickable thumbnail that links out:

   ```md
   [![WebMCP Computer demo](https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg)](https://www.youtube.com/watch?v=VIDEO_ID)
   ```

Add a **Video:** bullet below the live-demo link near the top of `README.md`.
