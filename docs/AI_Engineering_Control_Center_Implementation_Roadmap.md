# AI Engineering Control Center
## Implementation Roadmap and Technical Build Order

**Purpose:** A prioritized, dependency-aware implementation plan for building the AI Engineering Control Center.  
**Approach:** Build the execution and recovery foundations before advanced multi-agent automation or visual polish.

---

## 1. Implementation principles

1. **Prove real execution first.** A dashboard that launches, observes, and resumes one coding task is more valuable than a beautiful mock factory.
2. **Persist state from day one.** Do not build the orchestration engine around transient frontend state or chat history alone.
3. **Use explicit contracts.** Define schemas for projects, sessions, tasks, agent runs, events, checkpoints, and model-routing decisions before adding complex features.
4. **Separate orchestration from providers.** The scheduler should not depend directly on one CLI's event format or authentication implementation.
5. **Keep source repositories separate.** The orchestration workspace stores metadata and memory; Git worktrees contain code changes.
6. **Make all work resumable.** Every long-running task needs durable state, logs, cancellation behavior, and a clear recovery path.
7. **Use least privilege.** Agents should have only the permissions required for their task.
8. **Measure quality as well as cost.** Cheap model usage is not a success if it increases defects or rework.
9. **Build visualization from events.** The factory view should represent actual runtime state.
10. **Deliver in vertical slices.** Each phase should produce a working, testable increment.

## 2. Priority legend

- **P0 — Critical foundation:** required for a reliable MVP.
- **P1 — Core capability:** needed to demonstrate the main product value.
- **P2 — Advanced capability:** add after the foundation is proven.
- **P3 — Polish/scale:** defer until real usage justifies it.

## 3. Dependency overview

```text
Requirements and technical spikes
            |
            v
Repository + project/session data model
            |
            v
One provider adapter + process lifecycle
            |
            v
Durable events, task state, checkpoint/recovery
            |
            +--------------------+
            |                    |
            v                    v
Basic dashboard UI        Shared project/session memory
            |                    |
            +----------+---------+
                       |
                       v
              Git worktree isolation
                       |
                       v
             Model routing and usage
                       |
                       v
             Account/provider handoff
                       |
                       v
             Multi-agent task graph
                       |
                       v
          Build/test/review/approval gates
                       |
                       v
             Knowledge graph explorer
                       |
                       v
             Live Agent Factory view
                       |
                       v
             Analytics, workflow builder,
             hardening and multi-user scale
```

This is a dependency guide, not a requirement to postpone all UI work until the end. Build a basic UI alongside the runtime, then improve the factory view once the event model is stable.

---

## 4. Phase 0 — Resolve technical risks before implementation

**Priority: P0**

### Tasks

- [ ] Confirm the first target environment: local Mac, one developer, one repository.
- [ ] Choose one backend stack: Node.js/TypeScript or Python/FastAPI.
- [ ] Confirm the supported Claude Code CLI launch, session identification, output/event capture, model selection, cancellation, and resume mechanisms for the installed version.
- [ ] Identify which state is exposed by the runtime and which state must be maintained by the application.
- [ ] Determine what account switching and session resumption are officially supported. Do not assume a login change transfers a live session.
- [ ] Define how secrets are stored and how workers receive credentials without logging them.
- [ ] Test Git worktree creation, cleanup, and recovery after process termination.
- [ ] Define MVP acceptance criteria and a small test repository.

### Deliverable

A short technical decision record with one proven path to launch a real coding task, capture its output, cancel it, and resume from a portable checkpoint.

### Exit criteria

The highest-risk provider/runtime assumptions are tested rather than guessed. If cross-account continuation is unsupported, the system can still resume using a portable checkpoint.

---

## 5. Phase 1 — Define contracts, data model, and storage

**Priority: P0**

Build the data model before the UI grows around ad hoc state.

### Core entities

- `Project`: repository location, default branch, settings, and memory references.
- `Session`: feature/task identity, status, project, active worktree, checkpoint, and timestamps.
- `Task`: description, acceptance criteria, dependencies, priority, and completion criteria.
- `AgentRun`: task, role, provider, model, process identity, status, and timestamps.
- `Event`: append-only record of meaningful runtime and workflow changes.
- `Checkpoint`: resumable state, Git state, next action, and referenced artifacts.
- `Artifact`: diff, log, test report, specification, or other output.
- `RoutingDecision`: selected model/provider, policy reason, and usage information.
- `Approval`: requested action, evidence, decision, and approver identity.
- `KnowledgeNode` / `KnowledgeEdge`: indexed entities and their provenance.

### Tasks

- [ ] Define JSON schemas or typed contracts for the entities.
- [ ] Use stable IDs for projects, sessions, tasks, runs, events, and artifacts.
- [ ] Define valid states and transitions, e.g. `queued`, `running`, `paused`, `blocked`, `failed`, `completed`, `cancelled`.
- [ ] Define which fields are authoritative in the database and which files are human-readable projections.
- [ ] Add schema migrations and seed/demo data.
- [ ] Use SQLite for the local MVP; keep storage interfaces replaceable.
- [ ] Define redaction rules for credentials and sensitive output.

### Deliverable

A persistent data layer with migrations, typed domain models, and state-transition validation.

### Exit criteria

A session can be created, queried, updated, and reloaded after an application restart without losing its authoritative state.

---

## 6. Phase 2 — One real agent runtime and process supervision

**Priority: P0**

Do not begin with a large fleet of agents. First control one real execution reliably.

### Tasks

- [ ] Implement a provider-adapter interface independent of the UI.
- [ ] Implement one Claude Code CLI adapter using supported invocation and output mechanisms.
- [ ] Launch a task in a configured repository/worktree.
- [ ] Capture stdout/stderr or structured runtime events where supported.
- [ ] Track process ID, start/end time, exit status, and termination reason.
- [ ] Provide start, inspect, cancel, and status operations.
- [ ] Handle timeouts, process crashes, application shutdown, and orphaned processes.
- [ ] Store logs as artifacts and persist important events.
- [ ] Redact secrets before persisting logs.
- [ ] Never infer that a task succeeded merely because the process started or produced a final-looking message.

### Deliverable

One task can be launched from a backend API and its actual status and output can be inspected.

### Exit criteria

A process can finish, fail, or be cancelled and the resulting status is correctly persisted and queryable.

---

## 7. Phase 3 — Durable orchestration and checkpoint/recovery

**Priority: P0**

This is the most important reliability milestone.

### Checkpoint content

- Session and task IDs.
- Original request and acceptance criteria.
- Current plan and completed/incomplete steps.
- Current workflow state and next action.
- Project/worktree path, branch, current revision, and Git status.
- Changed-file list and relevant diff/artifact references.
- Build/test outcomes and errors.
- Important decisions, rejected approaches, and unresolved questions.
- Relevant memory/graph references.
- Last known runtime status and event sequence.

### Tasks

- [ ] Save checkpoints at defined boundaries and before handoffs.
- [ ] Persist state before launching work and after receiving meaningful results.
- [ ] Add safe cancellation and pause behavior.
- [ ] Resume by verifying the worktree and reading the checkpoint.
- [ ] Have the resumed worker inspect current Git status and diff before editing.
- [ ] Use idempotency keys for retried orchestration operations.
- [ ] Recover sessions after application/backend restart.
- [ ] Prevent two workers from concurrently owning the same writable worktree.
- [ ] Track event sequence numbers and distinguish old from current events.
- [ ] Add recovery tests for crashes at different points in the workflow.

### Deliverable

A session can be interrupted and resumed from persisted state without replaying its entire conversation.

### Exit criteria

Automated tests demonstrate recovery after worker failure and application restart, with no silent loss of uncommitted changes.

---

## 8. Phase 4 — Basic dashboard and session workspace

**Priority: P0**

Build a functional control surface while the runtime is still small.

### Screens

- Overview of sessions and their statuses.
- Session list/sidebar.
- Session detail with task, logs, files changed, and timeline.
- Agent-run detail with model, provider, exit status, and artifacts.
- Diff viewer.
- Start, cancel, and resume controls.

### Tasks

- [ ] Build the Next.js/TypeScript application.
- [ ] Add REST endpoints for commands and queries.
- [ ] Add WebSocket or SSE updates for live events.
- [ ] Render actual backend state rather than maintaining a second independent state machine in the browser.
- [ ] Show errors, disconnected runtime state, and stale data clearly.
- [ ] Use seeded mock data only for UI development; distinguish it from real runtime data.
- [ ] Add basic accessibility and keyboard navigation.

### Deliverable

A user can start and monitor a real task from the dashboard and inspect its output.

### Exit criteria

The UI remains correct after refresh/reconnect and accurately reflects persisted backend state.

---

## 9. Phase 5 — Project memory and feature-session memory

**Priority: P1**

Build explicit context persistence before multi-account handoff.

### Tasks

- [ ] Add project-level architecture, conventions, decisions, and known-issue files.
- [ ] Add per-session task specification, state, checkpoint, decisions, and next-action notes.
- [ ] Define which agent roles can update which memory categories.
- [ ] Include timestamps and source references for important claims.
- [ ] Keep session memory separate from canonical project memory.
- [ ] Add a context-retrieval service that returns relevant snippets, not the entire memory directory.
- [ ] Add memory compaction and deduplication rules.
- [ ] Prevent secrets and untrusted instructions from being copied into persistent memory.
- [ ] Add a session handoff summary generated from actual state and verified artifacts.

### Deliverable

A new execution can resume a feature using a concise checkpoint and relevant project memory.

### Exit criteria

A controlled test demonstrates that a second session can continue the same task from a checkpoint without relying on the original conversation.

---

## 10. Phase 6 — Git worktree management and isolation

**Priority: P1**

Parallel coding is unsafe without clear workspace ownership.

### Tasks

- [ ] Create and remove worktrees through a controlled service.
- [ ] Associate each writable worker with an explicit worktree.
- [ ] Track branch, base revision, current revision, and uncommitted changes.
- [ ] Detect overlapping file ownership and likely merge conflicts.
- [ ] Protect user changes; never reset, clean, or overwrite uncommitted files automatically.
- [ ] Provide diff inspection and safe cleanup previews.
- [ ] Define a strategy for integration branches and cherry-picks/merges.
- [ ] Keep task output and logs outside source-controlled files unless deliberately committed.

### Deliverable

Each independent task can work in an isolated Git worktree, with changes reviewable and recoverable.

### Exit criteria

Two isolated tasks can work concurrently without writing into each other's worktrees, and integration conflicts are detected before merge.

---

## 11. Phase 7 — Model routing, usage tracking, and budgets

**Priority: P1**

Start with simple transparent rules. Avoid a complex autonomous router before there is data to evaluate it.

### Initial rules

- Haiku: extraction, classification, tagging, short summaries, boilerplate, and routine subtasks.
- Sonnet: normal coding, debugging, analysis, code review, and most substantive work.
- Opus: difficult reasoning, architecture decisions, complex refactors, or repeated failures where a stronger model is justified.

Verify supported model identifiers and availability for the actual provider integration.

### Tasks

- [ ] Define a versioned routing policy configuration.
- [ ] Classify tasks by type, complexity, and risk.
- [ ] Add per-task and daily budget limits.
- [ ] Record model/provider, routing reason, outcome, retries, and reported usage/cost where available.
- [ ] Define escalation triggers, such as repeated failed validation or unresolved high-impact findings.
- [ ] Bound escalation and retry loops.
- [ ] Support a cheap extraction stage followed by stronger reasoning when appropriate.
- [ ] Show when cost data is estimated, unavailable, or reported by the provider.
- [ ] Build initial analytics for cost per accepted task and escalation outcomes.

### Deliverable

The scheduler can select a model according to explicit rules and explain why it did so.

### Exit criteria

Routing decisions are reproducible and logged; budget limits are enforced; evaluation compares quality as well as cost.

---

## 12. Phase 8 — Authorized account/provider adapters and handoff

**Priority: P1**

Treat account switching as a recoverable execution handoff, not as a way to evade usage limits.

### Tasks

- [ ] Define a provider/account adapter contract.
- [ ] Store credentials through OS credential storage or an appropriate secrets manager.
- [ ] Expose only supported provider capabilities and model IDs.
- [ ] Track reported availability, errors, and rate-limit responses.
- [ ] Checkpoint work before stopping or handing off a worker.
- [ ] Ensure the old worker is stopped or quiesced before the next worker writes.
- [ ] Verify repository/worktree, permissions, branch, and diff before resuming.
- [ ] Resume from portable state; do not assume the original internal conversation is transferable.
- [ ] Queue work when no authorized capacity is available.
- [ ] Prevent repeated automatic retries against a rate-limited provider.
- [ ] Audit account/provider changes and handoff events.

### Deliverable

A task can be resumed through another supported execution adapter using the same persisted project/session state.

### Exit criteria

Handoff tests show that work and uncommitted changes remain intact, and provider limits are respected.

---

## 13. Phase 9 — Multi-agent workflow engine

**Priority: P1**

Only add parallel agents once single-agent recovery and isolated workspaces are reliable.

### Workflow stages

1. Intake and requirements.
2. Specification and planning.
3. Task dependency graph.
4. Workspace preparation.
5. Parallel specialist execution.
6. Deterministic verification.
7. Independent reviews.
8. Corrections and bounded retries.
9. Integration.
10. Human approval.
11. Merge readiness and audit record.

### Tasks

- [ ] Define a workflow schema for steps, dependencies, conditions, and policies.
- [ ] Add a scheduler that starts only tasks whose dependencies are satisfied.
- [ ] Define specialist roles and permitted tools for each role.
- [ ] Keep concurrent tasks isolated.
- [ ] Use Haiku for appropriate routine subtasks and Sonnet for most substantive coding.
- [ ] Escalate to Opus only according to configured rules.
- [ ] Run compiler, tests, linters, and scanners as deterministic checks.
- [ ] Route review findings to the responsible task/agent.
- [ ] Re-run affected checks and the required full suite before completion.
- [ ] Stop on retry limits, budget limits, repeated failures, or unresolved blockers.
- [ ] Require explicit human approval for protected merges.
- [ ] Persist every transition and evidence artifact.

### Deliverable

One feature workflow can coordinate multiple isolated agents and progress through verifiable checks to merge readiness.

### Exit criteria

A demonstration feature can be completed with a recorded plan, agent activity, test evidence, review findings, retry history, and explicit approval.

---

## 14. Phase 10 — Repository index and knowledge graph

**Priority: P1/P2**

Start with precise source-level relationships, then add semantic concepts.

### Tasks

- [ ] Choose a parser/indexing approach compatible with the target languages.
- [ ] Extract files, symbols, imports, calls, declarations, and test references.
- [ ] Ingest Git revision and changed-file information.
- [ ] Add relationships from build/test/dependency metadata.
- [ ] Add feature, requirement, decision, and agent-run nodes.
- [ ] Store source locations and provenance for relationships.
- [ ] Add incremental indexing after file changes.
- [ ] Detect and display stale indexes.
- [ ] Add optional LLM-derived architectural/business relationships, marked as inferred.
- [ ] Add graph queries for relevant files, downstream dependencies, and related tests.
- [ ] Allow the user to inspect source and evidence from each node.

### Deliverable

A session-specific graph can show the feature's relevant code, dependencies, decisions, and tests.

### Exit criteria

The graph returns useful, source-linked results for a real feature and flags stale information after changes.

---

## 15. Phase 11 — Agent Factory visualization

**Priority: P2**

The factory view should be driven by real events from the runtime and workflow engine.

### Tasks

- [ ] Define visual states mapped to authoritative run states.
- [ ] Build workstations for planning, coding, testing, reviewing, and integration.
- [ ] Render actual active/queued/completed/failed tasks.
- [ ] Make agents and stations selectable.
- [ ] Show the task, model, logs, files, and output in the detail panel.
- [ ] Animate only events that have occurred.
- [ ] Show waiting, blocked, and failed states honestly.
- [ ] Keep a conventional list/timeline alternative for accessibility and operational clarity.
- [ ] Start with 2D/canvas or a graph-like scene; add a richer isometric/3D scene only if useful.

### Deliverable

The factory offers a visual overview and lets users inspect real agent execution.

### Exit criteria

A user can click a visual agent and see the matching real task and runtime evidence; mock and real activity are never confused.

---

## 16. Phase 12 — Approval inbox, safety, and policy enforcement

**Priority: P1 for merge/deployment workflows; otherwise incremental**

Some controls must exist before multi-agent workflows can modify important code. Expand them as capabilities grow.

### Tasks

- [ ] Add permission profiles for read, edit, terminal, network, secrets, and external actions.
- [ ] Require explicit approval for destructive actions and protected merges.
- [ ] Add approval records and an audit trail.
- [ ] Present diff, test evidence, risks, and unresolved findings together.
- [ ] Integrate branch-protection and CI status where available.
- [ ] Add safe cancellation, timeouts, process cleanup, and resource limits.
- [ ] Protect against prompt injection from repository files and tool outputs.
- [ ] Redact secrets in logs, events, memory, and model context.
- [ ] Prevent untrusted agent output from changing permissions or bypassing gates.
- [ ] Add security tests for authorization and isolation boundaries.

### Deliverable

A human can make informed decisions on high-impact actions, and the system enforces permissions in the backend.

### Exit criteria

Protected actions cannot be triggered merely by an agent claiming approval; policy is enforced server-side and audited.

---

## 17. Phase 13 — Analytics, workflow configuration, and hardening

**Priority: P2/P3**

### Tasks

- [ ] Dashboard for cost per accepted task/feature.
- [ ] Model escalation and retry analytics.
- [ ] Checkpoint recovery and failure-rate analytics.
- [ ] Task duration and human intervention metrics.
- [ ] Workflow editor for steps, dependencies, roles, and gates.
- [ ] Configurable task-specific retry and budget limits.
- [ ] Import/export workflow definitions with schema validation.
- [ ] Test long-running sessions and many event updates.
- [ ] Improve accessibility, keyboard navigation, and error recovery.
- [ ] Add backup/export and project-memory migration tools.
- [ ] Consider PostgreSQL and multi-user features only when needed.

### Deliverable

A stable tool that can be tuned using real execution and cost-quality data.

### Exit criteria

The system can explain where it saves cost, where it escalates, where it fails, and whether quality is maintained.

---

## 18. Suggested code/module boundaries

Example layout; adapt it to the chosen backend stack.

```text
apps/
  dashboard/                 # Next.js UI
services/
  orchestrator/
    api/                      # REST and live-event endpoints
    domain/                   # Typed entities and state transitions
    scheduler/                # Dependency scheduling and retries
    workflows/                # Workflow definitions and execution
    runtime/
      adapters/               # Claude Code CLI and future providers
      process-manager/        # Start, stop, monitor, recover
    routing/                  # Model selection and budgets
    checkpoints/              # Save/restore and handoff
    workspaces/               # Git worktree lifecycle
    permissions/              # Authorization and approvals
    events/                   # Durable events and delivery
    storage/                  # Repositories and migrations
    memory/                   # Project/session memory and retrieval
    indexing/                 # Symbols, references, freshness
    knowledge-graph/          # Nodes, edges, queries, provenance
    artifacts/                # Logs, diffs, reports
    analytics/                # Cost, outcomes, reliability
packages/
  contracts/                  # Shared schemas and event types
  workflow-schema/            # Workflow definition validation
  provider-adapter-interface/ # Runtime/provider contracts
policies/
  model-routing.yaml
  permissions.yaml
workflows/
  feature-development.yaml
  bug-fix.yaml
tests/
  unit/
  integration/
  recovery/
  security/
  e2e/
```

Keep module boundaries logical, but avoid splitting into many separately deployed services for a local MVP.

## 19. Minimum viable product definition

The first usable MVP should include only:

- [ ] One local repository.
- [ ] One real Claude Code execution adapter.
- [ ] One feature session at a time.
- [ ] Persisted session state and checkpoints.
- [ ] Start, status, cancel, and resume.
- [ ] Live output and event timeline.
- [ ] Changed-file list and diff viewer.
- [ ] Basic project and session memory.
- [ ] Safe Git workspace handling.
- [ ] Clear process failure and recovery behavior.

Do not make the animated factory, multi-agent parallelism, cross-account handoff, or advanced graph indexing prerequisites for the first MVP.

## 20. Definition of done for the first end-to-end demonstration

Use one real, bounded feature on a non-production repository.

The demonstration should show:

1. A feature request is captured with acceptance criteria.
2. A coding task starts from the dashboard.
3. Real execution events and output are visible.
4. The task changes files in an isolated workspace.
5. A checkpoint is saved.
6. The application or worker is interrupted.
7. The session resumes from persisted state.
8. The current diff is inspected before further edits.
9. Tests/build checks run and their real results are recorded.
10. The final diff and outstanding issues are presented for human review.
11. The session, artifacts, and audit timeline remain available after restart.

Once this passes reliably, add model routing and the first multi-agent workflow.

## 21. Final priority recommendation

**Build in this order:**

1. Technical feasibility and provider/runtime spike.
2. Contracts, persistence, and session state.
3. Single-agent runtime and process supervision.
4. Durable checkpoint/recovery.
5. Basic dashboard and event timeline.
6. Project/session memory.
7. Git worktree isolation.
8. Model routing and budgets.
9. Authorized provider/account handoff.
10. Multi-agent workflow scheduler.
11. Deterministic verification and human approval gates.
12. Repository indexing and knowledge graph.
13. Agent Factory visualization.
14. Analytics and workflow builder.
15. Multi-user deployment and scaling, only when justified.

The critical path is **reliable execution → durable recovery → shared context → isolated workspaces → model routing → multi-agent orchestration → visualization**. This order minimizes the risk of building a compelling UI around an unreliable engine.
