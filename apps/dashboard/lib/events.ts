import type { DomainEvent } from './types.ts';
import type { Tone } from './status.ts';
import { usd } from './format.ts';

/**
 * Merge incoming events into the list: unique by `seq`, sorted ascending. The stream replays from the
 * start after every reconnect, and the same event can arrive twice, so this must be idempotent.
 */
export function mergeEvents(existing: DomainEvent[], incoming: DomainEvent[]): DomainEvent[] {
  if (!incoming.length) return existing;
  const bySeq = new Map<number, DomainEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  let changed = false;
  for (const e of incoming) if (!bySeq.has(e.seq)) { bySeq.set(e.seq, e); changed = true; }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : existing;
}

export interface EventView { title: string; detail?: string; tone: Tone }

const toneForState = (s: string): Tone => (s === 'completed' ? 'good' : s === 'failed' ? 'bad' : s === 'running' ? 'info' : s === 'paused' || s === 'blocked' ? 'warn' : 'muted');
const clip = (s: string, n = 240) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Human wording for an event. Unknown types fall back to their raw name, so new events never break the UI. */
export function describeEvent(e: DomainEvent): EventView {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'session.created': return { title: 'Session created', detail: p.title, tone: 'muted' };
    case 'session.status': return { title: `Session ${p.from} → ${p.to}`, detail: p.reason, tone: toneForState(p.to) };
    case 'task.created': return { title: 'Task created', tone: 'muted' };
    case 'task.status': return { title: `Task ${p.from} → ${p.to}`, detail: p.reason, tone: toneForState(p.to) };
    case 'run.created': return { title: 'Run created', detail: `${p.role ?? 'agent'} · ${p.model ?? ''}`.trim(), tone: 'muted' };
    case 'run.status': {
      const bits = [p.reason, p.exitCode !== undefined ? `exit ${p.exitCode}` : '', p.pid ? `pid ${p.pid}` : ''].filter(Boolean);
      return { title: `Run ${p.from} → ${p.to}`, detail: bits.join(' · ') || undefined, tone: toneForState(p.to) };
    }
    case 'agent.init': return { title: 'Agent started', detail: p.model, tone: 'info' };
    case 'agent.message': {
      const tools = Array.isArray(p.tools) && p.tools.length ? `uses ${p.tools.join(', ')}` : '';
      return { title: p.text ? 'Agent says' : tools ? 'Agent acts' : 'Agent thinking', detail: [p.text ? clip(p.text) : '', tools].filter(Boolean).join(' — ') || undefined, tone: 'muted' };
    }
    case 'agent.tool_result': return { title: p.isError ? 'Tool error' : 'Tool finished', detail: p.summary ? clip(String(p.summary), 160) : undefined, tone: p.isError ? 'bad' : 'muted' };
    case 'agent.result': return { title: p.ok ? 'Agent finished' : 'Agent reported an error', detail: [p.text ? clip(p.text, 160) : '', typeof p.costUsd === 'number' ? `cost ${usd(p.costUsd)}` : ''].filter(Boolean).join(' · ') || undefined, tone: p.ok ? 'good' : 'bad' };
    case 'checkpoint.saved': return { title: `Checkpoint #${p.seq} saved`, tone: 'muted' };
    case 'checkpoint.failed': return { title: 'Checkpoint failed', detail: p.error, tone: 'warn' };
    case 'worktree.locked': return { title: 'Working directory locked', detail: p.path, tone: 'muted' };
    case 'worktree.unlocked': return { title: 'Working directory released', detail: p.path, tone: 'muted' };
    case 'session.resume': return { title: `Resumed (${p.mode})`, detail: [`drift: ${p.drift}`, ...(p.notes ?? [])].join(' · '), tone: 'info' };
    case 'approval.requested': return { title: 'Approval requested', detail: p.action, tone: 'warn' };
    case 'approval.decided': return { title: `Approval ${p.status}`, detail: p.approver, tone: p.status === 'approved' ? 'good' : 'bad' };
    default: return { title: e.type, tone: 'muted' };
  }
}

/** Events after which the session, runs or file changes may have changed and should be refetched. */
export const refreshHint = (e: DomainEvent): { session: boolean; changes: boolean } => ({
  session: /^(session|task|run|checkpoint)\./.test(e.type),
  changes: e.type === 'agent.tool_result' || e.type.startsWith('run.') || e.type.startsWith('checkpoint.'),
});
