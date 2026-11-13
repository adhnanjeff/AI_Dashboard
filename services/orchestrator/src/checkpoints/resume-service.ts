import type { AgentRun, QueueItem } from '../domain/types.ts';
import type { Scheduler } from '../routing/scheduler.ts';
import type { Store } from '../storage/store.ts';
import type { Supervisor } from '../runtime/process-manager/supervisor.ts';
import type { MemoryService } from '../memory/memory-service.ts';
import { buildResumePrompt, type CheckpointService, type Drift } from './checkpoint-service.ts';

export class ResumeError extends Error {
  drift?: Drift;
  constructor(msg: string, drift?: Drift) { super(msg); this.drift = drift; }
}

export interface ResumeOptions {
  /** Required when no scheduler is attached. With a scheduler, absent = the routing policy chooses. */
  model?: string; timeoutMs?: number; idempotencyKey?: string;
  /** Run on a specific provider / registered account (handoff). Absent = whichever can take the model. */
  provider?: string; accountId?: string; origin?: 'resume' | 'handoff';
  /**
   * portable (default): a brand-new provider session seeded only from the checkpoint. Works on any
   *   account/provider and does not depend on the old conversation.
   * native: also passes the provider's own --resume id. Only valid for the same provider/account.
   */
  mode?: 'portable' | 'native';
}

// Resume = verify the checkpoint against the real repository, then start a FRESH worker that is told
// to inspect the current state before editing. It never resets or cleans anything.
export class ResumeService {
  private store: Store; private supervisor: Supervisor; private checkpoints: CheckpointService; private memory?: MemoryService; private scheduler?: Scheduler;
  constructor(store: Store, supervisor: Supervisor, checkpoints: CheckpointService, memory?: MemoryService, scheduler?: Scheduler) {
    this.store = store; this.supervisor = supervisor; this.checkpoints = checkpoints; this.memory = memory; this.scheduler = scheduler;
  }

  /** Dry run: what would resume do, and is it safe? Read-only. */
  check(sessionId: string): { checkpointId: string; nextAction: string; drift: Drift } {
    const cp = this.checkpoints.latest(sessionId);
    if (!cp) throw new ResumeError('session has no checkpoint');
    return { checkpointId: cp.id, nextAction: cp.nextAction, drift: this.checkpoints.verify(cp) };
  }

  resume(sessionId: string, o: ResumeOptions): { run: AgentRun | null; queued?: QueueItem; drift: Drift | null; replayed: boolean } {
    if (o.idempotencyKey) {
      const prior = this.supervisor.findByKey(o.idempotencyKey);
      if (prior) return { run: prior, drift: null, replayed: true };
    }
    const session = this.store.getSession(sessionId); if (!session) throw new ResumeError('session not found');
    if (session.status !== 'paused' && session.status !== 'failed')
      throw new ResumeError(`session is ${session.status}; only paused or failed sessions can be resumed`);
    const cp = this.checkpoints.latest(sessionId); if (!cp) throw new ResumeError('session has no checkpoint to resume from');
    const task = cp.data.taskId ? this.store.getTask(cp.data.taskId) : undefined;
    if (!task) throw new ResumeError('checkpoint does not reference a task');
    if (task.status !== 'paused' && task.status !== 'failed') throw new ResumeError(`task is ${task.status}; nothing to resume`);

    const drift = this.checkpoints.verify(cp);
    if (drift.level === 'blocked') throw new ResumeError(`resume blocked: ${drift.notes.join('; ')}`, drift);

    let resumeId: string | undefined;
    if (o.mode === 'native') {
      // The provider's own conversation id means nothing to another provider or another login.
      const lastId = this.store.latestRunIdForSession(sessionId); const last = lastId ? this.store.getRun(lastId) : undefined;
      if (last && ((o.provider && o.provider !== last.provider) || (o.accountId !== undefined && o.accountId !== (last.accountId ?? undefined))))
        throw new ResumeError('native resume only works on the same provider and account; use portable mode to move work');
      if (!cp.data.cliSessionId) throw new ResumeError('native resume needs a provider session id, but the checkpoint has none');
      resumeId = cp.data.cliSessionId;
    }
    this.store.appendEvent({ sessionId, type: 'session.resume', payload: {
      checkpointId: cp.id, mode: o.mode ?? 'portable', drift: drift.level, notes: drift.notes, checkpointEventSeq: cp.data.lastEventSeq } });
    // Relevant notes only (not the whole memory), chosen by what the worker must do next.
    const memoryBlock = this.memory?.contextFor(sessionId, `${task.description} ${task.acceptanceCriteria.join(' ')} ${cp.nextAction}`) ?? '';
    const prompt = buildResumePrompt(cp, drift, memoryBlock);
    if (this.scheduler) {
      const r = this.scheduler.launch({ taskId: task.id, prompt, cwd: cp.data.cwd, model: o.model, provider: o.provider, accountId: o.accountId,
        timeoutMs: o.timeoutMs, resumeId, idempotencyKey: o.idempotencyKey, origin: o.origin ?? 'resume' });
      return r.kind === 'started' ? { run: r.run, drift, replayed: !!r.replayed } : { run: null, queued: r.item, drift, replayed: false };
    }
    if (!o.model) throw new ResumeError('model is required');
    const run = this.supervisor.start({ taskId: task.id, prompt, cwd: cp.data.cwd, model: o.model,
      timeoutMs: o.timeoutMs, resumeId, idempotencyKey: o.idempotencyKey });
    return { run, drift, replayed: false };
  }
}
