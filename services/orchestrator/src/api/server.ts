import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Store } from '../storage/store.ts';
import type { DomainEvent } from '../domain/types.ts';
import { snapshot } from '../checkpoints/git.ts';
import { CapacityError, IdempotencyConflictError, SessionBusyError, WorktreeBusyError, WrongWorkdirError, type Supervisor } from '../runtime/process-manager/supervisor.ts';
import { InvalidTransitionError } from '../domain/states.ts';
import { ResumeError, ResumeService } from '../checkpoints/resume-service.ts';
import { MemoryError, MemoryService } from '../memory/memory-service.ts';
import { WorktreeError, WorktreeService } from '../worktrees/worktree-service.ts';
import { Router, RoutingError } from '../routing/router.ts';
import { Scheduler } from '../routing/scheduler.ts';
import { ProviderError, ProviderService } from '../providers/accounts.ts';
import { ProviderHealthService } from '../providers/health.ts';
import { HandoffError, HandoffService } from '../providers/handoff-service.ts';
import { WorkflowEngine, WorkflowError } from '../workflows/engine.ts';
import { IndexError, RepoIndex } from '../indexing/indexer.ts';
import { buildFactorySnapshot } from '../factory/snapshot.ts';
import { PolicyError, PolicyService, PROTECTED_ACTIONS, type PolicyOptions } from '../policy/policy-service.ts';
import { ProtectedOps, type CiProvider } from '../policy/protected-ops.ts';
import { PROFILES, ROLE_PROFILE } from '../policy/profiles.ts';
import { DefinitionError, ROLES, featureTemplate } from '../workflows/definition.ts';
import { exportWorkflow, parseWorkflowImport, workflowJsonSchema } from '../workflows/portable.ts';
import { buildAnalytics } from '../analytics/analytics.ts';
import { AdminError, backupDatabase, exportProject, importProjectMemory, listBackups } from '../admin/backup.ts';

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

const MAX_BODY = 1024 * 1024;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}
const idemKey = (req: IncomingMessage): string | undefined => {
  const k = req.headers['idempotency-key'];
  if (k === undefined) return undefined;
  if (typeof k !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(k)) throw new HttpError(400, 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9._:-]');
  return k;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  return v;
};

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const FILE_CAP = 200 * 1024;

export interface ApiOptions {
  /** Browser origins allowed to call this API directly. Default none: the dashboard reaches us server-to-server. */
  allowedOrigins?: string[];
  /** Directory that holds per-session git worktrees. Default: <repo>.worktrees next to each repository. */
  worktreeRoot?: string;
  /** Where credential variables named by provider accounts are read from. Default: the process environment. */
  env?: NodeJS.ProcessEnv;
  /** If set, queued work is offered capacity this often. Off by default (tests call /queue/drain themselves). */
  drainIntervalMs?: number;
  /** If set, running workflows are advanced this often. Off by default (tests call tick() themselves). */
  workflowIntervalMs?: number;
  /** If set, projects that already have an index are re-indexed when their files change, this often. Off by default. */
  indexIntervalMs?: number;
  /** Phase 12. Pass the same PolicyService the Supervisor uses. If omitted one is created from the options below. */
  policy?: PolicyService;
  /** Secret a person's decision must carry (header x-orch-decision-token). The dashboard server adds it; agents never see it. */
  decisionToken?: string;
  protectedBranches?: string[]; separationOfDuties?: boolean;
  /** Where CI / branch-protection status comes from. Default: none configured. */
  ci?: CiProvider;
  /** Phase 13. Where database backups are written (fixed folder, server-chosen names). Default .sandbox/backups. */
  backupDir?: string; maxBackups?: number;
}

// Thin HTTP layer: validates input, calls Store / Supervisor, returns their state. No business logic here.
// Security: callers cannot choose the working directory. A run always executes in the project's repo.
export function createApi(store: Store, supervisor: Supervisor, opts: ApiOptions = {}): Server {
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const checkpoints = supervisor.checkpoints;
  const workdir = (sessionId: string) => {
    const s = store.getSession(sessionId)!;
    return s.worktreePath ?? store.getProject(s.projectId)!.repoPath;
  };
  const memory = new MemoryService(store);
  const worktrees = new WorktreeService(store, { root: opts.worktreeRoot });
  const registry = supervisor.registry;
  const health = supervisor.health ?? new ProviderHealthService(store);
  const router = new Router(store);
  const providers = new ProviderService(store, registry, health, opts.env);
  const scheduler = new Scheduler(store, supervisor, router, providers, registry);
  const resumer = checkpoints ? new ResumeService(store, supervisor, checkpoints, memory, scheduler) : undefined;
  const handoffs = checkpoints && resumer ? new HandoffService({ store, supervisor, checkpoints, resumer, providers, registry, workdir }) : undefined;
  const flows = new WorkflowEngine({ store, supervisor, scheduler, worktrees, memory });
  const repoIndex = new RepoIndex(store, memory);
  const policy = opts.policy ?? new PolicyService(store, { decisionToken: opts.decisionToken, protectedBranches: opts.protectedBranches, separationOfDuties: opts.separationOfDuties } satisfies PolicyOptions);
  const ops = new ProtectedOps({ store, policy, worktrees, ci: opts.ci });
  const approvalView = (a: NonNullable<ReturnType<Store['getApproval']>>) => {
    const t = new Date().toISOString(); const lapsed = !!a.expiresAt && a.expiresAt <= t;
    const state = a.status === 'pending' ? (lapsed ? 'expired' : 'pending') : a.consumedAt ? 'used' : a.status === 'approved' && lapsed ? 'expired' : a.status;
    const s = store.getSession(a.sessionId); const label = (PROTECTED_ACTIONS as Record<string, { label: string }>)[a.action]?.label ?? null;
    return { ...a, state, actionLabel: label, sessionTitle: s?.title ?? null, projectId: s?.projectId ?? null };
  };
  const routeInfo = (runId: string) => store.listRouting(runId).map((d) => ({ id: d.id, provider: d.provider, model: d.model, policyVersion: d.policyVersion, reason: d.reason, inputs: d.inputs, createdAt: d.createdAt }));
  // Memory writes name a role. Until agents get a tool bridge, the only caller is the local dashboard/user, so the
  // role is asserted by the caller; the service still enforces what each role may write.
  const memBody = (b: any) => ({ category: str(b.category, 'category'), content: str(b.content, 'content'),
    role: b.role === undefined ? 'user' : str(b.role, 'role'), source: b.source && typeof b.source === 'object' ? { kind: b.source.kind, ref: b.source.ref } : undefined });
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method ?? 'GET';
      const need = <X>(v: X | undefined, what: string): X => { if (v === undefined) throw new HttpError(404, `${what} not found`); return v; };

      // ---- request guard. Any web page can make a browser send requests to 127.0.0.1, so:
      //  * Host must be a loopback name (blocks DNS-rebinding),
      //  * a browser-supplied Origin must be explicitly allowed (blocks cross-site POSTs),
      //  * bodies must be application/json (a cross-site form or no-cors fetch cannot send that).
      if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'host not allowed');
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, 'origin not allowed');
      const hasBody = (req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined;
      if (m !== 'GET' && m !== 'HEAD' && hasBody && !/^application\/json\b/i.test(req.headers['content-type'] ?? ''))
        throw new HttpError(415, 'content-type must be application/json');

      if (m === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

      // ---- listings for the dashboard
      if (m === 'GET' && url.pathname === '/projects') return send(res, 200, store.listProjects());
      if (m === 'GET' && url.pathname === '/sessions') {
        return send(res, 200, store.listSessions().reverse().map((s) => {
          const runId = store.latestRunIdForSession(s.id); const run = runId ? store.getRun(runId) : undefined;
          return { session: s, project: { id: s.projectId, name: store.getProject(s.projectId)?.name ?? '?' },
            latestRun: run ? { id: run.id, status: run.status, model: run.model, startedAt: run.startedAt, endedAt: run.endedAt } : null,
            taskCount: store.listTasks(s.id).length };
        }));
      }
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'runs') {
        need(store.getSession(parts[1]), 'session'); return send(res, 200, store.listRunsForSession(parts[1]));
      }

      // Live event stream (Server-Sent Events). Replays from ?after= (or Last-Event-ID) and then follows.
      // Replay is synchronous, so no event can slip between "replayed" and "subscribed".
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'stream') {
        const sessionId = need(store.getSession(parts[1]), 'session').id;
        let last = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 2000\n\n');
        const write = (e: DomainEvent) => { if (e.seq > last) { last = e.seq; res.write(`id: ${e.seq}\nevent: session-event\ndata: ${JSON.stringify(e)}\n\n`); } };
        for (const e of store.listEvents(sessionId, last)) write(e);
        const unsubscribe = store.subscribe((e) => { if (e.sessionId === sessionId) write(e); });
        const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => { clearInterval(beat); unsubscribe(); });
        return;
      }

      // Live repository state for the session: changed files + unified diff (computed now, read-only).
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'changes') {
        const sessionId = need(store.getSession(parts[1]), 'session').id;
        const snap = snapshot(workdir(sessionId));
        const cp = store.latestCheckpoint(sessionId);
        const untracked = new Set(snap.untracked);
        return send(res, 200, {
          available: snap.available, branch: snap.branch ?? null, revision: snap.revision ?? null, status: snap.status,
          files: snap.changedFiles.map((path) => ({ path, untracked: untracked.has(path) })),
          diff: snap.diff, diffTruncated: snap.diffTruncated, computedAt: new Date().toISOString(),
          checkpoint: cp ? { id: cp.id, seq: cp.seq, createdAt: cp.createdAt, matchesNow: (cp.data as any).fingerprint === snap.fingerprint } : null,
        });
      }
      // Content of ONE changed file (for untracked files, which a diff cannot show).
      // The path must be one git itself reports as changed, so this cannot be used to read arbitrary files.
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'file') {
        const sessionId = need(store.getSession(parts[1]), 'session').id;
        const wanted = url.searchParams.get('path') ?? '';
        const dir = workdir(sessionId); const snap = snapshot(dir);
        if (!snap.changedFiles.includes(wanted)) throw new HttpError(404, 'not a changed file in this session');
        const full = resolve(dir, wanted);
        if (!full.startsWith(resolve(dir) + sep)) throw new HttpError(400, 'path escapes the working directory');
        let size: number; try { size = statSync(full).size; } catch { throw new HttpError(404, 'file no longer exists'); }
        if (size > FILE_CAP) throw new HttpError(413, `file is larger than ${FILE_CAP} bytes`);
        const buf = readFileSync(full);
        if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, 'binary file');
        return send(res, 200, { path: wanted, size, content: buf.toString('utf8') });
      }

      if (m === 'POST' && url.pathname === '/projects') {
        const b = await readJson(req);
        return send(res, 201, store.createProject({ name: str(b.name, 'name'), repoPath: str(b.repoPath, 'repoPath'), defaultBranch: b.defaultBranch }));
      }
      if (m === 'POST' && url.pathname === '/sessions') {
        const b = await readJson(req);
        need(store.getProject(str(b.projectId, 'projectId')), 'project');
        return send(res, 201, store.createSession({ projectId: b.projectId, title: str(b.title, 'title') }));
      }
      if (m === 'GET' && parts[0] === 'sessions' && parts.length === 2) {
        const s = need(store.getSession(parts[1]), 'session');
        return send(res, 200, { session: s, tasks: store.listTasks(s.id), checkpoint: store.latestCheckpoint(s.id) ?? null });
      }
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'events') {
        need(store.getSession(parts[1]), 'session');
        return send(res, 200, store.listEvents(parts[1], Number(url.searchParams.get('after') ?? 0) || 0));
      }
      if (m === 'POST' && parts[0] === 'sessions' && parts[2] === 'tasks') {
        const b = await readJson(req); need(store.getSession(parts[1]), 'session');
        return send(res, 201, store.createTask({ sessionId: parts[1], description: str(b.description, 'description'),
          acceptanceCriteria: Array.isArray(b.acceptanceCriteria) ? b.acceptanceCriteria.map(String) : [] }));
      }
      if (m === 'POST' && parts[0] === 'tasks' && parts[2] === 'runs') {
        const b = await readJson(req);
        const task = need(store.getTask(parts[1]), 'task');
        const project = store.getProject(store.getSession(task.sessionId)!.projectId)!;
        const model = b.model === undefined || b.model === '' || b.model === 'auto' ? undefined : str(b.model, 'model');
        if (model !== undefined && !MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
        const notes = memory.contextFor(task.sessionId, `${task.description} ${task.acceptanceCriteria.join(' ')}`);
        const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt
          : `${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}${notes ? `\n\n${notes}` : ''}`;
        const timeoutMs = b.timeoutMs === undefined ? undefined : Number(b.timeoutMs);
        if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new HttpError(400, 'timeoutMs must be 1000..3600000');
        const r = scheduler.launch({ taskId: task.id, prompt, cwd: workdir(task.sessionId), model, timeoutMs, idempotencyKey: idemKey(req), origin: 'run',
          provider: b.provider === undefined ? undefined : str(b.provider, 'provider'), accountId: b.accountId === undefined ? undefined : str(b.accountId, 'accountId'),
          profile: b.permissionProfile === undefined ? undefined : str(b.permissionProfile, 'permissionProfile'), approvalId: b.approvalId === undefined ? undefined : str(b.approvalId, 'approvalId') });
        if (r.kind === 'queued') return send(res, 202, { queued: true, item: r.item, reason: r.reason });
        return send(res, 202, { ...r.run, routing: r.decision && { mode: r.decision.mode, model: r.decision.model, tier: r.decision.tier, reason: r.decision.reason, policyVersion: r.decision.policyVersion } });
      }
      // ---- memory: project-wide and per-session, kept separate
      if (parts[0] === 'projects' && parts[2] === 'memory') {
        const project = need(store.getProject(parts[1]), 'project');
        if (m === 'GET' && parts.length === 3) return send(res, 200, memory.list({ projectId: project.id, status: url.searchParams.get('all') ? undefined : 'active' }));
        if (m === 'POST' && parts.length === 3) { const r = memory.add({ projectId: project.id, ...memBody(await readJson(req)) }); return send(res, r.deduped ? 200 : 201, r); }
        if (m === 'POST' && parts[3] === 'compact') return send(res, 200, memory.compact({ projectId: project.id }));
      }
      if (parts[0] === 'sessions' && ['memory', 'context', 'handoff'].includes(parts[2])) {
        const s = need(store.getSession(parts[1]), 'session');
        if (parts[2] === 'memory' && m === 'GET' && parts.length === 3) return send(res, 200, memory.list({ projectId: s.projectId, sessionId: s.id, status: url.searchParams.get('all') ? undefined : 'active' }));
        if (parts[2] === 'memory' && m === 'POST' && parts.length === 3) { const r = memory.add({ projectId: s.projectId, sessionId: s.id, ...memBody(await readJson(req)) }); return send(res, r.deduped ? 200 : 201, r); }
        if (parts[2] === 'memory' && m === 'POST' && parts[3] === 'compact') return send(res, 200, memory.compact({ projectId: s.projectId, sessionId: s.id }));
        if (parts[2] === 'context' && m === 'GET') return send(res, 200, memory.retrieve({ projectId: s.projectId, sessionId: s.id, query: url.searchParams.get('q') ?? '' }));
        if (parts[2] === 'handoff' && m === 'GET') return send(res, 200, memory.handoff(s.id, checkpoints));
      }
      if (m === 'POST' && parts[0] === 'memory' && parts[2] === 'archive') {
        const b = await readJson(req); return send(res, 200, memory.archive(parts[1], b.role === undefined ? 'user' : str(b.role, 'role')));
      }
      // ---- isolated git worktrees
      if (m === 'GET' && parts[0] === 'projects' && parts[2] === 'worktrees') return send(res, 200, worktrees.overview(need(store.getProject(parts[1]), 'project').id));
      if (parts[0] === 'sessions' && parts[2] === 'worktree') {
        const s = need(store.getSession(parts[1]), 'session'); const w = worktrees.get(s.id);
        if (m === 'POST' && parts.length === 3) return send(res, 201, worktrees.create(s.id));
        if (m === 'GET' && parts.length === 3) return send(res, 200, w ? worktrees.status(w) : null);
        const active = need(w, 'worktree');
        if (m === 'GET' && parts[3] === 'merge-check') return send(res, 200, worktrees.mergeCheck(active));
        if (m === 'GET' && parts[3] === 'remove-preview') return send(res, 200, worktrees.removalPreview(active));
        if (m === 'POST' && parts[3] === 'remove') return send(res, 200, worktrees.remove(active));
      }
      if (m === 'GET' && url.pathname === '/worktree-locks') return send(res, 200, store.listWorktreeLocks());

      // ---- checkpoints, pause, resume
      if (parts[0] === 'sessions' && ['checkpoint', 'resume-check', 'resume', 'pause'].includes(parts[2])) {
        const session = need(store.getSession(parts[1]), 'session');
        if (parts[2] === 'pause' && m === 'POST') {
          const r = await supervisor.pauseSession(session.id);
          if (!r) throw new HttpError(409, 'session has no active run to pause');
          return send(res, 200, { run: r, session: store.getSession(session.id) });
        }
        if (!checkpoints || !resumer) throw new HttpError(501, 'checkpoints are not enabled');
        if (parts[2] === 'checkpoint' && m === 'GET') return send(res, 200, need(checkpoints.latest(session.id), 'checkpoint'));
        if (parts[2] === 'checkpoint' && m === 'POST') {
          const b = await readJson(req);
          return send(res, 201, checkpoints.capture({ sessionId: session.id, reason: 'manual',
            nextAction: typeof b.nextAction === 'string' && b.nextAction.trim() ? b.nextAction : 'Continue the task.' }));
        }
        if (parts[2] === 'resume-check' && m === 'GET') return send(res, 200, resumer.check(session.id));
        if (parts[2] === 'resume' && m === 'POST') {
          const b = await readJson(req);
          const model = b.model === undefined || b.model === '' || b.model === 'auto' ? undefined : str(b.model, 'model');
          if (model !== undefined && !MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
          if (b.mode !== undefined && !['portable', 'native'].includes(b.mode)) throw new HttpError(400, 'mode must be portable or native');
          const timeoutMs = b.timeoutMs === undefined ? undefined : Number(b.timeoutMs);
          if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new HttpError(400, 'timeoutMs must be 1000..3600000');
          const r = resumer.resume(session.id, { model, mode: b.mode, timeoutMs, idempotencyKey: idemKey(req),
            provider: b.provider === undefined ? undefined : str(b.provider, 'provider'), accountId: b.accountId === undefined ? undefined : str(b.accountId, 'accountId') });
          return send(res, r.queued ? 202 : r.replayed ? 200 : 202, r);
        }
      }
      if (parts[0] === 'runs' && parts.length === 2 && m === 'GET') {
        const r = need(supervisor.status(parts[1]), 'run');
        const task = store.getTask(r.taskId)!;
        const resultEvent = store.listEvents(task.sessionId).find((e) => e.runId === r.id && e.type === 'agent.result');
        const costUsd = resultEvent?.payload.costUsd; const u = store.getUsage(r.id);
        const cost = router.costOf({ runId: r.id, taskId: r.taskId, sessionId: task.sessionId, projectId: '', provider: r.provider, model: r.model, role: r.role, status: r.status, startedAt: r.startedAt ?? '', costUsd: u?.costUsd ?? null, inputTokens: null, outputTokens: null, reported: u?.costUsd != null }, router.active().policy);
        return send(res, 200, { ...r, active: supervisor.isActive(r.id), sessionId: task.sessionId, routing: routeInfo(r.id),
          cost: { usd: cost.usd, source: cost.source, note: cost.source === 'reported' ? undefined : 'an estimate from the routing policy: the provider reported no cost' },
          tokens: u && (u.inputTokens !== null || u.outputTokens !== null) ? { input: u.inputTokens, output: u.outputTokens } : null,
          usage: typeof costUsd === 'number' ? { costUsd, source: 'reported' } : { source: 'unavailable' },
          artifacts: store.listArtifacts(task.sessionId).filter((a) => a.runId === r.id).map((a) => ({ id: a.id, kind: a.kind, createdAt: a.createdAt, bytes: a.content?.length ?? 0 })) });
      }
      if (m === 'POST' && parts[0] === 'runs' && parts[2] === 'cancel') {
        need(supervisor.status(parts[1]), 'run');
        return send(res, 200, await supervisor.cancel(parts[1]));
      }
      if (m === 'GET' && parts[0] === 'runs' && parts[2] === 'log') {
        const run = need(supervisor.status(parts[1]), 'run');
        const sid = store.getTask(run.taskId)!.sessionId;
        const art = store.listArtifacts(sid).find((a) => a.runId === run.id && a.kind === 'log');
        if (!art) throw new HttpError(404, 'log not available yet (run still active?)');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end(art.content ?? '');
      }
      // ---- Phase 7: routing policy, budgets, usage
      if (url.pathname === '/routing/policy') {
        if (m === 'GET') { const a = router.active(); return send(res, 200, { version: a.version, policy: a.policy, versions: store.listPolicies().map((v) => ({ version: v.version, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt })) }); }
        if (m === 'PUT' || m === 'POST') { const b = await readJson(req); const v = router.publish(b.policy, 'user', typeof b.note === 'string' ? b.note.slice(0, 200) : undefined); return send(res, 201, { version: v.version, policy: v.config }); }
      }
      if (m === 'GET' && url.pathname === '/routing/today') return send(res, 200, router.today());
      if (m === 'GET' && url.pathname === '/usage/summary') {
        const pid = url.searchParams.get('projectId') ?? undefined; if (pid) need(store.getProject(pid), 'project');
        return send(res, 200, router.summary({ days: Number(url.searchParams.get('days') ?? 7) || 7, projectId: pid }));
      }
      if (m === 'GET' && parts[0] === 'tasks' && parts[2] === 'route-preview') {
        need(store.getTask(parts[1]), 'task'); const model = url.searchParams.get('model') || undefined;
        if (model && !MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
        return send(res, 200, scheduler.preview(parts[1], model));
      }
      if (m === 'GET' && parts[0] === 'routing' && parts[1] === 'decisions' && parts[3] === 'replay') return send(res, 200, router.replay(parts[2]));
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'routing') {
        need(store.getSession(parts[1]), 'session'); return send(res, 200, store.listRunsForSession(parts[1]).map((r) => ({ runId: r.id, status: r.status, model: r.model, provider: r.provider, decisions: routeInfo(r.id) })));
      }

      // ---- Phase 8: providers, accounts, queue, handoff, audit
      if (m === 'GET' && url.pathname === '/providers') return send(res, 200, { providers: providers.overview(), queued: store.listQueue('queued').length });
      if (m === 'POST' && url.pathname === '/providers/accounts') {
        const b = await readJson(req);
        return send(res, 201, providers.addAccount({ provider: str(b.provider, 'provider'), label: str(b.label, 'label'), configDir: typeof b.configDir === 'string' ? b.configDir : undefined,
          credentialRef: typeof b.credentialRef === 'string' ? b.credentialRef : undefined, priority: b.priority }));
      }
      if (m === 'POST' && parts[0] === 'providers' && parts[1] === 'accounts' && parts[3] === 'enabled') {
        const b = await readJson(req); if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
        return send(res, 200, providers.setEnabled(parts[2], b.enabled));
      }
      if (m === 'GET' && url.pathname === '/queue') return send(res, 200, store.listQueue());
      if (m === 'POST' && url.pathname === '/queue/drain') return send(res, 200, scheduler.drain());
      if (m === 'POST' && parts[0] === 'queue' && parts[2] === 'cancel') return send(res, 200, scheduler.cancelQueued(parts[1]));

      // ---- Phase 12: permissions, approvals, protected actions
      const token = typeof req.headers['x-orch-decision-token'] === 'string' ? req.headers['x-orch-decision-token'] : undefined;
      if (m === 'GET' && url.pathname === '/policy') return send(res, 200, { profiles: Object.values(PROFILES), roleDefaults: ROLE_PROFILE,
        protectedActions: PROTECTED_ACTIONS, decisionTokenRequired: !!policy.opts.decisionToken, separationOfDuties: policy.opts.separationOfDuties, approvalTtlMs: policy.opts.approvalTtlMs, ciConfigured: !!opts.ci });
      if (m === 'GET' && url.pathname === '/approvals') {
        const st = url.searchParams.get('status'); const all = store.listApprovals({ limit: Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 300) }).map(approvalView);
        return send(res, 200, st ? all.filter((a) => a.state === st) : all);
      }
      if (parts[0] === 'approvals' && parts.length >= 2) {
        const a = need(store.getApproval(parts[1]), 'approval');
        if (m === 'GET' && parts.length === 2) return send(res, 200, approvalView(a));
        if (m === 'POST' && (parts[2] === 'approve' || parts[2] === 'reject')) { const b = await readJson(req); return send(res, 200, approvalView(policy.decide(a.id, parts[2] === 'approve' ? 'approved' : 'rejected', b.approver, token))); }
        if (m === 'POST' && parts[2] === 'execute-merge') { const b = await readJson(req); return send(res, 200, ops.executeMerge(a.id, str(b.actor, 'actor'))); }
      }
      if (m === 'POST' && parts[0] === 'projects' && parts[2] === 'merge-requests') {
        const b = await readJson(req); need(store.getProject(parts[1]), 'project');
        return send(res, 201, approvalView(ops.requestMerge({ projectId: parts[1], branch: str(b.branch, 'branch'), target: b.target === undefined ? undefined : str(b.target, 'target'), requestedBy: str(b.requestedBy, 'requestedBy'), workflowId: b.workflowId === undefined ? undefined : str(b.workflowId, 'workflowId') })));
      }
      if (m === 'POST' && parts[0] === 'sessions' && parts[2] === 'worktree' && parts[3] === 'discard-request') { need(store.getSession(parts[1]), 'session'); const b = await readJson(req); return send(res, 201, approvalView(ops.requestDiscard(parts[1], str(b.requestedBy, 'requestedBy')))); }
      if (m === 'POST' && parts[0] === 'sessions' && parts[2] === 'worktree' && parts[3] === 'discard') { need(store.getSession(parts[1]), 'session'); const b = await readJson(req); return send(res, 200, ops.executeDiscard(parts[1], b.approvalId, str(b.actor, 'actor'))); }
      if (m === 'POST' && parts[0] === 'tasks' && parts[2] === 'permission-requests') {
        const t = need(store.getTask(parts[1]), 'task'); const b = await readJson(req); const profile = str(b.profile, 'profile');
        if (!(profile in PROFILES) || !PROFILES[profile as keyof typeof PROFILES].elevated) throw new HttpError(400, 'only the elevated profiles (terminal, network, external) need a request');
        return send(res, 201, approvalView(policy.request('permission.elevate', { sessionId: t.sessionId, subject: `profile:${profile}@task:${t.id}`, requestedBy: str(b.requestedBy, 'requestedBy'),
          evidence: { kind: 'permission', taskId: t.id, profile, grants: PROFILES[profile as keyof typeof PROFILES].grants, why: typeof b.why === 'string' ? b.why.slice(0, 500) : null } })));
      }

      // ---- Phase 13: analytics, backups, project export / import
      if (m === 'GET' && url.pathname === '/analytics') {
        const projectId = url.searchParams.get('projectId') ?? undefined; if (projectId) need(store.getProject(projectId), 'project');
        const a = router.active().policy; const days = Number(url.searchParams.get('days') ?? 30);
        if (!Number.isFinite(days) || days < 1 || days > 365) throw new HttpError(400, 'days must be 1..365');
        return send(res, 200, buildAnalytics(store, { projectId, days, estimateUsd: a.budgets.estimateUsd, maxTier: a.escalation.maxTier }));
      }
      const backupDir = opts.backupDir ?? '.sandbox/backups';
      if (m === 'GET' && url.pathname === '/admin/backups') return send(res, 200, { dir: resolve(backupDir), backups: listBackups(backupDir) });
      if (m === 'POST' && url.pathname === '/admin/backups') {
        if (listBackups(backupDir).length >= (opts.maxBackups ?? 20)) throw new HttpError(409, `there are already ${opts.maxBackups ?? 20} backups; move or delete old ones in ${resolve(backupDir)} first`);
        const info = backupDatabase(store, backupDir); store.audit('user', 'admin.backup', info.file, { bytes: info.bytes, schemaVersion: info.schemaVersion });
        return send(res, 201, info);
      }
      if (m === 'GET' && parts[0] === 'projects' && parts[2] === 'export') return send(res, 200, exportProject(store, need(store.getProject(parts[1]), 'project').id));
      if (m === 'POST' && parts[0] === 'projects' && parts[2] === 'import-memory') {
        need(store.getProject(parts[1]), 'project'); const b = await readJson(req); const r = importProjectMemory(memory, parts[1], b.file ?? b);
        store.audit('user', 'admin.import-memory', `project:${parts[1]}`, { imported: r.imported, duplicates: r.duplicates, skipped: r.skipped.length }); return send(res, 200, r);
      }

      // ---- Phase 11: Agent Factory snapshot (read-only, derived from real records)
      if (m === 'GET' && url.pathname === '/factory') {
        const projectId = url.searchParams.get('projectId') ?? undefined; if (projectId) need(store.getProject(projectId), 'project');
        return send(res, 200, buildFactorySnapshot(store, flows, { projectId, activityLimit: Number(url.searchParams.get('activity') ?? 40) || 40 }));
      }

      // ---- Phase 10: repository index and knowledge graph
      if (parts[0] === 'projects' && (parts[2] === 'index' || parts[2] === 'graph')) {
        need(store.getProject(parts[1]), 'project');
        if (parts[2] === 'index' && m === 'GET') return send(res, 200, repoIndex.status(parts[1]));
        if (parts[2] === 'index' && m === 'POST') { const b = await readJson(req).catch(() => ({})); return send(res, 200, repoIndex.index(parts[1], { full: b.full === true })); }
        if (parts[2] === 'graph' && parts[3] === 'search' && m === 'GET') return send(res, 200, repoIndex.search(parts[1], url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 40) || 40));
        if (parts[2] === 'graph' && parts[3] === 'files' && m === 'GET') {
          const path = url.searchParams.get('path') ?? ''; const depth = Math.min(Number(url.searchParams.get('depth') ?? 2) || 2, 6);
          return send(res, 200, { dependencies: repoIndex.dependencies(parts[1], path, 1).results, dependents: repoIndex.dependents(parts[1], path, depth).results, tests: repoIndex.testsFor(parts[1], [path], depth).tests });
        }
        if (parts[2] === 'graph' && parts[3] === 'relevant' && m === 'GET') {
          const files = (url.searchParams.get('files') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
          return send(res, 200, repoIndex.relevant(parts[1], { query: url.searchParams.get('query') ?? undefined, sessionId: url.searchParams.get('sessionId') ?? undefined, files, limit: Number(url.searchParams.get('limit') ?? 25) || 25 }));
        }
        if (parts[2] === 'graph' && parts[3] === 'inferred' && m === 'GET') return send(res, 200, repoIndex.inferredEdges(parts[1]));
        if (parts[2] === 'graph' && parts[3] === 'inferred' && m === 'POST') {
          const b = await readJson(req);
          return send(res, 201, repoIndex.addInferred(parts[1], { fromId: str(b.fromId, 'fromId'), toId: str(b.toId, 'toId'), kind: str(b.kind, 'kind'), rationale: str(b.rationale, 'rationale'), model: typeof b.model === 'string' ? b.model : undefined }));
        }
      }
      if (m === 'GET' && parts[0] === 'graph' && parts[1] === 'nodes' && parts.length === 3) return send(res, 200, repoIndex.node(parts[2]));
      if (m === 'POST' && parts[0] === 'graph' && parts[1] === 'edges' && parts[3] === 'remove') return send(res, 200, repoIndex.removeInferred(parts[2]));
      if (m === 'GET' && parts[0] === 'sessions' && parts[2] === 'graph') { need(store.getSession(parts[1]), 'session'); return send(res, 200, repoIndex.sessionGraph(parts[1])); }

      // ---- Phase 9: multi-agent workflows
      if (parts[0] === 'workflows') {
        if (m === 'GET' && parts.length === 1) return send(res, 200, flows.list(url.searchParams.get('projectId') ?? undefined));
        if (m === 'GET' && parts[1] === 'roles') return send(res, 200, ROLES);
        if (m === 'GET' && parts[1] === 'schema') return send(res, 200, workflowJsonSchema());
        if (m === 'POST' && parts[1] === 'validate') {
          const b = await readJson(req); let input = b.definition ?? b.file;
          if (input && typeof input === 'object' && 'definition' in input) { try { input = parseWorkflowImport(input).definition; } catch (e) { if (e instanceof DefinitionError) return send(res, 200, { ok: false, problems: e.problems }); throw e; } }
          const r = flows.check(input); return send(res, 200, r.ok ? { ok: true, problems: [], definition: r.definition, file: exportWorkflow(r.definition, { title: typeof b.title === 'string' ? b.title : undefined, goal: typeof b.goal === 'string' ? b.goal : undefined }) } : { ok: false, problems: r.problems });
        }
        if (m === 'POST' && parts[1] === 'import') {
          const b = await readJson(req); need(store.getProject(str(b.projectId, 'projectId')), 'project');
          const f = parseWorkflowImport(b.file); const c = flows.check(f.definition); if (!c.ok) throw new HttpError(400, `invalid workflow: ${c.problems.join('; ')}`);
          const wf = flows.create({ projectId: b.projectId, title: typeof b.title === 'string' && b.title.trim() ? b.title : (f.title ?? 'Imported workflow'), goal: typeof b.goal === 'string' && b.goal.trim() ? b.goal : (f.goal ?? 'Imported workflow'), definition: f.definition, createdBy: 'import' });
          store.audit('user', 'workflow.imported', wf.id, { steps: f.definition.steps.length }); return send(res, 201, { workflow: wf, warnings: f.warnings });
        }
        if (m === 'GET' && parts[2] === 'export') { const g = flows.get(parts[1]); return send(res, 200, exportWorkflow(g.workflow.definition, { title: g.workflow.title, goal: g.workflow.goal })); }
        if (m === 'POST' && parts.length === 1) {
          const b = await readJson(req);
          const definition = b.template && typeof b.template === 'object'
            ? (() => { try { return featureTemplate(b.template); } catch (e: any) { throw new HttpError(400, e.message); } })() : b.definition;
          return send(res, 201, flows.create({ projectId: str(b.projectId, 'projectId'), title: str(b.title, 'title'), goal: str(b.goal, 'goal'), definition }));
        }
        if (m === 'GET' && parts.length === 2) return send(res, 200, flows.get(parts[1]));
        if (m === 'GET' && parts[2] === 'transitions') return send(res, 200, flows.transitions(parts[1]));
        if (m === 'GET' && parts[2] === 'evidence') return send(res, 200, flows.evidenceList(parts[1], { step: url.searchParams.get('step') ?? undefined, full: url.searchParams.get('full') === '1' }));
        if (m === 'GET' && parts[2] === 'record') return send(res, 200, flows.record(parts[1]));
        if (m === 'POST' && parts[2] === 'start') return send(res, 200, flows.start(parts[1]));
        if (m === 'POST' && parts[2] === 'cancel') return send(res, 200, await flows.cancel(parts[1]));
        if (m === 'POST' && parts[2] === 'steps' && (parts[4] === 'approve' || parts[4] === 'reject')) {
          const b = await readJson(req);
          return send(res, 200, flows.decide(parts[1], parts[3], parts[4] === 'approve' ? 'approved' : 'rejected', policy.authorizeDecision(b.approver, token)));
        }
      }
      if (m === 'GET' && url.pathname === '/audit') return send(res, 200, store.listAudit(Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)));
      if (parts[0] === 'sessions' && parts[2] === 'handoffs' && m === 'GET') { need(store.getSession(parts[1]), 'session'); return send(res, 200, store.listHandoffs(parts[1])); }
      if (parts[0] === 'sessions' && parts[2] === 'handoff' && m === 'POST') {
        need(store.getSession(parts[1]), 'session'); if (!handoffs) throw new HttpError(501, 'checkpoints are not enabled');
        const b = await readJson(req); const model = str(b.model, 'model'); if (!MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
        const r = await handoffs.handoff(parts[1], { toProvider: str(b.provider, 'provider'), toAccountId: b.accountId === undefined ? undefined : str(b.accountId, 'accountId'), model, reason: str(b.reason, 'reason'), timeoutMs: b.timeoutMs === undefined ? undefined : Number(b.timeoutMs) });
        return send(res, 202, r);
      }
      throw new HttpError(404, 'not found');
    } catch (e: any) {
      if (e instanceof HttpError || e instanceof MemoryError) return send(res, e.status, { error: e.message });
      if (e instanceof WorktreeError || e instanceof RoutingError || e instanceof ProviderError || e instanceof HandoffError || e instanceof WorkflowError || e instanceof IndexError) return send(res, e.status, { error: e.message, details: e.details });
      if (e instanceof DefinitionError) return send(res, 400, { error: e.message, problems: e.problems });
      if (e instanceof AdminError) return send(res, e.status, { error: e.message });
      if (e instanceof PolicyError) return send(res, e.status, { error: e.message, details: e.details });
      if (e instanceof CapacityError) return send(res, 429, { error: e.message });
      if (e instanceof SessionBusyError || e instanceof WorktreeBusyError || e instanceof IdempotencyConflictError || e instanceof WrongWorkdirError) return send(res, 409, { error: e.message });
      if (e instanceof ResumeError) return send(res, 409, { error: e.message, drift: e.drift });
      if (e instanceof InvalidTransitionError) return send(res, 409, { error: e.message });
      if (/cannot be started/.test(e?.message)) return send(res, 409, { error: e.message });
      console.error(e); return send(res, 500, { error: 'internal error' });
    }
  });
  if (opts.indexIntervalMs) { const t = setInterval(() => { try { repoIndex.refreshStale(); } catch (e) { console.error('re-index failed', e); } }, opts.indexIntervalMs); t.unref(); server.on('close', () => clearInterval(t)); }
  if (opts.workflowIntervalMs) { flows.startTimer(opts.workflowIntervalMs); server.on('close', () => flows.stopTimer()); }
  if (opts.drainIntervalMs) {
    const t = setInterval(() => { try { scheduler.drain(); } catch (e) { console.error('queue drain failed', e); } }, opts.drainIntervalMs);
    t.unref(); server.on('close', () => clearInterval(t));
  }
  return server;
}
