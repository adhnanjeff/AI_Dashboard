# Phase 4 decision record: basic dashboard

Scope (roadmap §8): session list, session detail (timeline, files changed, diff), run detail with log, start/cancel/resume controls, real backend state, clear errors/stale/disconnected states, demo data distinguishable, basic accessibility.

## Decisions

### D1. Browser talks only to a same-origin Next.js gateway (`app/api/[...path]/route.ts`)
- **Why:** the orchestrator can start agents that edit files. Letting a web page call it directly invites cross-site and DNS-rebinding abuse, and would need CORS. A server-side gateway keeps one origin, no CORS, and one place to validate.
- Gateway checks: loopback Host, same-site Origin on POST, JSON content-type, safe path segments (no `.`/`..`). Forwards only content-type, idempotency-key, last-event-id.
- **Tradeoff:** one extra hop. SSE needs `compress:false` so it is not buffered.

### D2. Orchestrator request guard (also fixes a Phase 2 hole)
- Refuses foreign Host (403), any browser Origin unless in `ORCH_ALLOWED_ORIGINS` (403), non-JSON bodies (415).
- **Why:** before this, any web page could POST a "simple" request and start an agent. Defence in depth: the backend does not trust the gateway to be the only caller.
- Required a one-line change to a Phase 2 test (send content-type).

### D3. Live updates via SSE with replay by `seq`
- `GET /sessions/:id/stream` replays stored events (`after` / `Last-Event-ID`), then streams live. The client dedupes with `mergeEvents` and batches every 100 ms.
- **Why:** the append-only event log already has a per-session `seq`, so reconnect = resume from the last `seq`, giving correctness after refresh. SSE is simpler than WebSockets for one-way data.
- Events are hints: they trigger debounced refetches of detail/runs/changes. The persisted state stays the source of truth.

### D4. Store announces events only after COMMIT
- `Store.subscribe`; events queued inside a transaction are announced on commit and discarded on rollback.
- **Why:** otherwise a client could see an event for a change that was rolled back.

### D5. Polling with stale-data rules
- Keeps old data on error, ignores out-of-order responses, pauses when the tab is hidden. Banners say "showing stale data (last refreshed …)" or "orchestrator not reachable".
- **Why:** the exit criterion is "correct after refresh/reconnect"; hiding errors or blanking the screen would be wrong in both directions.

### D6. Cancel = pause, resumable
- UI text says so. Two-step confirm on Cancel. Resume shows a drift check (unchanged/changed/blocked) first; blocked disables the button.
- Start/Resume send idempotency keys, reused on retry, so a double-click or retry cannot start two workers.

### D7. `/sessions/:id/file` is allow-listed to git-changed paths
- Needed to show untracked files (not in `git diff`). Only paths git reports as changed, inside the repo, text only, capped at 200 KB; traversal and binary files are refused.
- **Why:** an arbitrary file-read endpoint would leak the machine.

### D8. Separate npm project for the dashboard, TypeScript 5.9, no UI libraries
- The backend stays dependency-free. Next 16 / React 19 only live in `apps/dashboard`. TypeScript 7 deliberately avoided (immature tooling for Next). Hand-written CSS with dark mode.

### D9. Pure logic in `lib/`, tested with `node:test`
- Diff parser, `mergeEvents`, `describeEvent`, `refreshHint`, `availableActions`, formatters. They run under the existing test runner with no browser tooling. The diff parser is also tested on real `git diff` output.

### D10. No mock mode; seeded demo data gets a DEMO badge
- Titles starting `demo:` are badged. **Why:** the UI must never pretend fake data is real, and must show real state.

### D11. Accessibility
- Status = glyph + word + colour. Diff lines carry +/− signs. Skip link, aria-live regions, labelled regions, arrow-key navigation in the file list, focusable scrollable areas.

## Findings
- Recovery must never kill by saved pid: pid 1234 in the demo DB belonged to an unrelated live process (already the Phase 3 rule; confirmed again).
- I suspected two stale-UI bugs (Cancel still showing; "Changed files (0)"). Both were timing artefacts of my own checks; no change made.
- Found and fixed: the New session form flashed "Add a new project…" while projects loaded. It now shows "Loading projects…" and disables submit.

## Verified
- 75 automated tests pass (13 API, 10 lib, 52 earlier). `tsc` and `next build` clean.
- In a real browser: overview + DEMO badges; create-and-start a real session; live timeline; changed files and untracked-file diff; arrow-key navigation; run detail with log and cost; 404 page; orchestrator stopped → clear "not reachable" banners and "stream stopped" notice.

## Not done / limits
- No auth beyond loopback and the guard.
- Cancel/resume buttons were not clicked in the browser (covered by Phase 2/3 backend tests only).
- The "stale data kept on error" path was unit-reasoned but not exercised live (page was loaded fresh with the backend down).
- No React component tests or e2e automation; no mobile/dark-mode visual pass; no pagination.
- No separate Pause button (Cancel pauses).
- The event stream does not auto-reconnect after a hard close; the banner asks for reload.

## Next: Phase 5 (project and session memory)
