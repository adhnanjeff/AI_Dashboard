import type { AgentRun, QueueItem } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import { ProviderError, type ProviderService } from '../providers/accounts.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { SessionBusyError, WorktreeBusyError, type Supervisor } from '../runtime/process-manager/supervisor.ts';
import { RoutingError, type Decision, type Router } from './router.ts';

export class BudgetError extends RoutingError {}
export class ProviderUnavailableError extends ProviderError {}

export type LaunchOrigin = 'run' | 'resume' | 'handoff' | 'queue';
export interface LaunchRequest {
  taskId: string; prompt: string; cwd: string;
  /** A model chosen by a person. Absent = the routing policy decides. */
  model?: string;
  /** Pin a provider and/or one of its registered accounts (used by handoff). Absent = any that can take the model. */
  provider?: string; accountId?: string;
  role?: string; timeoutMs?: number; resumeId?: string; idempotencyKey?: string; origin: LaunchOrigin;
}
export type LaunchResult =
  | { kind: 'started'; run: AgentRun; decision: Decision | null; replayed?: boolean }
  | { kind: 'queued'; item: QueueItem; reason: string };

const MAX_QUEUE_ATTEMPTS = 500;

// The single path by which work is launched: decide the model, enforce the budget, pick an authorised account that
// is not rate-limited, start the run, and record why. If no authorised capacity exists the request is QUEUED; it is
// never retried in a loop and never moved to a different provider without an explicit instruction.
export class Scheduler {
  private store: Store; private supervisor: Supervisor; private router: Router; private providers: ProviderService; private registry: ProviderRegistry;
  constructor(store: Store, supervisor: Supervisor, router: Router, providers: ProviderService, registry: ProviderRegistry) {
    this.store = store; this.supervisor = supervisor; this.router = router; this.providers = providers; this.registry = registry;
  }

  /** What would happen, without starting anything. */
  preview(taskId: string, model?: string) {
    const decision = this.router.decide(taskId, { model });
    return { decision, targets: this.targetsFor(decision.model).map((t) => ({ provider: t.provider, accountId: t.accountId, label: t.label, available: t.availability.available, reason: t.availability.reason ?? null })) };
  }

  launch(req: LaunchRequest, o: { allowQueue?: boolean } = {}): LaunchResult {
    const allowQueue = o.allowQueue ?? true;
    const task = this.store.getTask(req.taskId); if (!task) throw new RoutingError(404, 'task not found');

    if (req.idempotencyKey) { // a replay returns the original run and must not decide, reserve budget or log again
      const prior = this.supervisor.findByKey(req.idempotencyKey);
      if (prior) return { kind: 'started', run: prior, decision: null, replayed: true };
    }

    const decision = this.router.decide(req.taskId, { model: req.model });
    if (!decision.budget.ok) {
      this.store.appendEvent({ sessionId: task.sessionId, type: 'routing.refused', payload: { model: decision.model, reasons: decision.budget.reasons } });
      throw new BudgetError(409, `budget limit: ${decision.budget.reasons.join('; ')}`, decision.budget);
    }

    const targets = this.targetsFor(decision.model, req.provider, req.accountId);
    if (!targets.length) throw new RoutingError(400, `no registered provider${req.provider ? ` named ${req.provider}` : ''} supports model ${decision.model}`);
    const ready = targets.find((t) => t.availability.available);
    if (!ready) {
      const why = targets.map((t) => `${t.provider}/${t.label}: ${t.availability.reason ?? 'unavailable'}`).join('; ');
      const until = targets.map((t) => t.availability.until).filter(Boolean).sort()[0];
      if (!allowQueue) throw new ProviderUnavailableError(409, `no authorised capacity: ${why}`, { retryAfter: until ?? null });
      const item = this.store.enqueue({ taskId: req.taskId, sessionId: task.sessionId, reason: `no authorised capacity: ${why}`,
        request: { taskId: req.taskId, prompt: req.prompt, cwd: req.cwd, model: req.model, provider: req.provider, accountId: req.accountId, role: req.role,
          timeoutMs: req.timeoutMs, resumeId: req.resumeId, idempotencyKey: req.idempotencyKey, origin: req.origin } });
      return { kind: 'queued', item, reason: item.reason };
    }

    const env = this.providers.launchEnv(ready.accountId, ready.provider);
    const run = this.supervisor.start({ taskId: req.taskId, prompt: req.prompt, cwd: req.cwd, model: decision.model, role: req.role,
      timeoutMs: req.timeoutMs, resumeId: req.resumeId, idempotencyKey: req.idempotencyKey, provider: ready.provider, accountId: ready.accountId ?? undefined, env });
    if (ready.accountId) this.store.touchAccount(ready.accountId);
    this.store.recordRouting({ runId: run.id, provider: ready.provider, model: decision.model, policyVersion: String(decision.policyVersion), reason: decision.reason,
      usage: { source: 'unavailable' }, inputs: { ...this.router.inputsOf(decision), origin: req.origin, accountId: ready.accountId } });
    this.store.appendEvent({ sessionId: task.sessionId, runId: run.id, type: 'routing.decided', payload: { mode: decision.mode, model: decision.model, tier: decision.tier,
      provider: ready.provider, account: ready.label, policyVersion: decision.policyVersion, reason: decision.reason, origin: req.origin } });
    return { kind: 'started', run, decision };
  }

  /** Start whatever queued work now has capacity. Called by a timer and by the dashboard; safe to call at any time. */
  drain(): { started: string[]; stillQueued: number; abandoned: string[] } {
    const started: string[] = []; const abandoned: string[] = [];
    for (const item of this.store.listQueue('queued')) {
      const req = item.request as unknown as LaunchRequest;
      try {
        const r = this.launch({ ...req, origin: 'queue' }, { allowQueue: false });
        if (r.kind === 'started') { this.store.updateQueueItem(item.id, { status: 'started', runId: r.run.id, bumpAttempts: true }); started.push(item.id); }
      } catch (e: any) {
        if (e instanceof ProviderUnavailableError || e instanceof SessionBusyError || e instanceof WorktreeBusyError) {
          const q = this.store.updateQueueItem(item.id, { bumpAttempts: true });
          if (q.attempts >= MAX_QUEUE_ATTEMPTS) { this.store.updateQueueItem(item.id, { status: 'abandoned', reason: 'gave up waiting for capacity' }); abandoned.push(item.id); }
          continue;
        }
        this.store.updateQueueItem(item.id, { status: 'abandoned', reason: String(e?.message ?? e).slice(0, 300) }); abandoned.push(item.id);
      }
    }
    return { started, stillQueued: this.store.listQueue('queued').length, abandoned };
  }

  cancelQueued(id: string, actor = 'user') {
    const q = this.store.getQueueItem(id); if (!q) throw new RoutingError(404, 'queue item not found');
    if (q.status !== 'queued') throw new RoutingError(409, `queue item is ${q.status}`);
    this.store.audit(actor, 'queue.cancelled', `queue:${id}`, { sessionId: q.sessionId });
    return this.store.updateQueueItem(id, { status: 'cancelled', reason: 'cancelled by user' });
  }

  // ---- which provider/account can take this model?
  private targetsFor(model: string, provider?: string, accountId?: string) {
    const names = provider ? [provider] : this.registry.list().map((a) => a.provider);
    if (provider && !this.registry.get(provider)) throw new RoutingError(400, `unknown provider: ${provider}`);
    const out: { provider: string; accountId: string | null; label: string; availability: ReturnType<ProviderService['availabilityOf']> }[] = [];
    for (const p of names) {
      if (!this.registry.supports(p, model)) continue;
      if (accountId) {
        const a = this.store.getAccount(accountId);
        if (!a || a.provider !== p || !a.enabled) throw new RoutingError(400, 'that account is not an enabled account of that provider');
        out.push({ provider: p, accountId: a.id, label: a.label, availability: this.providers.availabilityOf(p, a.id) }); continue;
      }
      for (const c of this.providers.candidates(p)) out.push({ provider: p, accountId: c.accountId, label: c.label, availability: c.availability });
    }
    return out;
  }
}
