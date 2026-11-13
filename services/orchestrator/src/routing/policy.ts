// Phase 7: the routing policy and the pure functions that apply it.
// Nothing here touches the database or the clock, so the same (policy, features, history) always gives the
// same answer. That is what makes a logged decision reproducible.

export const TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type Tier = (typeof TIERS)[number];
export const LEVELS = ['low', 'medium', 'high'] as const;
export type Level = (typeof LEVELS)[number];
export const TASK_TYPES = ['architecture', 'refactor', 'extraction', 'classification', 'summary', 'boilerplate', 'review', 'debugging', 'coding'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface PolicyRule {
  id: string; tier: Tier; reason: string;
  /** Matches when the task type is one of these (omit = any). */
  types?: TaskType[];
  minComplexity?: Level; maxComplexity?: Level; minRisk?: Level; maxRisk?: Level;
}
export interface RoutingPolicy {
  /** Model id used for each tier. Must be ids the provider actually supports (checked against provider capabilities). */
  models: Record<Tier, string>;
  /** First matching rule wins. */
  rules: PolicyRule[];
  defaultTier: Tier;
  escalation: {
    /** Every N failed attempts on one task moves one tier up. */
    afterFailures: number; maxTier: Tier;
    /** Hard stop: after this many FAILED attempts on one task nothing is launched automatically; a human decides. */
    maxAttemptsPerTask: number;
  };
  budgets: {
    perTaskUsd: number; dailyUsd: number;
    /** Used to reserve budget for a run in flight and to price runs the provider reported no cost for. Always shown as an estimate. */
    estimateUsd: Record<Tier, number>;
  };
  /** Advice only for now: see the decision record. */
  extractionFirst: { enabled: boolean; minDescriptionChars: number };
}

export const DEFAULT_POLICY: RoutingPolicy = {
  models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
  rules: [
    { id: 'arch-or-risky', tier: 'opus', types: ['architecture'], reason: 'architecture decisions need the strongest reasoning' },
    { id: 'complex-refactor', tier: 'opus', types: ['refactor'], minComplexity: 'high', reason: 'a complex refactor touches many things at once' },
    { id: 'high-risk', tier: 'opus', minRisk: 'high', minComplexity: 'medium', reason: 'high-risk change that is not trivial' },
    { id: 'routine-text', tier: 'haiku', types: ['extraction', 'classification', 'summary', 'boilerplate'], maxComplexity: 'medium', maxRisk: 'medium', reason: 'routine, low-stakes work' },
    { id: 'small-and-safe', tier: 'haiku', maxComplexity: 'low', maxRisk: 'low', types: ['coding', 'debugging'], reason: 'small, low-risk change' },
  ],
  defaultTier: 'sonnet',
  escalation: { afterFailures: 2, maxTier: 'opus', maxAttemptsPerTask: 4 },
  budgets: { perTaskUsd: 5, dailyUsd: 25, estimateUsd: { haiku: 0.1, sonnet: 0.5, opus: 2 } },
  extractionFirst: { enabled: true, minDescriptionChars: 1500 },
};

// ---------------------------------------------------------------- validation
export class PolicyError extends Error {}
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
const num = (v: unknown, name: string, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new PolicyError(`${name} must be a number from ${min} to ${max}`);
  return v;
};

/** Strict: unknown keys are dropped, anything malformed throws. Returns a clean copy. */
export function validatePolicy(input: unknown): RoutingPolicy {
  const o = input as any;
  if (!o || typeof o !== 'object') throw new PolicyError('policy must be an object');
  const models = {} as Record<Tier, string>;
  for (const t of TIERS) {
    const m = o.models?.[t];
    if (typeof m !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(m)) throw new PolicyError(`models.${t} must be a model id`);
    models[t] = m;
  }
  if (!Array.isArray(o.rules) || o.rules.length > 50) throw new PolicyError('rules must be a list of at most 50');
  const ids = new Set<string>();
  const rules: PolicyRule[] = o.rules.map((r: any, i: number) => {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.id)) throw new PolicyError(`rules[${i}].id must be lowercase letters, digits or dashes`);
    if (ids.has(r.id)) throw new PolicyError(`duplicate rule id ${r.id}`); ids.add(r.id);
    if (!isTier(r.tier)) throw new PolicyError(`rules[${i}].tier must be haiku, sonnet or opus`);
    if (typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 200) throw new PolicyError(`rules[${i}].reason is required (max 200 chars)`);
    const out: PolicyRule = { id: r.id, tier: r.tier, reason: r.reason };
    if (r.types !== undefined) {
      if (!Array.isArray(r.types) || !r.types.every((t: unknown) => (TASK_TYPES as readonly string[]).includes(t as string))) throw new PolicyError(`rules[${i}].types has an unknown task type`);
      out.types = r.types;
    }
    for (const k of ['minComplexity', 'maxComplexity', 'minRisk', 'maxRisk'] as const) {
      if (r[k] !== undefined) { if (!isLevel(r[k])) throw new PolicyError(`rules[${i}].${k} must be low, medium or high`); out[k] = r[k]; }
    }
    return out;
  });
  if (!isTier(o.defaultTier)) throw new PolicyError('defaultTier must be haiku, sonnet or opus');
  const e = o.escalation ?? {};
  if (!isTier(e.maxTier)) throw new PolicyError('escalation.maxTier must be haiku, sonnet or opus');
  const escalation = { afterFailures: num(e.afterFailures, 'escalation.afterFailures', 1, 10), maxTier: e.maxTier as Tier,
    maxAttemptsPerTask: num(e.maxAttemptsPerTask, 'escalation.maxAttemptsPerTask', 1, 20) };
  const b = o.budgets ?? {}; const est = b.estimateUsd ?? {};
  const budgets = { perTaskUsd: num(b.perTaskUsd, 'budgets.perTaskUsd', 0.01, 100000), dailyUsd: num(b.dailyUsd, 'budgets.dailyUsd', 0.01, 100000),
    estimateUsd: { haiku: num(est.haiku, 'budgets.estimateUsd.haiku', 0.001, 1000), sonnet: num(est.sonnet, 'budgets.estimateUsd.sonnet', 0.001, 1000), opus: num(est.opus, 'budgets.estimateUsd.opus', 0.001, 1000) } };
  const x = o.extractionFirst ?? {};
  return { models, rules, defaultTier: o.defaultTier, escalation, budgets,
    extractionFirst: { enabled: x.enabled === true, minDescriptionChars: num(x.minDescriptionChars ?? 1500, 'extractionFirst.minDescriptionChars', 100, 100000) } };
}

// ---------------------------------------------------------------- classification
export interface Features {
  type: TaskType; complexity: Level; risk: Level; descriptionChars: number;
  /** The words that decided it, so a human can see why and correct the policy instead of guessing. */
  signals: string[];
}
const TYPE_PATTERNS: [TaskType, RegExp][] = [
  ['architecture', /\b(architect\w*|system design|design (?:the|a|an) \w+|trade-?offs?|migration strategy)\b/i],
  ['refactor', /\b(refactor\w*|restructur\w*|re-?write|re-?architect\w*|migrate)\b/i],
  ['extraction', /\b(extract|list all|find all|collect|gather|inventory)\b/i],
  ['classification', /\b(classif\w+|categori[sz]e|label|tag)\b/i],
  ['summary', /\b(summari[sz]e|summary|tl;dr|describe what)\b/i],
  ['boilerplate', /\b(boilerplate|scaffold\w*|rename|typo|docstring|comment|changelog|format|lint|bump)\b/i],
  ['review', /\b(review|audit)\b/i],
  ['debugging', /\b(bug|fix|debug\w*|crash\w*|errors?|failing|regression|flaky)\b/i],
];
const RISK_WORDS = /\b(auth\w*|password|payment|billing|security|crypto\w*|secret|permission\w*|delete|drop table|production|prod|migration|credential\w*|encrypt\w*)\b/gi;
const SCOPE_WORDS = /\b(across|all modules|every|end-to-end|concurren\w+|database|schema|multiple (?:files|services|modules)|whole (?:repo|codebase))\b/gi;
const level = (score: number, hi: number, mid: number): Level => (score >= hi ? 'high' : score >= mid ? 'medium' : 'low');

export function classify(description: string, criteria: string[] = []): Features {
  const text = `${description}\n${criteria.join('\n')}`;
  const signals: string[] = [];
  let type: TaskType = 'coding';
  for (const [t, re] of TYPE_PATTERNS) { const m = text.match(re); if (m) { type = t; signals.push(`type ${t}: "${m[0].toLowerCase()}"`); break; } }
  let c = 0;
  if (text.length > 1500) { c += 2; signals.push('long description'); } else if (text.length > 600) { c += 1; signals.push('medium-length description'); }
  if (criteria.length >= 8) { c += 2; signals.push(`${criteria.length} acceptance criteria`); } else if (criteria.length >= 5) { c += 1; signals.push(`${criteria.length} acceptance criteria`); }
  const scope = [...new Set((text.match(SCOPE_WORDS) ?? []).map((w) => w.toLowerCase()))].slice(0, 3);
  if (scope.length) { c += scope.length; signals.push(`wide scope: ${scope.join(', ')}`); }
  const risks = [...new Set((text.match(RISK_WORDS) ?? []).map((w) => w.toLowerCase()))];
  if (risks.length) signals.push(`sensitive area: ${risks.slice(0, 3).join(', ')}`);
  return { type, complexity: level(c, 3, 1), risk: level(risks.length, 2, 1), descriptionChars: description.length, signals };
}

// ---------------------------------------------------------------- routing
const rank = (l: Level) => LEVELS.indexOf(l);
const tierRank = (t: Tier) => TIERS.indexOf(t);

export function ruleMatches(r: PolicyRule, f: Features): boolean {
  if (r.types && !r.types.includes(f.type)) return false;
  if (r.minComplexity && rank(f.complexity) < rank(r.minComplexity)) return false;
  if (r.maxComplexity && rank(f.complexity) > rank(r.maxComplexity)) return false;
  if (r.minRisk && rank(f.risk) < rank(r.minRisk)) return false;
  if (r.maxRisk && rank(f.risk) > rank(r.maxRisk)) return false;
  return true;
}

export interface RouteResult {
  tier: Tier; model: string; ruleId: string; reason: string;
  baseTier: Tier; escalated: boolean;
  /** Set when the attempt limit is reached: nothing should be launched automatically. */
  attemptLimitReached: boolean;
  /** Advice: a cheap extraction pass before the real work. */
  extractFirst: boolean;
}

export function route(policy: RoutingPolicy, f: Features, history: { failedAttempts: number }): RouteResult {
  const hit = policy.rules.find((r) => ruleMatches(r, f));
  const baseTier = hit?.tier ?? policy.defaultTier;
  let reason = hit ? `rule "${hit.id}": ${hit.reason}` : `no rule matched; default tier ${policy.defaultTier}`;
  let tier = baseTier;
  const steps = Math.floor(history.failedAttempts / policy.escalation.afterFailures);
  const cap = tierRank(policy.escalation.maxTier);
  if (steps > 0) {
    tier = TIERS[Math.min(tierRank(baseTier) + steps, Math.max(cap, tierRank(baseTier)))];
    if (tier !== baseTier) reason += `; escalated ${baseTier} -> ${tier} after ${history.failedAttempts} failed attempt(s)`;
    else reason += `; already at the ceiling (${policy.escalation.maxTier}) after ${history.failedAttempts} failed attempt(s)`;
  }
  const attemptLimitReached = history.failedAttempts >= policy.escalation.maxAttemptsPerTask;
  const extractFirst = policy.extractionFirst.enabled && f.descriptionChars >= policy.extractionFirst.minDescriptionChars && tierRank(tier) >= tierRank('sonnet');
  return { tier, model: policy.models[tier], ruleId: hit?.id ?? 'default', reason, baseTier, escalated: tier !== baseTier, attemptLimitReached, extractFirst };
}

/** Which tier a model id belongs to under this policy (null if the policy does not know it). */
export function tierOf(policy: RoutingPolicy, model: string): Tier | null {
  for (const t of TIERS) if (policy.models[t] === model) return t;
  const m = model.toLowerCase();
  for (const t of TIERS) if (m.includes(t)) return t;
  return null;
}
/** Estimate for a model. Unknown models are priced at the highest estimate so a budget is never under-counted. */
export function estimateFor(policy: RoutingPolicy, model: string): number {
  const t = tierOf(policy, model);
  return t ? policy.budgets.estimateUsd[t] : Math.max(...TIERS.map((x) => policy.budgets.estimateUsd[x]));
}
