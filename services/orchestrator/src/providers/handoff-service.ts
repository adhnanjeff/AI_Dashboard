import type { AgentRun, HandoffRecord, QueueItem } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import { snapshot } from '../checkpoints/git.ts';
import type { CheckpointService, Drift } from '../checkpoints/checkpoint-service.ts';
import { ResumeError, type ResumeService } from '../checkpoints/resume-service.ts';
import type { Supervisor } from '../runtime/process-manager/supervisor.ts';
import { lockKey } from '../runtime/process-manager/supervisor.ts';
import type { ProviderRegistry } from './registry.ts';
import type { ProviderService } from './accounts.ts';

export class HandoffError extends Error {
  status: number; details?: unknown;
  constructor(status: number, msg: string, details?: unknown) { super(msg); this.status = status; this.details = details; }
}
export interface HandoffInput { toProvider: string; toAccountId?: string; model: string; reason: string; actor?: string; timeoutMs?: number }
export interface HandoffResult { handoff: HandoffRecord; run: AgentRun | null; queued?: QueueItem; drift: Drift }

// Moving a session to another execution adapter/account. This is a recoverable hand-over of WORK, built on
// the same portable checkpoint as a normal resume. It is deliberately not a way around a usage limit:
//   * it only ever goes to an adapter/account the user registered and enabled,
//   * it never moves a rate-limited account's work to another account of the SAME provider,
//   * it never retries by itself: if the target has no capacity the work is queued, once.
// Order matters and is enforced here: stop the old worker -> checkpoint -> verify repo/branch/diff ->
// only then let the next worker start.
export class HandoffService {
  private d: { store: Store; supervisor: Supervisor; checkpoints: CheckpointService; resumer: ResumeService; providers: ProviderService; registry: ProviderRegistry; workdir: (sessionId: string) => string };
  constructor(deps: HandoffService['d']) { this.d = deps; }

  async handoff(sessionId: string, i: HandoffInput): Promise<HandoffResult> {
    const { store, supervisor, checkpoints, resumer, providers, registry } = this.d;
    const actor = i.actor ?? 'user';
    const session = store.getSession(sessionId); if (!session) throw new HandoffError(404, 'session not found');
    if (typeof i.reason !== 'string' || i.reason.trim().length < 3) throw new HandoffError(400, 'a reason is required (it is kept in the audit trail)');
    if (!['running', 'paused', 'failed'].includes(session.status)) throw new HandoffError(409, `session is ${session.status}; only a running, paused or failed session can be handed off`);

    // ---- validate the target BEFORE stopping anything
    const target = registry.get(i.toProvider); if (!target) throw new HandoffError(400, `unknown provider: ${i.toProvider}`);
    if (!registry.supports(i.toProvider, i.model)) throw new HandoffError(400, `${i.toProvider} does not support model ${i.model}`);
    if (target.capabilities && !target.capabilities.canEditFiles) throw new HandoffError(400, `${i.toProvider} cannot edit files, so it cannot continue this work`);
    if (i.toAccountId) {
      const a = store.getAccount(i.toAccountId);
      if (!a || a.provider !== i.toProvider || !a.enabled) throw new HandoffError(400, 'that account is not an enabled account of that provider');
    }
    const lastId = store.latestRunIdForSession(sessionId); const last = lastId ? store.getRun(lastId) : undefined;
    if (!last) throw new HandoffError(409, 'session has no run to hand off');
    const from = { provider: last.provider, accountId: last.accountId ?? null };
    if (from.provider === i.toProvider && from.accountId === (i.toAccountId ?? null)) throw new HandoffError(400, 'the work is already on that provider and account; use resume instead');

    const notes: string[] = [];
    const base = { sessionId, fromRunId: last.id, fromProvider: from.provider, fromAccountId: from.accountId, toProvider: i.toProvider, toAccountId: i.toAccountId ?? null, toModel: i.model, reason: i.reason, actor };
    const refuse = (msg: string, status = 409, extra: Partial<HandoffRecord> = {}): never => {
      const rec = store.addHandoff({ ...base, toRunId: null, checkpointId: null, driftLevel: null, fingerprint: null, ...extra, status: 'refused', notes: [...notes, msg] });
      store.appendEvent({ sessionId, type: 'provider.handoff', payload: { handoffId: rec.id, status: 'refused', to: i.toProvider, reason: msg } });
      store.audit(actor, 'handoff.refused', `session:${sessionId}`, { to: i.toProvider, reason: msg });
      throw new HandoffError(status, msg, { handoffId: rec.id });
    };

    // Same provider, source limited: that would be hopping accounts to get around a limit. Refuse.
    if (from.provider === i.toProvider) {
      const src = providers.availabilityOf(from.provider, from.accountId);
      if (!src.available) refuse(`the current account is rate limited (${src.reason}). Moving the work to another account of the same provider would bypass that limit. Wait until the limit lifts or choose a different provider.`);
    }

    store.audit(actor, 'handoff.requested', `session:${sessionId}`, { from: from.provider, to: i.toProvider, model: i.model, reason: i.reason });

    // ---- 1. stop the old worker and wait until it has really ended
    const activeId = supervisor.activeRunFor(sessionId);
    if (activeId) {
      await supervisor.pauseSession(sessionId);
      notes.push(`stopped run ${activeId}`);
    } else if (session.status === 'running') {
      refuse('session is marked running but no worker is attached; restart the orchestrator so orphan recovery can settle it first');
    }
    if (supervisor.activeRunFor(sessionId)) refuse('the previous worker is still running; not starting another');
    const cwd = this.d.workdir(sessionId);
    if (store.getWorktreeLock(lockKey(cwd))) refuse('the working directory is still locked by the previous worker');

    // ---- 2. checkpoint what is on disk now
    const taskId = last.taskId;
    const cp = checkpoints.capture({ sessionId, runId: last.id, taskId, cwd, reason: 'handoff', nextAction: 'Inspect the repository as it is now, then continue the task. A different worker is taking over.' });
    const fingerprint = (cp.data as any).fingerprint ?? null;
    notes.push(`checkpoint #${cp.seq} saved`);

    // ---- 3. verify repository, worktree, branch and diff before anyone writes
    const drift = checkpoints.verify(cp);
    if (drift.level === 'blocked') refuse(`blocked: ${drift.notes.join('; ')}`, 409, { checkpointId: cp.id, driftLevel: drift.level, fingerprint });
    const wt = store.activeWorktreeForSession(sessionId);
    if (session.worktreePath && !wt) refuse('the session points at a worktree that is not registered as active', 409, { checkpointId: cp.id, driftLevel: drift.level, fingerprint });
    if (wt) {
      const snap = snapshot(cwd);
      if (!snap.available || snap.branch !== wt.branch) refuse(`the worktree is on branch ${snap.branch ?? 'unknown'}, expected ${wt.branch}`, 409, { checkpointId: cp.id, driftLevel: drift.level, fingerprint });
    }
    notes.push(`verified: drift ${drift.level}${wt ? `, worktree branch ${wt.branch}` : ''}`);

    // ---- 4. start the next worker from the portable checkpoint
    let res: ReturnType<ResumeService['resume']>;
    try { res = resumer.resume(sessionId, { model: i.model, provider: i.toProvider, accountId: i.toAccountId, mode: 'portable', timeoutMs: i.timeoutMs, origin: 'handoff' }); }
    catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : e instanceof ResumeError ? 409 : 500;
      refuse(`could not start the next worker: ${e?.message ?? e}`, status, { checkpointId: cp.id, driftLevel: drift.level, fingerprint });
      throw e; // unreachable: refuse() throws
    }
    const queued = res.queued;
    const rec = store.addHandoff({ ...base, toRunId: res.run?.id ?? null, checkpointId: cp.id, driftLevel: drift.level, fingerprint, status: queued ? 'queued' : 'started',
      notes: [...notes, queued ? `no capacity right now: queued (${queued.reason})` : `started run ${res.run!.id}`] });
    store.appendEvent({ sessionId, runId: res.run?.id, type: 'provider.handoff', payload: { handoffId: rec.id, status: rec.status, from: from.provider, to: i.toProvider, model: i.model, checkpointId: cp.id, drift: drift.level, reason: i.reason } });
    store.audit(actor, queued ? 'handoff.queued' : 'handoff.started', `session:${sessionId}`, { from: from.provider, to: i.toProvider, model: i.model, runId: res.run?.id ?? null, checkpointId: cp.id });
    return { handoff: rec, run: res.run, queued, drift };
  }
}
