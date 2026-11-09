# Phase 1 Decision Record: contracts, data model, storage

Date: 2026-11-09 · Env: Node 24.18 (built-in `node:sqlite`, SQLite 3.53) · Tests: `npm test` (12 passing)

Goal (roadmap §5): a session can be created, queried, updated and reloaded after an application restart without losing authoritative state.

## Decisions and why

| # | Decision | Why |
|---|---|---|
| 1 | **Built-in `node:sqlite`** instead of `better-sqlite3` | Zero dependencies and no native compile step on Windows. It is a synchronous API, which is simple and right for a single-user local MVP. Trade-off: it is marked experimental in Node 24, so the `Store` class is the only place that touches it and can be swapped. |
| 2 | **Run `.ts` directly with Node** (no build step) | Phase 0 already showed this works. Consequence: only type-annotation syntax is allowed. Constructor parameter properties (`constructor(private x)`) are rejected, so classes use explicit fields. |
| 3 | **One `Store` class is the only writer** | The roadmap requires a state machine and audit trail that cannot be bypassed. If every write goes through `Store`, every status change is validated and logged. Later phases (API, runtime) call `Store` and never SQL. |
| 4 | **One shared state table** for Session, Task and AgentRun (`queued, running, paused, blocked, failed, completed, cancelled`) | The roadmap defines one vocabulary. `completed` and `cancelled` are terminal. `failed -> queued` is the only way back, so a retry is explicit and recorded. `blocked` may go to `failed`, so a stuck run can be given up on. Approvals have their own small machine: `pending -> approved/rejected`. |
| 5 | **Validate in code and again in SQL** (`CHECK` on status, foreign keys on) | Code gives clear errors (`InvalidTransitionError`). The database constraints catch bugs or manual edits that skip the code. |
| 6 | **Status change and its event are written in one transaction** | A crash cannot leave a status changed with no audit record, or the reverse. |
| 7 | **Events are append-only, enforced by SQL triggers** with a per-session `seq` and `UNIQUE(session_id, seq)` | Roadmap §7 needs sequence numbers to tell old events from current ones. Triggers make tampering fail even from raw SQL. `BEGIN IMMEDIATE` transactions serialize writers so two writers cannot take the same `seq`. |
| 8 | **Database is authoritative; files are projections** | Authoritative: all status, events, checkpoints, approvals, routing. Human-readable files (memory markdown, `state.json`, `checkpoint.md`) will be generated from the database in Phase 5, never read back as truth. This avoids two sources that can disagree. |
| 9 | **Redaction at the write boundary** (events, artifacts, checkpoints, task text) | Roadmap §5 asks for redaction rules. Doing it inside `Store` means no caller can forget. It is pattern-based (API keys, GitHub tokens, AWS keys, bearer tokens, private keys, `password=`-style pairs), so it is a safety net, not a guarantee. |
| 10 | **Type-prefixed UUID ids** (`ses_…`, `run_…`) | Stable and collision-free. A session id cannot be mistaken for a run id in logs or URLs. |
| 11 | **Flexible fields stored as JSON text** (`settings`, `acceptance_criteria`, `git_state`, `data`) | The shape of these will keep changing. Everything we filter or join on is a real column. |
| 12 | **Append-only migrations** in a `schema_migration` table, each in a transaction | Safe upgrades from day one. Migration 1 is never edited; changes become version 2, 3, … |
| 13 | **Checkpoints are versioned per session** and the session points at the latest | Matches roadmap Phase 3: resume reads the latest checkpoint, while older ones remain for audit. |
| 14 | **Approvals require a non-empty approver** | Roadmap §12: protected actions need an identity on the record. Full policy enforcement comes in Phase 12. |
| 15 | **Knowledge graph is schema only** (nodes and edges with `provenance` and `verified`) | The concept doc says LLM-inferred links must never look verified. The flag exists now so it is never retrofitted. Indexing itself is Phase 10. |
| 16 | **Demo data is clearly named `demo`** and seeded only by an explicit command | Roadmap §8: seeded mock data must never be confused with real runtime data. |

## What is deliberately not done
- No cross-entity rules yet (e.g. a run cannot start while its session is `cancelled`). That belongs to the scheduler in Phase 3.
- No API, no UI, and no wiring of the Phase 0 CLI adapter into `Store` (Phase 2).
- No JSON schemas for external validation. TypeScript types are the contract for now. Add a validator when an API accepts outside input.
- Redaction is regex-based and will miss unknown secret formats.
- No connection pooling or multi-process writer test. SQLite WAL plus `BEGIN IMMEDIATE` is assumed enough for a single local backend.

## Findings during build
- Node's TypeScript stripping rejects constructor parameter properties (fixed).
- `node --test` on Node 24 needs a glob, not a directory path.
- On Windows a temp directory cannot be deleted while a SQLite handle is open (WAL files), so tests close handles first. The app must also close the database on shutdown.

## Exit criteria: met
`EXIT CRITERIA: session survives an application restart…` closes the database, reopens it in a fresh `Store`, and checks that session, tasks, events and checkpoint are identical and that the next event gets the correct `seq`.

## Next: Phase 2
A provider-adapter interface and a Claude Code adapter (from the Phase 0 spike) that drives `Store`: start, status, cancel, persisted exit status and logs.
