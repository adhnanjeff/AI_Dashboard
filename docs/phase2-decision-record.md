# Phase 2 Decision Record: agent runtime and process supervision

Date: 2026-11-09 · Branch: `feature/phase-2-runtime` (from `main` @ d248c59) · Tests: `npm test` (28 passing: 12 Phase 1 + 16 Phase 2)

Goal (roadmap §6): one task can be launched from a backend API, and its actual status and output can be inspected. A process can finish, fail or be cancelled, and the resulting status is correctly persisted and queryable.

## Decisions and why

| # | Decision | Why |
|---|---|---|
| 1 | **A provider-neutral adapter interface** (`LaunchSpec`, `NormalizedEvent`, `AdapterProcess`) | Roadmap principle 4: the scheduler must not depend on one CLI's event format. The supervisor only sees `init / assistant / tool_result / result / other`. A second provider later means one new adapter file. |
| 2 | **Spawn `claude` directly, never through a shell** | Phase 0 found that `shell: true` splits the prompt on spaces. The prompt is now one argv element. This also makes the PID we store the real process. |
| 3 | **We choose the CLI session id** (`--session-id <uuid>`) and save it before work starts | Phase 0 showed this works. It means resume (Phase 3) has the id even if we crash seconds later. |
| 4 | **Success is decided from evidence, not from the process starting or a final-sounding message** | Roadmap §6 says never infer success. A run is `completed` only if exit code is 0 **and** the CLI emitted a `result` event with `is_error:false`. "Exit 0 with no result" and "exit 0 with an error result" are both `failed`. Both have tests. |
| 5 | **Every failure has a recorded reason** (`exit code N`, `timeout after Xms`, `spawn error`, `orphaned…`, `cancelled by user`) | Termination reason is a required field in the roadmap. Without it a `failed` status is not actionable. |
| 6 | **Cancel kills the whole process tree** (`taskkill /T /F` on Windows, process group on POSIX) | Phase 0 noted this. The CLI starts tool subprocesses, and killing only the parent would leave them running. The test uses a fixture that spawns a grandchild and checks the grandchild is dead. |
| 7 | **Cancel leaves the task and session `paused`, not `cancelled`** | `cancelled` is terminal in the Phase 1 state machine. Pausing keeps the work resumable, which Phase 3 needs. Only the run itself ends `cancelled`. |
| 8 | **Failed runs set task and session to `failed`; `failed -> queued -> running` is allowed for a retry** | Reuses the Phase 1 rule that retry is explicit and recorded as events. A completed task cannot be restarted. |
| 9 | **One active run per session** (`SessionBusyError`, HTTP 409) | MVP is "one feature session at a time" and there is no worktree ownership yet (Phase 6). Refusing is safer than two agents editing the same folder. |
| 10 | **Timeouts on every run** (default 10 min, API range 1s to 1h) | Roadmap: handle timeouts. A hung worker would otherwise block its session forever. |
| 11 | **Only meaningful events become database events; the full output goes to a log artifact** | Hook output, token counters and rate-limit notices would drown the timeline. Nothing is lost: the whole stream is in the log artifact. |
| 12 | **Redaction via the Phase 1 `Store`** for events and the log | Agent output is untrusted. Test: a fake key and a `password=` value in output never reach events or the log. |
| 13 | **Log size capped at 5 MB**, with a `[log truncated]` marker | Prevents one chatty run from filling the database. |
| 14 | **Orphan recovery at startup marks leftover `running` runs as `failed`**, and does **not** kill a process that is still alive | After a crash we cannot know what happened, so success is never assumed. Killing by saved pid is unsafe because Windows can reuse pids. It is reported (`still alive: true`) for a human or a later phase to handle. |
| 15 | **Port binding is the single-instance lock; recovery runs only after bind succeeds** | Found during real testing (see below). Two supervisors on one database would mark each other's live runs as orphaned. |
| 16 | **Graceful shutdown cancels all workers, then closes the database** | No worker should outlive its supervisor on a normal exit, and an open handle keeps SQLite files locked on Windows. |
| 17 | **HTTP API: bound to 127.0.0.1, callers cannot choose the working directory**, model name validated, 1 MB body limit | Least privilege (roadmap principle 7). A run always executes inside the project's own repository. Real authentication is out of scope for a local single-user MVP. |
| 18 | **`node:http` with a thin route layer** | No framework needed for 9 routes. All logic lives in `Store` and `Supervisor`, so a framework can replace it later. |
| 19 | **A fake `claude` fixture for tests** | Real runs cost money, are slow, and cannot be forced to fail, hang or print secrets. The fixture can. The real CLI was tested separately (below). |

## Verified against the real Claude CLI
- **Real task via API:** added `subtract()` to `math.js`. Run `completed`, exit 0, 21 events, correct diff, cost recorded in the `agent.result` event.
- **Real cancel:** status `cancelled`, task and session `paused`, worker pid confirmed gone.
- **Real crash recovery:** server killed hard mid-run, restarted: run marked `failed` with reason `orphaned…`, session and task `failed`.
- **Second instance:** refuses to start on the same port and leaves the live run untouched.

## Findings during build
- **Bug found by real testing:** my first crash test killed the wrong process, so two servers ran on one database. The second one ran orphan recovery and marked the first one's live runs failed. Fixed by decision 15 (recovery only after the port is bound).
- Windows process lookup by port can return several pids. Kill scripts must handle a list.
- On the clean crash test the worker died together with the server. In the earlier accidental run it survived and was reported as alive. Both cases are handled, but which one happens may depend on how the server is killed.

## What is deliberately not done
- **No checkpoints are written by the supervisor yet.** Run state is persisted, but resume from a checkpoint is Phase 3.
- **No resume endpoint.** The adapter supports `resumeId`, but nothing exposes it.
- **No live streaming endpoint** (SSE/WebSocket). Events are polled over HTTP. Live push is Phase 4.
- **No authentication on the API** beyond binding to localhost.
- **Orphaned live workers are reported, not killed.**
- **Permission mode is fixed** (`acceptEdits`, tools `Read,Edit,Write`). Per-role permission profiles are Phase 12.
- **No retries or scheduling.** A failed run needs a manual new start.

## Exit criteria: met
"A process can finish, fail, or be cancelled and the resulting status is correctly persisted and queryable": covered by the success/failure/cancel/timeout tests, the restart test (`EXIT CRITERIA: finished runs are persisted…`) and the real runs above.

## Next: Phase 3
Durable checkpoint and recovery: save checkpoints at boundaries, resume from a checkpoint with a verified worktree, prevent two owners of one worktree, and test crashes at different points.
