import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter, normalizeLine } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import { Supervisor, SessionBusyError } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p2-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const adapter = (scenario: string, extra: Record<string, string> = {}) =>
  new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: scenario, ...extra } });

function world(scenario = 'ok', extra: Record<string, string> = {}, db = openDb(':memory:')) {
  const store = new Store(db);
  const project = store.createProject({ name: 'p', repoPath: tmp });
  const session = store.createSession({ projectId: project.id, title: 's' });
  const task = store.createTask({ sessionId: session.id, description: 'do it', acceptanceCriteria: ['works'] });
  const sup = new Supervisor(store, adapter(scenario, extra));
  const go = (o: Partial<Parameters<Supervisor['start']>[0]> = {}) => sup.start({ taskId: task.id, prompt: 'x', cwd: tmp, model: 'm', ...o });
  return { db, store, project, session, task, sup, go };
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('condition not met in time');
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('normalizeLine maps known events and tolerates junk', () => {
  assert.deepEqual(normalizeLine('{"type":"system","subtype":"init","session_id":"s","model":"m"}'), { kind: 'init', model: 'm', providerSessionId: 's' });
  assert.equal(normalizeLine('not json'), undefined);
  assert.equal(normalizeLine('42'), undefined);
  assert.deepEqual(normalizeLine('{"type":"system","subtype":"hook_response"}'), { kind: 'other', type: 'system/hook_response' });
  const r = normalizeLine('{"type":"result","subtype":"success","is_error":false,"result":"hi"}');
  assert.equal(r?.kind === 'result' && r.ok, true);
  const bad = normalizeLine('{"type":"result","subtype":"success","is_error":true,"result":"x"}');
  assert.equal(bad?.kind === 'result' && bad.ok, false);
});

test('successful run: persisted as completed with pid, exit code, events, log and mirrored state', async () => {
  const w = world('ok');
  const started = w.go();
  assert.equal(started.status, 'running'); assert.ok(started.pid); assert.ok(started.cliSessionId);
  const done = await w.sup.waitFor(started.id);
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.ok(done.endedAt);
  assert.equal(w.store.getTask(w.task.id)!.status, 'completed');
  assert.equal(w.store.getSession(w.session.id)!.status, 'completed');
  const types = w.store.listEvents(w.session.id).map((e) => e.type);
  for (const t of ['agent.init', 'agent.message', 'agent.tool_result', 'agent.result']) assert.ok(types.includes(t), t);
  assert.ok(!types.some((t) => t.includes('hook') || t.includes('thinking')), 'noise is not persisted as events');
  const log = w.store.listArtifacts(w.session.id).find((a) => a.kind === 'log')!;
  assert.match(log.content!, /hook_response/, 'full output is kept in the log artifact');
  assert.equal(w.sup.isActive(started.id), false);
});

test('nonzero exit is failed, with reason and stderr captured', async () => {
  const w = world('fail');
  const done = await w.sup.waitFor(w.go().id);
  assert.equal(done.status, 'failed'); assert.equal(done.exitCode, 2); assert.match(done.terminationReason!, /exit code 2/);
  assert.equal(w.store.getSession(w.session.id)!.status, 'failed');
  assert.match(w.store.listArtifacts(w.session.id)[0].content!, /\[stderr\] boom/);
});

test('exit 0 without a result event is NOT success', async () => {
  const w = world('noresult');
  const done = await w.sup.waitFor(w.go().id);
  assert.equal(done.status, 'failed'); assert.match(done.terminationReason!, /without a result event/);
});

test('exit 0 with an error result is NOT success', async () => {
  const w = world('errresult');
  const done = await w.sup.waitFor(w.go().id);
  assert.equal(done.status, 'failed'); assert.match(done.terminationReason!, /error result/);
});

test('missing executable is a failed run, not a crash', async () => {
  const w = world('ok');
  const sup = new Supervisor(w.store, new ClaudeCliAdapter({ command: 'definitely-not-a-real-binary-xyz' }));
  const run = sup.start({ taskId: w.task.id, prompt: 'x', cwd: tmp, model: 'm' });
  const done = await sup.waitFor(run.id);
  assert.equal(done.status, 'failed'); assert.match(done.terminationReason!, /spawn error/);
});

test('cancel stops the process AND its child, and leaves the session resumable (paused)', async () => {
  const pidfile = join(tmp, 'cancel.pid');
  const w = world('slow', { FAKE_PIDFILE: pidfile });
  const run = w.go();
  await until(() => existsSync(pidfile));
  const grandchild = Number(readFileSync(pidfile, 'utf8'));
  assert.ok(alive(run.pid!) && alive(grandchild), 'both processes running before cancel');
  const done = await w.sup.cancel(run.id);
  assert.equal(done.status, 'cancelled'); assert.equal(done.terminationReason, 'cancelled by user');
  await until(() => !alive(grandchild), 3000);
  assert.ok(!alive(run.pid!));
  assert.equal(w.store.getTask(w.task.id)!.status, 'paused');
  assert.equal(w.store.getSession(w.session.id)!.status, 'paused');
  assert.equal(w.sup.isActive(run.id), false);
  assert.equal((await w.sup.cancel(run.id)).status, 'cancelled', 'cancelling twice is harmless');
});

test('timeout kills the run and records why', async () => {
  const pidfile = join(tmp, 'timeout.pid');
  const w = world('slow', { FAKE_PIDFILE: pidfile });
  const run = w.go({ timeoutMs: 1200 });
  const done = await w.sup.waitFor(run.id);
  assert.equal(done.status, 'failed'); assert.match(done.terminationReason!, /timeout after 1200ms/);
  await until(() => existsSync(pidfile) && !alive(Number(readFileSync(pidfile, 'utf8'))), 3000);
});

test('only one active run per session', async () => {
  const w = world('slow', { FAKE_PIDFILE: join(tmp, 'busy.pid') });
  const run = w.go();
  const task2 = w.store.createTask({ sessionId: w.session.id, description: 'second' });
  assert.throws(() => w.sup.start({ taskId: task2.id, prompt: 'x', cwd: tmp, model: 'm' }), SessionBusyError);
  await w.sup.cancel(run.id);
});

test('a completed task cannot be restarted, but a failed one can be retried', async () => {
  const w = world('ok');
  await w.sup.waitFor(w.go().id);
  assert.throws(() => w.go(), /cannot be started/);

  const f = world('fail');
  await f.sup.waitFor(f.go().id);
  const retry = new Supervisor(f.store, adapter('ok'));
  const run = retry.start({ taskId: f.task.id, prompt: 'x', cwd: tmp, model: 'm' });
  assert.equal((await retry.waitFor(run.id)).status, 'completed');
  assert.equal(f.store.getSession(f.session.id)!.status, 'completed');
});

test('secrets in agent output never reach events or the log artifact', async () => {
  const w = world('secret');
  await w.sup.waitFor(w.go().id);
  const dump = JSON.stringify(w.store.listEvents(w.session.id)) + w.store.listArtifacts(w.session.id).map((a) => a.content).join('');
  assert.ok(!dump.includes('sk-ant-api03-abcdefghijklmnop'));
  assert.ok(!dump.includes('hunter2hunter2'));
  assert.match(dump, /REDACTED/);
});

test('shutdown stops every active worker', async () => {
  const pidfile = join(tmp, 'shutdown.pid');
  const w = world('slow', { FAKE_PIDFILE: pidfile });
  const run = w.go();
  await until(() => existsSync(pidfile));
  await w.sup.shutdown();
  const r = w.store.getRun(run.id)!;
  assert.equal(r.status, 'cancelled'); assert.equal(r.terminationReason, 'application shutdown');
  assert.ok(!alive(run.pid!));
});

test('orphan recovery: a run left "running" by a dead supervisor is marked failed, never completed', () => {
  const w = world('ok');
  w.store.transitionSession(w.session.id, 'running'); w.store.transitionTask(w.task.id, 'running');
  const run = w.store.createRun({ taskId: w.task.id, role: 'coder', provider: 'claude-code-cli', model: 'm' });
  w.store.transitionRun(run.id, 'running', { pid: 2147483000 }); // a pid that cannot exist
  const found = w.sup.recoverOrphans();
  assert.deepEqual(found.map((o) => [o.runId, o.stillAlive]), [[run.id, false]]);
  const r = w.store.getRun(run.id)!;
  assert.equal(r.status, 'failed'); assert.match(r.terminationReason!, /orphaned/);
  assert.equal(w.store.getSession(w.session.id)!.status, 'failed');
  assert.deepEqual(w.sup.recoverOrphans(), [], 'second pass finds nothing');
});

test('EXIT CRITERIA: finished runs are persisted and queryable after an application restart', async () => {
  const path = join(tmp, 'restart.db');
  const w = world('ok', {}, openDb(path));
  const done = await w.sup.waitFor(w.go().id);
  const events = w.store.listEvents(w.session.id);
  w.db.close();
  const db2 = openDb(path); const s2 = new Store(db2);
  assert.deepEqual(s2.getRun(done.id), done);
  assert.deepEqual(s2.listEvents(w.session.id), events);
  assert.equal(s2.getSession(w.session.id)!.status, 'completed');
  db2.close();
});

test('API: create, start, poll, read events and log, and reject bad input', async () => {
  const w = world('ok');
  const server = createApi(w.store, w.sup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
  try {
    const p = await call('POST', '/projects', { name: 'api', repoPath: tmp });
    const s = await call('POST', '/sessions', { projectId: p.json.id, title: 'via api' });
    const t = await call('POST', `/sessions/${s.json.id}/tasks`, { description: 'make file', acceptanceCriteria: ['exists'] });
    assert.equal(t.status, 201);
    const r = await call('POST', `/tasks/${t.json.id}/runs`, { model: 'claude-haiku-5-5' });
    assert.equal(r.status, 202); assert.equal(r.json.status, 'running');
    await until(() => !w.sup.isActive(r.json.id));
    const got = await call('GET', `/runs/${r.json.id}`);
    assert.equal(got.json.status, 'completed'); assert.equal(got.json.active, false);
    const ev = await call('GET', `/sessions/${s.json.id}/events?after=3`);
    assert.ok(ev.json.length > 0 && ev.json.every((e: any) => e.seq > 3));
    const log = await call('GET', `/runs/${r.json.id}/log`);
    assert.equal(log.status, 200); assert.match(log.json, /"type":"result"/);
    assert.equal((await call('GET', `/sessions/${s.json.id}`)).json.session.status, 'completed');

    assert.equal((await call('POST', `/tasks/${t.json.id}/runs`, { model: 'm' })).status, 409, 'completed task cannot restart');
    assert.equal((await call('POST', '/projects', { name: '' })).status, 400);
    assert.equal((await call('POST', `/tasks/${t.json.id}/runs`, { model: 'bad model; rm -rf' })).status, 400);
    assert.equal((await call('POST', `/tasks/${t.json.id}/runs`, { model: 'm', timeoutMs: 5 })).status, 400);
    assert.equal((await call('GET', '/runs/run_nope')).status, 404);
    assert.equal((await call('GET', '/nothing')).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('API: cancel a running task', async () => {
  const w = world('slow', { FAKE_PIDFILE: join(tmp, 'api.pid') });
  const server = createApi(w.store, w.sup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const run = await (await fetch(`${base}/tasks/${w.task.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) })).json() as any;
    const c = await (await fetch(`${base}/runs/${run.id}/cancel`, { method: 'POST' })).json() as any;
    assert.equal(c.status, 'cancelled');
    assert.equal(w.store.getSession(w.session.id)!.status, 'paused');
  } finally { await new Promise((r) => server.close(r)); }
});
