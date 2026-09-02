# The WebMCP Computer (VerbOS)

**Category:** An agent-native computer

## The problem

Every developer using a coding agent faces the same choice: give it your real machine, or don't let it run anything. Sandboxes exist, but they're headless. You get a log, not a screen. And agents drive today's computers the way a human would, through screenshots, mouse coordinates, and typed keystrokes into interfaces built for eyes and hands.

The WebMCP Computer is a full computer that lives inside one browser tab, built for agents as first-class citizens. Files, processes, windows, applications, and the terminal are exposed directly as WebMCP tools. The agent operates the machine natively. The human watches the same desktop, live, and can step in at any moment.

Run agent-generated code without giving the agent your computer. Watch it happen. Take the keyboard when you want to.

## Why WebMCP

WebMCP gives a page one channel to describe itself to an agent: tools with names, descriptions, JSON schemas, and annotations. We treat that channel as a syscall table. Instead of one page exposing a form or two, the entire operating system is the tool surface: `app_open`, `fs_write`, `term_exec`, `window_move`, `settings_set`, `ps`, `kill`, and about fifty more. An agent operating this machine never needs a screenshot or a coordinate.

The protocol's dynamism is what makes it an OS rather than a dashboard. Per-app tools register when a window opens and vanish when it closes. A page the agent builds and serves inside the OS can register its own WebMCP tools, and the agent calls them through the same surface. That's WebMCP inside WebMCP, and it's the demo moment: the agent writes a pizza-ordering page, serves it, and four `site_*` tools appear that didn't exist a second ago.

## What a human and an agent do together

- **A coding agent gets a fresh machine.** It edits files, runs scripts in the in-browser shell, serves a folder, and previews the result in a sandboxed window. The human sees the file change in Files, the command land in Terminal, and the page render in Preview.
- **Agent-generated code runs in a real sandbox.** Preview and agent-made apps execute in opaque sandboxed frames inside the tab. Nothing touches the host.
- **The agent repairs a wedged workspace.** It reads `dmesg`, lists and kills processes, changes settings, and the human watches every action leave a trace: an agent cursor jumps to the touched window, a toast names the verb, agent-written terminal rows are tinted.
- **The agent browses the real web from inside the sandbox.** The Browser app drives one shared remote Chrome, and the agent can discover and call the remote site's own WebMCP tools without leaving the OS.
- **Opt into real Linux.** Enable the cloud kernel and `cloud_exec` runs commands in a container with git, node, and python, streaming output back into Terminal.
- **The human interferes at will.** Same filesystem, same windows, same terminal. Two users, one machine, one keyboard each.

Every control a human can click has a verb an agent can call. Hover any button and a small chip shows the tool name behind it.

## How it's built

- **Registration** goes through `@nekuda/webmcp-sdk` (npm), which resolves the live `document.modelContext` surface and pins the spec version. Every tool declares an invocation class through annotations: ask (read-only), act (reversible, visible), or transact (consequential). Errors return as MCP `isError` results.
- **Kernel** is a pure-TypeScript Zustand store: process table, window registry, event bus. Every tool call and human action emits an OS event that the agent-presence layer, `dmesg`, and the Tool Monitor all read.
- **Shell** is just-bash, a bash interpreter in JavaScript with coreutils, curl, jq, sqlite3, and python3.
- **Filesystem** is ZenFS on OPFS with session restore.
- **Preview** is a virtual HTTP server inside the tab that serves `~` folders into a sandboxed frame and bridges that frame's tool registrations to the host.
- **Browser and cloud** are two small Cloudflare Workers: one holds the Browser Run token for a shared remote Chrome, one mounts an opt-in container workspace. The core OS is local-first and static; everything else is opt-in per action and falls back to local if it fails.
- **The manual ships with the machine.** WebMCP has no resources channel, so the OS manual is seeded into `~/skills/` and served by an `os_manual` tool.

Stack: Vite, React 18, TypeScript strict, hand-rolled CSS. No UI kit. 320 unit tests and a native-Chrome WebMCP end-to-end suite.

## Try it

Open the live URL in ChatGPT's browser or in Chrome with `--enable-features=WebMCP`. Press any key or call any tool to wake the machine. Ask your agent to open Files, write a page, serve it, and order a pizza from it.
