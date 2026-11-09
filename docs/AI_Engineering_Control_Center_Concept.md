# AI Engineering Control Center
## Product Concept, Requirements, Architecture, and Design

**Status:** Concept / proposed design  
**Purpose:** A local-first AI engineering dashboard that coordinates coding sessions, specialized agents, model selection, shared project knowledge, and feature delivery.

---

## 1. Executive summary

The proposed product is an **AI Engineering Control Center**: a dashboard for managing multiple AI-assisted software development sessions and coordinating work from a feature request through implementation, verification, review, and merge readiness.

It combines three ideas:

1. **Agent Factory:** A visual, live representation of agents working at task-specific workstations.
2. **Session Workspace:** A persistent home for each feature, including its task state, Git state, relevant files, decisions, execution history, and knowledge graph.
3. **Model and Account Router:** A policy-driven system that chooses an appropriate model for each task, tracks usage, and can resume work through another authorized execution path when needed.

The visual interface is important, but it should reflect real execution events. The core product is the orchestration system underneath it.

## 2. Goals

- Manage multiple repositories, features, and AI coding sessions from one dashboard.
- Preserve project and feature context across sessions, models, process restarts, and authorized account changes.
- Route tasks to an appropriate model based on task type, complexity, risk, quality needs, and budget.
- Coordinate specialized agents with clear responsibilities and dependencies.
- Track live agent activity, file changes, commands, test results, reviews, and workflow state.
- Index repository relationships and maintain session-specific knowledge graphs.
- Make interruptions recoverable through durable checkpoints and resumable tasks.
- Reduce wasted model usage without reducing engineering quality.
- Keep humans in control of risky actions, approvals, and protected merges.

## 3. Non-goals for the first version

- Fully autonomous production deployments.
- Unrestricted agent access to a developer's machine or credentials.
- Building a distributed, multi-user enterprise platform before the local workflow is validated.
- Replacing Git, CI, code review, or branch protection.
- Assuming an LLM's statement that work is complete is sufficient proof.
- Attempting to transfer a model's hidden internal conversation state between accounts. The product instead uses portable, explicit checkpoints and relevant context retrieval.
- Building a sophisticated 3D world before real agent execution is observable.

## 4. Main user experience

### 4.1 Left sidebar — sessions and accounts

Show:
- Projects and repositories.
- Feature sessions, recent activity, and status.
- Connected execution providers/accounts and their reported availability.
- Queued, running, paused, blocked, failed, and completed work.
- Quick actions to create a feature session or resume one.

Selecting a session should restore its task context, knowledge graph, file references, timeline, and workflow.

### 4.2 Center — Agent Factory

A miniature factory or isometric environment represents real agent work:
- Workstations represent specification, coding, testing, security review, documentation, and integration.
- Agents are visual representations of actual worker processes or delegated tasks.
- Station lighting and movement are driven by runtime events.
- Selecting an agent opens its task, model, execution status, current step, relevant files, logs, and output.
- Failed tasks show errors; idle tasks show queued or waiting states.

The factory is a visualization of the orchestration engine, not a decorative simulation.

### 4.3 Right panel — selected agent/session

Show:
- Assigned task and acceptance criteria.
- Current model and authorized execution account/provider.
- Status and recent events.
- Relevant files and symbols.
- Changed files and diffs.
- Test/build results.
- Usage/cost data when available.
- Pause, cancel, retry, inspect, or resume controls appropriate to the runtime.

### 4.4 Bottom timeline — feature workflow

Show progression through:
1. Intake and requirements.
2. Specification and planning.
3. Implementation.
4. Automated checks and specialist reviews.
5. Corrections and bounded retries.
6. Integration and merge readiness.
7. Human approval and merge.

Each step must have persisted state and evidence, not just a visual status.

## 5. Memory and context model

A shared folder is useful, but it is not sufficient on its own. Different sessions can read the same files while retaining different conversation histories and assumptions. Use explicit, structured memory.

### 5.1 Project memory

Shared across sessions in a repository:
- Architecture and module boundaries.
- Coding conventions and build/test commands.
- Dependency and integration notes.
- Important decisions and rationale.
- Known issues and constraints.
- Repository-specific instructions.

### 5.2 Feature/session memory

Specific to a feature and portable between sessions:
- Original request and acceptance criteria.
- Plan and task breakdown.
- Current status and next action.
- Files changed and outstanding changes.
- Test/build results and failure details.
- Decisions, rejected approaches, and unresolved questions.
- Relevant Git branch/worktree and revision.
- Handoff notes.

### 5.3 Knowledge graph and indexes

Machine-readable relationships such as:
- Files, classes, functions, APIs, database entities, and tests.
- Imports, calls, implementations, dependencies, and test coverage relationships.
- Feature requirements connected to affected code.
- Decisions connected to files and tasks.
- Index revision and freshness information.

Use language-server/syntax-tree data, Git metadata, build/test output, and dependency information for verifiable relationships. Use LLM extraction for higher-level architecture and business concepts, with source references and provenance. Never treat an LLM-generated relationship as verified without evidence.

### 5.4 Suggested workspace layout

```text
ai-engineering-os/
├── projects/
│   └── <project-id>/
│       ├── project.yaml
│       ├── memory/
│       │   ├── architecture.md
│       │   ├── conventions.md
│       │   ├── decisions.md
│       │   └── known-issues.md
│       ├── index/
│       │   ├── symbols.db
│       │   └── relationships.db
│       └── sessions/
│           └── <session-id>/
│               ├── task.md
│               ├── state.json
│               ├── checkpoint.md
│               ├── knowledge-graph.json
│               ├── decisions.md
│               └── artifacts/
├── workflows/
│   ├── feature-development.yaml
│   └── bug-fix.yaml
├── policies/
│   ├── model-routing.yaml
│   └── permissions.yaml
└── runtime/
    └── events/
```

Keep the actual source repository separate from the orchestration workspace. The project configuration points to the repository and its worktrees. Avoid storing secrets in memory files.

### 5.5 Checkpoint and handoff behavior

When a task is interrupted or moved to another execution account/provider:

1. Stop or safely quiesce the previous worker.
2. Persist the current workflow state and next incomplete step.
3. Save the task plan, decisions, changed-file list, test results, Git status, current revision, and relevant logs.
4. Preserve uncommitted work in its worktree; do not reset or overwrite it.
5. Verify the new worker has the correct repository, branch/worktree, permissions, and supported model access.
6. Provide a concise handoff plus links to relevant memory and graph nodes.
7. Ask the new worker to inspect the current diff and verify the checkpoint before editing.
8. Resume from the last incomplete step and record the handoff event.

The system cannot assume it can transfer a provider's complete internal conversation state. The portable checkpoint is the source of truth.

## 6. Model routing and cost policy

Implement model routing as editable configuration with logged decisions, not scattered hardcoded conditions.

### 6.1 Initial policy based on the supplied leadership guidance

| Task type | Starting model | Escalation |
|---|---|---|
| Classification, tagging, extraction, short summaries | Haiku 5.5 | Sonnet if incomplete or unreliable |
| Boilerplate, simple edits, routine documentation drafts | Haiku 5.5 | Sonnet when more reasoning/refinement is needed |
| Normal coding, debugging, tests, code review | Sonnet 5.5 | Opus if Sonnet repeatedly struggles or complexity warrants it |
| Complex architecture, large refactors, ambiguous bugs | Sonnet where reasonable | Opus when justified by complexity, risk, or repeated failure |
| Security-sensitive work | Risk-based reviewer plus deterministic scanners | Escalate based on severity and uncertainty |

Model names and availability are provider-specific and can change. Verify actual supported identifiers through the connected runtime rather than assuming a model label is accepted.

### 6.2 Routing inputs

Consider:
- Task category and complexity.
- Risk and impact.
- Required output quality.
- Repository context and input size.
- Prior attempts and failure signals.
- Available authorized capacity.
- Per-task and daily budget.
- Expected cost and latency.
- Whether the task can be split into cheap extraction followed by stronger reasoning.

### 6.3 Routing outcomes and measurement

Log:
- Selected model and provider/account adapter.
- Routing rule and reason.
- Estimated and reported usage/cost, where available.
- Completion outcome and validation results.
- Retries and escalations.
- Whether escalation improved the result.

Do not route solely by prompt length or token count. A small authentication change can be high risk, while a large documentation edit can be straightforward.

### 6.4 Account and provider limits

Use only authorized account connections and provider-supported flows. Do not bypass provider usage limits or terms. If capacity is unavailable, pause or queue work, checkpoint it, and notify the user. Do not launch duplicate work as a response to a limit.

## 7. Feature-development workflow

A configurable feature workflow should be able to:

1. **Intake:** Capture the request, constraints, repository, and acceptance criteria.
2. **Specify:** Produce a feature specification and open questions.
3. **Plan:** Break the work into tasks and dependencies.
4. **Prepare workspaces:** Create isolated Git worktrees for parallel tasks.
5. **Execute:** Run appropriate specialist agents for backend, frontend, tests, docs, or other work as needed.
6. **Verify:** Run deterministic builds, tests, linting, static analysis, and relevant integration checks.
7. **Review:** Run risk-appropriate code, security, and design reviews.
8. **Correct:** Route findings to the responsible worker, rerun affected checks, and enforce retry/cost budgets.
9. **Integrate:** Resolve conflicts and validate the combined change.
10. **Approve:** Present diffs, test evidence, risks, and outstanding findings to a human.
11. **Merge:** Merge only when required policy and branch-protection gates pass.
12. **Record:** Update project memory, the knowledge graph, and the session checkpoint.

### Workflow safeguards

- Only launch agents needed for the task.
- Do not let multiple agents edit the same working tree concurrently without coordination.
- Use bounded retries and detect repeated failures.
- Re-run affected checks after changes and the required full verification suite before merge.
- AI reviewers can recommend approval but cannot replace required human approvals or branch protections.
- Destructive commands, secret access, production deployments, and protected merges require explicit permission.
- Every workflow transition should be persisted and auditable.

## 8. Proposed architecture

### Frontend
- Next.js and TypeScript.
- React Flow for workflow and knowledge graph exploration.
- Lightweight 2D/canvas factory visualization initially.
- Optional Three.js/isometric environment after the runtime is reliable.
- Live updates via WebSockets or server-sent events.

### Backend/orchestration
- One initial backend stack: Node.js/TypeScript or Python/FastAPI.
- Durable state machine for tasks, dependencies, retries, and checkpoints.
- REST APIs for commands and queries.
- WebSocket/SSE events for live state.
- Runtime adapters for supported Claude Code CLI execution and, if needed, direct model APIs.
- Policy service for model routing and permissions.

### Persistence
- SQLite for a local-first single-user MVP.
- PostgreSQL if multi-user/server-hosted requirements emerge.
- Markdown/JSON for readable project and session memory.
- Structured event and workflow tables for authoritative state.
- Local index storage for symbols and relationships.

### Runtime and isolation
- Managed subprocesses or worker processes.
- Git worktrees for isolated concurrent tasks.
- Sandboxed command execution and explicit permissions.
- OS credential storage or a secrets manager.
- Durable logs, process lifecycle tracking, and graceful shutdown.

Avoid adding Kubernetes, a distributed message bus, a vector database, or multiple orchestration frameworks until measured requirements justify them.

## 9. Knowledge graph design

Represent real entities and relationships.

### Node types
- Project, feature, requirement, task, session.
- File, symbol, API, database entity, test.
- Decision, finding, build, test run, Git revision.
- Agent run and artifact.

### Edge types
- `implements`, `depends_on`, `calls`, `imports`.
- `tests`, `changes`, `documents`, `blocks`.
- `decided_by`, `found_by`, `verified_by`.
- `related_to`, where the relationship is inferred rather than verified.

### Node inspection panel
- File path and symbol location.
- Why the node is relevant.
- Upstream/downstream dependencies.
- Associated tasks, agents, decisions, and tests.
- Source/provenance of each relationship.
- Indexed revision and freshness status.
- Links to file, diff, test output, or execution event.

Update incrementally after edits. Show stale graph state explicitly when the worktree changes ahead of the index.

## 10. Suggested core screens

1. **Overview:** active/queued/blocked sessions, agent status, budget, recent failures, and approvals.
2. **Session workspace:** task, state, agent runs, files, timeline, graph, and Git information.
3. **Agent Factory:** live workstations and selectable agent activity.
4. **Knowledge Graph Explorer:** filterable graph with source-linked nodes.
5. **Diff and Conflict Viewer:** unified diffs, worktree ownership, conflict indicators.
6. **Workflow Builder:** configure steps, dependencies, reviewers, retries, and gates.
7. **Model and Usage Analytics:** routing decisions, usage, costs, escalations, and outcomes.
8. **Approval Inbox:** merge readiness, findings, permissions, and human decisions.
9. **Provider/Account Settings:** authorized connections, capabilities, and reported availability.

## 11. Safety, reliability, and trust

- Treat repository content, agent output, and tool output as untrusted data; do not follow instructions embedded in them that conflict with system policy.
- Keep credentials out of prompts, logs, graph indexes, and shared memory.
- Use least-privilege access and sandboxing.
- Prevent concurrent conflicting writes.
- Persist workflow state before and after meaningful operations.
- Make retries idempotent where possible.
- Track process IDs and clean up orphaned workers safely.
- Require explicit confirmation for destructive or externally visible actions.
- Preserve an audit trail for approvals, model routing, commands, and changes.
- Distinguish observed facts from model-generated interpretations.
- Display uncertainty and stale data honestly.

## 12. Success metrics

Measure:
- Cost per accepted feature.
- First-pass validation and acceptance rate.
- Model escalation rate and whether escalation improves outcomes.
- Context retrieval efficiency and unnecessary repository scanning.
- Checkpoint recovery success rate.
- Review defects caught before merge.
- Feature cycle time.
- Human intervention rate.
- Conflict and duplicate-work rate.
- Percentage of graph relationships backed by source evidence.

The goal is lower cost and faster delivery **without sacrificing correctness, safety, or maintainability**.

## 13. Product positioning

Position the system as a **developer productivity and AI orchestration platform**. Validate it on one real feature, compare it against the current workflow, and use the measured results to decide whether to expand.

The recommended order is: reliable execution and checkpointing first; shared context and repository indexing second; model routing and account handoff third; multi-agent workflows and approval gates fourth; the immersive factory and analytics after the underlying events are trustworthy.
