# Session restore, desktop presence, window-contract parity

User-driven round (2026-08-26 feedback). Theme: the OS should feel persistent and
inhabited, and everything a human can do to a window, an agent can do through the
contract. BRIEF rules bind throughout — especially 3 (every control has a verb), 4
(visible traces), and 6 (manual ships with the machine).

> **Scale-readiness amendment:** A tab is pending and fully interaction/agent/heartbeat
> blocked until its exclusive Web Lock is granted. A confirmed competing tab offers
> **Take over**; stealing the lock immediately blocks the previous owner, aborts agent work
> and every active human Terminal command, and discards queued human Terminal commands.
> Human- and agent-attributed filesystem mutations carry the ownership epoch captured when
> they were invoked and recheck it immediately before changing canonical bytes, including
> after filesystem locks, preflight reads, and asynchronous update callbacks. Reacquiring
> ownership never revives an old ticket. System seed and repair writes remain admitted while
> ownership is pending. Editor and Notes autosaves retain the ticket from scheduling, so a
> pending save fails without marking its stale snapshot clean. A remote mutation already
> accepted by a Worker cannot be undone; cancellation and the final admission check only
> prevent further local work and stale success reporting. The 500 ms BroadcastChannel probe
> distinguishes a live peer from a normal reload without opening an admission window.
> BroadcastChannel is not a safe mutex
> for suspended tabs, so strict enforcement requires Web Locks. Browsers without that API
> remain visibly degraded and usable for one-tab local work, with Browser heartbeat disabled.

## Scope, in priority order

1. **Browser-installation session restore.** Refreshing or reopening the browser restores the machine's exact desktop:
   open apps, window rects, z-order, focused window, Editor's open file, Notes
   selection, terminal cwd (fresh shell session in the restored window — scrollback is
   NOT restored; the session genuinely ended). Persist to `localStorage` on every
   kernel window/process mutation (debounced); restore at boot after FS ready, skipping
   the screensaver when restoring a non-empty session. FS + settings already persist
   via OPFS — this is the window/process table. Live multi-tab synchronization is OUT
   of scope; machine ownership still prevents two tabs from acting as the machine at
   once. e2e: open 3 apps, move one, reload
   → same rects/z/focus; unit: serializer round-trip.
2. **One window chrome, consistent corners + icons.** The terminal (xterm canvas) pokes
   square corners outside the rounded window — the shared `Window` component owns
   border-radius + `overflow: hidden` for EVERY app body; no app-level override may
   escape it. Dock icons: one icon component, theme-token colors (the terminal dock
   icon is stuck dark in light theme today and the glyph is rough — redraw consistent
   with the others). Audit every app in both themes.
3. **Cascade placement.** New windows cascade from the last-opened window's origin
   (+24px, +24px), wrapping back near the work-area origin when a window would leave
   the visible area. Explicitly not a packing algorithm. Restored sessions keep their
   saved rects; only NEW windows cascade.
4. **`app_open` placement contract.** Optional `x`, `y`, `width`, `height` (same
   clamping as window_move/window_resize) and `focus?: boolean` (default true). A
   singleton reuse with placement params MOVES/RESIZES the existing window (truthful
   `reused: true` plus the applied rect). Description + windows.md updated (rule 6).
5. **Write-coherence (Editor autosave).** Editor autosaves ~500ms debounced with a
   dirty indicator while pending; `cat` right after typing reflects the edit. External
   file change while buffer is clean → live refresh (extend the existing fs-event
   path); while dirty → non-blocking "file changed on disk" banner with a Reload
   action, never a silent merge. Notes already persists on append — align its save
   path to the same debounce if it differs. Unit + e2e (type → term_exec cat sees it).
6. **Desktop icons.** `~/desktop` files render as icons on the desktop grid (name +
   type glyph), double-click opens in Editor (folders reveal in Files), live-updating
   from FS events, VerbHint carries `<path> · editor_open_file`. Drag-to-reposition
   optional; skip if it fights react-rnd.
7. **Sticky notes.** A note in Notes gains "Stick to desktop": renders as a chromeless
   card on the desktop layer (movable, theme-aware), unstick from the card or the app.
   Tool: `notes_stick {title_or_index, sticky}` (rule 3). Sticky state persists (FS or
   the session store — pick one and document). Skills notes coverage updated.
8. **Activity tab (cheap).** Settings gains an "Activity" tab beside Tool Monitor: the
   last 50 OS events humanized (`[agent] fs_write · ~/site/index.html · 2s ago`,
   `[human] app_open · files`), same store dmesg reads. No new app, no new tool
   (`dmesg` is the shell parity).
9. **Docs — parity + preview ruling.** windows.md gains the placement contract;
   preview.md gains one paragraph: served content cannot register WebMCP tools (opaque
   sandbox, no modelContext — an injection vector by design, not a gap); the
   `preview_*` tools are the served site's dynamic surface. REFERENCE.md unchanged
   unless surface facts change.

## Parity decisions (record in windows.md; already decided)

- Unsaved editor buffer: NOT exposed as a tool — autosave (item 5) dissolves the gap.
- Screensaver: agent wakes but cannot start it — accepted asymmetry, documented.
- Minimize/zoom: do not exist for humans either — no gap, dots stay decorative-free.

## Out of scope

Cross-device session recovery; live cross-tab window synchronization; served-content tool registration; full Activity
Monitor app; scrollback restoration.

## Acceptance

Gates green (both Chromes — the taxonomy pin's Canary lane included). e2e additions:
session-restore round-trip; app_open with rect lands where asked (agent-placed
window); autosave-cat coherence; desktop icon opens Editor. Manual updated in the same
commits (byte-pin). Conventional commits on main, no push (team lead pushes via PR).
