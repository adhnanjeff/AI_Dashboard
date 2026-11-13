# Phase 7 decision record: model routing, usage tracking and budgets

Scope (roadmap §11): a versioned routing policy; classify tasks by type, complexity and risk; per-task and daily budgets; record model/provider, routing reason, outcome, retries and reported usage; escalation triggers with bounded loops; a cheap extraction stage; show whether cost is reported, estimated or unavailable; analytics for cost per accepted task and escalation outcomes. Exit: routing decisions are reproducible and logged, budgets are enforced, evaluation compares quality as well as cost.

Built together with Phase 8 on branch `feature/phase-7-8-routing-providers`.

## Decisions

### D1. Transparent rules, not a learned router
- `routing/policy.ts`: an ordered list of rules (`types`, `min/maxComplexity`, `min/maxRisk` → tier), a default tier, escalation settings and budgets. **First match wins.** Tiers map to model ids (`haiku`, `sonnet`, `opus`) in the policy, not in code.
- **Why:** the roadmap says to avoid an autonomous router until there is data. A short rule list can be read, argued with and changed in a minute.
- Defaults follow the roadmap: routine text work and small low-risk edits → Haiku; architecture, complex refactors and risky non-trivial changes → Opus; everything else → Sonnet.

### D2. Classification is keyword-based, and says which words decided it
- `classify()` returns type, complexity, risk **and a `signals` list** (for example `type boilerplate: "typo"`, `wide scope: across, database`). Signals are stored with each decision.
- **Why:** an LLM classifier would add cost, latency and a second source of unreproducibility. Keywords are crude, but wrong answers are visible and fixable by editing the policy. A person can always override (D5).
- **Limit:** a task described in unusual words will be classified as ordinary coding and routed to Sonnet. That is the safe default tier, not a silent failure.

### D3. The policy is versioned and immutable
- Migration 5 `routing_policy`: every change is a **new version**; update and delete are blocked by triggers. Publishing is validated strictly (`validatePolicy`: known tiers, sane numbers, unique rule ids, unknown keys dropped) and audited.
- **Why:** "reproducible" needs the exact policy that was in force at decision time to still exist.

### D4. A decision is pure and logged with its inputs, so it can be replayed
- `route(policy, features, history)` has no database or clock access. Each launch writes a `routing_decision` row with the policy version, the reason text, and `inputs` (features, failed attempts, what the policy chose, budget state, origin).
- `GET /routing/decisions/:id/replay` re-runs the stored inputs against the stored policy version and reports `reproducible: true/false`. Tested, including after a newer policy changed the answer for new tasks.

### D5. A person's model choice is honoured, but still budget-checked and logged
- `model` omitted or `"auto"` → the policy decides. A model named → **manual**: used as asked, recorded as manual together with what the policy would have chosen.
- **Why:** the policy should advise, not lock people out. The attempt limit (D6) applies to automatic routing only: after it trips, a person can still decide to try again.

### D6. Escalation is bounded and ignores provider problems
- Every `afterFailures` (default 2) **failed attempts on a task** moves the tier up one step, never above `maxTier`. After `maxAttemptsPerTask` (default 4) failed attempts automatic routing refuses with a clear 409.
- A failure caused by the provider (rate limit, could not start, orphaned by a restart) is **not counted**: it says nothing about task difficulty, so it neither escalates nor uses up attempts.
- Not built: "unresolved high-impact findings" as an escalation trigger. There is no reviewer stage until Phase 9; failed validation is represented by failed runs for now.

### D7. Cost is reported, estimated or reserved, and the three are never blended silently
- Migration 5 `usage_record`: one row per run **only when the provider reported something** (cost, tokens). No row = unavailable; nothing is invented.
- For budgets and analytics: reported cost where it exists; otherwise the policy's per-tier **estimate**, labelled `estimated` once the run has ended and `reserved` while it is still running. Unknown models are priced at the highest estimate so a budget cannot be under-counted.
- The UI and API show the source everywhere (usage meter legend, run page, model table "N reported, M estimated").

### D8. Budgets are checked before anything starts
- `Router.budgetCheck`: spent on this task (all its runs) plus the estimate for the new run must fit `perTaskUsd`; spent today (UTC) plus the estimate must fit `dailyUsd`. A refusal is a 409 with the arithmetic in the message, writes a `routing.refused` session event, and creates **no run**.
- **Why reserve an estimate:** without it, five runs launched in the same minute would all see "$0 spent" and overshoot.
- **Limit:** the real cost is only known after the run ends, so a single run can still exceed its estimate. Budgets bound launches, they do not kill a run mid-flight.

### D9. One launch path
- `routing/scheduler.ts` is the only way work starts: decide → budget → pick an authorised provider/account → start → record the decision. The run endpoint, resume and handoff all use it. Idempotent replays return the original run without a second decision or reservation.
- The existing `usage` field on `GET /runs/:id` is unchanged; `cost`, `tokens` and `routing` were added beside it so existing consumers keep working.

### D10. Analytics compare quality with cost
- `GET /usage/summary`: totals by source, per model (runs, success rate, cost, **cost per completed run**, reported vs estimated runs), **cost per accepted task** (everything spent on a task, failed attempts included, divided by tasks that ended completed), and escalation outcomes (how many escalated, how many then succeeded, per path such as haiku→sonnet).

## Not done, and why
- **Cheap extraction stage before reasoning.** The policy only **advises** it (`extractFirst` in the decision). Running it for real needs a per-run tool restriction and a run type that does not complete the task when it ends; the supervisor currently treats any completed run as task completion. Left for Phase 9 (workflow engine), where stages are a first-class concept.
- **Real provider pricing.** Estimates are flat per tier and editable; they are not a price list.
- **Verifying model ids against the live provider.** Supported ids are declared per adapter (Phase 8) and checked at launch; availability is not probed.

## How it was tested
`tests/unit/phase7.test.ts` (16 tests): classification and rule table, purity, policy validation and immutability, logged and replayable decisions, manual override, bounded escalation, escalation analytics, reported vs estimated vs reserved cost, per-task and daily budgets, dry-run preview, and the HTTP endpoints. All use the real supervisor with the fake worker.
