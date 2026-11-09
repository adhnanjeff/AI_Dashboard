# Phase 3 Decision Record: durable checkpoints, resume and recovery

Date: 2026-11-09 · Branch: `feature/phase-3-checkpoints` (from `main` @ 19cffd1, which includes merged Phase 2) · Tests: `npm test` (52 passing: 28 earlier + 24 new)

Goal (roadmap §7): a session can be interrupted and resumed from persisted state without replaying its conversation, with no silent loss of uncommitted changes, including after a worker failure or an application restart.

## Decisions and why

| # | Decision | Why |
|---|---|---|
| 1 | **Portable resume is the default**: a brand-new provider session seeded from the checkpoint. Native `--resume <id>` is an opt-in `mode`. | Concept doc §5.5 and Phase 0: a provider's hidden conversation cannot be assumed transferable across accounts or providers. The checkpoint plus the real repository is the source of truth. Native mode stays available for same-account convenience. |
| 2 | **A checkpoint stores facts the worker cannot rediscover**: request and acceptance criteria, plan (the session's tasks), why it stopped, next action, last thing the agent said, changed files, event position, branch and revision, and a fingerprint of the repository state. | This is the roadmap's checkpoint list. Fields with no producer yet (`notes`, `checks`) exist as empty placeholders so the shape does not change later. |
| 3 | **Checkpoints are taken at four boundaries**: before launch, after successful tool calls (throttled, default 5 s), at every run end (completed, failed, cancelled), and during orphan recovery. | "Persist state before launching work and after meaningful results." Before-launch means a crash right after spawn is still resumable. Mid-run means a hard crash loses at most a few seconds of context. Throttling stops git being run on every tool call. |
| 4 | **Checkpoint code can only read git** (`status, diff, rev-parse, ls-files, log` allow-list; anything else throws). | The roadmap says never reset, clean or overwrite uncommitted files. Making that a property of the code, with a test over `reset/clean/checkout/commit/stash/rm/restore`, is stronger than a convention. |
| 5 | **`GIT_OPTIONAL_LOCKS=0` on every git call** | `git status` normally refreshes the index and takes `index.lock`. That could collide with the agent's own git commands. |
| 6 | **A fingerprint (hash of revision, branch, status, diff and untracked-file contents) detects drift** | Comparing only file names would miss an edit to an already-changed file. Including untracked content matters because new files are exactly what an agent creates. |
| 7 | **Verification has three outcomes: unchanged, changed, blocked.** Blocked only for: directory missing, no longer a git repo, or a different branch. Everything else (human edits, new commits) is `changed`: resume proceeds and the worker is told. | Blocking on every difference would make resume useless, because a human often touches the repo while an agent is paused. A switched branch is different: continuing blindly could put work on the wrong branch. |
| 8 | **The resume prompt omits the diff** and instructs: inspect the real state first, never delete/reset/revert, do only the remaining work. | The live repository is more accurate than a stored diff, and a prompt would otherwise carry code (and possible secrets) into a model. The diff is still stored (redacted) as an artifact for humans. |
| 9 | **Resume only from `paused` or `failed`, and only for a `paused`/`failed` task**; the rest returns a clear error and starts nothing. | Reuses the Phase 1 state machine. A refused resume changes no state and creates no run (tested). |
| 10 | **Worktree lock: one writer per directory, enforced in the database** (`worktree_lock`, `PRIMARY KEY(path)`), checked before any state change. Paths are normalised (case, trailing separator on Windows). | Phase 2 only blocked two runs in the same session. Roadmap Phase 3 requires that two workers cannot own one writable worktree, across sessions too. The primary key makes acquisition atomic. |
| 11 | **Locks are released in `settle()`**, the single place every run outcome flows through, and stale locks are reclaimed at startup or when seen. | Releasing in one place means no path (cancel, timeout, launch error, orphan) can forget. Reclaiming means a crash cannot lock a directory forever. |
| 12 | **Idempotency keys** (`Idempotency-Key` header, unique index on `agent_run`) for start and resume. Same key + same task returns the original run; same key + different task is a 409. | A client that retries after a timeout must not start a second worker. Tested including after the original run has finished, and for resume. |
| 13 | **Pause is a first-class action** (`POST /sessions/:id/pause`) built on cancel, with reason `paused by user`. | Phase 2 already left cancelled sessions `paused`. A named endpoint makes the intent explicit and gives a checkpoint "paused by user" as the reason. |
| 14 | **A checkpoint failure never fails a run**; it is recorded as a `checkpoint.failed` event. | Durability features must not make the thing they protect less reliable. Tested with a checkpoint service that always throws. |
| 15 | **Orphan recovery also saves a checkpoint of the repository as it is now** and frees the lock. | After a crash the last mid-run checkpoint may be seconds old. Re-snapshotting at recovery means the resume prompt reflects the real post-crash state. |
| 16 | **Run `main.ts` as a separate process for the crash test** (new env knobs `CLAUDE_BIN`, `ORCH_CLAUDE_ARGS`, `ORCH_CHECKPOINT_INTERVAL_MS`). | A real crash needs a real process to kill. Faking one in-process cannot prove the database state survives. The knobs are also genuinely useful (custom Claude path, tuning). |
| 17 | **Migration 2 is additive** (`ALTER TABLE ... ADD COLUMN`, new table). Migration 1 is untouched. | Matches the Phase 1 rule: applied migrations are never edited. |
| 18 | **New API surface is small and read-mostly**: `GET /sessions/:id/checkpoint`, `GET /sessions/:id/resume-check` (dry run), `POST …/checkpoint`, `POST …/pause`, `POST …/resume`, `GET /worktree-locks`. | `resume-check` lets a human see drift before committing to a resume. When checkpoints are not configured the API answers 501 instead of failing. |

## Verified against the real Claude CLI
- **Crash:** real task writing 6 files; server killed hard after `part1.txt` appeared. Restart recovered the run as `failed (orphaned…)`, freed the lock, and the checkpoint listed `part1.txt, part2.txt`. Resume completed: `part3` to `part6` created, `part1`/`part2` hashes unchanged (the worker did not rewrite them).
- **Pause:** real task paused after `part2.txt`; resumed; all 6 files exist, `part1` hash unchanged.

## Findings during build
- **Bug found by the tests:** `CheckpointService` called a helper (`latestRunId`) I had not written. It was invisible in supervisor-driven checkpoints (they always pass a run id) and only failed on manual checkpoints. Fixed with a store query.
- Phase 1's migration test hard-coded "1 migration" and had to assert `MIGRATIONS.length` instead.
- On Windows the worker died with the server in both real crash runs, so the "worker survives the crash" path is covered only by the Phase 2 accident and unit tests, not by a deliberate real run.

## What is deliberately not done
- **No git worktree creation.** The lock protects any directory, but creating and removing real `git worktree`s is Phase 6.
- **No plan or step tracking inside a task.** "Completed/incomplete steps" is the session's task list. Finer steps need the Phase 9 workflow engine.
- **`notes` and `checks` are empty.** Decisions, rejected approaches and build/test results need producers (Phases 5 and 9).
- **No automatic resume.** A human or caller decides. Auto-resume needs retry and budget policy (Phase 7).
- **Orphaned live workers are still only reported, not killed.**
- **Untracked files are fingerprinted, not stored.** If someone deletes an untracked file, resume warns that it changed but cannot restore it.
- **No lock heartbeat.** A lock whose run is `running` but whose supervisor died is only freed by `recoverOrphans`, so a second instance must start first.

## Exit criteria: met
"Automated tests demonstrate recovery after worker failure and application restart, with no silent loss of uncommitted changes": `EXIT CRITERIA: server process is hard-killed mid-run…` kills a real server process, restarts it on the same database, resumes through the API, and asserts the uncommitted file is byte-identical, the run is not duplicated on retry, and the event log has no gaps. Confirmed again with the real CLI above.

## Next: Phase 4
A basic dashboard (Next.js): session list, session detail with live event timeline (SSE), logs, changed files and diff viewer, and start / pause / resume buttons driven by the API built in Phases 2 and 3.
