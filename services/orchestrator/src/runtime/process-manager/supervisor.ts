import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canTransition, type WorkState } from '../../domain/states.ts';
import type { AgentRun } from '../../domain/types.ts';
import type { CheckpointService } from '../../checkpoints/checkpoint-service.ts';
import type { Store } from '../../storage/store.ts';
import type { AdapterProcess, NormalizedEvent, ProviderAdapter } from '../adapters/types.ts';
import type { ProviderHealthService } from '../../providers/health.ts';
import { ProviderRegistry } from '../../providers/registry.ts';

export interface StartInput {
  taskId: string; prompt: string; cwd: string; model: string;
  role?: string; timeoutMs?: number; resumeId?: string;
  /** A retried request with the same key returns the original run instead of starting another. */
  idempotencyKey?: string;
  /** Which registered adapter runs this (default: the first registered). */
  provider?: string;
  /** Registered account the run is attributed to. */
  accountId?: string;
  /** Extra environment for this launch only (account profile / credential). Never stored. */
  env?: Record<string, string>;
}
export interface SupervisorOptions {
  /** Records what each provider reports about itself (rate limits, errors) so work is not sent to a limited account. */
  health?: ProviderHealthService;
  defaultTimeoutMs?: number; logCapBytes?: number;
  checkpoints?: CheckpointService;
  /** Minimum gap between mid-run checkpoints. 0 = after every successful tool call. Default 5000. */
  checkpointIntervalMs?: number;
}

interface Active {
  runId: string; sessionId: string; proc: AdapterProcess;
  cancelled: boolean; cancelReason?: string; timedOut: boolean;
  timer?: NodeJS.Timeout; finished: Promise<AgentRun>;
}

export class SessionBusyError extends Error {}
export class WorktreeBusyError extends Error {}
export class IdempotencyConflictError extends Error {}
export class WrongWorkdirError extends Error {}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
// Normalised so "C:\Repo", "c:/repo/" and "C:\Repo\" are the same lock on Windows.
export const lockKey = (cwd: string) => { const p = resolve(cwd).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? p.toLowerCase() : p; };

// Owns the lifecycle of agent processes and is the only thing that writes run outcomes.
// Rule: a run is `completed` only when the process exited 0 AND the provider reported a successful
// result. A started process, or a final-looking message, is never treated as success.
export class Supervisor {
  readonly checkpoints?: CheckpointService;
  private store: Store; readonly registry: ProviderRegistry; readonly health?: ProviderHealthService;
  private defaultTimeoutMs: number; private logCap: number; private cpInterval: number;
  private active = new Map<string, Active>();

  constructor(store: Store, adapter: ProviderAdapter | ProviderRegistry, opts: SupervisorOptions = {}) {
    this.store = store; this.registry = ProviderRegistry.of(adapter); this.health = opts.health;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
    this.logCap = opts.logCapBytes ?? 5 * 1024 * 1024;
    this.checkpoints = opts.checkpoints; this.cpInterval = opts.checkpointIntervalMs ?? 5000;
  }

  /** Starts a run and returns once it is `running`. Use waitFor() to await the final state. */
  start(input: StartInput): AgentRun {
    const task = this.store.getTask(input.taskId); if (!task) throw new Error(`task not found: ${input.taskId}`);
    const session = this.store.getSession(task.sessionId)!;
    const adapter: ProviderAdapter | undefined = input.provider ? this.registry.get(input.provider) : this.registry.default;
    if (!adapter) throw new Error(`provider not registered: ${input.provider}`);
    const accountKey = input.accountId ?? '';

    if (input.idempotencyKey) {
      const prior = this.store.getRunByKey(input.idempotencyKey);
      if (prior) {
        if (prior.taskId !== task.id) throw new IdempotencyConflictError(`idempotency key already used for a different task`);
        return prior;
      }
    }
    for (const a of this.active.values())
      if (a.sessionId === session.id) throw new SessionBusyError(`session ${session.id} already has an active run (${a.runId})`);

    // A session with an isolated worktree may only ever run there: it must not write into the main checkout
    // or into another session's worktree, whatever the caller passes.
    if (session.worktreePath && lockKey(session.worktreePath) !== lockKey(input.cwd))
      throw new WrongWorkdirError(`session is bound to worktree ${session.worktreePath}; refusing to run in ${input.cwd}`);

    // One writer per working directory, even across sessions. Checked before any state is changed.
    const lockPath = lockKey(input.cwd);
    const holder = this.store.getWorktreeLock(lockPath);
    if (holder) {
      if (this.store.getRun(holder.runId)?.status === 'running') throw new WorktreeBusyError(`working directory is in use by run ${holder.runId} (session ${holder.sessionId})`);
      this.store.releaseWorktreeLocksForRun(holder.runId); // stale lock left by a run that already ended
    }

    // Bring session and task to `running`; terminal states cannot be restarted.
    this.activate(session.status, (to) => this.store.transitionSession(session.id, to), 'session');
    this.activate(task.status, (to) => this.store.transitionTask(task.id, to), 'task');

    const cliSessionId = input.resumeId ?? randomUUID();
    const run = this.store.createRun({ taskId: task.id, role: input.role ?? 'coder', provider: adapter.provider, model: input.model, idempotencyKey: input.idempotencyKey, accountId: input.accountId });
    if (this.store.acquireWorktreeLock(lockPath, session.id, run.id)) throw new WorktreeBusyError('working directory lock was taken concurrently');

    // Persist state BEFORE launching work, so a crash right after launch is still recoverable.
    this.checkpoint(session.id, run.id, input.cwd, 'before-launch', `Start the task: ${task.description}`);

    let proc: AdapterProcess;
    try { proc = adapter.launch({ cwd: input.cwd, prompt: input.prompt, model: input.model, cliSessionId, resumeId: input.resumeId, env: input.env }); }
    catch (e: any) {
      this.health?.recordError(adapter.provider, accountKey, `launch error: ${e.message}`);
      this.store.transitionRun(run.id, 'running', { cliSessionId });
      this.settle(run.id, 'failed', { reason: `launch error: ${e.message}` }, input.cwd);
      return this.store.getRun(run.id)!;
    }
    this.store.transitionRun(run.id, 'running', { pid: proc.pid, cliSessionId });

    const entry: Active = { runId: run.id, sessionId: session.id, proc, cancelled: false, timedOut: false, finished: undefined as any };
    const log: string[] = []; let logBytes = 0; let truncated = false; let result: Extract<NormalizedEvent, { kind: 'result' }> | undefined;
    let limited: Extract<NormalizedEvent, { kind: 'rate_limit' }> | undefined;
    let lastCp = Date.now();
    const addLog = (s: string) => {
      if (logBytes >= this.logCap) { truncated = true; return; }
      log.push(s); logBytes += Buffer.byteLength(s);
    };

    proc.onEvent((ev, raw) => {
      addLog(raw + '\n');
      const sessionId = session.id;
      if (ev.kind === 'init') this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.init', payload: { model: ev.model, providerSessionId: ev.providerSessionId } });
      else if (ev.kind === 'assistant') this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.message', payload: { text: ev.text.slice(0, 2000), tools: ev.tools } });
      else if (ev.kind === 'tool_result') {
        this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.tool_result', payload: { isError: ev.isError, summary: ev.summary } });
        // Mid-run checkpoint after a successful tool call (throttled), so a crash loses little work.
        if (!ev.isError && Date.now() - lastCp >= this.cpInterval) {
          lastCp = Date.now();
          this.checkpoint(sessionId, run.id, input.cwd, 'progress', `Continue the task: ${task.description}`);
        }
      }
      else if (ev.kind === 'rate_limit') {
        if (!limited) this.store.appendEvent({ sessionId, runId: run.id, type: 'provider.rate_limited', payload: { text: ev.text.slice(0, 300), resetsAt: ev.resetsAt ?? null } });
        limited = limited ?? ev;
      }
      else if (ev.kind === 'result') { result = ev; this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.result', payload: { ok: ev.ok, text: ev.text.slice(0, 2000), costUsd: ev.costUsd } }); }
      // `other` events (hooks, token counters, rate limits) stay in the log artifact only.
    });
    proc.onStderr((c) => addLog(`[stderr] ${c}`));

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    entry.timer = setTimeout(() => { entry.timedOut = true; void proc.kill(); }, timeoutMs);

    entry.finished = proc.done.then((exit) => {
      clearTimeout(entry.timer);
      if (truncated) addLog('\n[log truncated]\n');
      let to: WorkState; let reason: string;
      if (entry.cancelled) { to = 'cancelled'; reason = entry.cancelReason ?? 'cancelled'; }
      else if (entry.timedOut) { to = 'failed'; reason = `timeout after ${timeoutMs}ms`; }
      else if (exit.spawnError) { to = 'failed'; reason = `spawn error: ${exit.spawnError}`; }
      else if (exit.exitCode === 0 && result?.ok) { to = 'completed'; reason = 'provider reported success'; }
      else if (limited) { to = 'failed'; reason = `provider rate limited${limited.resetsAt ? ` (resets ${limited.resetsAt})` : ''}`; }
      else if (exit.exitCode !== 0) { to = 'failed'; reason = `exit code ${exit.exitCode ?? exit.signal}`; }
      else if (!result) { to = 'failed'; reason = 'exited 0 without a result event'; }
      else { to = 'failed'; reason = 'provider reported an error result'; }
      this.store.addArtifact({ sessionId: session.id, runId: run.id, kind: 'log', content: log.join('') });
      // Only what the provider actually reported is recorded; a run with no report simply has no usage row.
      if (result && (result.costUsd !== undefined || result.usage)) {
        try { this.store.recordUsage({ runId: run.id, costUsd: result.costUsd, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens }); } catch { /* accounting must never fail a run */ }
      }
      try {
        if (to === 'completed') this.health?.recordSuccess(adapter.provider, accountKey);
        else if (limited) this.health?.recordRateLimit(adapter.provider, accountKey, limited.resetsAt, limited.text);
        else if (exit.spawnError) this.health?.recordError(adapter.provider, accountKey, reason);
      } catch { /* health tracking must never fail a run */ }
      const done = this.settle(run.id, to, { exitCode: exit.exitCode ?? undefined, reason }, input.cwd);
      this.active.delete(run.id);
      return done;
    });
    this.active.set(run.id, entry);
    return this.store.getRun(run.id)!;
  }

  status(runId: string) { return this.store.getRun(runId); }
  isActive(runId: string) { return this.active.has(runId); }
  /** The run currently executing for a session, if any (a handoff must see this empty before the next worker writes). */
  activeRunFor(sessionId: string): string | undefined { return [...this.active.values()].find((a) => a.sessionId === sessionId)?.runId; }
  findByKey(key: string) { return this.store.getRunByKey(key); }
  waitFor(runId: string): Promise<AgentRun> {
    const a = this.active.get(runId);
    return a ? a.finished : Promise.resolve(this.store.getRun(runId)!);
  }

  async cancel(runId: string, reason = 'cancelled by user'): Promise<AgentRun> {
    const a = this.active.get(runId);
    if (!a) return this.store.getRun(runId)!; // already finished: nothing to do
    a.cancelled = true; a.cancelReason = reason;
    await a.proc.kill();
    return a.finished;
  }

  /** Pauses a session: stops its active run (a checkpoint is saved) and leaves the session `paused`. */
  async pauseSession(sessionId: string): Promise<AgentRun | undefined> {
    const a = [...this.active.values()].find((x) => x.sessionId === sessionId);
    return a ? this.cancel(a.runId, 'paused by user') : undefined;
  }

  /** Graceful application shutdown: stop every worker so none is left running unsupervised. */
  async shutdown() { await Promise.all([...this.active.keys()].map((id) => this.cancel(id, 'application shutdown'))); }

  /**
   * Run at startup. Any run still `running` in the database but not owned by this process was left
   * behind by a crash or restart. It is marked failed (never assumed to have succeeded), its worktree
   * lock is released and a checkpoint of the repository as it is NOW is saved, so the session can be
   * resumed. A process that is still alive is reported but not killed: the pid may have been reused.
   */
  recoverOrphans(): { runId: string; pid: number | null; stillAlive: boolean }[] {
    const out: { runId: string; pid: number | null; stillAlive: boolean }[] = [];
    for (const r of this.store.listRuns('running')) {
      if (this.active.has(r.id)) continue;
      const stillAlive = r.pid != null && isAlive(r.pid);
      this.settle(r.id, 'failed', { reason: `orphaned: supervisor restarted (pid ${r.pid ?? 'unknown'} ${stillAlive ? 'is still alive and was NOT killed' : 'is not running'})` });
      out.push({ runId: r.id, pid: r.pid, stillAlive });
    }
    for (const l of this.store.listWorktreeLocks()) // locks whose run is no longer running
      if (this.store.getRun(l.runId)?.status !== 'running') this.store.releaseWorktreeLocksForRun(l.runId);
    return out;
  }

  // ---- helpers
  private activate(status: WorkState, move: (to: WorkState) => unknown, what: string) {
    if (status === 'running') return;
    if (status === 'failed') { move('queued'); move('running'); return; }
    if (!canTransition(status, 'running')) throw new Error(`${what} is ${status} and cannot be started`);
    move('running');
  }

  // A checkpoint problem must never fail or hide a run: record it and carry on.
  private checkpoint(sessionId: string, runId: string, cwd: string | undefined, reason: string, nextAction: string) {
    if (!this.checkpoints) return;
    try { this.checkpoints.capture({ sessionId, runId, cwd, reason, nextAction }); }
    catch (e: any) {
      try { this.store.appendEvent({ sessionId, runId, type: 'checkpoint.failed', payload: { reason, error: String(e?.message ?? e).slice(0, 300) } }); } catch { /* nothing more to do */ }
    }
  }

  // Writes the run outcome, mirrors it onto the task and session, releases the worktree lock,
  // then saves a checkpoint of the final state.
  //   completed -> task completed; session completed once every task is completed
  //   failed    -> task failed;    session failed
  //   cancelled -> task paused;    session paused   (resumable)
  private settle(runId: string, to: 'completed' | 'failed' | 'cancelled', info: { exitCode?: number; reason: string }, cwd?: string): AgentRun {
    const run = this.store.transitionRun(runId, to, info);
    const task = this.store.getTask(run.taskId)!;
    const taskTo: WorkState = to === 'cancelled' ? 'paused' : to;
    if (canTransition(task.status, taskTo)) this.store.transitionTask(task.id, taskTo, info.reason);
    const session = this.store.getSession(task.sessionId)!;
    let sessionTo: WorkState | undefined;
    if (to === 'cancelled') sessionTo = 'paused';
    else if (to === 'failed') sessionTo = 'failed';
    else if (this.store.listTasks(session.id).every((t) => t.status === 'completed')) sessionTo = 'completed';
    if (sessionTo && canTransition(session.status, sessionTo)) this.store.transitionSession(session.id, sessionTo, info.reason);

    this.store.releaseWorktreeLocksForRun(runId);
    const next = to === 'completed' ? 'The task finished. Review the diff and run the checks.'
      : to === 'failed' ? `The previous attempt failed (${info.reason}). Inspect the repository, then retry the task.`
      : 'The run was paused. Inspect the repository, then continue the task.';
    this.checkpoint(session.id, runId, cwd, `run-${to}`, next);
    return run;
  }
}
