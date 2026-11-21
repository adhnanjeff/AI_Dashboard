# Phase 12 decision record: approval inbox, safety and policy enforcement

Scope (roadmap §16): permission profiles; explicit approval for destructive actions and protected merges; approval records and audit; diff, test evidence, risks and findings together; branch-protection and CI status where available; safe cancellation, timeouts, cleanup and limits; prompt-injection protection; secret redaction; untrusted output cannot change permissions or bypass gates; security tests. Exit: protected actions cannot be triggered by an agent claiming approval; policy is enforced server-side and audited.

## Decisions

### D1. Roles get a permission profile, and it reaches the process as real tool lists
`policy/profiles.ts`: capabilities read, edit, terminal, network, secrets, external; profiles `read_only`, `edit`, `terminal`, `network`, `external`. Default by role: planner and reviewer read-only; coder, docs, tester and unknown roles edit (no shell, no web). The supervisor asks the policy service for the profile **before any state changes** and passes the provider CLI `--allowedTools` and `--disallowedTools`. This closes the Phase 9 gap: read-only roles are now *prevented* from writing, not just checked afterwards (the after-the-fact check stays as a second layer). Every profile denies secret files (`.env`, keys, `.npmrc`, `.aws`); no profile grants `secrets`. The profile used is recorded as a `policy.profile` event on the session.

### D2. Elevation needs an approval for this profile and this task
`terminal`, `network` and `external` run only with an approved `permission.elevate` request whose subject is `profile:<p>@task:<id>`. The approval is spent in the same step that starts the run. A read-only role cannot be given an editing profile by naming it. A refusal leaves no run, no state change and an audit entry.

### D3. What is a "human decision" is decided by the server
- Decisions (`/approvals/:id/approve|reject` and the workflow step routes) must carry a **decision token**. The dashboard server holds it (generated on first start, kept in `.sandbox/decision.token` or `ORCH_DECISION_TOKEN`) and adds it only to those routes for same-site browser requests. The orchestrator **withholds every `ORCH_*` variable and common source-control tokens from agent processes** (`agentEnv`).
- Names such as `agent`, `system`, `workflow`, `claude`, `reviewer` are refused as approvers. Optional separation of duties (`ORCH_SEPARATION_OF_DUTIES=1`) stops a requester approving their own request.
- Refused attempts are audited.

### D4. An approval is a single-use, subject-bound, expiring record
Migration 9 adds subject, requested-by, expiry, consumed-at/by, decided-via and risk to `approval`, plus triggers: a request cannot be edited, a decision cannot be changed, an approval cannot be reused or deleted. `consume()` is one atomic UPDATE that requires approved, unused, unexpired, same action and same subject. Default lifetime: 1 hour.

### D5. Protected merge: request, person decides, execute
`policy/protected-ops.ts` is the only code that merges.
- **Request** (agent branches `orch/…` only) gathers the evidence in one place: file diff, merge check, recorded test results, unresolved reviewer findings, CI status, and risks (protected target, no tests, failed checks, sensitive files such as workflows, lockfiles, migrations, large change, injected instructions seen).
- **Execute** re-checks the world **before** spending the approval: the branch is still at the approved commit, the target is checked out and clean, it still merges cleanly, CI is not failing. Then it spends the approval and runs `git merge --no-ff` of that exact commit. A refusal because the world changed does **not** burn the approval.
- The orchestrator never switches branches for the user, never pushes.

### D6. Discarding unsaved work is a separate approved action
Normal worktree removal still refuses to lose anything. `worktree.discard` is approved against the exact state the person saw (head and number of uncommitted files); if that changes, the approval no longer matches.

### D7. Untrusted text is fenced and flagged, and cannot approve anything
`policy/untrusted.ts`: `wrapUntrusted` fences text from tools, check output, reviewer findings and earlier workers (redacted, length-limited, marker cannot be forged), and `scanUntrusted` flags instruction-like content (it is a heuristic). It is applied to the workflow fixer feedback, the resume prompt and the handoff. Instruction-like tool output also records a `security.untrusted_instruction` event, shown as a risk on merge requests. The real protection is structural: approvals need the decision token, so no text an agent reads or writes can approve or change a permission.

### D8. Redaction
More patterns (JWT, Slack, Google keys, credentials in connection strings). Prompts are redacted **before they reach the model process**; audit details, approval evidence and risk text are redacted before storage (events, artifacts, checkpoints, memory already were).

### D9. Resource limits and cancellation
Maximum concurrent runs (default 8, `ORCH_MAX_ACTIVE_RUNS`, refused with HTTP 429 or queued by the scheduler) and a hard per-run time cap (default 60 min) that no caller can exceed. Existing timeout kill, cancel, process-tree cleanup, orphan recovery and lock release are covered by Phase 2 and 3 tests and re-verified for the cap.

### Inbox and API
`GET /approvals[?status]`, `GET /approvals/:id`, approve/reject, `POST /projects/:id/merge-requests`, `POST /approvals/:id/execute-merge`, `POST /sessions/:id/worktree/discard-request|discard`, `POST /tasks/:id/permission-requests`, `GET /policy`. Dashboard: **Approvals** page (open and history, evidence, decision, "Merge now", and a table of what agents may do) with a waiting-count badge in the header.

## Not done / limits (please read)
- **Not an OS sandbox.** Profiles limit the CLI's tools. An agent with an approved shell can do what the OS user can do, including read the decision token file. Strong isolation needs containers or a separate OS account.
- The decision token is a **local secret, not user authentication**. The dashboard has no login, so anyone who can open the dashboard can approve. Real multi-user auth is future work.
- **CI / branch protection**: the interface exists (`CiProvider`) and CI failure blocks a merge, but no GitHub or other provider is implemented; the default honestly reports "unknown".
- Injection detection is a pattern list and will miss things. Memory notes written by agents are still placed in prompts as before (marked unverified in the handoff).
- Memory-write roles are still asserted by the caller (Phase 5 note).
- Merging works only when the target branch is checked out and clean in the main repository.
- Permission requests for terminal/network exist in the API; the dashboard has no button to start a run with an elevated profile yet.
- No push, deploy or other external action is implemented, so the `external` capability only exists as a profile.

## Testing
`tests/unit/phase12.test.ts`, 14 tests: profile tool lists reach the process; environment withheld; elevation (no approval, wrong task, wrong profile, single use, read-only role); decision channel (no/wrong token, agent names, self-approval, repeat, expiry); consumption rules and database triggers; protected merge (request evidence, claims ignored, exact-commit check, dirty or wrong checkout keeps the approval, conflict refused); workflow test evidence and findings in the request; discard pinned to state; untrusted text fenced, flagged, and unable to approve; redaction in prompts, audit and evidence; resource limits and the time cap; the full HTTP flow including the token. Full suite 179/179.
Verified in the browser: the Approvals page; an agent-like name refused; approval through the dashboard gateway recorded as `human-token`; "Merge now" produced the merge commit in a scratch repository; the approval showed as used and the audit trail listed each step.
Manual: restart `npm run api` and the dashboard (a decision token file is created at `.sandbox/decision.token`), create a merge request with `POST /projects/:id/merge-requests`, then use the Approvals page.
