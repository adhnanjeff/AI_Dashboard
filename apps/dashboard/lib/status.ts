import type { Run, SessionDetail, WorkState } from './types.ts';

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'muted';

// Status is always shown as a glyph + a word + a colour, never colour alone.
export const STATE_META: Record<WorkState, { label: string; glyph: string; tone: Tone }> = {
  queued: { label: 'Queued', glyph: '○', tone: 'muted' },
  running: { label: 'Running', glyph: '●', tone: 'info' },
  paused: { label: 'Paused', glyph: '⏸', tone: 'warn' },
  blocked: { label: 'Blocked', glyph: '⛔', tone: 'warn' },
  failed: { label: 'Failed', glyph: '✕', tone: 'bad' },
  completed: { label: 'Completed', glyph: '✓', tone: 'good' },
  cancelled: { label: 'Cancelled', glyph: '⊘', tone: 'muted' },
};
export const stateMeta = (s: string) => STATE_META[s as WorkState] ?? { label: s, glyph: '?', tone: 'muted' as Tone };

export interface Actions { start: boolean; cancel: boolean; resume: boolean; why: string }

/**
 * Which controls make sense right now. The backend remains the authority and re-validates every action;
 * this only decides what to offer so the user is not shown buttons that are bound to fail.
 */
export function availableActions(detail: SessionDetail, runs: Run[]): Actions {
  const s = detail.session.status;
  const active = runs.some((r) => r.status === 'running');
  const hasQueuedTask = detail.tasks.some((t) => t.status === 'queued');
  if (active) return { start: false, cancel: true, resume: false, why: 'A run is active.' };
  if (s === 'queued' && hasQueuedTask) return { start: true, cancel: false, resume: false, why: 'Not started yet.' };
  if ((s === 'paused' || s === 'failed') && detail.checkpoint)
    return { start: false, cancel: false, resume: true, why: s === 'paused' ? 'Paused: resume continues from the latest checkpoint.' : 'Failed: resume retries from the latest checkpoint.' };
  if (s === 'paused' || s === 'failed') return { start: false, cancel: false, resume: false, why: 'No checkpoint to resume from.' };
  if (s === 'completed') return { start: false, cancel: false, resume: false, why: 'Completed.' };
  return { start: false, cancel: false, resume: false, why: 'Nothing to do right now.' };
}

/** Demo rows come from `npm run db:seed` and must never be mistaken for real runtime data. */
export const isDemo = (title: string) => title.startsWith('demo:');
