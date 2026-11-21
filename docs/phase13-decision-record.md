# Phase 13 decision record: analytics, workflow configuration and hardening

Scope (roadmap §17): cost per accepted task or feature; escalation and retry analytics; checkpoint recovery and failure rates; task duration and human-intervention metrics; workflow editor; per-task retry and budget limits; import/export of workflow definitions with schema validation; long-running and many-event tests; accessibility, keyboard and error recovery; backup/export and project-memory migration; PostgreSQL and multi-user only if needed. Exit: the system can explain where it saves cost, where it escalates, where it fails, and whether quality is maintained.

## Decisions

### D1. Analytics is a read-only projection, and it never turns "unknown" into zero
`analytics/analytics.ts` reads rows the runtime already wrote and writes nothing (`GET /analytics?projectId&days`, 1 to 365 days). Cost is **only what providers reported**. A run with no report is "unknown": every cost figure carries the count it covers ("11 of 14 accepted had a cost"), a day with runs but no reports is drawn as a grey tick instead of an empty bar, and the insight list says when totals are lower bounds. Demo sessions are excluded from every figure.

### D2. "Accepted" is a recorded fact
Accepted work is a workflow that completed (its merge-ready gate was approved by a person) or a standalone session that completed. Nothing is inferred from text. Cost per accepted work is averaged over accepted units that have at least one reported cost, and a second figure covers only units whose every run reported. Spend on work that was *not* accepted is shown beside it, so the cost of failure is visible. Workflow cost is read from the evidence each attempt recorded, because a step row only remembers its latest session.

### D3. Escalation, retries, failure, recovery and time are counted from existing records
Routing decisions (escalated, base tier to tier, success of escalated runs), tasks with more than one run, workflow step retries and retry limits hit, failure causes (free-text reasons grouped into stable categories), checkpoints saved and failed, resumes and the share of resumed work that completed, orphaned runs, handoffs, run/session/workflow durations (median and 90th percentile), approvals requested, decided and waiting, decision time, accepted-without-a-person and accepted-on-first-attempt.

### D4. Insights say what they are based on, and stay silent without enough data
Each finding names its basis. Below 5 runs the only insight is "not enough data". Per-model or per-tier statements need at least 5 finished runs. Estimated savings come from the routing policy's own cost estimates and are labelled as an estimate, not a measurement. "Quality looks maintained" is a plain rule on acceptance rate and first-attempt rate, stated with the numbers.

### D5. Per-step retry and budget limits
Steps already had `maxAttempts` (1 to 5). Phase 13 adds `budgetUsd` for agent and review steps: before an attempt starts, the engine sums the reported cost of that step's earlier attempts (from evidence) and stops the workflow if it has reached the budget. A run that reported nothing adds nothing, which is stated in the failure text. It is a stop before the next attempt, not a mid-run kill: a single run can still overshoot.

### D6. Workflow files are an envelope around the definition the engine already validates
Format `ai-control-center/workflow` version 1 (`workflows/portable.ts`). Import is **stricter** than the engine: unknown keys are reported, so a misspelt `maxAtempts` is an error instead of a silent default. Wrong format or version, missing definition, unknown ids, cycles and disallowed check commands are all reported together. `GET /workflows/schema` publishes a JSON Schema for editors and CI (shape and ranges; step relations are checked by the tool). Endpoints: `POST /workflows/validate`, `POST /workflows/import`, `GET /workflows/:id/export`. Import creates a draft and is audited.

### D7. Workflow editor
`/workflows/editor`: steps, kinds, roles, "starts after", fixer, review block level, command, attempts, budget, "only run when", approval and merge gates; move up/down and remove with labelled buttons (no drag-only interaction). The page does no validation of its own: it sends the definition to `POST /workflows/validate` after each change and shows the server's problems in a polite live region. **Create** stays disabled until the server says the definition is valid. Download, import from file or pasted JSON, start from the feature template, and "Edit as new" from any workflow.

### D8. Backup, export and import are explicit, bounded actions
- **Backup** (`POST /admin/backups`): SQLite `VACUUM INTO` into a fixed folder (`ORCH_BACKUP_DIR`, default `.sandbox/backups`) under a server-chosen name. A caller cannot pick a path. The copy is reopened read-only and checked (integrity, schema version, row counts) before it is reported. At most 20 backups (refused after that; delete old ones by hand). Audited.
- **Project export** (`GET /projects/:id/export`): settings, project memory, workflow definitions. No local path, runs, logs, approvals or credentials.
- **Memory import** (`POST /projects/:id/import-memory`): only human-written, active entries, each through the normal memory screening; agent-written entries are skipped because the runs they cite do not exist in the target project. Repeating an import adds nothing. At most 500 entries. Audited.

### D9. Hardening
- Test: a session with 30,000 events stays fast to read the tail of, append to (sequence continues), and analyse alongside 400 runs.
- Accessibility: skip link (existing), labelled controls, `aria-live` for validation and status, chart has a text alternative and a "show as table" view, focus rings, `prefers-reduced-motion` honoured globally, forced-colours styles for the chart, and status shown with words as well as colour.
- Error recovery: loading and failure states with "Try again" on analytics; the editor keeps your work when a check fails; the backup button reports why it was refused.
- Responsive: no horizontal page scroll at phone width on Analytics (checked); the editor and Data pages were only checked at desktop width.

### D10. PostgreSQL and multi-user: not needed yet
SQLite handled every scale test here. The Store is the only writer, so a move later is one module. Multi-user needs real authentication first (Phase 12 limit), which is a separate piece of work. Not started, on purpose.

### D11. Interface polish (unslop pass)
The unslop skill (heydamir/unslop, CC BY 4.0) was read as reference material only; nothing from the repository was installed or run. It applies in "polish" mode because the dashboard was already designed: headings, table headers and sidebar labels are sentence case instead of uppercase with tracking; weights are 500 and 600 only; small text has no negative tracking; stat cards are a label, a figure and its basis (the coloured left border is gone); spacing nudged to a 4px rhythm; the one accent marks the thing that matters in a chart (largest bar, top-ranked row). The signature detail is the **basis line** under every figure ("16 of 18 runs reported"). The skill's step "stop and wait for direction" was skipped because you asked for it to be applied directly.

## Not done / limits (please read)
- **Cost is only as complete as provider reports.** If the CLI reports nothing, analytics shows "unknown", not an estimate.
- **No time-series of escalation or failure**: totals and rankings only, apart from daily spend.
- **Budget stops before the next attempt**, it does not kill a run in flight.
- **Quality is measured by acceptance and retries**, not by judging the code. A person approving a weak change counts as accepted.
- **Restore is manual**: stop the orchestrator and point `DB_PATH` at a backup. There is no restore button, deliberately.
- **Project export has no workflow-run history or session transcripts.** Memory import cannot restore agent-written notes.
- **JSON Schema covers shape, not relations.** Cycles, unknown ids and disallowed commands are checked by the tool.
- **Not measured**: real billed runs, a browser accessibility audit with a screen reader, very large analytics windows on a busy database.

## Testing
`tests/unit/phase13.test.ts`, 22 tests: empty state; unreported cost stays unknown; cost per accepted vs not accepted (demo and unfinished excluded); no averaging over unpriced units; escalation, retries, failure causes and estimated savings; stable failure categories; recovery rate; approvals and wait time; insights need enough data; window and project filters; limit validation; export/import round trip; every import problem reported (typo, version, format, cycle, unknown id); JSON Schema strictness; editor check without creating anything; budget stop with an unreported run adding nothing; workflow cost from all attempts; verified backup; export contents; memory import screening and idempotence; 30,000-event session; HTTP flow including the backup cap. Full suite 201/201. Dashboard `tsc --noEmit` clean and `next build` succeeds.
Verified in the browser against a scratch orchestrator: Analytics (insights, chart, ranked lists, 375px layout with no horizontal scroll), the editor (valid template, problems after removing a step, Create disabled while invalid, import rejecting a misspelt key), and Data (backup created, listed and integrity-checked through the gateway).
Manual: restart `npm run api` and the dashboard, then open **Analytics**, **Workflows > Open the editor** and **Data**.
