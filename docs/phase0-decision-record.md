# Phase 0 Decision Record

Date: 2026-11-09 · Env: Windows 11, Node 24.18, Git 2.54, Claude Code 2.1.316 · Spike: `spike/spike.ts`

## Decisions
- **Backend stack:** Node.js/TypeScript. Node 24 runs `.ts` directly (no build step needed for the spike).
- **Provider adapter v1:** spawn `claude.exe` as a child process in print mode:
  `claude -p <prompt> --output-format stream-json --verbose --model <id> --permission-mode acceptEdits --allowedTools ...`
- **Source of truth:** our own DB + checkpoint. The CLI's session is a convenience, not the record.

## Findings (all observed, not assumed)
| Assumption | Result |
|---|---|
| Launch headless task in a given cwd | Works. Exit 0, file edits land in cwd. |
| Structured event capture | Works. NDJSON on stdout: `system/init` (has `session_id`, `model`), `assistant`, `user` (tool results), `result` (has `total_cost_usd`, `is_error`). Also noisy `hook_*`, `thinking_tokens`, `rate_limit_event` types to filter. |
| We choose the session ID | Yes, `--session-id <uuid>`. Known before launch, so it can be persisted first. |
| Native resume | Works. `--resume <id>` recalled the earlier file and content. |
| Portable resume (fresh session from checkpoint + git status/diff) | Works. The new session finished only the remaining step. |
| Cancel without orphans | `taskkill /PID <pid> /T /F` stopped the run (exit 1, `cancelled`). Orphan check printed 0, but the check is crude (see Open items). |
| Worktree create / survive crash | Works. Plain `git worktree remove` refuses when uncommitted files exist; the file survived. `--force` is needed to discard, so the app must never use it automatically. |
| Cost data | Reported by the CLI per run in the `result` event. |

## Gotchas
- **Do not spawn with `shell: true`.** The prompt is split on spaces and the model received one word. `claude` is a native `.exe`, so spawn it directly and pass the prompt as an argument.
- The user's global hooks and plugins also run inside `claude -p` (`hook_*` events). Consider `--bare` or a settings override for worker runs.
- A cancelled run emits no `result` event, so the app must write the terminal state itself from the exit code and its own cancel flag.

## State ownership
- **CLI exposes:** session id, model, per-run cost, tool events, exit code.
- **App must track:** task and checkpoint state, worktree ownership, cancel intent, logs, retries, approvals.

## Open items
1. Replace the orphan check with a PID-tree snapshot before and after cancel (the PowerShell check can match itself).
2. Cross-account resume is untested; rely on portable checkpoints.
3. Test app-crash recovery (kill the supervisor, not just the child).
4. Decide the permission model for real tasks (`acceptEdits` plus allowlist was enough for the spike).

## Next: Phase 1
SQLite contracts for Project, Session, AgentRun, Event and Checkpoint, with a state-transition validator.
