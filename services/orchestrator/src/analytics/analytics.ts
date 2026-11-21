import type { Store } from '../storage/store.ts';

/**
 * Phase 13: analytics. A read-only projection over rows the runtime already wrote. It writes nothing.
 *
 * Honesty rules, because these numbers drive decisions:
 *  - Cost is only what providers REPORTED. A run with no report is "unknown", never zero, and every cost figure says
 *    how many runs it covers.
 *  - "Accepted" is a recorded fact: a workflow that completed (its merge-ready gate was approved by a person) or a
 *    standalone session that completed. Nothing is inferred from text.
 *  - Estimated savings come from the routing policy's own estimates and are labelled as estimates.
 *  - Small samples are called small. An insight is only stated when there is enough data behind it.
 */

export const MIN_SAMPLE = 5;
const DAY = 86_400_000;

export interface AnalyticsOptions { projectId?: string; days?: number; now?: Date; estimateUsd?: Record<string, number>; maxTier?: string }

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const round = (n: number | null, d = 4) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const ms = (a: string | null, b: string | null) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null);
const rate = (n: number, of: number) => (of > 0 ? n / of : null);

/** Groups free-text termination reasons into a few stable categories. */
export function failureCategory(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (r.startsWith('timeout')) return 'timeout';
  if (r.startsWith('provider rate limited')) return 'provider rate limit';
  if (r.startsWith('orphaned')) return 'orphaned by restart';
  if (r.startsWith('spawn error') || r.startsWith('launch error')) return 'could not start';
  if (r.startsWith('exit code')) return 'process exited with error';
  if (r.startsWith('exited 0 without')) return 'no result reported';
  if (r.startsWith('provider reported an error')) return 'provider error result';
  if (r.startsWith('cancelled')) return 'cancelled';
  return 'other';
}

interface RunRow { run_id: string; task_id: string; session_id: string; project_id: string; title: string; role: string; provider: string; model: string; status: string;
  started_at: string; ended_at: string | null; reason: string | null; cost: number | null; in_tok: number | null; out_tok: number | null }

export function buildAnalytics(store: Store, o: AnalyticsOptions = {}) {
  const q = store.sql();
  const days = Math.min(365, Math.max(1, Math.floor(o.days ?? 30)));
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const pid = o.projectId ?? null;
  const notDemo = (col: string) => `${col} NOT LIKE 'demo:%'`;

  // ---- every run that started in the window (demo sessions excluded: they are seed data, not work)
  const runs = q.all<RunRow>(`SELECT r.id run_id, r.task_id, t.session_id, s.project_id, s.title, r.role, r.provider, r.model, r.status, r.started_at, r.ended_at,
      r.termination_reason reason, u.cost_usd cost, u.input_tokens in_tok, u.output_tokens out_tok
    FROM agent_run r JOIN task t ON t.id=r.task_id JOIN session s ON s.id=t.session_id LEFT JOIN usage_record u ON u.run_id=r.id
    WHERE r.started_at IS NOT NULL AND r.started_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')} ORDER BY r.started_at`, since, pid, pid);
  const finished = runs.filter((r) => r.status === 'completed' || r.status === 'failed');
  const known = runs.filter((r) => r.cost !== null);

  // ---- cost
  const byModel = new Map<string, { model: string; runs: number; completed: number; failed: number; costUsd: number; reportedRuns: number; durationsMs: number[] }>();
  const byDay = new Map<string, { day: string; runs: number; costUsd: number; reportedRuns: number }>();
  for (const r of runs) {
    const m = byModel.get(r.model) ?? { model: r.model, runs: 0, completed: 0, failed: 0, costUsd: 0, reportedRuns: 0, durationsMs: [] }; byModel.set(r.model, m);
    m.runs++; if (r.status === 'completed') m.completed++; if (r.status === 'failed') m.failed++;
    if (r.cost !== null) { m.costUsd += r.cost; m.reportedRuns++; }
    const d = ms(r.started_at, r.ended_at); if (d !== null && r.status !== 'cancelled') m.durationsMs.push(d);
    const day = r.started_at.slice(0, 10); const dd = byDay.get(day) ?? { day, runs: 0, costUsd: 0, reportedRuns: 0 }; byDay.set(day, dd);
    dd.runs++; if (r.cost !== null) { dd.costUsd += r.cost; dd.reportedRuns++; }
  }

  // ---- accepted work. Workflow cost comes from the evidence every attempt recorded (a step's row only remembers its latest session).
  const wfRows = q.all<any>(`SELECT id, project_id, title, status, created_at, updated_at, halted_reason FROM workflow WHERE (? IS NULL OR project_id=?) AND ${notDemo('title')} ORDER BY created_at`, pid, pid);
  const evidenceRuns = q.all<any>(`SELECT workflow_id, step_key, attempt, content FROM workflow_evidence WHERE kind='run'`);
  const wfEvidence = new Map<string, { runs: number; costUsd: number; reportedRuns: number; runIds: string[] }>();
  for (const e of evidenceRuns) {
    let c: any; try { c = JSON.parse(e.content); } catch { continue; }
    const w = wfEvidence.get(e.workflow_id) ?? { runs: 0, costUsd: 0, reportedRuns: 0, runIds: [] }; wfEvidence.set(e.workflow_id, w);
    w.runs++; if (typeof c.costUsd === 'number') { w.costUsd += c.costUsd; w.reportedRuns++; } if (c.runId) w.runIds.push(c.runId);
  }
  const wfApprovals = q.all<any>(`SELECT workflow_id, COUNT(approval_id) n FROM workflow_step GROUP BY workflow_id`);
  const wfApprovalCount = new Map(wfApprovals.map((r) => [r.workflow_id, r.n as number]));
  const wfSessionIds = new Set<string>([
    ...q.all<any>('SELECT session_id FROM workflow_step WHERE session_id IS NOT NULL').map((r) => r.session_id as string),
    ...runs.filter((r) => [...wfEvidence.values()].some((w) => w.runIds.includes(r.run_id))).map((r) => r.session_id),
  ]);

  type Unit = { kind: 'workflow' | 'session'; id: string; title: string; status: string; accepted: boolean; at: string; runs: number; reportedRuns: number; costUsd: number; firstAttempt: boolean; humanTouches: number };
  const units: Unit[] = [];
  for (const w of wfRows) {
    if (w.status === 'running' || w.status === 'draft' || w.updated_at < since) continue;
    const e = wfEvidence.get(w.id) ?? { runs: 0, costUsd: 0, reportedRuns: 0, runIds: [] };
    const retries = q.one<any>(`SELECT COUNT(*) n FROM workflow_transition WHERE workflow_id=? AND reason LIKE 'retry:%'`, w.id)!.n as number;
    units.push({ kind: 'workflow', id: w.id, title: w.title, status: w.status, accepted: w.status === 'completed', at: w.updated_at, runs: e.runs, reportedRuns: e.reportedRuns, costUsd: e.costUsd, firstAttempt: retries === 0, humanTouches: wfApprovalCount.get(w.id) ?? 0 });
  }
  const sessions = q.all<any>(`SELECT id, title, status, created_at, updated_at FROM session WHERE (? IS NULL OR project_id=?) AND ${notDemo('title')} AND updated_at >= ? AND status IN ('completed','failed','cancelled')`, pid, pid, since);
  const resumed = new Map(q.all<any>(`SELECT session_id, COUNT(*) n FROM event WHERE type='session.resume' GROUP BY session_id`).map((r) => [r.session_id as string, r.n as number]));
  const handedOff = new Map(q.all<any>(`SELECT session_id, COUNT(*) n FROM handoff GROUP BY session_id`).map((r) => [r.session_id as string, r.n as number]));
  const approvalsBySession = new Map(q.all<any>(`SELECT session_id, COUNT(*) n FROM approval GROUP BY session_id`).map((r) => [r.session_id as string, r.n as number]));
  for (const s of sessions) {
    if (wfSessionIds.has(s.id)) continue;
    const rs = runs.filter((r) => r.session_id === s.id); if (!rs.length) continue; // a session that never ran anything is not work
    const touches = (resumed.get(s.id) ?? 0) + (handedOff.get(s.id) ?? 0) + (approvalsBySession.get(s.id) ?? 0);
    units.push({ kind: 'session', id: s.id, title: s.title, status: s.status, accepted: s.status === 'completed', at: s.updated_at, runs: rs.length, reportedRuns: rs.filter((r) => r.cost !== null).length,
      costUsd: sum(rs.map((r) => r.cost)), firstAttempt: rs.length === 1 && rs[0].status === 'completed', humanTouches: touches });
  }
  const accepted = units.filter((u) => u.accepted), notAccepted = units.filter((u) => !u.accepted);
  const acceptedPriced = accepted.filter((u) => u.reportedRuns > 0);
  const completeCost = accepted.filter((u) => u.runs > 0 && u.reportedRuns === u.runs);

  // ---- routing: escalation and retries
  const decisions = q.all<any>(`SELECT d.run_id, d.provider, d.model, d.inputs, d.reason, d.created_at, t.id task_id, t.session_id
    FROM routing_decision d JOIN agent_run r ON r.id=d.run_id JOIN task t ON t.id=r.task_id JOIN session s ON s.id=t.session_id
    WHERE d.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, since, pid, pid)
    .map((d: any) => { let i: any = {}; try { i = JSON.parse(d.inputs); } catch { /* old row */ } return { ...d, route: i.route ?? {}, origin: i.origin ?? null, failedAttempts: Number(i.failedAttempts ?? 0) }; });
  const escalated = decisions.filter((d) => d.route.escalated === true);
  const runById = new Map(runs.map((r) => [r.run_id, r]));
  const trans = new Map<string, number>(); for (const d of escalated) { const k = `${d.route.baseTier} -> ${d.route.tier}`; trans.set(k, (trans.get(k) ?? 0) + 1); }
  const escRuns = escalated.map((d) => runById.get(d.run_id)).filter((r): r is RunRow => !!r);
  const escDone = escRuns.filter((r) => r.status === 'completed' || r.status === 'failed');
  const byTask = new Map<string, RunRow[]>(); for (const r of runs) { const a = byTask.get(r.task_id) ?? []; a.push(r); byTask.set(r.task_id, a); }
  const multi = [...byTask.values()].filter((a) => a.length > 1);
  const recovered = multi.filter((a) => a.at(-1)!.status === 'completed');
  const tierCount = new Map<string, number>(); for (const d of decisions) tierCount.set(d.route.tier ?? 'unknown', (tierCount.get(d.route.tier ?? 'unknown') ?? 0) + 1);
  const est = o.estimateUsd; const top = o.maxTier;
  const cheaper = est && top && est[top] !== undefined ? decisions.filter((d) => d.route.tier && d.route.tier !== top && est[d.route.tier] !== undefined) : [];
  const refused = q.one<any>(`SELECT COUNT(*) n FROM event e JOIN session s ON s.id=e.session_id WHERE e.type='routing.refused' AND e.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, since, pid, pid)!.n as number;
  const wfRetry = q.one<any>(`SELECT COUNT(*) n FROM workflow_transition t JOIN workflow w ON w.id=t.workflow_id WHERE t.reason LIKE 'retry:%' AND t.at >= ? AND (? IS NULL OR w.project_id=?) AND ${notDemo('w.title')}`, since, pid, pid)!.n as number;
  const wfRetryLimit = q.one<any>(`SELECT COUNT(*) n FROM workflow_transition t JOIN workflow w ON w.id=t.workflow_id WHERE t.reason LIKE 'retry limit reached%' AND t.at >= ? AND (? IS NULL OR w.project_id=?) AND ${notDemo('w.title')}`, since, pid, pid)!.n as number;

  // ---- reliability: failures, checkpoints, recovery
  const failures = new Map<string, number>(); for (const r of runs.filter((x) => x.status === 'failed')) { const c = failureCategory(r.reason); failures.set(c, (failures.get(c) ?? 0) + 1); }
  const evCount = (type: string) => q.one<any>(`SELECT COUNT(*) n FROM event e JOIN session s ON s.id=e.session_id WHERE e.type=? AND e.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, type, since, pid, pid)!.n as number;
  const resumedSessions = q.all<any>(`SELECT DISTINCT e.session_id id, s.status FROM event e JOIN session s ON s.id=e.session_id WHERE e.type='session.resume' AND e.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, since, pid, pid);
  const handoffs = q.all<any>(`SELECT h.status FROM handoff h JOIN session s ON s.id=h.session_id WHERE h.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, since, pid, pid);

  // ---- time and human involvement
  const durations = runs.filter((r) => r.status !== 'cancelled').map((r) => ms(r.started_at, r.ended_at)).filter((d): d is number => d !== null);
  const doneSessions = sessions.filter((s) => s.status === 'completed' && !wfSessionIds.has(s.id)).map((s) => ms(s.created_at, s.updated_at)).filter((d): d is number => d !== null);
  const wfDurations = wfRows.filter((w) => w.status === 'completed' && w.updated_at >= since).map((w) => ms(w.created_at, w.updated_at)).filter((d): d is number => d !== null);
  const aps = q.all<any>(`SELECT a.action, a.status, a.created_at, a.decided_at, a.consumed_at, a.expires_at FROM approval a JOIN session s ON s.id=a.session_id WHERE a.created_at >= ? AND (? IS NULL OR s.project_id=?) AND ${notDemo('s.title')}`, since, pid, pid);
  const waits = aps.map((a) => ms(a.created_at, a.decided_at)).filter((d): d is number => d !== null);
  const byAction = new Map<string, { action: string; requested: number; approved: number; rejected: number; pending: number; waitsMs: number[] }>();
  for (const a of aps) { const b = byAction.get(a.action) ?? { action: a.action, requested: 0, approved: 0, rejected: 0, pending: 0, waitsMs: [] }; byAction.set(a.action, b);
    b.requested++; if (a.status === 'approved') b.approved++; else if (a.status === 'rejected') b.rejected++; else b.pending++; const w = ms(a.created_at, a.decided_at); if (w !== null) b.waitsMs.push(w); }
  const touched = accepted.filter((u) => u.humanTouches > 0);
  const firstTry = accepted.filter((u) => u.firstAttempt);

  const result = {
    generatedAt: now.toISOString(), windowDays: days, since, projectId: pid, minSample: MIN_SAMPLE,
    totals: { runs: runs.length, finished: finished.length, completed: runs.filter((r) => r.status === 'completed').length, failed: runs.filter((r) => r.status === 'failed').length, cancelled: runs.filter((r) => r.status === 'cancelled').length,
      reportedRuns: known.length, unknownCostRuns: runs.length - known.length, reportedUsd: round(sum(known.map((r) => r.cost))),
      inputTokens: sum(runs.map((r) => r.in_tok)), outputTokens: sum(runs.map((r) => r.out_tok)) },
    cost: {
      byModel: [...byModel.values()].map((m) => ({ model: m.model, runs: m.runs, completed: m.completed, failed: m.failed, reportedRuns: m.reportedRuns, costUsd: round(m.costUsd), medianDurationMs: median(m.durationsMs),
        completionRate: round(rate(m.completed, m.completed + m.failed)), avgCostPerRunUsd: round(m.reportedRuns ? m.costUsd / m.reportedRuns : null) })).sort((a, b) => b.runs - a.runs),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, costUsd: round(d.costUsd) })),
    },
    accepted: {
      definition: 'A workflow whose merge-ready gate a person approved and that completed, or a standalone session that completed.',
      units: units.length, accepted: accepted.length, notAccepted: notAccepted.length, acceptanceRate: round(rate(accepted.length, units.length)),
      costPerAcceptedUsd: round(acceptedPriced.length ? sum(acceptedPriced.map((u) => u.costUsd)) / acceptedPriced.length : null), acceptedWithCost: acceptedPriced.length,
      costPerAcceptedCompleteUsd: round(completeCost.length ? sum(completeCost.map((u) => u.costUsd)) / completeCost.length : null), acceptedWithCompleteCost: completeCost.length,
      spendOnNotAcceptedUsd: round(sum(notAccepted.map((u) => u.costUsd))), notAcceptedWithCost: notAccepted.filter((u) => u.reportedRuns > 0).length,
      byKind: (['workflow', 'session'] as const).map((k) => { const us = units.filter((u) => u.kind === k); const a = us.filter((u) => u.accepted); const p = a.filter((u) => u.reportedRuns > 0);
        return { kind: k, units: us.length, accepted: a.length, costPerAcceptedUsd: round(p.length ? sum(p.map((u) => u.costUsd)) / p.length : null), acceptedWithCost: p.length, medianRunsPerAccepted: median(a.map((u) => u.runs)) }; }),
      recent: [...units].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12).map((u) => ({ kind: u.kind, id: u.id, title: u.title, status: u.status, accepted: u.accepted, runs: u.runs, reportedRuns: u.reportedRuns, costUsd: u.reportedRuns ? round(u.costUsd) : null, at: u.at })),
    },
    routing: {
      decisions: decisions.length, byTier: [...tierCount].map(([tier, n]) => ({ tier, decisions: n })).sort((a, b) => b.decisions - a.decisions),
      escalated: escalated.length, escalationRate: round(rate(escalated.length, decisions.length)), transitions: [...trans].map(([path, n]) => ({ path, decisions: n })).sort((a, b) => b.decisions - a.decisions),
      escalatedRunsFinished: escDone.length, escalatedRunsCompleted: escDone.filter((r) => r.status === 'completed').length, escalatedSuccessRate: round(rate(escDone.filter((r) => r.status === 'completed').length, escDone.length)),
      escalatedCostUsd: round(sum(escRuns.map((r) => r.cost))), escalatedCostRuns: escRuns.filter((r) => r.cost !== null).length,
      tasksWithRetries: multi.length, extraRuns: multi.reduce((a, b) => a + b.length - 1, 0), tasksRecoveredByRetry: recovered.length, refusedByRetryLimit: refused,
      workflowRetries: wfRetry, workflowRetryLimitsHit: wfRetryLimit,
      savings: est && top ? { basis: 'routing-policy estimates, not measured cost', ceilingTier: top, runsOnCheaperTier: cheaper.length, estimatedUsd: round(sum(cheaper.map((d) => est[top] - est[d.route.tier]))) } : null,
    },
    reliability: {
      failureRate: round(rate(runs.filter((r) => r.status === 'failed').length, finished.length)), failuresByCause: [...failures].map(([cause, n]) => ({ cause, runs: n })).sort((a, b) => b.runs - a.runs),
      checkpointsSaved: evCount('checkpoint.saved'), checkpointsFailed: evCount('checkpoint.failed'), resumes: evCount('session.resume'),
      resumedSessions: resumedSessions.length, resumedThenCompleted: resumedSessions.filter((s) => s.status === 'completed').length,
      recoveryRate: round(rate(resumedSessions.filter((s) => s.status === 'completed').length, resumedSessions.filter((s) => ['completed', 'failed', 'cancelled'].includes(s.status)).length)),
      orphaned: failures.get('orphaned by restart') ?? 0, handoffs: handoffs.length, handoffsRefused: handoffs.filter((h) => h.status === 'refused').length,
    },
    time: {
      runMedianMs: median(durations), runP90Ms: pct(durations, 0.9), runsTimed: durations.length,
      sessionMedianMs: median(doneSessions), sessionsTimed: doneSessions.length, workflowMedianMs: median(wfDurations), workflowsTimed: wfDurations.length,
    },
    humans: {
      approvalsRequested: aps.length, approved: aps.filter((a) => a.status === 'approved').length, rejected: aps.filter((a) => a.status === 'rejected').length, pending: aps.filter((a) => a.status === 'pending').length,
      medianWaitMs: median(waits), p90WaitMs: pct(waits, 0.9),
      byAction: [...byAction.values()].map((a) => ({ action: a.action, requested: a.requested, approved: a.approved, rejected: a.rejected, pending: a.pending, medianWaitMs: median(a.waitsMs) })).sort((a, b) => b.requested - a.requested),
      acceptedNeedingAPerson: touched.length, acceptedWithoutAPerson: accepted.length - touched.length, firstAttemptAccepted: firstTry.length,
      firstAttemptRate: round(rate(firstTry.length, accepted.length)), resumes: evCount('session.resume'),
    },
    insights: [] as { topic: 'cost' | 'escalation' | 'failure' | 'quality' | 'people'; text: string; basis: string }[],
  };
  result.insights = insightsOf(result);
  return result;
}
export type Analytics = ReturnType<typeof buildAnalytics>;

const usd = (n: number | null) => (n === null ? 'unknown' : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const p = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);

/**
 * Plain-language findings, each with the numbers behind it. A finding is only produced when there is enough data;
 * otherwise a single "not enough data" line says how much is missing, instead of a confident-sounding guess.
 */
export function insightsOf(a: Omit<Analytics, 'insights'> & { insights?: unknown }): Analytics['insights'] {
  const out: Analytics['insights'] = []; const n = a.minSample;
  if (a.totals.runs < n) return [{ topic: 'quality', text: `Not enough runs yet to say anything reliable (${a.totals.runs} in ${a.windowDays} days; at least ${n} needed).`, basis: `${a.totals.runs} runs` }];
  if (a.totals.unknownCostRuns > 0) out.push({ topic: 'cost', text: `${a.totals.unknownCostRuns} of ${a.totals.runs} runs reported no cost, so cost totals are lower bounds, not exact.`, basis: `${a.totals.reportedRuns} of ${a.totals.runs} runs reported` });
  if (a.accepted.accepted >= 1 && a.accepted.costPerAcceptedUsd !== null) {
    const waste = a.accepted.spendOnNotAcceptedUsd ?? 0;
    out.push({ topic: 'cost', text: `An accepted piece of work cost ${usd(a.accepted.costPerAcceptedUsd)} on average (${a.accepted.acceptedWithCost} of ${a.accepted.accepted} had reported cost).${waste > 0 ? ` ${usd(waste)} was spent on work that was not accepted.` : ''}`, basis: `${a.accepted.accepted} accepted of ${a.accepted.units}` });
  }
  const cheap = a.routing.savings;
  if (cheap && cheap.runsOnCheaperTier >= n) out.push({ topic: 'cost', text: `${cheap.runsOnCheaperTier} runs were routed below the ${cheap.ceilingTier} tier. By the routing policy's own estimates that avoided about ${usd(cheap.estimatedUsd)}. This is an estimate, not a measurement.`, basis: cheap.basis });
  if (a.routing.decisions >= n) {
    if (a.routing.escalated === 0) out.push({ topic: 'escalation', text: `No run needed escalating to a stronger model (${a.routing.decisions} routing decisions).`, basis: `${a.routing.decisions} decisions` });
    else out.push({ topic: 'escalation', text: `${p(a.routing.escalationRate)} of routing decisions were escalations (${a.routing.escalated} of ${a.routing.decisions}), most often ${a.routing.transitions[0]?.path ?? 'n/a'}. ${a.routing.escalatedRunsFinished >= n ? `Escalated runs succeeded ${p(a.routing.escalatedSuccessRate)} of the time.` : `Too few escalated runs finished to judge whether escalating helps (${a.routing.escalatedRunsFinished}).`}`, basis: `${a.routing.escalated} escalated` });
  }
  if (a.totals.finished >= n) {
    const top = a.reliability.failuresByCause[0];
    out.push({ topic: 'failure', text: top ? `${p(a.reliability.failureRate)} of finished runs failed. The most common cause was "${top.cause}" (${top.runs}).` : `No run failed in ${a.totals.finished} finished runs.`, basis: `${a.totals.finished} finished runs` });
    const weak = a.cost.byModel.filter((m) => m.completed + m.failed >= n && (m.completionRate ?? 1) < 0.7).sort((x, y) => (x.completionRate ?? 1) - (y.completionRate ?? 1))[0];
    if (weak) out.push({ topic: 'quality', text: `${weak.model} completed only ${p(weak.completionRate)} of its runs (${weak.completed} of ${weak.completed + weak.failed}). Check whether it is being given work above its tier.`, basis: `${weak.completed + weak.failed} finished runs` });
  }
  if (a.accepted.units >= n) out.push({ topic: 'quality', text: `${p(a.accepted.acceptanceRate)} of finished work was accepted. ${p(a.humans.firstAttemptRate)} of accepted work passed without a retry, so quality ${a.accepted.acceptanceRate !== null && a.accepted.acceptanceRate >= 0.8 && (a.humans.firstAttemptRate ?? 0) >= 0.5 ? 'looks maintained' : 'needs attention'} on this sample.`, basis: `${a.accepted.units} finished units` });
  if (a.humans.approvalsRequested >= 1) out.push({ topic: 'people', text: `${a.humans.approvalsRequested} approvals were requested; ${a.humans.pending} are still waiting.${a.humans.medianWaitMs !== null ? ` The median decision took ${dur(a.humans.medianWaitMs)}.` : ''}`, basis: `${a.humans.approvalsRequested} requests` });
  if (!out.length) out.push({ topic: 'quality', text: 'Nothing stands out in this period.', basis: `${a.totals.runs} runs` });
  return out;
}
const dur = (v: number) => (v < 1000 ? `${v} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : v < 3_600_000 ? `${Math.round(v / 60_000)} min` : `${(v / 3_600_000).toFixed(1)} h`);
