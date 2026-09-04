## What

<!-- One paragraph. Link the issue if there is one. -->

## Why

## How to verify

<!-- Commands or clicks a reviewer can repeat. -->

## Checklist

- [ ] Tests pass locally for every package I touched
      (`cd web && bun test src server`, `cd workers/computer && bun test src`,
      `cd workers/browser-session && bun test src`)
- [ ] Typecheck passes (`bunx tsc --noEmit` in each touched package)
- [ ] `cd web && bun run build` passes if `web/` changed
- [ ] New or changed tools use `snake_case` wire names and declare an invocation class
- [ ] Tests live beside the code they cover; focused modules use matching test files where practical
- [ ] No secrets, account IDs, tokens, or user data in the diff
- [ ] `shared/` changes: both Workers and the site are updated together and
      `docs/OPERATIONS.md` / `docs/SELF_HOSTING.md` reflect new limits
- [ ] Docs updated (`README.md`, `docs/features/`, `docs/agent-skills/`) where behaviour changed
