import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import type { ProviderCapabilities } from '../../services/orchestrator/src/runtime/adapters/types.ts';
import { Supervisor } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { ResumeError, ResumeService } from '../../services/orchestrator/src/checkpoints/resume-service.ts';
import { ProviderRegistry } from '../../services/orchestrator/src/providers/registry.ts';
import { ProviderHealthService } from '../../services/orchestrator/src/providers/health.ts';
import { ProviderError, ProviderService } from '../../services/orchestrator/src/providers/accounts.ts';
import { HandoffError, HandoffService } from '../../services/orchestrator/src/providers/handoff-service.ts';
import { Router } from '../../services/orchestrator/src/routing/router.ts';
import { Scheduler } from '../../services/orchestrator/src/routing/scheduler.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p8-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error('condition not met in time');
};
const caps = (o: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({ displayName: 'fake', models: ['m'], supportsNativeResume: true, canEditFiles: true,
  credentialEnv: 'ANTHROPIC_API_KEY', configDirEnv: 'CLAUDE_CONFIG_DIR', ...o });
const HOUR = 3_600_000;

// Two execution adapters ("p-a" hangs after editing, like a stuck worker; "p-b" finishes the job), a controllable clock,
// and a credential environment that stands in for the user's secrets manager.
function world(o: { creds?: Record<string, string>; extra?: ClaudeCliAdapter[] } = {}) {
  const db = openDb(':memory:'); const store = new Store(db); const repo = makeRepo();
  const project = store.createProject({ name: 'p8', repoPath: repo });
  const clock = { t: Date.now() };
  const argsFile = join(tmp, `args${n}.json`);
  const envA: Record<string, string> = { FAKE_SCENARIO: 'edit-then-hang' };
  const envB: Record<string, string> = { FAKE_SCENARIO: 'record-prompt', FAKE_ARGS_FILE: argsFile };
  const mk = (name: string, env: Record<string, string>, c = caps()) => new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env, providerName: name, capabilities: c });
  const registry = new ProviderRegistry([mk('p-a', envA), mk('p-b', envB), ...(o.extra ?? [])]);
  const health = new ProviderHealthService(store, { now: () => clock.t, rateLimitCooldownMs: 15 * 60_000 });
  const cps = new CheckpointService(store);
  const sup = new Supervisor(store, registry, { checkpoints: cps, checkpointIntervalMs: 0, health });
  const router = new Router(store); const providers = new ProviderService(store, registry, health, o.creds ?? {});
  const sched = new Scheduler(store, sup, router, providers, registry);
  const resumer = new ResumeService(store, sup, cps, undefined, sched);
  const handoff = new HandoffService({ store, supervisor: sup, checkpoints: cps, resumer, providers, registry, workdir: () => repo });
  const feature = (title = 'f', description = 'do it') => {
    const session = store.createSession({ projectId: project.id, title });
    return { session, task: store.createTask({ sessionId: session.id, description }) };
  };
  const start = (taskId: string, extra: Record<string, unknown> = {}) => {
    const r = sched.launch({ taskId, prompt: 'x', cwd: repo, model: 'm', origin: 'run', ...extra } as any);
    return r;
  };
  // wait until the hanging worker has written work.txt and a checkpoint that contains it exists
  const workSaved = (sessionId: string) => until(() => existsSync(join(repo, 'work.txt')) && !!(store.latestCheckpoint(sessionId)?.data as any)?.changedFiles?.includes('work.txt'));
  return { db, store, repo, project, clock, envA, envB, argsFile, registry, health, sup, router, providers, sched, resumer, handoff, cps, feature, start, workSaved };
}
type W = ReturnType<typeof world>;
const started = (r: ReturnType<W['start']>) => { assert.equal(r.kind, 'started'); if (r.kind !== 'started') throw new Error('not started'); return r.run; };

// ---------------------------------------------------------------- accounts and credentials
test('accounts hold references, never secrets: a pasted key is refused, the credential reaches only the child process, and is nowhere in the database', async () => {
  const SECRET = 'sk-ant-api03-SUPERSECRETVALUE0123456789abcdef';
  const w = world({ creds: { WORK_KEY: SECRET } });
  const profile = join(tmp, 'profile-work'); mkdirSync(profile);
  const bad = (i: any, status: number, re: RegExp) => assert.throws(() => w.providers.addAccount(i), (e: unknown) => e instanceof ProviderError && e.status === status && re.test((e as Error).message));
  bad({ provider: 'p-b', label: 'x', credentialRef: SECRET }, 400, /NAME of an environment variable/);
  bad({ provider: 'p-b', label: 'x', credentialRef: 'lowercase_name' }, 400, /NAME of an environment variable/);
  bad({ provider: 'p-b', label: 'x', configDir: 'relative/dir' }, 400, /absolute/);
  bad({ provider: 'p-b', label: 'x', configDir: join(tmp, 'does-not-exist') }, 400, /existing directory/);
  bad({ provider: 'nope', label: 'x' }, 400, /unknown provider/);
  bad({ provider: 'p-b', label: '' }, 400, /label/);
  const acc = w.providers.addAccount({ provider: 'p-b', label: 'work', configDir: profile, credentialRef: 'WORK_KEY', priority: 5 });
  bad({ provider: 'p-b', label: 'work' }, 409, /already exists/);

  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-b' })); await w.sup.waitFor(run.id);
  assert.equal(w.store.getRun(run.id)!.accountId, acc.id, 'the run is attributed to the account');
  const seen = JSON.parse(readFileSync(w.argsFile, 'utf8'));
  assert.equal(seen.configDir, profile, 'the login profile reached the worker');
  assert.equal(seen.keyLength, SECRET.length, 'the credential reached the worker');

  const dump = JSON.stringify(w.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => [t.name, w.db.prepare(`SELECT * FROM ${t.name}`).all()]));
  assert.ok(!dump.includes('SUPERSECRETVALUE'), 'the secret is not in any table');
  assert.ok(dump.includes('WORK_KEY'), 'only the variable NAME is kept');
  assert.ok(w.store.listAudit().some((a) => a.action === 'account.added' && a.subject === `account:${acc.id}`));

  const missing = w.providers.addAccount({ provider: 'p-b', label: 'unset', credentialRef: 'NOT_SET_ANYWHERE', priority: 9 });
  const g = w.feature('g');
  assert.throws(() => w.start(g.task.id, { provider: 'p-b', accountId: missing.id }), (e: unknown) => e instanceof ProviderError && e.status === 409 && /not set/.test((e as Error).message));
  assert.equal(w.store.listRunsForSession(g.session.id).length, 0, 'nothing started with a missing credential');
});

test('the audit log is append-only and records account changes', () => {
  const w = world(); const a = w.providers.addAccount({ provider: 'p-a', label: 'one' });
  w.providers.setEnabled(a.id, false); w.providers.setEnabled(a.id, true);
  assert.deepEqual(w.store.listAudit().map((x) => x.action).reverse(), ['policy.published', 'account.added', 'account.disabled', 'account.enabled']);
  assert.throws(() => w.db.prepare('UPDATE audit_log SET actor=?').run('x'), /append-only/);
  assert.throws(() => w.db.prepare('DELETE FROM audit_log').run(), /append-only/);
});

// ---------------------------------------------------------------- limits are respected
test('a reported rate limit blocks the account: work is queued once, never retried in a loop, and resumes only after the reported time', async () => {
  const w = world(); w.envA.FAKE_SCENARIO = 'ratelimit'; w.envA.FAKE_RESET_EPOCH = String(Math.floor((w.clock.t + HOUR) / 1000));
  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a' })); await w.sup.waitFor(run.id);
  const done = w.store.getRun(run.id)!;
  assert.equal(done.status, 'failed'); assert.match(done.terminationReason!, /^provider rate limited \(resets /);
  assert.equal(w.store.failedRunCount(f.task.id), 0, 'a provider limit is not a task failure: it does not escalate or use attempts');
  const h = w.store.getHealth('p-a', '')!; assert.equal(h.lastOutcome, 'rate-limited'); assert.equal(Date.parse(h.limitedUntil!), Math.floor((w.clock.t + HOUR) / 1000) * 1000);
  assert.ok(w.store.listAudit().some((a) => a.action === 'provider.rate_limited'));
  assert.ok(w.store.listEvents(f.session.id).some((e) => e.type === 'provider.rate_limited'));

  const q = w.start(f.task.id, { provider: 'p-a' });
  assert.equal(q.kind, 'queued'); if (q.kind !== 'queued') return; assert.match(q.reason, /reported rate limit until/);
  for (let i = 0; i < 3; i++) assert.deepEqual(w.sched.drain().started, []);
  assert.equal(w.store.listRunsForSession(f.session.id).length, 1, 'no further attempt was made against the limited provider');
  assert.equal(w.store.getQueueItem(q.item.id)!.attempts, 3);

  w.clock.t += HOUR + 1000; w.envA.FAKE_SCENARIO = 'record-prompt';
  const d = w.sched.drain(); assert.equal(d.started.length, 1);
  const item = w.store.getQueueItem(q.item.id)!; assert.equal(item.status, 'started');
  await w.sup.waitFor(item.runId!); assert.equal(w.store.getRun(item.runId!)!.status, 'completed');
  assert.equal(w.store.getHealth('p-a', '')!.limitedUntil, null, 'a successful run clears the block');
  const types = w.store.listEvents(f.session.id).map((e) => e.type); assert.ok(types.includes('queue.added') && types.includes('queue.started'));
});

test('a limit reported in the result text (no reset time) uses the cool-down and is recognised as a limit, not a task failure', async () => {
  const w = world(); w.envA.FAKE_SCENARIO = 'ratelimit-result';
  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a' })); await w.sup.waitFor(run.id);
  assert.match(w.store.getRun(run.id)!.terminationReason!, /provider rate limited/);
  assert.equal(Date.parse(w.store.getHealth('p-a', '')!.limitedUntil!), w.clock.t + 15 * 60_000);
  assert.equal(w.store.failedRunCount(f.task.id), 0);
});

test('a worker that cannot even start backs off exponentially instead of being hammered', async () => {
  const w = world({ extra: [new ClaudeCliAdapter({ command: 'definitely-not-a-real-binary-xyz', providerName: 'p-broken', capabilities: caps() })] });
  const f = w.feature(); const r1 = started(w.start(f.task.id, { provider: 'p-broken' })); await w.sup.waitFor(r1.id);
  const first = Date.parse(w.store.getHealth('p-broken', '')!.limitedUntil!) - w.clock.t;
  assert.equal(first, 30_000);
  assert.equal(w.start(f.task.id, { provider: 'p-broken' }).kind, 'queued', 'not retried inside the back-off window');
  w.clock.t += 31_000; const r2 = started(w.start(f.task.id, { provider: 'p-broken' })); await w.sup.waitFor(r2.id);
  assert.equal(Date.parse(w.store.getHealth('p-broken', '')!.limitedUntil!) - w.clock.t, 60_000, 'second failure doubles the wait');
});

test('accounts are not rotated to get around a limit: a limited account blocks its siblings, and recovery goes back by priority', async () => {
  const w = world(); w.envA.FAKE_SCENARIO = 'ratelimit-result';
  const A = w.providers.addAccount({ provider: 'p-a', label: 'A', priority: 10 }); const B = w.providers.addAccount({ provider: 'p-a', label: 'B', priority: 0 });
  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a' })); await w.sup.waitFor(run.id);
  assert.equal(w.store.getRun(run.id)!.accountId, A.id, 'highest priority account is used first');
  const q = w.start(f.task.id, { provider: 'p-a' });
  assert.equal(q.kind, 'queued', 'the sibling account B is NOT used while A is limited'); if (q.kind !== 'queued') return;
  assert.match(q.reason, /not rotated to get around a limit|reported rate limit/);
  assert.equal(w.store.listRunsForSession(f.session.id).length, 1);
  w.clock.t += 16 * 60_000; w.envA.FAKE_SCENARIO = 'record-prompt';
  const d = w.sched.drain(); assert.equal(d.started.length, 1);
  assert.equal(w.store.getRun(w.store.getQueueItem(q.item.id)!.runId!)!.accountId, A.id);
  void B;
});

test('queued work can be cancelled, and a queued item whose request becomes invalid is abandoned rather than retried forever', async () => {
  const w = world(); w.health.recordRateLimit('p-b', '', new Date(w.clock.t + HOUR).toISOString());
  const f = w.feature(); const q = w.start(f.task.id, { provider: 'p-b' }); assert.equal(q.kind, 'queued'); if (q.kind !== 'queued') return;
  assert.equal(w.sched.cancelQueued(q.item.id).status, 'cancelled');
  assert.throws(() => w.sched.cancelQueued(q.item.id), /cancelled/);
  const g = w.feature('g'); const q2 = w.start(g.task.id, { provider: 'p-b' }); if (q2.kind !== 'queued') throw new Error('x');
  w.db.prepare("UPDATE task SET status='completed' WHERE id=?").run(g.task.id); // the task can no longer be started
  w.clock.t += 2 * HOUR; const d = w.sched.drain();
  assert.deepEqual([d.started.length, d.abandoned.length], [0, 1]);
  assert.equal(w.store.getQueueItem(q2.item.id)!.status, 'abandoned');
});

// ---------------------------------------------------------------- handoff
test('EXIT CRITERIA: a task moves to another execution adapter; the old worker stops first, uncommitted work is intact, and the new worker resumes from portable state', async () => {
  const w = world(); const f = w.feature('handoff', 'create work.txt then part2.txt');
  const oldRun = started(w.start(f.task.id, { provider: 'p-a' })); await w.workSaved(f.session.id);
  assert.ok(w.sup.activeRunFor(f.session.id), 'the first worker is mid-task');

  const res = await w.handoff.handoff(f.session.id, { toProvider: 'p-b', model: 'm', reason: 'planned switch to provider b' });
  assert.equal(res.handoff.status, 'started'); assert.equal(res.run!.provider, 'p-b'); assert.equal(res.drift.level, 'unchanged');
  await w.sup.waitFor(res.run!.id);

  // 1. the old worker was stopped and finished BEFORE the new one existed
  const old = w.store.getRun(oldRun.id)!, next = w.store.getRun(res.run!.id)!;
  assert.equal(old.status, 'cancelled'); assert.ok(old.endedAt! <= next.startedAt!);
  const ev = w.store.listEvents(f.session.id);
  const oldEnded = ev.find((e) => e.runId === oldRun.id && e.type === 'run.status' && e.payload.to === 'cancelled')!.seq;
  const newCreated = ev.find((e) => e.runId === next.id && e.type === 'run.created')!.seq;
  assert.ok(oldEnded < newCreated, 'old worker ended before the next one was created');
  assert.equal(w.sup.activeRunFor(f.session.id), undefined); assert.equal(w.store.listWorktreeLocks().length, 0);

  // 2. nothing was lost: the uncommitted file is byte-for-byte intact and the new worker added its own
  assert.equal(readFileSync(join(w.repo, 'work.txt'), 'utf8'), 'precious\n');
  assert.equal(readFileSync(join(w.repo, 'part2.txt'), 'utf8'), 'finished by resumed worker\n');
  assert.equal(git(w.repo, 'status', '--porcelain'), '?? part2.txt\n?? work.txt\n', 'both files are still uncommitted: nothing was reset, cleaned or committed');

  // 3. the new worker started fresh (portable), and was told what exists on disk
  const seen = JSON.parse(readFileSync(w.argsFile, 'utf8'));
  assert.ok(!seen.argv.includes('--resume'), 'no provider-native conversation id was carried across');
  const prompt = seen.argv[seen.argv.indexOf('-p') + 1]; assert.match(prompt, /work\.txt/);

  // 4. recorded: checkpoint, verification, audit and events
  const cp = w.store.listCheckpoints(f.session.id).find((c) => c.id === res.handoff.checkpointId)!; assert.equal((cp.data as any).reason, 'handoff');
  assert.equal(res.handoff.fingerprint, (cp.data as any).fingerprint);
  assert.deepEqual([res.handoff.fromProvider, res.handoff.toProvider, res.handoff.driftLevel], ['p-a', 'p-b', 'unchanged']);
  const actions = w.store.listAudit().map((a) => a.action); assert.ok(actions.includes('handoff.requested') && actions.includes('handoff.started'));
  assert.ok(ev.length && w.store.listEvents(f.session.id).some((e) => e.type === 'provider.handoff' && e.payload.status === 'started'));
  assert.equal(w.store.getSession(f.session.id)!.status, 'completed');
  assert.equal(w.store.listHandoffs(f.session.id).length, 1);
});

test('handoff respects limits: it will not move a limited account\'s work to another account of the same provider, and does not stop the worker for a refused request', async () => {
  const w = world(); const X = w.providers.addAccount({ provider: 'p-a', label: 'X', priority: 5 }); const Y = w.providers.addAccount({ provider: 'p-a', label: 'Y' });
  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a', accountId: X.id })); await w.workSaved(f.session.id);
  w.health.recordRateLimit('p-a', X.id, new Date(w.clock.t + HOUR).toISOString());
  await assert.rejects(() => w.handoff.handoff(f.session.id, { toProvider: 'p-a', toAccountId: Y.id, model: 'm', reason: 'try the other account' }),
    (e: unknown) => e instanceof HandoffError && e.status === 409 && /bypass that limit/.test((e as Error).message));
  assert.equal(w.sup.activeRunFor(f.session.id), run.id, 'the worker was left running');
  const rec = w.store.listHandoffs(f.session.id)[0]; assert.equal(rec.status, 'refused');
  assert.ok(w.store.listAudit().some((a) => a.action === 'handoff.refused'));
  await w.sup.cancel(run.id);
});

test('handoff validates the target before touching anything', async () => {
  const w = world({ extra: [new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], providerName: 'p-ro', capabilities: caps({ canEditFiles: false }) })] });
  const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a' })); await w.workSaved(f.session.id);
  const dis = w.providers.addAccount({ provider: 'p-b', label: 'off' }); w.providers.setEnabled(dis.id, false);
  const rej = (i: any, status: number, re: RegExp) => assert.rejects(() => w.handoff.handoff(f.session.id, { model: 'm', reason: 'testing', ...i }), (e: unknown) => e instanceof HandoffError && e.status === status && re.test((e as Error).message));
  await rej({ toProvider: 'nope' }, 400, /unknown provider/);
  await rej({ toProvider: 'p-b', model: 'not-supported' }, 400, /does not support model/);
  await rej({ toProvider: 'p-ro' }, 400, /cannot edit files/);
  await rej({ toProvider: 'p-b', toAccountId: dis.id }, 400, /not an enabled account/);
  await rej({ toProvider: 'p-a' }, 400, /already on that provider/);
  await rej({ toProvider: 'p-b', reason: ' ' }, 400, /reason is required/);
  assert.equal(w.sup.activeRunFor(f.session.id), run.id, 'none of the refused requests stopped the worker');
  await w.sup.cancel(run.id);
  const done = w.feature('done'); w.db.prepare("UPDATE session SET status='completed' WHERE id=?").run(done.session.id);
  await assert.rejects(() => w.handoff.handoff(done.session.id, { toProvider: 'p-b', model: 'm', reason: 'testing' }), (e: unknown) => e instanceof HandoffError && /only a running, paused or failed/.test((e as Error).message));
});

test('handoff to a provider with no capacity: the old worker is stopped, work is checkpointed, and the move is queued until capacity returns', async () => {
  const w = world(); const f = w.feature('queued handoff');
  const old = started(w.start(f.task.id, { provider: 'p-a' })); await w.workSaved(f.session.id);
  w.health.recordRateLimit('p-b', '', new Date(w.clock.t + HOUR).toISOString());

  const res = await w.handoff.handoff(f.session.id, { toProvider: 'p-b', model: 'm', reason: 'move while b is limited' });
  assert.equal(res.handoff.status, 'queued'); assert.equal(res.run, null); assert.ok(res.queued);
  assert.equal(w.store.getRun(old.id)!.status, 'cancelled'); assert.equal(w.store.getSession(f.session.id)!.status, 'paused');
  assert.equal(readFileSync(join(w.repo, 'work.txt'), 'utf8'), 'precious\n');
  assert.equal(w.sched.drain().started.length, 0, 'still limited: nothing is attempted');
  assert.equal(w.store.listRunsForSession(f.session.id).length, 1);

  w.clock.t += 2 * HOUR; const d = w.sched.drain(); assert.equal(d.started.length, 1);
  const runId = w.store.getQueueItem(res.queued!.id)!.runId!; await w.sup.waitFor(runId);
  const r = w.store.getRun(runId)!; assert.deepEqual([r.provider, r.status], ['p-b', 'completed']);
  assert.equal(readFileSync(join(w.repo, 'work.txt'), 'utf8'), 'precious\n'); assert.ok(existsSync(join(w.repo, 'part2.txt')));
});

test('a provider\'s own conversation id is never carried to another provider or account', async () => {
  const w = world(); const f = w.feature(); const run = started(w.start(f.task.id, { provider: 'p-a' })); await w.workSaved(f.session.id);
  await w.sup.pauseSession(f.session.id); void run;
  assert.throws(() => w.resumer.resume(f.session.id, { mode: 'native', provider: 'p-b', model: 'm' }), (e: unknown) => e instanceof ResumeError && /same provider and account/.test((e as Error).message));
  const ok = w.resumer.resume(f.session.id, { mode: 'native', provider: 'p-a', model: 'm' }); assert.ok(ok.run); await w.sup.cancel(ok.run!.id);
});

// ---------------------------------------------------------------- over HTTP
function serve(w: W, env: NodeJS.ProcessEnv = {}) {
  const server = createApi(w.store, w.sup, { env });
  return new Promise<{ call: (m: string, p: string, b?: unknown) => Promise<{ status: number; json: any }>; close: () => void }>((res) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      res({ close: () => { server.closeAllConnections(); server.close(); },
        call: async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; } });
    });
  });
}

test('API: providers, accounts, handoff, queue and audit end to end', async () => {
  const w = world(); const s = await serve(w);
  try {
    const ov = (await s.call('GET', '/providers')).json;
    assert.deepEqual(ov.providers.map((p: any) => p.provider), ['p-a', 'p-b']); assert.deepEqual(ov.providers[0].capabilities.models, ['m']); assert.equal(ov.providers[0].mode, 'default-login');
    assert.equal((await s.call('POST', '/providers/accounts', { provider: 'p-b', label: 'k', credentialRef: 'sk-ant-api03-abcdefghijkl' })).status, 400);
    assert.equal((await s.call('POST', '/providers/accounts', { provider: 'p-b', label: 'k', configDir: 'rel' })).status, 400);
    const acc = await s.call('POST', '/providers/accounts', { provider: 'p-b', label: 'second', priority: 1 }); assert.equal(acc.status, 201);
    assert.equal((await s.call('POST', `/providers/accounts/${acc.json.id}/enabled`, { enabled: 'yes' })).status, 400);
    assert.equal((await s.call('POST', `/providers/accounts/${acc.json.id}/enabled`, { enabled: true })).json.enabled, true);

    const f = w.feature('api', 'create work.txt then part2.txt');
    const run = await s.call('POST', `/tasks/${f.task.id}/runs`, { provider: 'p-a', model: 'm' }); assert.equal(run.status, 202); assert.equal(run.json.provider, 'p-a');
    await w.workSaved(f.session.id);
    assert.equal((await s.call('POST', `/sessions/${f.session.id}/handoff`, { provider: 'p-b', model: 'm' })).status, 400, 'a reason is required');
    const h = await s.call('POST', `/sessions/${f.session.id}/handoff`, { provider: 'p-b', accountId: acc.json.id, model: 'm', reason: 'api test' });
    assert.equal(h.status, 202); assert.equal(h.json.handoff.status, 'started'); assert.equal(h.json.run.accountId, acc.json.id);
    await w.sup.waitFor(h.json.run.id);
    const list = (await s.call('GET', `/sessions/${f.session.id}/handoffs`)).json; assert.deepEqual([list.length, list[0].toProvider], [1, 'p-b']);
    assert.ok((await s.call('GET', '/audit')).json.some((a: any) => a.action === 'handoff.started'));
    assert.deepEqual((await s.call('GET', '/queue')).json, []); assert.equal((await s.call('POST', '/queue/drain')).json.stillQueued, 0);
    const routing = (await s.call('GET', `/sessions/${f.session.id}/routing`)).json; assert.equal(routing.length, 2);
    assert.deepEqual(routing.map((r: any) => r.provider), ['p-a', 'p-b']);
    assert.equal((await s.call('POST', '/sessions/nope/handoff', { provider: 'p-b', model: 'm', reason: 'x' })).status, 404);
  } finally { s.close(); }
});

test('API: a run that cannot get capacity is answered with 202 queued, not an error', async () => {
  const w = world(); const s = await serve(w);
  try {
    w.health.recordRateLimit('p-b', '', new Date(w.clock.t + HOUR).toISOString()); const f = w.feature();
    const r = await s.call('POST', `/tasks/${f.task.id}/runs`, { provider: 'p-b', model: 'm' });
    assert.equal(r.status, 202); assert.equal(r.json.queued, true); assert.match(r.json.reason, /no authorised capacity/);
    const q = (await s.call('GET', '/queue')).json; assert.equal(q.length, 1); assert.equal(q[0].status, 'queued');
    assert.equal((await s.call('POST', `/queue/${q[0].id}/cancel`)).json.status, 'cancelled');
  } finally { s.close(); }
});
