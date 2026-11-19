import type { Store } from '../storage/store.ts';
import type { WorkflowEngine } from '../workflows/engine.ts';

/**
 * Phase 11: a read-only picture of real work for the Agent Factory view.
 *
 * Everything here is derived from rows the runtime and workflow engine already wrote (sessions, tasks, runs, workflow
 * steps, events). Nothing is invented and nothing is simulated: if no run exists there are no items. Seeded demo
 * sessions (`demo:` titles) are included but flagged `demo: true` so they can never be mistaken for real activity.
 */

export const STATIONS = [
  { id: 'planning', label: 'Planning', blurb: 'Agents that read the goal and plan the work.' },
  { id: 'coding', label: 'Coding', blurb: 'Agents that write code or documentation in their own workspace.' },
  { id: 'testing', label: 'Testing', blurb: 'Test agents and the checks (commands) that verify the work.' },
  { id: 'reviewing', label: 'Reviewing', blurb: 'Read-only reviewers that report findings.' },
  { id: 'integration', label: 'Integration', blurb: 'Combining parts, the merge check and the human approval gate.' },
] as const;
export type StationId = (typeof STATIONS)[number]['id'];

/** One word for every state an item can be in. `queued` also covers a workflow step that has not started. */
export type FactoryState = 'queued' | 'running' | 'paused' | 'blocked' | 'waiting_approval' | 'failed' | 'completed' | 'cancelled' | 'skipped';

export interface FactoryItem {
  key: string; source: 'session' | 'workflow'; label: string; station: StationId; state: FactoryState;
  /** The status string exactly as stored, so the view can show what the database says. */
  rawStatus: string; kind: string; role: string | null;
  model: string | null; provider: string | null; attempt: number | null;
  sessionId: string | null; runId: string | null; workflowId: string | null; workflowTitle: string | null; stepKey: string | null;
  startedAt: string | null; endedAt: string | null; updatedAt: string | null;
  /** Last thing the agent said, truncated. Null when it has said nothing. */
  lastOutput: string | null;
  /** Why it is in this state, when something recorded a reason (failure text, halt reason, approval request). */
  note: string | null;
  demo: boolean;
}
export interface ActivityEntry { at: string; source: 'event' | 'workflow'; type: string; text: string; sessionId: string | null; workflowId: string | null; stepKey: string | null }
export interface FactorySnapshot {
  generatedAt: string;
  stations: { id: StationId; label: string; blurb: string; counts: Record<string, number>; total: number }[];
  items: FactoryItem[];
  activity: ActivityEntry[];
  totals: { real: number; demo: number; active: number };
  note: string;
}

const STATION_OF_ROLE: Record<string, StationId> = { planner: 'planning', coder: 'coding', docs: 'coding', tester: 'testing', reviewer: 'reviewing' };
function stationForStep(kind: string, role: string | null): StationId {
  if (kind === 'check') return 'testing';
  if (kind === 'review') return 'reviewing';
  if (kind === 'integrate' || kind === 'merge_ready' || kind === 'approval') return 'integration';
  return STATION_OF_ROLE[role ?? 'coder'] ?? 'coding';
}
const STEP_STATE: Record<string, FactoryState> = { pending: 'queued', running: 'running', waiting_approval: 'waiting_approval', passed: 'completed', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled' };
const ACTIVITY_TYPES = ['run.status', 'agent.result', 'approval.requested', 'approval.decided', 'task.status', 'provider.rate_limited', 'provider.handoff', 'routing.refused', 'checkpoint.saved', 'checkpoint.failed', 'queue.added', 'session.resume'];
const clip = (s: unknown, n: number) => { const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null; };

export function buildFactorySnapshot(store: Store, flows: WorkflowEngine, o: { projectId?: string; activityLimit?: number } = {}): FactorySnapshot {
  const q = store.sql(); const items: FactoryItem[] = [];
  const lastOutput = (sessionId: string | null): string | null => {
    if (!sessionId) return null;
    const row = q.one<{ payload: string }>("SELECT payload FROM event WHERE session_id=? AND type IN ('agent.message','agent.result') ORDER BY seq DESC LIMIT 1", sessionId);
    if (!row) return null;
    try { const p = JSON.parse(row.payload); return clip(p.text ?? p.result ?? p.message, 240); } catch { return null; }
  };
  const owned = new Set<string>(); const wfTitles: { title: string; projectId: string }[] = [];

  for (const w of flows.list(o.projectId)) {
    const d = flows.get(w.id); wfTitles.push({ title: w.title, projectId: w.projectId });
    for (const r of q.all<{ content: string }>("SELECT content FROM workflow_evidence WHERE workflow_id=? AND kind='anchor'", w.id)) owned.add(r.content);
    for (const s of d.steps) {
      if (s.state.sessionId) owned.add(s.state.sessionId);
      const failure = s.state.detail?.failure ? clip(s.state.detail.failure, 200) : null;
      const appr = d.approvals.find((a) => a.step === s.id && a.status === 'pending');
      const session = s.state.sessionId ? store.getSession(s.state.sessionId) : undefined;
      items.push({
        key: `wf:${w.id}:${s.id}`, source: 'workflow', label: s.title ?? s.id, station: stationForStep(s.kind, s.role ?? null), state: STEP_STATE[s.state.status] ?? 'queued',
        rawStatus: s.state.status, kind: s.kind, role: s.role ?? null, model: s.run?.model ?? null, provider: s.run?.provider ?? null, attempt: s.state.attempts || null,
        sessionId: s.state.sessionId, runId: s.state.runId, workflowId: w.id, workflowTitle: w.title, stepKey: s.id,
        startedAt: s.state.startedAt, endedAt: s.state.endedAt, updatedAt: s.state.endedAt ?? s.state.startedAt ?? w.updatedAt,
        lastOutput: lastOutput(s.state.sessionId), note: appr ? appr.action : failure ?? (s.state.status === 'pending' && w.status === 'failed' ? w.haltedReason : null),
        demo: !!session?.title.startsWith('demo:'),
      });
    }
  }

  for (const s of store.listSessions(o.projectId)) {
    if (owned.has(s.id) || s.title.startsWith('Workflow: ') || wfTitles.some((w) => w.projectId === s.projectId && s.title.startsWith(`${w.title}: `))) continue;
    const runId = store.latestRunIdForSession(s.id); const run = runId ? store.getRun(runId) : undefined;
    const role = run?.role ?? 'coder';
    items.push({
      key: `s:${s.id}`, source: 'session', label: s.title, station: STATION_OF_ROLE[role] ?? 'coding', state: s.status, rawStatus: s.status, kind: 'agent', role,
      model: run?.model ?? null, provider: run?.provider ?? null, attempt: runId ? store.listRunsForSession(s.id).length : null,
      sessionId: s.id, runId: runId ?? null, workflowId: null, workflowTitle: null, stepKey: null,
      startedAt: run?.startedAt ?? null, endedAt: run?.endedAt ?? null, updatedAt: s.updatedAt, lastOutput: lastOutput(s.id),
      note: s.status === 'failed' || s.status === 'blocked' ? clip(run?.terminationReason, 200) : null, demo: s.title.startsWith('demo:'),
    });
  }

  const limit = Math.min(o.activityLimit ?? 40, 100); const activity: ActivityEntry[] = [];
  const ph = ACTIVITY_TYPES.map(() => '?').join(',');
  for (const e of q.all<any>(`SELECT e.session_id, e.type, e.payload, e.created_at FROM event e ${o.projectId ? 'JOIN session s ON s.id=e.session_id WHERE s.project_id=? AND' : 'WHERE'} e.type IN (${ph}) ORDER BY e.rowid DESC LIMIT ?`, ...(o.projectId ? [o.projectId] : []), ...ACTIVITY_TYPES, limit)) {
    let p: any = {}; try { p = JSON.parse(e.payload); } catch { /* keep empty */ }
    const text = e.type === 'run.status' ? `run ${p.from ? `${p.from} → ` : ''}${p.to ?? p.status ?? '?'}${p.reason ? ` (${clip(p.reason, 100)})` : ''}`
      : e.type === 'agent.result' ? `agent finished: ${clip(p.text ?? p.result, 100) ?? 'no text'}`
      : e.type === 'task.status' ? `task ${p.from ? `${p.from} → ` : ''}${p.to ?? p.status ?? '?'}`
      : e.type === 'approval.requested' ? `approval requested: ${clip(p.action, 100) ?? ''}` : e.type === 'approval.decided' ? `approval ${p.to ?? p.status ?? 'decided'} by ${p.approver ?? '?'}` : e.type;
    activity.push({ at: e.created_at, source: 'event', type: e.type, text, sessionId: e.session_id, workflowId: null, stepKey: null });
  }
  for (const t of q.all<any>(`SELECT t.workflow_id, t.step_key, t.to_status, t.reason, t.at FROM workflow_transition t ${o.projectId ? 'JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=?' : ''} ORDER BY t.id DESC LIMIT ?`, ...(o.projectId ? [o.projectId] : []), limit))
    activity.push({ at: t.at, source: 'workflow', type: 'workflow.transition', text: `${t.step_key ?? 'workflow'} → ${t.to_status}: ${clip(t.reason, 120)}`, sessionId: null, workflowId: t.workflow_id, stepKey: t.step_key });
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); activity.length = Math.min(activity.length, limit);

  const live = (i: FactoryItem) => i.state === 'running' || i.state === 'waiting_approval';
  const stations = STATIONS.map((st) => {
    const mine = items.filter((i) => i.station === st.id); const counts: Record<string, number> = {};
    for (const i of mine) counts[i.state] = (counts[i.state] ?? 0) + 1;
    return { id: st.id, label: st.label, blurb: st.blurb, counts, total: mine.length };
  });
  return {
    generatedAt: new Date().toISOString(), stations, items, activity,
    totals: { real: items.filter((i) => !i.demo).length, demo: items.filter((i) => i.demo).length, active: items.filter(live).length },
    note: 'Built from runtime and workflow records only. Nothing is simulated; items marked demo come from seeded sample data.',
  };
}
