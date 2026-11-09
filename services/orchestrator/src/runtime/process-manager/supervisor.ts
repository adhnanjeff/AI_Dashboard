import { randomUUID } from 'node:crypto';
import { canTransition, type WorkState } from '../../domain/states.ts';
import type { AgentRun } from '../../domain/types.ts';
import type { Store } from '../../storage/store.ts';
import type { AdapterProcess, NormalizedEvent, ProviderAdapter } from '../adapters/types.ts';

export interface StartInput {
  taskId: string; prompt: string; cwd: string; model: string;
  role?: string; timeoutMs?: number; resumeId?: string;
}
export interface SupervisorOptions { defaultTimeoutMs?: number; logCapBytes?: number }

interface Active {
  runId: string; sessionId: string; proc: AdapterProcess;
  cancelled: boolean; cancelReason?: string; timedOut: boolean;
  timer?: NodeJS.Timeout; finished: Promise<AgentRun>;
}

export class SessionBusyError extends Error {}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };

// Owns the lifecycle of agent processes and is the only thing that writes run outcomes.
// Rule: a run is `completed` only when the process exited 0 AND the provider reported a successful
// result. A started process, or a final-looking message, is never treated as success.
export class Supervisor {
  private store: Store; private adapter: ProviderAdapter;
  private defaultTimeoutMs: number; private logCap: number;
  private active = new Map<string, Active>();

  constructor(store: Store, adapter: ProviderAdapter, opts: SupervisorOptions = {}) {
    this.store = store; this.adapter = adapter;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
    this.logCap = opts.logCapBytes ?? 5 * 1024 * 1024;
  }

  /** Starts a run and returns once it is `running`. Use waitFor() to await the final state. */
  start(input: StartInput): AgentRun {
    const task = this.store.getTask(input.taskId); if (!task) throw new Error(`task not found: ${input.taskId}`);
    const session = this.store.getSession(task.sessionId)!;
    for (const a of this.active.values())
      if (a.sessionId === session.id) throw new SessionBusyError(`session ${session.id} already has an active run (${a.runId})`);

    // Bring session and task to `running`; terminal states cannot be restarted.
    this.activate(session.status, (to) => this.store.transitionSession(session.id, to), 'session');
    this.activate(task.status, (to) => this.store.transitionTask(task.id, to), 'task');

    const cliSessionId = input.resumeId ?? randomUUID();
    const run = this.store.createRun({ taskId: task.id, role: input.role ?? 'coder', provider: this.adapter.provider, model: input.model });

    let proc: AdapterProcess;
    try { proc = this.adapter.launch({ cwd: input.cwd, prompt: input.prompt, model: input.model, cliSessionId, resumeId: input.resumeId }); }
    catch (e: any) {
      this.store.transitionRun(run.id, 'running', { cliSessionId });
      this.settle(run.id, 'failed', { reason: `launch error: ${e.message}` });
      return this.store.getRun(run.id)!;
    }
    this.store.transitionRun(run.id, 'running', { pid: proc.pid, cliSessionId });

    const entry: Active = { runId: run.id, sessionId: session.id, proc, cancelled: false, timedOut: false, finished: undefined as any };
    const log: string[] = []; let logBytes = 0; let truncated = false; let result: Extract<NormalizedEvent, { kind: 'result' }> | undefined;
    const addLog = (s: string) => {
      if (logBytes >= this.logCap) { truncated = true; return; }
      log.push(s); logBytes += Buffer.byteLength(s);
    };

    proc.onEvent((ev, raw) => {
      addLog(raw + '\n');
      const sessionId = session.id;
      if (ev.kind === 'init') this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.init', payload: { model: ev.model, providerSessionId: ev.providerSessionId } });
      else if (ev.kind === 'assistant') this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.message', payload: { text: ev.text.slice(0, 2000), tools: ev.tools } });
      else if (ev.kind === 'tool_result') this.store.appendEvent({ sessionId, runId: run.id, type: 'agent.tool_result', payload: { isError: ev.isError, summary: ev.summary } });
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
      else if (exit.exitCode !== 0) { to = 'failed'; reason = `exit code ${exit.exitCode ?? exit.signal}`; }
      else if (!result) { to = 'failed'; reason = 'exited 0 without a result event'; }
      else { to = 'failed'; reason = 'provider reported an error result'; }
      this.store.addArtifact({ sessionId: session.id, runId: run.id, kind: 'log', content: log.join('') });
      const done = this.settle(run.id, to, { exitCode: exit.exitCode ?? undefined, reason });
      this.active.delete(run.id);
      return done;
    });
    this.active.set(run.id, entry);
    return this.store.getRun(run.id)!;
  }

  status(runId: string) { return this.store.getRun(runId); }
  isActive(runId: string) { return this.active.has(runId); }
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

  /** Graceful application shutdown: stop every worker so none is left running unsupervised. */
  async shutdown() { await Promise.all([...this.active.keys()].map((id) => this.cancel(id, 'application shutdown'))); }

  /**
   * Run at startup. Any run still `running` in the database but not owned by this process was left
   * behind by a crash or restart. It is marked failed (never assumed to have succeeded). A process
   * that is still alive is reported but not killed: the pid may have been reused by something else.
   */
  recoverOrphans(): { runId: string; pid: number | null; stillAlive: boolean }[] {
    const out: { runId: string; pid: number | null; stillAlive: boolean }[] = [];
    for (const r of this.store.listRuns('running')) {
      if (this.active.has(r.id)) continue;
      const stillAlive = r.pid != null && isAlive(r.pid);
      this.settle(r.id, 'failed', { reason: `orphaned: supervisor restarted (pid ${r.pid ?? 'unknown'} ${stillAlive ? 'is still alive and was NOT killed' : 'is not running'})` });
      out.push({ runId: r.id, pid: r.pid, stillAlive });
    }
    return out;
  }

  // ---- helpers
  private activate(status: WorkState, move: (to: WorkState) => unknown, what: string) {
    if (status === 'running') return;
    if (status === 'failed') { move('queued'); move('running'); return; }
    if (!canTransition(status, 'running')) throw new Error(`${what} is ${status} and cannot be started`);
    move('running');
  }

  // Writes the run outcome, then mirrors it onto the task and session.
  //   completed -> task completed; session completed once every task is completed
  //   failed    -> task failed;    session failed
  //   cancelled -> task paused;    session paused   (resumable in Phase 3)
  private settle(runId: string, to: 'completed' | 'failed' | 'cancelled', info: { exitCode?: number; reason: string }): AgentRun {
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
    return run;
  }
}
