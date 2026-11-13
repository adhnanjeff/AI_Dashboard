# Phase 8 decision record: authorised provider accounts and handoff

Scope (roadmap §12): a provider/account adapter contract; credentials through OS storage or a secrets manager; expose only supported capabilities and model ids; track reported availability, errors and rate limits; checkpoint before handing off; make sure the old worker has stopped before the next writes; verify repo/worktree/branch/diff before resuming; resume from portable state; queue when there is no authorised capacity; never retry repeatedly against a rate-limited provider; audit account changes and handoffs. Exit: handoff tests show work and uncommitted changes intact, and provider limits are respected.

The roadmap's framing is followed literally: account switching is a **recoverable execution handoff, not a way to evade usage limits**.

## Decisions

### D1. Adapters declare what they can do
- `ProviderAdapter` gained optional `capabilities` (`models`, `canEditFiles`, `supportsNativeResume`, and the names of the environment variables for a credential and a login profile). `ProviderRegistry` holds the adapters; the supervisor picks one by name.
- The scheduler only offers a model to adapters that list it, and a handoff target must be able to edit files. An adapter that declares nothing (test doubles) is treated as accepting any model.
- Extra adapters can be registered with `ORCH_EXTRA_ADAPTERS`. They must speak the same stream-json protocol as the Claude CLI; a different protocol needs its own adapter class. **Only the Claude CLI adapter exists today**, so "another supported adapter" means a second registration of it (another login profile or build) until a different provider is written.

### D2. Accounts are references, never secrets
- Migration 6 `provider_account` stores a label, priority, an optional **login-profile folder** (must be an existing absolute directory) and an optional **credential reference**: the *name* of an environment variable. A value that is not shaped like a variable name (for example a pasted key) is refused with a message saying so.
- The value is read from the orchestrator's environment at launch and handed to that one child process. A test dumps every table after a run and asserts the secret is not in the database.
- **Not built: OS keychain integration.** The environment variable is the hand-off point for whatever secrets manager the user already uses. Windows Credential Manager, macOS Keychain and libsecret are different APIs and need a native dependency or shelling out; adding that would be the next step, behind the same `credentialRef` idea.
- For the CLI's own sign-in, no credential is stored at all: the "default login" is whatever the user has already signed in to.

### D3. What a provider reports about itself is tracked, and nothing is probed
- Migration 6 `provider_health`. The adapter recognises a rate limit in the event stream (`rate_limit_event` that is not `allowed*`), in a failed result's text ("usage limit", "429", "overloaded"…), or on stderr, and normalises it to one event. The supervisor then fails the run with `provider rate limited (resets …)` and records it.
- A reported reset time is used as given; otherwise a cool-down (default 15 minutes). A block is never shortened. A successful run clears it.
- **Provider errors** (the process cannot start, or the launch throws) back off exponentially (30 s, 60 s … capped at 10 min).
- Nothing pings a provider to check on it.

### D4. Rate limits stop work; they do not move it
- If no authorised account is available, the request is **queued** (`queue_item`), once. `drain()` (every 30 s, or from the dashboard) starts items only when capacity is really available. A queued item that can no longer be started is abandoned with the reason, and there is a hard cap on checks.
- **Accounts are not rotated around a limit.** While one account of a provider has a reported rate limit, its sibling accounts of that provider are also treated as unavailable. Accounts exist to keep separate things separate (for example work and personal); they must not become a way to keep hammering a provider that said stop. Tested: with accounts A and B, A limited, new work is queued, not sent to B, and goes back to A by priority when the block ends.
- Provider-level failures do not count as task attempts (Phase 7 D6), so a limit cannot cause an escalation to a more expensive model.

### D5. Handoff is an ordered, verified procedure
`providers/handoff-service.ts`, in this order:
1. **Validate the target before touching anything** (registered provider, supported model, can edit files, account enabled, not a no-op). A refused request leaves the running worker alone (tested).
2. **Refuse the same-provider hop off a limited account** ("would bypass that limit"), and record the refusal.
3. **Stop the old worker** with the existing pause (checkpoint saved) and wait until it has ended and released the directory lock; refuse if it has not.
4. **Checkpoint** what is on disk now (`reason: handoff`).
5. **Verify** with the Phase 3 drift check (blocked → refuse), and for an isolated session check the worktree is still registered and on its branch.
6. **Start the new worker** from the portable checkpoint through the scheduler. If the target has no capacity the move is **queued**; the old worker stays stopped and the work saved.
7. Record a `handoff` row, a `provider.handoff` session event and audit entries, including for refusals.
- **Portable only.** A provider's own conversation id is never carried to another provider or account (`native` resume across them is refused). The new worker is told what is on disk and starts fresh.
- **The exit criterion is tested end to end:** the first worker writes an uncommitted file and hangs; after handoff the file is byte-for-byte intact, git shows nothing reset or committed, the old run ended before the new run was created, the new worker received the file list and no `--resume` id, and the audit trail has the request and the start.

### D6. The audit log is append-only
- Migration 6 `audit_log`, with update and delete blocked by triggers. It records account added/enabled/disabled, policy published, rate limits and errors, handoff requested/started/queued/refused, and queue cancellations. Details pass through the redactor.

### D7. The dashboard separates "who can run" from "what to run"
- **Providers** page: adapters and capabilities, accounts with live availability and the reason for any wait, add/enable/disable, the queue with cancel and "check capacity now", and the audit trail.
- **Session page:** why each run used its model, work waiting for capacity, and a hand-off form with a two-click confirmation because it stops a running worker.
- The new-session and resume model pickers default to **Auto**, so the Phase 7 policy is what normally chooses.

## Known limits
- Only one real adapter. Handoff is exercised with two registered adapters of the same protocol, as in the tests; it has not been run between two different real providers.
- Rate-limit detection depends on the CLI's messages. The patterns are in one place (`claude-cli.ts`) and are covered by tests with the fake worker; they have not been exercised against a real limit.
- The queue timer runs inside the orchestrator process: if it is not running, queued work waits.
- A real billed run through the new launch path was not tried.

## How it was tested
`tests/unit/phase8.test.ts` (14 tests): account validation and the no-secrets-in-database check, audit immutability, rate limit → queue → no retry → recovery, limit text without a reset time, exponential back-off, no account rotation, queue cancel and abandon, the handoff exit criterion, refusals (limited source, invalid targets, no capacity → queued), native resume refused across providers, and the HTTP endpoints. The Phase 3 crash test now sends a model id that the real adapter declares.
