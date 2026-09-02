# Running WebMCP Computer tests

From `web/`:

```sh
bun test
bun run test:e2e
```

`bun test` runs unit tests only. `bun run test:e2e` builds production assets, serves them with
Vite preview on an ephemeral port, and launches isolated headless Chrome.

E2E requires Chrome 151+ with native WebMCP support. It defaults to macOS system Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and launches it with
`--enable-features=WebMCP`. Set `WEBMCP_COMPUTER_CHROME` to another compatible Chrome executable.
Missing WebMCP support fails the suite; it never skips.
