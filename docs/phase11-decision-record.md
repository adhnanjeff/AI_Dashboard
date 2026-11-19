# Phase 11 decision record: Agent Factory visualization

Scope (roadmap §15): visual states mapped to authoritative run states; workstations for planning, coding, testing, reviewing and integration; render actual active/queued/completed/failed work; selectable agents and stations; a detail panel with task, model, logs, files and output; animate only events that occurred; show waiting, blocked and failed honestly; keep a list/timeline alternative; start 2D. Exit: clicking a visual agent shows the matching real task and runtime evidence; mock and real activity are never confused.

## Decisions

### D1. The factory is a read-only projection of existing records
`GET /factory[?projectId][&activity=N]` (`factory/snapshot.ts`) reads sessions, runs, workflow steps, events and workflow transitions and returns items, per-station counts and recent activity. It writes nothing, adds no tables, and POST is rejected. If nothing exists, the result is empty and the page says so; no placeholder agents are drawn.

### D2. One item is one real thing
- A workflow **step** becomes one item (its stored step status, current attempt, session, run, model and any recorded failure or pending approval text).
- A **standalone session** becomes one item (stored session status, latest run).
- Sessions owned by workflows (step attempts, the anchor session) are excluded from the standalone list so nothing is shown twice.

### D3. Station placement follows the definition, not a guess
Check and test roles → Testing; review/reviewer → Reviewing; integrate, merge-ready, approval → Integration; planner → Planning; coder/docs/unknown → Coding. A standalone session uses its latest run's role.

### D4. States are shown as stored
Workflow `passed` is displayed as Done, `pending` as Waiting, `waiting_approval` as Needs approval; everything else keeps its name. The stored status string is shown in the badge tooltip and the detail panel. Each state is a glyph, a word and a colour. Steps the engine marked cancelled after a failure appear as cancelled, never as passed. A check shows no model, because it ran a command.

### D5. Mock is marked, not hidden
Sessions titled `demo:` (from `db:seed`) are flagged `demo` by the server, drawn with a dashed outline and a DEMO tag, counted separately ("N real, M demo"), and can be hidden with one checkbox. They are shown by default so seeded data cannot be mistaken for a broken page.

### D6. Motion only marks things that happened
- A token pulses only while its stored state is `running`.
- A one-off highlight plays when this page **observed** an item's state change between two polls. The first load highlights nothing, and motion is off under `prefers-reduced-motion`.
- There is no simulated travel, idle animation or fake progress.

### D7. Accessible alternative is first class
Tokens are buttons (`aria-pressed`). The **List** view is a table with the same data and the same selection, and "What just happened" is a plain timeline of recorded events and workflow transitions. The detail panel uses the existing session events and changes endpoints, so evidence comes from the same source as the session page.

### D8. 2D HTML stations, not canvas
Stations are columns of real buttons joined by arrows. This keeps keyboard and screen-reader access and avoids a canvas that would need its own accessibility layer. A richer isometric or 3D scene was not built (the roadmap says only if useful).

## Not done / limits
- **Polling, not push.** The page refreshes every 2 s, so a state that lasts less than that can be missed; the activity feed still lists it.
- Stations are selectable only through their agents; there is no station-level detail page.
- Attempts of a workflow step are not listed separately; the item shows the current attempt, and the workflow page keeps the full history.
- Standalone sessions are all placed by run role; a session with no run yet shows at Coding as Waiting.
- Not checked in a real long-running multi-agent session; verified in the browser against the seeded database only.

## Testing
`tests/unit/phase11.test.ts`, 5 tests: empty state; standalone and demo flagging with no model claimed before a run; a full workflow reaching approval (station mapping, completed/waiting states, model and links, no duplicate workflow sessions, activity newest first); a failing check shown as failed with its reason and unrun steps cancelled; HTTP (project filter, 404, read-only). Full suite 165/165.
Manual: restart `npm run api` and the dashboard, open **Factory**, select a token and compare with its session page; create a workflow and watch the tokens move as steps change; untick "Show demo data".
