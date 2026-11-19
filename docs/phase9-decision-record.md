# Phase 9 decision record: multi-agent workflows

Scope (roadmap §13): a workflow engine that splits a feature across agents with roles, runs steps in parallel where safe, integrates their work, runs checks, has it reviewed, and stops for a human approval. Exit: one demonstration with plan, agent activity, test evidence, review findings, retry history and an explicit approval.

## Decisions

### D1. A workflow is data, validated once, then immutable
- Step kinds: `agent`, `check`, `review`, `integrate`, `approval`, `merge_ready`. Roles: planner, coder, tester, docs, reviewer (`ROLES` has a `writes` flag).
- `validateWorkflow` rejects unknown kinds, duplicate ids, missing or cyclic `needs`, bad limits. Defaults: concurrency 2 (max 4), attempts 2 (max 5). A check or review automatically depends on its target; its `fixer` defaults to that target.
- A DB trigger makes the definition immutable after creation. `featureTemplate` builds the usual shape: parts, integrate, checks, review, merge-ready.

### D2. Isolation: every agent attempt gets its own session and worktree
- Parts run in parallel on separate worktrees (Phase 6). A correction starts a new worktree from the previous branch (`create(sessionId, startPoint)`), so earlier work is kept.
- The engine commits a step's work onto an `orch/` branch (`snapshotCommit`). The wf-git helper only allows status, add, commit, merge, diff, rev-parse, branch, and only on `orch/` branches.
- **Nothing is ever merged into the base branch.** The integrate step merges each part's branch (`--no-ff`) in a fresh worktree. A conflict aborts the merge, fails the workflow and records `merge-conflict` evidence.

### D3. Read-only roles are checked afterwards, not prevented
Reviewer, planner etc. run in a worktree; if the workspace changed, the step fails as a role violation. This is detection, **not tool restriction**.

### D4. Checks are argv arrays from an allow-list
No shell. Allowed programs: node, npm, npx, pnpm, tsc, eslint, pytest, cargo, go and similar; override with `ORCH_CHECK_COMMANDS`. On Windows, `.cmd` programs go through a shell only if the arguments pass a metacharacter filter. Output is stored as evidence.

### D5. Failure handling is bounded
- A failed check or serious review finding goes to `routeFailure`: feedback to the fixer agent, fixer and everything downstream reset to pending.
- Stops on step attempt limit, fixer attempt limit, or an **identical repeated failure** (fingerprint with digits normalised).
- A provider rate limit or budget error halts the workflow; it is never retried around.
- `when` conditions skip steps. A failed step is tolerated only if some step has `when: {status: 'failed'}` on it.

### D6. Reviewer findings are text-parsed
Lines `FINDING: <severity> | <path> | <message>` in the `agent.result` text (the supervisor truncates it to 2000 chars). Severity gates the correction loop.

### D7. Human approval is real
`merge_ready` runs `worktrees.mergeCheck`, then `store.requestApproval`, anchored on an "anchor session" made at workflow start. `decide()` requires a named approver. Approve/reject are recorded as evidence.

### D8. State lives in SQLite, so a restart is safe
Migration 7: `workflow`, `workflow_step`, `workflow_transition`, `workflow_evidence`. Transitions and evidence are append-only (triggers). `tick()` is synchronous; async check processes are tracked with tokens. Tested: a second engine instance continues a workflow.

### API and UI
`/workflows` routes (list, roles, create from `definition` or `template`, get, transitions, evidence, record, start, cancel, step approve/reject). Dashboard: Workflows list/create, workflow view with plan table, approval card, history, evidence, audit-record link.

## Not done
- **LLM-generated planning.** A planner role exists but its output is only recorded as evidence; the plan is author-supplied.
- **Real tool restriction** per run (see D3).
- No dependency-aware conflict prediction; overlapping edits fail at integrate.
- No real billed Claude run was made through a workflow; tests use the fake CLI.
- Nothing merges to the base branch; that stays manual.

## Testing
`tests/unit/phase9.test.ts`, 17 tests: schema, allow-list, findings parsing, the full demonstration (parallel parts, failing check, correction, review finding, second correction, approval, base HEAD unchanged), concurrency, `when`/tolerated failure, bounded retries and repeated-failure stop, budget stop, agent retry limit, role violation, merge conflict, rejection, cancel, restart, append-only triggers, HTTP API.
Manual: restart `npm run api`, open Workflows, create a workflow with two parts and `npm test`, Start, watch it, approve with a name.
