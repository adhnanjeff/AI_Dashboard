# Phase 6 decision record: git worktree management and isolation

Scope (roadmap §10): controlled create/remove, explicit worktree per writable worker, track branch/base/current/uncommitted, detect overlapping files and likely conflicts, protect user changes, diff inspection and cleanup previews, an integration strategy, task output outside source-controlled files. Exit: two isolated tasks work concurrently without writing into each other's worktrees, and integration conflicts are detected before merge.

Built on the same branch as Phase 5 (no merge in between) at the user's request, so both phases land in one commit.

## Decisions

### D1. One worktree per session, created before its first run
- A `worktree` table (migration 4) with a unique "one active worktree per session" index; rows are kept after removal as a record. `session.worktree_path` points to it.
- **Why before the first run:** checkpoints, resume and locks all record a working directory. Moving a session to a new directory mid-life would make older checkpoints point at the wrong place. Refusing it removes a whole class of bugs.
- **Tradeoff:** an existing session cannot be moved into a worktree; start a new session instead.

### D2. Worktrees live outside the repository
- Default root: `<repo>.worktrees` next to the repo (override with `ORCH_WORKTREE_ROOT` or API option). A root inside the repo is refused.
- **Why:** nothing in the worktree folder can then be picked up by the main repo's `git status`/`git add`. Task output and logs were already kept in the database, never in the repo (roadmap item satisfied by construction).
- Branch is `orch/<slug>-<id8>`, validated with `git check-ref-format`, created from the project's default branch commit (falls back to the current branch if the configured one does not exist). Base revision is recorded.

### D3. A session bound to a worktree can only run there
- `Supervisor.start` throws `WrongWorkdirError` if the working directory is not the session's worktree, whatever the caller passes. The API now derives the directory from the session (worktree if any, else the project repo).
- **Why:** "each writable worker has an explicit worktree" has to be an enforced invariant, not a convention. Tested: starting session A in the main repo or in B's worktree is refused and changes nothing.
- The Phase 2 per-directory lock now gives real concurrency: different worktrees have different lock keys, so sessions run in parallel; two sessions on the same folder still cannot.

### D4. A second, stricter git allow-list for the few commands that write
- `worktrees/git-admin.ts`: reads (`rev-parse`, `rev-list`, `merge-base`, `merge-tree`, `diff`, `status`, `ls-files`, `log`, `check-ref-format`, `show-ref`, `for-each-ref`) plus `worktree add|remove|list|prune`. Everything else (reset, clean, checkout, stash, rebase, merge, push, `branch -D`) is not runnable, and `--force`, `-f`, `-D`, `--hard` are refused for every command.
- **Why:** same reasoning as Phase 3: "never reset, clean or overwrite" becomes a property of the code. Checkpoint code keeps its own read-only list.

### D5. Conflict detection with `git merge-tree --write-tree`
- It computes the merge in memory (only unreachable objects are written): no branch, index or file changes. Used for branch vs target, and branch vs branch. Tests assert no ref moved and no file changed after checks.
- **Limit (stated in the UI and API):** only **committed** work is compared; uncommitted files are listed as "not included". Needs git ≥ 2.38.
- Overlap detection (same files touched, committed or not) complements it: it warns earlier than a conflict exists.

### D6. The orchestrator never merges
- `integrationPlan` returns an order (clean branches first, then fewest pairwise conflicts), the conflicts, and suggested commands: merge session branches one at a time into a throw-away integration branch in its own worktree, run checks, then you fast-forward the default branch.
- **Why not execute it:** a merge can leave a repo mid-conflict, which is exactly the "someone's work is at risk" state this phase exists to avoid. Detecting conflicts before merge is the exit criterion; resolving them is a human decision. A guided or automated merge can come later with approvals (Phase 8).

### D7. Removal is conservative and has no force
- `removalPreview` lists blockers (a run is active; uncommitted/untracked files that would be lost). `remove` refuses while any blocker exists, then runs plain `git worktree remove` (which itself refuses a dirty tree: two independent checks).
- Only the **directory** is removed. The branch is kept, so its commits stay recoverable. A folder deleted by hand is handled by `prune` and marking the record removed.
- UI needs two clicks on the destructive button, and only offers it when the preview says it is safe.

### D8. Dashboard
- Session page: Isolated worktree panel (create, status, merge check, removal preview). New-session form: optional "work in an isolated worktree" (off by default, because it creates a folder next to the repo). `/projects/[id]/worktrees`: all worktrees, overlap warnings, integration plan and commands.

## Findings
- Removing worktrees leaves their `orch/*` branches. That is intended (recoverability) but means branches accumulate; there is no branch cleanup tool yet.
- The sandbox repo triggers git's CRLF warning on Windows when committing from a worktree. It is cosmetic and unrelated to the service.
- Tests need care on Windows: temp paths can be 8.3 short names, so path comparisons use `realpath`.

## Verified
- 103 tests pass (10 new in `tests/unit/phase6.test.ts`), dashboard typecheck clean.
- EXIT 1 test: two sessions run at the same time, each only writes inside its own worktree, nothing appears in the main checkout, locks differ, checkpoints name the right directory, cross-directory starts are refused.
- EXIT 2 test: conflicting edits in two branches are reported (overlap, pairwise conflict, and, after one lands on main, a predicted conflict for the other) with no ref or file changed by the checks.
- In a real browser: two worktrees, the overlap warning, pair-conflict banner, integration plan, per-session merge check, a removal preview blocked by an uncommitted file, then real removal through the API.

## Not done / limits
- No automatic merge, cherry-pick or rebase, and no "update from base" action for a branch that is behind.
- Conflicts are only predicted for committed work; no semantic (build/test) conflict detection.
- Worktrees cannot be attached to a session that already ran; no branch deletion; no disk-space/cap management.
- A real agent run inside a worktree was exercised through the fake worker and API, not through a billed Claude run.
- The dashboard has no full per-worktree diff against base (the existing Changes panel shows the diff against HEAD).
- Worktrees are not yet tied to approvals or budgets (Phases 7–8).

## Next: Phase 7 (model routing, usage tracking and budgets)
