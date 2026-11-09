import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import type { ProviderAdapter } from '../../services/orchestrator/src/runtime/adapters/types.ts';
import { Supervisor, WorktreeBusyError, IdempotencyConflictError } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService, buildResumePrompt } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { ResumeService, ResumeError } from '../../services/orchestrator/src/checkpoints/resume-service.ts';
import { readGit, snapshot } from '../../services/orchestrator/src/checkpoints/git.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const MAIN = resolve(ROOT, 'services/orchestrator/src/main.ts');
const tmp = mkdtempSync(join(tmpdir(), 'p3-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo(name = `repo${++n}`) {
  const dir = join(tmp, name); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'base.txt'), 'base\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
const adapter = (scenario: string, extra: Record<string, string> = {}) =>
  new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: scenario, ...extra } });
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('condition not met in time');
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function world(scenario = 'ok', extra: Record<string, string> = {}, o: { db?: DatabaseSync; repo?: string; interval?: number } = {}) {
  const db = o.db ?? openDb(':memory:'); const store = new Store(db);
  const repo = o.repo ?? makeRepo();
  const project = store.createProject({ name: 'p', repoPath: repo });
  const session = store.createSession({ projectId: project.id, title: 's' });
  const task = store.createTask({ sessionId: session.id, description: 'build the thing', acceptanceCriteria: ['it works'] });
  const cps = new CheckpointService(store);
  const mk = (sc: string, ex: Record<string, string> = {}) => new Supervisor(store, adapter(sc, ex), { checkpoints: cps, checkpointIntervalMs: o.interval ?? 0 });
  const sup = mk(scenario, extra);
  const go = (s = sup, over: Partial<Parameters<Supervisor['start']>[0]> = {}) => s.start({ taskId: task.id, prompt: 'x', cwd: repo, model: 'm', ...over });
  return { db, store, repo, project, session, task, cps, sup, mk, go };
}

// ---------------------------------------------------------------- git snapshot (read-only)
test('git snapshot sees tracked edits, untracked files, and a changing fingerprint', () => {
  const repo = makeRepo();
  const clean = snapshot(repo);
  assert.equal(clean.available, true); assert.equal(clean.branch, 'main'); assert.equal(clean.status, 'clean'); assert.deepEqual(clean.changedFiles, []);
  writeFileSync(join(repo, 'base.txt'), 'edited\n'); writeFileSync(join(repo, 'new file.txt'), 'hello\n');
  const dirty = snapshot(repo);
  assert.deepEqual(dirty.untracked, ['new file.txt'], 'untracked file with a space in its name');
  assert.ok(dirty.changedFiles.includes('base.txt')); assert.match(dirty.diff, /\+edited/);
  assert.notEqual(dirty.fingerprint, clean.fingerprint);
  writeFileSync(join(repo, 'new file.txt'), 'hello!\n');
  assert.notEqual(snapshot(repo).fingerprint, dirty.fingerprint, 'untracked CONTENT changes the fingerprint');
  assert.equal(snapshot(tmp).available, false, 'not a git repo');
});

test('checkpoint git access is read-only by construction', () => {
  const repo = makeRepo();
  for (const cmd of ['reset', 'clean', 'checkout', 'commit', 'stash', 'rm', 'restore'])
    assert.throws(() => readGit(repo, cmd), /not allowed/, cmd);
  writeFileSync(join(repo, 'keep.txt'), 'x'); snapshot(repo);
  assert.ok(existsSync(join(repo, 'keep.txt')), 'snapshot never touches files');
});

// ---------------------------------------------------------------- capture
test('capture stores the request, plan, event position, diff artifact and points the session at it', () => {
  const w = world();
  writeFileSync(join(w.repo, 'base.txt'), 'edited\n');
  w.store.appendEvent({ sessionId: w.session.id, type: 'agent.message', payload: { text: 'halfway there' } });
  const cp = w.cps.capture({ sessionId: w.session.id, reason: 'manual', nextAction: 'finish it' });
  assert.equal(cp.nextAction, 'finish it'); assert.equal(w.store.getSession(w.session.id)!.checkpointId, cp.id);
  const d = cp.data as any;
  assert.equal(d.request.description, 'build the thing'); assert.deepEqual(d.request.acceptanceCriteria, ['it works']);
  assert.equal(d.steps.length, 1); assert.deepEqual(d.changedFiles, ['base.txt']); assert.equal(d.lastAgentMessage, 'halfway there');
  assert.ok(d.lastEventSeq >= 3); assert.equal(cp.gitState.branch, 'main');
  const art = w.store.listArtifacts(w.session.id).find((a) => a.id === d.diffArtifactId)!;
  assert.equal(art.kind, 'diff'); assert.match(art.content!, /\+edited/);
});

test('secrets in a diff are redacted before the checkpoint artifact is stored', () => {
  const w = world();
  writeFileSync(join(w.repo, 'base.txt'), 'password=supersecretvalue99\nkey sk-ant-api03-abcdefghijklmnopqrstuv\n');
  w.cps.capture({ sessionId: w.session.id, reason: 'manual', nextAction: 'x' });
  const dump = w.store.listArtifacts(w.session.id).map((a) => a.content).join('');
  assert.ok(!dump.includes('supersecretvalue99') && !dump.includes('sk-ant-api03-abc')); assert.match(dump, /REDACTED/);
});

// ---------------------------------------------------------------- verify / drift
test('verify: unchanged, changed, moved HEAD, branch switch (blocked), missing dir (blocked)', () => {
  const w = world();
  writeFileSync(join(w.repo, 'work.txt'), 'wip\n');
  const cp = w.cps.capture({ sessionId: w.session.id, reason: 'manual', nextAction: 'x' });
  assert.equal(w.cps.verify(cp).level, 'unchanged');

  writeFileSync(join(w.repo, 'other.txt'), 'surprise\n');
  const changed = w.cps.verify(cp);
  assert.equal(changed.level, 'changed'); assert.deepEqual(changed.added, ['other.txt']); assert.match(changed.notes.join(), /other\.txt/);

  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'agent committed');
  const moved = w.cps.verify(cp);
  assert.equal(moved.level, 'changed'); assert.match(moved.notes.join(), /HEAD moved/); assert.ok(moved.removed.includes('work.txt'));

  git(w.repo, 'checkout', '-q', '-b', 'other-branch');
  const blocked = w.cps.verify(cp);
  assert.equal(blocked.level, 'blocked'); assert.match(blocked.notes[0], /branch changed/);

  rmSync(w.repo, { recursive: true, force: true });
  assert.match(w.cps.verify(cp).notes[0], /no longer exists/);
});

test('resume prompt carries task, next action and rules, warns on drift, and never embeds the diff', () => {
  const w = world(); writeFileSync(join(w.repo, 'work.txt'), 'SECRET_DIFF_BODY\n');
  const cp = w.cps.capture({ sessionId: w.session.id, reason: 'paused by user', nextAction: 'write part two' });
  const calm = buildResumePrompt(cp as any, { level: 'unchanged', notes: [], added: [], removed: [] });
  for (const s of ['build the thing', 'it works', 'write part two', 'paused by user', 'work.txt', 'Do NOT delete, reset, revert']) assert.ok(calm.includes(s), s);
  assert.ok(!calm.includes('SECRET_DIFF_BODY') && !calm.includes('WARNING'));
  assert.match(buildResumePrompt(cp as any, { level: 'changed', notes: ['changed since checkpoint: z.txt'], added: ['z.txt'], removed: [] }), /WARNING[\s\S]*z\.txt/);
});

// ---------------------------------------------------------------- checkpoint boundaries
test('a run saves checkpoints before launch, during progress, and at the end', async () => {
  const w = world('record-prompt', {}, { interval: 0 });
  await w.sup.waitFor(w.go().id);
  const reasons = w.store.listCheckpoints(w.session.id).map((c) => (c.data as any).reason);
  assert.deepEqual(reasons, ['before-launch', 'progress', 'run-completed']);
  const seqs = w.store.listCheckpoints(w.session.id).map((c) => (c.data as any).lastEventSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'event position only moves forward');
  assert.equal((w.store.latestCheckpoint(w.session.id)!.data as any).lastRuntimeStatus, 'completed');
});

test('mid-run checkpoints are throttled by the interval', async () => {
  const w = world('record-prompt', {}, { interval: 60_000 });
  await w.sup.waitFor(w.go().id);
  assert.ok(!w.store.listCheckpoints(w.session.id).some((c) => (c.data as any).reason === 'progress'));
});

test('a checkpoint failure never fails the run; it is recorded as an event', async () => {
  const w = world('ok');
  const broken = { capture() { throw new Error('disk full'); } } as unknown as CheckpointService;
  const sup = new Supervisor(w.store, adapter('ok'), { checkpoints: broken });
  const done = await sup.waitFor(w.go(sup).id);
  assert.equal(done.status, 'completed');
  assert.ok(w.store.listEvents(w.session.id).some((e) => e.type === 'checkpoint.failed' && /disk full/.test(String(e.payload.error))));
});

// ---------------------------------------------------------------- pause / cancel -> resume
test('pause keeps uncommitted work; resume continues from the checkpoint with a fresh worker', async () => {
  const argsFile = join(tmp, 'args-pause.json');
  const w = world('edit-then-hang');
  const run = w.go();
  await until(() => existsSync(join(w.repo, 'work.txt')) && ((w.cps.latest(w.session.id)?.data.changedFiles ?? []) as string[]).includes('work.txt'));
  const paused = await w.sup.pauseSession(w.session.id);
  assert.equal(paused!.status, 'cancelled'); assert.equal(paused!.terminationReason, 'paused by user');
  assert.equal(w.store.getSession(w.session.id)!.status, 'paused');
  assert.equal(readFileSync(join(w.repo, 'work.txt'), 'utf8'), 'precious\n', 'uncommitted work untouched by pause');
  assert.equal(w.store.listWorktreeLocks().length, 0, 'lock released');

  const resumer = new ResumeService(w.store, w.mk('record-prompt', { FAKE_ARGS_FILE: argsFile }), w.cps);
  const r = resumer.resume(w.session.id, { model: 'm' });
  assert.equal(r.drift!.level, 'unchanged'); assert.notEqual(r.run.id, run.id);
  const resumedSup = (resumer as any).supervisor as Supervisor;
  assert.equal((await resumedSup.waitFor(r.run.id)).status, 'completed');
  const rec = JSON.parse(readFileSync(argsFile, 'utf8'));
  const prompt = rec.argv[rec.argv.indexOf('-p') + 1];
  assert.match(prompt, /RESUMING/); assert.match(prompt, /build the thing/); assert.match(prompt, /work\.txt/);
  assert.ok(!rec.argv.includes('--resume') && rec.argv.includes('--session-id'), 'portable mode: brand-new provider session');
  assert.equal(readFileSync(join(w.repo, 'work.txt'), 'utf8'), 'precious\n', 'earlier work survives the resume');
  assert.ok(existsSync(join(w.repo, 'part2.txt')));
  assert.equal(w.store.getSession(w.session.id)!.status, 'completed');
  assert.ok(w.store.listEvents(w.session.id).some((e) => e.type === 'session.resume' && e.payload.mode === 'portable'));
});

test('native mode also passes the provider --resume id', async () => {
  const argsFile = join(tmp, 'args-native.json');
  const w = world('edit-then-hang');
  const run = w.go(); await until(() => existsSync(join(w.repo, 'work.txt')));
  await w.sup.pauseSession(w.session.id);
  const sup2 = w.mk('record-prompt', { FAKE_ARGS_FILE: argsFile });
  const r = new ResumeService(w.store, sup2, w.cps).resume(w.session.id, { model: 'm', mode: 'native' });
  await sup2.waitFor(r.run.id);
  const rec = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(rec.argv[rec.argv.indexOf('--resume') + 1], w.store.getRun(run.id)!.cliSessionId);
});

test('resume tells the worker about changes made while it was stopped', async () => {
  const argsFile = join(tmp, 'args-drift.json');
  const w = world('edit-then-hang');
  w.go(); await until(() => existsSync(join(w.repo, 'work.txt')));
  await w.sup.pauseSession(w.session.id);
  writeFileSync(join(w.repo, 'base.txt'), 'edited by a human\n'); // someone touched the repo meanwhile
  const sup2 = w.mk('record-prompt', { FAKE_ARGS_FILE: argsFile });
  const r = new ResumeService(w.store, sup2, w.cps).resume(w.session.id, { model: 'm' });
  assert.equal(r.drift!.level, 'changed'); await sup2.waitFor(r.run.id);
  const rec = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.match(rec.argv[rec.argv.indexOf('-p') + 1], /WARNING[\s\S]*base\.txt/);
  assert.equal(readFileSync(join(w.repo, 'base.txt'), 'utf8'), 'edited by a human\n', "the human's edit is not reverted");
});

test('resume is refused when unsafe, and nothing starts', async () => {
  const w = world('edit-then-hang');
  const resumer = new ResumeService(w.store, w.sup, w.cps);
  assert.throws(() => resumer.resume(w.session.id, { model: 'm' }), /queued; only paused or failed/);
  assert.throws(() => resumer.check(w.session.id), /no checkpoint/);

  w.go(); await until(() => existsSync(join(w.repo, 'work.txt')));
  await w.sup.pauseSession(w.session.id);
  const runsBefore = w.store.listRuns().length;
  git(w.repo, 'checkout', '-q', '-b', 'elsewhere');
  assert.throws(() => resumer.resume(w.session.id, { model: 'm' }), (e: any) => e instanceof ResumeError && /branch changed/.test(e.message) && e.drift.level === 'blocked');
  assert.equal(w.store.listRuns().length, runsBefore, 'no new run was created');
  assert.equal(w.store.getSession(w.session.id)!.status, 'paused', 'session unchanged');
  git(w.repo, 'checkout', '-q', 'main');
  assert.equal(resumer.check(w.session.id).drift.level, 'unchanged', 'safe again after switching back');
});

test('a completed session cannot be resumed', async () => {
  const w = world('ok'); await w.sup.waitFor(w.go().id);
  assert.throws(() => new ResumeService(w.store, w.sup, w.cps).resume(w.session.id, { model: 'm' }), /completed; only paused or failed/);
});

test('crash point: launch failure leaves a failed, resumable session with checkpoints and no lock', async () => {
  const w = world('ok');
  const exploding: ProviderAdapter = { provider: 'boom', launch() { throw new Error('cannot start'); } };
  const sup1 = new Supervisor(w.store, exploding, { checkpoints: w.cps, checkpointIntervalMs: 0 });
  const run = sup1.start({ taskId: w.task.id, prompt: 'x', cwd: w.repo, model: 'm' });
  assert.equal(run.status, 'failed'); assert.match(run.terminationReason!, /launch error: cannot start/);
  assert.deepEqual(w.store.listCheckpoints(w.session.id).map((c) => (c.data as any).reason), ['before-launch', 'run-failed']);
  assert.equal(w.store.listWorktreeLocks().length, 0);
  const sup2 = w.mk('record-prompt');
  const r = new ResumeService(w.store, sup2, w.cps).resume(w.session.id, { model: 'm' });
  assert.equal((await sup2.waitFor(r.run.id)).status, 'completed');
});

test('crash point: process gone but run still "running" -> recovery fails it, frees the lock, saves a checkpoint', () => {
  const w = world('ok');
  w.store.transitionSession(w.session.id, 'running'); w.store.transitionTask(w.task.id, 'running');
  const run = w.store.createRun({ taskId: w.task.id, role: 'coder', provider: 'x', model: 'm' });
  w.store.transitionRun(run.id, 'running', { pid: 2147483000 });
  w.store.acquireWorktreeLock(w.repo.toLowerCase(), w.session.id, run.id);
  writeFileSync(join(w.repo, 'half-done.txt'), 'wip');
  assert.equal(w.sup.recoverOrphans().length, 1);
  assert.equal(w.store.listWorktreeLocks().length, 0);
  const cp = w.cps.latest(w.session.id)!;
  assert.equal(cp.data.reason, 'run-failed'); assert.ok(cp.data.changedFiles.includes('half-done.txt'));
  assert.match(cp.nextAction, /retry the task/);
});

// ---------------------------------------------------------------- worktree lock
test('one writer per working directory, across sessions; lock freed on finish', async () => {
  const w = world('slow', { FAKE_PIDFILE: join(tmp, 'lock.pid') });
  const run1 = w.go();
  assert.equal(w.store.listWorktreeLocks().length, 1);
  const s2 = w.store.createSession({ projectId: w.project.id, title: 'second' });
  const t2 = w.store.createTask({ sessionId: s2.id, description: 'other' });
  const start2 = (cwd: string) => w.sup.start({ taskId: t2.id, prompt: 'x', cwd, model: 'm' });
  assert.throws(() => start2(w.repo), WorktreeBusyError);
  assert.throws(() => start2(w.repo + '\\'), WorktreeBusyError, 'trailing separator is the same directory');
  assert.throws(() => start2(w.repo.toUpperCase()), process.platform === 'win32' ? WorktreeBusyError : /./, 'case-insensitive on Windows');
  assert.equal(w.store.getSession(s2.id)!.status, 'queued', 'a refused start changes no state');
  await w.sup.cancel(run1.id);
  assert.equal(w.store.listWorktreeLocks().length, 0);
  const sup2 = w.mk('ok'); const run2 = sup2.start({ taskId: t2.id, prompt: 'x', cwd: w.repo, model: 'm' });
  assert.equal((await sup2.waitFor(run2.id)).status, 'completed');
});

test('a stale lock left by an ended run is reclaimed', async () => {
  const w = world('ok'); await w.sup.waitFor(w.go().id);
  const s2 = w.store.createSession({ projectId: w.project.id, title: 'two' });
  const t2 = w.store.createTask({ sessionId: s2.id, description: 'two' });
  const finished = w.store.listRuns()[0];
  w.store.acquireWorktreeLock(w.repo.toLowerCase(), s2.id, finished.id); // stale: its run is completed
  const sup2 = w.mk('ok'); const run = sup2.start({ taskId: t2.id, prompt: 'x', cwd: w.repo, model: 'm' });
  assert.equal((await sup2.waitFor(run.id)).status, 'completed');
});

// ---------------------------------------------------------------- idempotency
test('same idempotency key returns the original run and starts no second process', async () => {
  const w = world('record-prompt');
  const a = w.go(w.sup, { idempotencyKey: 'key-0001-aaaa' });
  const b = w.go(w.sup, { idempotencyKey: 'key-0001-aaaa' });
  assert.equal(b.id, a.id); await w.sup.waitFor(a.id);
  assert.equal(w.store.listRuns().length, 1);
  assert.equal(w.go(w.sup, { idempotencyKey: 'key-0001-aaaa' }).id, a.id, 'still replayed after the run has finished');
  const t2 = w.store.createTask({ sessionId: w.session.id, description: 'different' });
  assert.throws(() => w.sup.start({ taskId: t2.id, prompt: 'x', cwd: w.repo, model: 'm', idempotencyKey: 'key-0001-aaaa' }), IdempotencyConflictError);
});

test('resume is idempotent too', async () => {
  const w = world('edit-then-hang');
  w.go(); await until(() => existsSync(join(w.repo, 'work.txt')));
  await w.sup.pauseSession(w.session.id);
  const sup2 = w.mk('record-prompt'); const rs = new ResumeService(w.store, sup2, w.cps);
  const first = rs.resume(w.session.id, { model: 'm', idempotencyKey: 'resume-key-1' });
  const again = rs.resume(w.session.id, { model: 'm', idempotencyKey: 'resume-key-1' });
  assert.equal(again.run.id, first.run.id); assert.equal(again.replayed, true);
  await sup2.waitFor(first.run.id);
  assert.equal(w.store.listRuns().length, 2, 'original run + exactly one resumed run');
});

// ---------------------------------------------------------------- persistence
test('checkpoints and migration 2 data survive an application restart', () => {
  const path = join(tmp, 'p3-restart.db');
  const w = world('ok', {}, { db: openDb(path) });
  writeFileSync(join(w.repo, 'x.txt'), '1');
  const cp = w.cps.capture({ sessionId: w.session.id, reason: 'manual', nextAction: 'go' });
  w.db.close();
  const db2 = openDb(path); const s2 = new Store(db2);
  assert.deepEqual(s2.latestCheckpoint(w.session.id), cp);
  assert.equal(s2.getSession(w.session.id)!.checkpointId, cp.id);
  assert.deepEqual(new CheckpointService(s2).verify(s2.latestCheckpoint(w.session.id) as any), { level: 'unchanged', notes: [], added: [], removed: [] });
  db2.close();
});

// ---------------------------------------------------------------- API
test('API: checkpoint, resume-check, pause, resume, idempotency header, validation', async () => {
  const w = world('edit-then-hang');
  const server = createApi(w.store, w.sup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
  try {
    assert.equal((await call('POST', `/sessions/${w.session.id}/pause`)).status, 409, 'nothing to pause');
    assert.equal((await call('GET', `/sessions/${w.session.id}/checkpoint`)).status, 404);
    const start = await call('POST', `/tasks/${w.task.id}/runs`, { model: 'm' }, { 'idempotency-key': 'api-key-12345' });
    assert.equal(start.status, 202);
    assert.equal((await call('POST', `/tasks/${w.task.id}/runs`, { model: 'm' }, { 'idempotency-key': 'api-key-12345' })).json.id, start.json.id, 'replay returns the same run');
    assert.equal((await call('POST', `/tasks/${w.task.id}/runs`, { model: 'm' }, { 'idempotency-key': 'short' })).status, 400);
    assert.equal((await call('GET', '/worktree-locks')).json.length, 1);
    await until(() => existsSync(join(w.repo, 'work.txt')));

    const manual = await call('POST', `/sessions/${w.session.id}/checkpoint`, { nextAction: 'manual note' });
    assert.equal(manual.status, 201); assert.equal(manual.json.nextAction, 'manual note');
    const paused = await call('POST', `/sessions/${w.session.id}/pause`);
    assert.equal(paused.status, 200); assert.equal(paused.json.session.status, 'paused');
    assert.equal((await call('GET', `/sessions/${w.session.id}/checkpoint`)).json.data.reason, 'run-cancelled');
    const check = await call('GET', `/sessions/${w.session.id}/resume-check`);
    assert.equal(check.json.drift.level, 'unchanged');
    assert.equal((await call('POST', `/sessions/${w.session.id}/resume`, { model: 'm', mode: 'weird' })).status, 400);
    assert.equal((await call('POST', `/sessions/${w.session.id}/resume`, { model: 'bad model!' })).status, 400);
    assert.equal((await call('GET', '/worktree-locks')).json.length, 0);
  } finally { await w.sup.shutdown(); await new Promise((r) => server.close(r)); }
});

test('API without checkpoints reports 501 instead of crashing', async () => {
  const w = world('ok');
  const plain = new Supervisor(w.store, adapter('ok'));
  const server = createApi(w.store, plain);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/${w.session.id}/checkpoint`);
    assert.equal(res.status, 501);
  } finally { await new Promise((r) => server.close(r)); }
});

// ---------------------------------------------------------------- EXIT CRITERIA: real crash of the server process
const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
async function startServer(env: Record<string, string>) {
  const port = await freePort();
  const proc: ChildProcess = spawn(process.execPath, ['--no-warnings', MAIN], {
    env: { ...process.env, PORT: String(port), CLAUDE_BIN: process.execPath, ORCH_CLAUDE_ARGS: JSON.stringify([FIXTURE]), ORCH_CHECKPOINT_INTERVAL_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  await until(() => /listening on/.test(out), 10000);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() as any };
  };
  const stop = async () => { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); };
  return { call, proc, stop, log: () => out };
}

test('EXIT CRITERIA: server process is hard-killed mid-run; after restart the session resumes from persisted state with no lost changes', async () => {
  const repo = makeRepo('crash-repo'); const dbPath = join(tmp, 'crash.db'); const argsFile = join(tmp, 'crash-args.json');

  const s1 = await startServer({ DB_PATH: dbPath, FAKE_SCENARIO: 'edit-then-hang' });
  const project = (await s1.call('POST', '/projects', { name: 'crash', repoPath: repo })).json;
  const session = (await s1.call('POST', '/sessions', { projectId: project.id, title: 'crash test' })).json;
  const task = (await s1.call('POST', `/sessions/${session.id}/tasks`, { description: 'create work.txt then part2.txt', acceptanceCriteria: ['both exist'] })).json;
  const run = (await s1.call('POST', `/tasks/${task.id}/runs`, { model: 'm' })).json;
  assert.equal(run.status, 'running');
  await until(() => existsSync(join(repo, 'work.txt')));
  // wait until a checkpoint that already contains the unfinished work has been persisted
  const deadline = Date.now() + 8000; let cpBefore: any;
  while (Date.now() < deadline) {
    const r = await s1.call('GET', `/sessions/${session.id}/checkpoint`);
    if (r.status === 200 && r.json.data.changedFiles.includes('work.txt')) { cpBefore = r.json; break; }
    await new Promise((x) => setTimeout(x, 50));
  }
  assert.ok(cpBefore, 'a mid-run checkpoint captured the unfinished work before the crash');

  // CRASH: kill the server without any chance to clean up, then the worker too (as a reboot would).
  await s1.stop();
  try { execFileSync('taskkill', ['/PID', String(run.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  await until(() => !alive(run.pid), 5000);
  assert.equal(readFileSync(join(repo, 'work.txt'), 'utf8'), 'precious\n', 'uncommitted file survives the crash');

  // RESTART on the same database with a worker that can finish the job.
  const s2 = await startServer({ DB_PATH: dbPath, FAKE_SCENARIO: 'record-prompt', FAKE_ARGS_FILE: argsFile });
  try {
    assert.match(s2.log(), /recovered orphaned run/);
    const after = (await s2.call('GET', `/runs/${run.id}`)).json;
    assert.equal(after.status, 'failed'); assert.match(after.terminationReason, /orphaned/);
    assert.equal((await s2.call('GET', `/sessions/${session.id}`)).json.session.status, 'failed');
    assert.equal((await s2.call('GET', '/worktree-locks')).json.length, 0, 'crashed run no longer owns the directory');
    const check = (await s2.call('GET', `/sessions/${session.id}/resume-check`)).json;
    assert.equal(check.drift.level, 'unchanged');

    const r1 = await s2.call('POST', `/sessions/${session.id}/resume`, { model: 'm' }, { 'idempotency-key': 'crash-resume-1' });
    assert.equal(r1.status, 202);
    const r2 = await s2.call('POST', `/sessions/${session.id}/resume`, { model: 'm' }, { 'idempotency-key': 'crash-resume-1' });
    assert.equal(r2.status, 200); assert.equal(r2.json.run.id, r1.json.run.id, 'retried resume does not start a second worker');
    const resumedId = r1.json.run.id;
    const end = Date.now() + 8000; let final: any;
    while (Date.now() < end) { final = (await s2.call('GET', `/runs/${resumedId}`)).json; if (final.active === false) break; await new Promise((x) => setTimeout(x, 50)); }
    assert.equal(final.status, 'completed');
    assert.equal((await s2.call('GET', `/sessions/${session.id}`)).json.session.status, 'completed');

    const rec = JSON.parse(readFileSync(argsFile, 'utf8'));
    const prompt: string = rec.argv[rec.argv.indexOf('-p') + 1];
    assert.match(prompt, /create work\.txt then part2\.txt/); assert.match(prompt, /work\.txt/); assert.match(prompt, /orphaned/);
    assert.equal(readFileSync(join(repo, 'work.txt'), 'utf8'), 'precious\n', 'earlier uncommitted work is intact');
    assert.ok(existsSync(join(repo, 'part2.txt')), 'the resumed worker finished the job');
    const runs = [run.id, resumedId]; assert.equal(new Set(runs).size, 2);
    const events = (await s2.call('GET', `/sessions/${session.id}/events`)).json as any[];
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'event log is gap-free across the crash');
  } finally { await s2.stop(); }
});
