import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Store } from '../storage/store.ts';
import type { DomainEvent } from '../domain/types.ts';
import { snapshot } from '../checkpoints/git.ts';
import { IdempotencyConflictError, SessionBusyError, WorktreeBusyError, WrongWorkdirError, type Supervisor } from '../runtime/process-manager/supervisor.ts';
import { InvalidTransitionError } from '../domain/states.ts';
import { ResumeError, ResumeService } from '../checkpoints/resume-service.ts';
import { MemoryError, MemoryService } from '../memory/memory-service.ts';
import { WorktreeError, WorktreeService } from '../worktrees/worktree-service.ts';

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
  const resumer = checkpoints ? new ResumeService(store, supervisor, checkpoints, memory) : undefined;
  // Memory writes name a role. Until agents get a tool bridge, the only caller is the local dashboard/user, so the
  // role is asserted by the caller; the service still enforces what each role may write.
  const memBody = (b: any) => ({ category: str(b.category, 'category'), content: str(b.content, 'content'),
    role: b.role === undefined ? 'user' : str(b.role, 'role'), source: b.source && typeof b.source === 'object' ? { kind: b.source.kind, ref: b.source.ref } : undefined });
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
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
        const model = str(b.model, 'model'); if (!MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
        const notes = memory.contextFor(task.sessionId, `${task.description} ${task.acceptanceCriteria.join(' ')}`);
        const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt
          : `${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}${notes ? `\n\n${notes}` : ''}`;
        const timeoutMs = b.timeoutMs === undefined ? undefined : Number(b.timeoutMs);
        if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new HttpError(400, 'timeoutMs must be 1000..3600000');
        return send(res, 202, supervisor.start({ taskId: task.id, prompt, cwd: workdir(task.sessionId), model, timeoutMs, idempotencyKey: idemKey(req) }));
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
          const model = str(b.model, 'model'); if (!MODEL_RE.test(model)) throw new HttpError(400, 'invalid model');
          if (b.mode !== undefined && !['portable', 'native'].includes(b.mode)) throw new HttpError(400, 'mode must be portable or native');
          const timeoutMs = b.timeoutMs === undefined ? undefined : Number(b.timeoutMs);
          if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new HttpError(400, 'timeoutMs must be 1000..3600000');
          const r = resumer.resume(session.id, { model, mode: b.mode, timeoutMs, idempotencyKey: idemKey(req) });
          return send(res, r.replayed ? 200 : 202, r);
        }
      }
      if (parts[0] === 'runs' && parts.length === 2 && m === 'GET') {
        const r = need(supervisor.status(parts[1]), 'run');
        const task = store.getTask(r.taskId)!;
        const resultEvent = store.listEvents(task.sessionId).find((e) => e.runId === r.id && e.type === 'agent.result');
        const costUsd = resultEvent?.payload.costUsd;
        return send(res, 200, { ...r, active: supervisor.isActive(r.id), sessionId: task.sessionId,
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
      throw new HttpError(404, 'not found');
    } catch (e: any) {
      if (e instanceof HttpError || e instanceof MemoryError) return send(res, e.status, { error: e.message });
      if (e instanceof WorktreeError) return send(res, e.status, { error: e.message, details: e.details });
      if (e instanceof SessionBusyError || e instanceof WorktreeBusyError || e instanceof IdempotencyConflictError || e instanceof WrongWorkdirError) return send(res, 409, { error: e.message });
      if (e instanceof ResumeError) return send(res, 409, { error: e.message, drift: e.drift });
      if (e instanceof InvalidTransitionError) return send(res, 409, { error: e.message });
      if (/cannot be started/.test(e?.message)) return send(res, 409, { error: e.message });
      console.error(e); return send(res, 500, { error: 'internal error' });
    }
  });
}
