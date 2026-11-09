import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from '../storage/store.ts';
import { IdempotencyConflictError, SessionBusyError, WorktreeBusyError, type Supervisor } from '../runtime/process-manager/supervisor.ts';
import { InvalidTransitionError } from '../domain/states.ts';
import { ResumeError, ResumeService } from '../checkpoints/resume-service.ts';

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

// Thin HTTP layer: validates input, calls Store / Supervisor, returns their state. No business logic here.
// Security: callers cannot choose the working directory. A run always executes in the project's repo.
export function createApi(store: Store, supervisor: Supervisor): Server {
  const checkpoints = supervisor.checkpoints;
  const resumer = checkpoints ? new ResumeService(store, supervisor, checkpoints) : undefined;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method ?? 'GET';
      const need = <X>(v: X | undefined, what: string): X => { if (v === undefined) throw new HttpError(404, `${what} not found`); return v; };

      if (m === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

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
        const prompt = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt
          : `${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
        const timeoutMs = b.timeoutMs === undefined ? undefined : Number(b.timeoutMs);
        if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new HttpError(400, 'timeoutMs must be 1000..3600000');
        return send(res, 202, supervisor.start({ taskId: task.id, prompt, cwd: project.repoPath, model, timeoutMs, idempotencyKey: idemKey(req) }));
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
        return send(res, 200, { ...r, active: supervisor.isActive(r.id) });
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
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof SessionBusyError || e instanceof WorktreeBusyError || e instanceof IdempotencyConflictError) return send(res, 409, { error: e.message });
      if (e instanceof ResumeError) return send(res, 409, { error: e.message, drift: e.drift });
      if (e instanceof InvalidTransitionError) return send(res, 409, { error: e.message });
      if (/cannot be started/.test(e?.message)) return send(res, 409, { error: e.message });
      console.error(e); return send(res, 500, { error: 'internal error' });
    }
  });
}
