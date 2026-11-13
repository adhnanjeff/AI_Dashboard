import type { RoutingDecision, RunCostRow } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import { DEFAULT_POLICY, TIERS, classify, estimateFor, route, tierOf, validatePolicy,
  type Features, type RouteResult, type RoutingPolicy, type Tier } from './policy.ts';

export class RoutingError extends Error {
  status: number; details?: unknown;
  constructor(status: number, msg: string, details?: unknown) { super(msg); this.status = status; this.details = details; }
}

export interface BudgetCheck {
  ok: boolean; estimateUsd: number;
  task: { spentUsd: number; limitUsd: number }; daily: { spentUsd: number; limitUsd: number };
  reasons: string[];
}
export interface Decision {
  mode: 'auto' | 'manual'; policyVersion: number; features: Features; failedAttempts: number;
  route: RouteResult; tier: Tier | null; model: string; reason: string; budget: BudgetCheck;
}
export type CostSource = 'reported' | 'estimated' | 'reserved';

const dayStart = (ms: number) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); };
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// Applies the policy to a task, enforces budgets, and answers "what has this cost?". It never starts anything.
export class Router {
  private store: Store; private now: () => number;
  constructor(store: Store, o: { now?: () => number } = {}) {
    this.store = store; this.now = o.now ?? Date.now;
    if (!store.latestPolicy()) store.publishPolicy(DEFAULT_POLICY, 'system', 'built-in default policy');
  }

  // ---- policy
  active(): { version: number; policy: RoutingPolicy } {
    const p = this.store.latestPolicy()!; return { version: p.version, policy: p.config as RoutingPolicy };
  }
  policyAt(version: number): RoutingPolicy | undefined { return this.store.getPolicy(version)?.config as RoutingPolicy | undefined; }
  publish(config: unknown, actor: string, note?: string) {
    let clean: RoutingPolicy;
    try { clean = validatePolicy(config); } catch (e: any) { throw new RoutingError(400, e.message); }
    return this.store.publishPolicy(clean, actor, note);
  }

  // ---- cost accounting. Cost is reported by the provider, or an estimate that is always labelled as one.
  costOf(row: RunCostRow, policy: RoutingPolicy): { usd: number; source: CostSource } {
    if (row.reported && row.costUsd !== null) return { usd: row.costUsd, source: 'reported' };
    const est = estimateFor(policy, row.model);
    return { usd: est, source: row.status === 'running' ? 'reserved' : 'estimated' };
  }
  private spend(rows: RunCostRow[], policy: RoutingPolicy) {
    const by = { reported: 0, estimated: 0, reserved: 0 } as Record<CostSource, number>;
    for (const r of rows) { const c = this.costOf(r, policy); by[c.source] += c.usd; }
    return { totalUsd: r4(by.reported + by.estimated + by.reserved), bySource: { reported: r4(by.reported), estimated: r4(by.estimated), reserved: r4(by.reserved) } };
  }

  budgetCheck(taskId: string, model: string, policy: RoutingPolicy = this.active().policy): BudgetCheck {
    const est = estimateFor(policy, model);
    const task = this.spend(this.store.runCostRows({ taskId }), policy).totalUsd;
    const day = this.spend(this.store.runCostRows({ since: dayStart(this.now()) }), policy).totalUsd;
    const reasons: string[] = [];
    if (task + est > policy.budgets.perTaskUsd) reasons.push(`task budget: $${r4(task)} spent + $${est} reserved for this run would exceed $${policy.budgets.perTaskUsd}`);
    if (day + est > policy.budgets.dailyUsd) reasons.push(`daily budget: $${r4(day)} spent today + $${est} reserved for this run would exceed $${policy.budgets.dailyUsd}`);
    return { ok: reasons.length === 0, estimateUsd: est, task: { spentUsd: r4(task), limitUsd: policy.budgets.perTaskUsd }, daily: { spentUsd: r4(day), limitUsd: policy.budgets.dailyUsd }, reasons };
  }

  /** Today's spend against the daily limit, split by how trustworthy each figure is. */
  today() {
    const { version, policy } = this.active();
    const s = this.spend(this.store.runCostRows({ since: dayStart(this.now()) }), policy);
    return { policyVersion: version, since: dayStart(this.now()), limitUsd: policy.budgets.dailyUsd, perTaskLimitUsd: policy.budgets.perTaskUsd, ...s, remainingUsd: r4(Math.max(0, policy.budgets.dailyUsd - s.totalUsd)) };
  }

  // ---- decisions
  features(taskId: string): Features {
    const t = this.store.getTask(taskId); if (!t) throw new RoutingError(404, 'task not found');
    return classify(t.description, t.acceptanceCriteria);
  }

  /** Decide the model for a task. `model` set = a human chose it: still checked against budget and logged, but not overridden. */
  decide(taskId: string, o: { model?: string } = {}): Decision {
    const { version, policy } = this.active();
    const features = this.features(taskId);
    const failedAttempts = this.store.failedRunCount(taskId);
    const rt = route(policy, features, { failedAttempts });
    if (o.model === undefined) {
      if (rt.attemptLimitReached) throw new RoutingError(409, `attempt limit reached: ${failedAttempts} failed attempts on this task (limit ${policy.escalation.maxAttemptsPerTask}). Automatic routing stops here; choose a model yourself to try again.`,
        { failedAttempts, limit: policy.escalation.maxAttemptsPerTask });
      return { mode: 'auto', policyVersion: version, features, failedAttempts, route: rt, tier: rt.tier, model: rt.model, reason: rt.reason, budget: this.budgetCheck(taskId, rt.model, policy) };
    }
    const tier = tierOf(policy, o.model);
    return { mode: 'manual', policyVersion: version, features, failedAttempts, route: rt, tier, model: o.model,
      reason: `chosen by the user; the policy would have used ${rt.model} (${rt.reason})`, budget: this.budgetCheck(taskId, o.model, policy) };
  }

  /** Everything needed to re-derive a decision later, stored with it. */
  inputsOf(d: Decision) {
    return { mode: d.mode, features: d.features, failedAttempts: d.failedAttempts,
      route: { tier: d.route.tier, model: d.route.model, ruleId: d.route.ruleId, reason: d.route.reason, baseTier: d.route.baseTier, escalated: d.route.escalated, extractFirst: d.route.extractFirst },
      budget: d.budget };
  }

  /** Re-run a logged decision against the policy version it was made under. */
  replay(decisionId: string) {
    const d = this.store.getRouting(decisionId); if (!d) throw new RoutingError(404, 'decision not found');
    const policy = this.policyAt(Number(d.policyVersion));
    if (!policy) return { decision: d, reproducible: false, why: `policy version ${d.policyVersion} is not in the database` };
    const inp: any = d.inputs ?? {};
    if (!inp.features) return { decision: d, reproducible: false, why: 'this decision was logged without its inputs' };
    const again = route(policy, inp.features, { failedAttempts: inp.failedAttempts ?? 0 });
    const was = inp.route ?? {};
    const same = again.tier === was.tier && again.model === was.model && again.ruleId === was.ruleId && again.reason === was.reason;
    return { decision: d, reproducible: same, recomputed: { tier: again.tier, model: again.model, ruleId: again.ruleId, reason: again.reason }, logged: was };
  }

  // ---- analytics
  summary(o: { days?: number; projectId?: string } = {}) {
    const days = Math.min(Math.max(o.days ?? 7, 1), 365);
    const since = new Date(this.now() - days * 86_400_000).toISOString();
    const { policy } = this.active();
    const rows = this.store.runCostRows({ since, projectId: o.projectId });
    const totals = this.spend(rows, policy);

    const byModel = new Map<string, { model: string; tier: Tier | null; runs: number; completed: number; failed: number; cancelled: number; running: number; costUsd: number; reportedRuns: number; estimatedRuns: number; inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      const m = byModel.get(r.model) ?? { model: r.model, tier: tierOf(policy, r.model), runs: 0, completed: 0, failed: 0, cancelled: 0, running: 0, costUsd: 0, reportedRuns: 0, estimatedRuns: 0, inputTokens: 0, outputTokens: 0 };
      const c = this.costOf(r, policy); m.runs++; m.costUsd += c.usd;
      if (c.source === 'reported') m.reportedRuns++; else m.estimatedRuns++;
      if (r.status === 'completed') m.completed++; else if (r.status === 'failed') m.failed++; else if (r.status === 'cancelled') m.cancelled++; else m.running++;
      m.inputTokens += r.inputTokens ?? 0; m.outputTokens += r.outputTokens ?? 0;
      byModel.set(r.model, m);
    }
    const models = [...byModel.values()].map((m) => ({ ...m, costUsd: r4(m.costUsd),
      successRate: m.completed + m.failed ? r4(m.completed / (m.completed + m.failed)) : null,
      costPerCompletedRun: m.completed ? r4(m.costUsd / m.completed) : null }));

    // Cost per ACCEPTED task: everything spent on a task (failed attempts included) divided by tasks that ended completed.
    const taskIds = [...new Set(rows.map((r) => r.taskId))];
    const accepted = taskIds.filter((id) => this.store.getTask(id)?.status === 'completed');
    const acceptedCost = rows.filter((r) => accepted.includes(r.taskId)).reduce((a, r) => a + this.costOf(r, policy).usd, 0);

    const status = new Map(rows.map((r) => [r.runId, r.status]));
    const decisions: RoutingDecision[] = this.store.listRoutingSince(since).filter((d) => status.has(d.runId));
    const esc = decisions.filter((d) => (d.inputs as any)?.route?.escalated);
    const path = new Map<string, { from: string; to: string; runs: number; completed: number; failed: number }>();
    for (const d of esc) {
      const from = (d.inputs as any).route.baseTier, to = tierOf(policy, d.model) ?? d.model, k = `${from}>${to}`;
      const e = path.get(k) ?? { from, to: String(to), runs: 0, completed: 0, failed: 0 }; e.runs++;
      if (status.get(d.runId) === 'completed') e.completed++; if (status.get(d.runId) === 'failed') e.failed++; path.set(k, e);
    }
    return { days, since, policyVersion: this.active().version, runs: rows.length, ...totals,
      tokens: { input: rows.reduce((a, r) => a + (r.inputTokens ?? 0), 0), output: rows.reduce((a, r) => a + (r.outputTokens ?? 0), 0), note: 'only runs where the provider reported tokens' },
      byModel: models,
      acceptedTasks: { count: accepted.length, costUsd: r4(acceptedCost), costPerAcceptedTask: accepted.length ? r4(acceptedCost / accepted.length) : null, tasksWithRuns: taskIds.length },
      escalation: { decisions: decisions.length, escalated: esc.length, manualOverrides: decisions.filter((d) => (d.inputs as any)?.mode === 'manual').length,
        escalatedCompleted: esc.filter((d) => status.get(d.runId) === 'completed').length, escalatedFailed: esc.filter((d) => status.get(d.runId) === 'failed').length, paths: [...path.values()] },
      tiers: TIERS };
  }
}
