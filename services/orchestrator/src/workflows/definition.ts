// Workflow schema (Phase 9). A workflow is plain JSON: steps, the steps each one needs, and per-step policies.
// Validation is strict and total: a definition that passes can always be scheduled (no unknown ids, no cycles).

export const STEP_KINDS = ['agent', 'check', 'review', 'integrate', 'approval', 'merge_ready'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What each role may do. `writes: false` roles are verified after the fact: if the workspace changed, the step fails. */
export const ROLES: Record<string, { writes: boolean; tools: string[]; brief: string }> = {
  planner: { writes: false, tools: ['Read', 'Grep', 'Glob'], brief: 'You plan and analyse. Do NOT modify any file. Write your plan as your final answer.' },
  coder: { writes: true, tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], brief: 'You implement the task in this workspace. Keep changes small and focused on the task.' },
  tester: { writes: true, tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], brief: 'You write and fix tests for the task. Do not change production code unless the task says so.' },
  docs: { writes: true, tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'], brief: 'You write or update documentation only.' },
  reviewer: { writes: false, tools: ['Read', 'Grep', 'Glob'], brief: 'You review code. Do NOT modify any file.' },
};

export interface StepDef {
  id: string; kind: StepKind; title?: string; role?: string; needs: string[];
  prompt?: string; acceptance?: string[]; model?: string;
  command?: string[]; timeoutMs?: number;            // check
  verifies?: string; reviews?: string;               // check / review target (an agent or integrate step)
  fixer?: string;                                    // the agent step that corrects a failed check/review (default: the target if it is an agent)
  blockAt?: Severity;                                // review: findings at or above this severity must be fixed (default high)
  when?: { step: string; status: 'passed' | 'failed' };
  maxAttempts: number;
  /** Phase 13: stop retrying an agent or review step once its reported spend reaches this. Only reported cost counts. */
  budgetUsd?: number;
}
export interface WorkflowDef { concurrency: number; steps: StepDef[] }

export class DefinitionError extends Error { problems: string[]; constructor(problems: string[]) { super(`invalid workflow: ${problems.join('; ')}`); this.problems = problems; } }

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL = /^[A-Za-z0-9._:\-/]{1,80}$/;
const int = (v: unknown, lo: number, hi: number, d: number) => (v === undefined ? d : Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : NaN);

export function validateWorkflow(input: unknown): WorkflowDef {
  const bad: string[] = [];
  const raw = input as any;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) throw new DefinitionError(['definition must be an object with a steps array']);
  const concurrency = int(raw.concurrency, 1, 4, 2); if (Number.isNaN(concurrency)) bad.push('concurrency must be 1..4');
  if (raw.steps.length < 1 || raw.steps.length > 40) bad.push('a workflow needs 1..40 steps');
  const steps: StepDef[] = [];
  for (const s of raw.steps.slice(0, 40)) {
    const id = String(s?.id ?? ''); const at = `step "${id}"`;
    if (!ID.test(id)) { bad.push(`step id "${id}" must be lowercase letters, digits and dashes, starting with a letter`); continue; }
    if (steps.some((x) => x.id === id)) { bad.push(`${at} is defined twice`); continue; }
    if (!STEP_KINDS.includes(s.kind)) { bad.push(`${at}: kind must be one of ${STEP_KINDS.join(', ')}`); continue; }
    const kind = s.kind as StepKind;
    const needs: string[] = s.needs === undefined ? [] : Array.isArray(s.needs) ? s.needs.map(String) : (bad.push(`${at}: needs must be an array`), []);
    const maxAttempts = int(s.maxAttempts, 1, 5, 2); if (Number.isNaN(maxAttempts)) bad.push(`${at}: maxAttempts must be 1..5`);
    const d: StepDef = { id, kind, needs: [...new Set(needs)], maxAttempts: Number.isNaN(maxAttempts) ? 2 : maxAttempts };
    if (typeof s.title === 'string') d.title = s.title.slice(0, 120);
    if (s.budgetUsd !== undefined) {
      if (typeof s.budgetUsd !== 'number' || !Number.isFinite(s.budgetUsd) || s.budgetUsd < 0.01 || s.budgetUsd > 100000) bad.push(`${at}: budgetUsd must be a number from 0.01 to 100000`);
      else if (kind !== 'agent' && kind !== 'review') bad.push(`${at}: budgetUsd applies only to agent and review steps`);
      else d.budgetUsd = s.budgetUsd;
    }
    if (s.model !== undefined) { if (typeof s.model === 'string' && (s.model === 'auto' || MODEL.test(s.model))) { if (s.model !== 'auto') d.model = s.model; } else bad.push(`${at}: invalid model`); }
    if (kind === 'agent' || kind === 'review') {
      d.role = String(s.role ?? (kind === 'review' ? 'reviewer' : 'coder'));
      const role = ROLES[d.role];
      if (!role) bad.push(`${at}: unknown role "${d.role}" (known: ${Object.keys(ROLES).join(', ')})`);
      else if (kind === 'review' && role.writes) bad.push(`${at}: a review step must use a read-only role`);
      if (typeof s.prompt === 'string' && s.prompt.trim()) d.prompt = s.prompt.slice(0, 8000);
      else if (kind === 'agent') bad.push(`${at}: an agent step needs a prompt`);
      if (Array.isArray(s.acceptance)) d.acceptance = s.acceptance.map(String).slice(0, 20);
    }
    if (kind === 'check') {
      if (!Array.isArray(s.command) || s.command.length < 1 || s.command.length > 20 || s.command.some((x: unknown) => typeof x !== 'string' || !x.length || x.length > 500 || x.includes('\0')))
        bad.push(`${at}: command must be an argument list like ["npm","test"] (no shell string)`);
      else d.command = s.command;
      const t = int(s.timeoutMs, 1000, 3_600_000, 300_000); if (Number.isNaN(t)) bad.push(`${at}: timeoutMs must be 1000..3600000`); else d.timeoutMs = t;
    }
    if (kind === 'review') { d.blockAt = SEVERITIES.includes(s.blockAt) ? s.blockAt : 'high'; }
    if (kind === 'approval' && typeof s.prompt === 'string') d.prompt = s.prompt.slice(0, 1000);
    for (const f of ['verifies', 'reviews', 'fixer'] as const) if (s[f] !== undefined) { if (typeof s[f] === 'string') d[f] = s[f]; else bad.push(`${at}: ${f} must be a step id`); }
    if (s.when !== undefined) {
      if (s.when && typeof s.when.step === 'string' && ['passed', 'failed'].includes(s.when.status)) d.when = { step: s.when.step, status: s.when.status };
      else bad.push(`${at}: when must be {"step": id, "status": "passed"|"failed"}`);
    }
    steps.push(d);
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) {
    const at = `step "${s.id}"`;
    for (const n of s.needs) { if (n === s.id) bad.push(`${at} cannot need itself`); else if (!byId.has(n)) bad.push(`${at} needs unknown step "${n}"`); }
    const target = (f: 'verifies' | 'reviews') => {
      const t = s[f]; if (!t) { bad.push(`${at}: ${s.kind === 'check' ? 'a check' : 'a review'} must name the step it ${f}`); return; }
      const ts = byId.get(t); if (!ts) { bad.push(`${at}: ${f} unknown step "${t}"`); return; }
      if (ts.kind !== 'agent' && ts.kind !== 'integrate') bad.push(`${at}: ${f} must be an agent or integrate step`);
      if (!s.needs.includes(t)) s.needs.push(t); // a verification cannot start before what it verifies
    };
    if (s.kind === 'check') target('verifies');
    if (s.kind === 'review') target('reviews');
    if (s.kind === 'check' || s.kind === 'review') {
      const t = byId.get((s.verifies ?? s.reviews)!);
      s.fixer ??= t?.kind === 'agent' ? t.id : undefined;
      if (s.fixer) { const f = byId.get(s.fixer); if (!f || f.kind !== 'agent') bad.push(`${at}: fixer must be an agent step`); else if (!ancestors(byId, s.id).has(f.id)) bad.push(`${at}: fixer "${s.fixer}" must be upstream of this step`); }
    }
    if (s.kind === 'integrate') {
      if (!s.needs.length) bad.push(`${at}: an integrate step needs at least one agent step`);
      for (const n of s.needs) if (byId.get(n) && byId.get(n)!.kind !== 'agent') bad.push(`${at}: can only integrate agent steps ("${n}" is ${byId.get(n)!.kind})`);
    }
    if (s.kind === 'merge_ready') {
      const integ = s.needs.map((n) => byId.get(n)).filter((x) => x?.kind === 'integrate');
      if (integ.length !== 1) bad.push(`${at}: merge_ready must need exactly one integrate step`);
    }
    if (s.when) { if (!byId.has(s.when.step)) bad.push(`${at}: when refers to unknown step "${s.when.step}"`); else if (!s.needs.includes(s.when.step)) s.needs.push(s.when.step); }
  }
  if (!bad.length && cyclic(steps)) bad.push('steps contain a dependency cycle');
  if (bad.length) throw new DefinitionError(bad);
  return { concurrency, steps };
}

/** All steps that `id` (transitively) needs. */
export function ancestors(byId: Map<string, StepDef>, id: string): Set<string> {
  const out = new Set<string>(); const walk = (k: string) => { for (const n of byId.get(k)?.needs ?? []) if (!out.has(n)) { out.add(n); walk(n); } };
  walk(id); return out;
}
/** `id` and every step that (transitively) needs it. */
export function downstreamOf(def: WorkflowDef, id: string): string[] {
  const out = new Set<string>([id]); let grew = true;
  while (grew) { grew = false; for (const s of def.steps) if (!out.has(s.id) && s.needs.some((n) => out.has(n))) { out.add(s.id); grew = true; } }
  return [...out];
}
function cyclic(steps: StepDef[]): boolean {
  const left = new Map(steps.map((s) => [s.id, new Set(s.needs)])); let progress = true;
  while (left.size && progress) { progress = false; for (const [k, n] of [...left]) if (!n.size) { left.delete(k); for (const o of left.values()) o.delete(k); progress = true; } }
  return left.size > 0;
}

/** The standard feature workflow: parallel parts in isolated worktrees -> integrate -> checks -> review -> merge readiness (approval). */
export function featureTemplate(o: { parts: { id: string; prompt: string; role?: string; model?: string }[]; checks: { id: string; command: string[] }[]; reviewPrompt?: string; concurrency?: number }): WorkflowDef {
  const parts = o.parts.map((p) => ({ id: p.id, kind: 'agent', role: p.role ?? 'coder', prompt: p.prompt, model: p.model, maxAttempts: 3 }));
  const steps: any[] = [...parts, { id: 'integrate', kind: 'integrate', needs: parts.map((p) => p.id) }];
  for (const c of o.checks) steps.push({ id: c.id, kind: 'check', command: c.command, verifies: 'integrate', fixer: parts[0]?.id, maxAttempts: 3 });
  steps.push({ id: 'review', kind: 'review', reviews: 'integrate', fixer: parts[0]?.id, needs: o.checks.map((c) => c.id), prompt: o.reviewPrompt, maxAttempts: 2 });
  steps.push({ id: 'merge-ready', kind: 'merge_ready', needs: ['integrate', 'review', ...o.checks.map((c) => c.id)] });
  return validateWorkflow({ concurrency: o.concurrency ?? 2, steps });
}
