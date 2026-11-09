import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import { Supervisor, WrongWorkdirError } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { WorktreeError, WorktreeService } from '../../services/orchestrator/src/worktrees/worktree-service.ts';
import { adminGit } from '../../services/orchestrator/src/worktrees/git-admin.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p6-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const real = (p: string) => realpathSync.native(p).toLowerCase();
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const f of ['base.txt', 'a.txt', 'b.txt']) writeFileSync(join(dir, f), `${f}\nline2\nline3\n`);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
const adapter = (scenario: string, extra: Record<string, string> = {}) =>
  new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: scenario, ...extra } });
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('condition not met in time');
};
const commit = (cwd: string, file: string, text: string, msg = 'change') => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', msg); };

function world(scenario = 'ok', extra: Record<string, string> = {}) {
  const db = openDb(':memory:'); const store = new Store(db); const repo = makeRepo();
  const project = store.createProject({ name: 'My Project', repoPath: repo });
  const wt = new WorktreeService(store, { root: join(tmp, `wt-root-${n}`) });
  const cps = new CheckpointService(store);
  const sup = new Supervisor(store, adapter(scenario, extra), { checkpoints: cps, checkpointIntervalMs: 0 });
  const feature = (title: string) => {
    const session = store.createSession({ projectId: project.id, title });
    const task = store.createTask({ sessionId: session.id, description: `do ${title}` });
    return { session, task, worktree: wt.create(session.id) };
  };
  return { db, store, repo, project, wt, cps, sup, feature };
}
const failsWith = (fn: () => unknown, status: number, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof WorktreeError && e.status === status && re.test(e.message));

// ---------------------------------------------------------------- allow-list
test('git admin allow-list: nothing that can lose work is runnable, and force flags are refused', () => {
  const repo = makeRepo();
  for (const bad of [['reset', '--hard'], ['clean', '-fd'], ['checkout', '.'], ['stash'], ['rebase', 'main'], ['merge', 'main'], ['push'], ['branch', '-D', 'x'], ['worktree', 'move', 'a', 'b']])
    assert.throws(() => adminGit(repo, ...bad), /not allowed/, bad.join(' '));
  assert.throws(() => adminGit(repo, 'worktree', 'remove', '--force', 'x'), /never allowed/);
  assert.throws(() => adminGit(repo, 'worktree', 'remove', '-f', 'x'), /never allowed/);
  assert.equal(adminGit(repo, 'rev-parse', 'HEAD').code, 0);
});

// ---------------------------------------------------------------- create
test('create: worktree sits outside the repo on its own branch from the base commit; the main checkout is untouched', () => {
  const w = world(); const baseHead = git(w.repo, 'rev-parse', 'main').trim();
  const { session, worktree } = w.feature('Add subtract!');
  assert.ok(!worktree.path.startsWith(w.repo), 'outside the repository');
  assert.match(worktree.branch, /^orch\/add-subtract-[0-9a-f]{8}$/);
  assert.equal(worktree.baseRevision, baseHead); assert.equal(worktree.baseBranch, 'main');
  assert.equal(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), worktree.branch);
  assert.ok(existsSync(join(worktree.path, 'base.txt')));
  assert.equal(w.store.getSession(session.id)!.worktreePath, worktree.path);
  assert.ok(w.store.listEvents(session.id).some((e) => e.type === 'worktree.created'));
  assert.equal(git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main'); assert.equal(git(w.repo, 'status', '--porcelain').trim(), '', 'main checkout is clean');
  assert.match(git(w.repo, 'worktree', 'list'), new RegExp(worktree.branch.replace('/', '[\\\\/]|')) );
  assert.ok(!existsSync(join(w.repo, '.orch-worktrees')), 'nothing is created inside the repository');
});

test('create is refused when it would be unsafe or ambiguous', async () => {
  const w = world(); const { session } = w.feature('one');
  failsWith(() => w.wt.create(session.id), 409, /already has a worktree/);
  failsWith(() => w.wt.create('ses_nope'), 404, /not found/);

  const started = w.store.createSession({ projectId: w.project.id, title: 'started' }); const t = w.store.createTask({ sessionId: started.id, description: 'x' });
  const sup = new Supervisor(w.store, adapter('ok'), { checkpoints: w.cps }); await sup.waitFor(sup.start({ taskId: t.id, prompt: 'x', cwd: w.repo, model: 'm' }).id);
  failsWith(() => w.wt.create(started.id), 409, /before its first run/);

  const notGit = join(tmp, 'plain'); mkdirSync(notGit);
  const p2 = w.store.createProject({ name: 'plain', repoPath: notGit }); const s2 = w.store.createSession({ projectId: p2.id, title: 's' });
  failsWith(() => w.wt.create(s2.id), 409, /not a git repository/);

  const inside = new WorktreeService(w.store, { root: join(w.repo, 'inside') }); const s3 = w.store.createSession({ projectId: w.project.id, title: 's3' });
  failsWith(() => inside.create(s3.id), 400, /outside the repository/);
});

test('create falls back to the current branch when the configured default does not exist', () => {
  const w = world(); const p = w.store.createProject({ name: 'odd', repoPath: makeRepo(), defaultBranch: 'trunk' });
  const s = w.store.createSession({ projectId: p.id, title: 'odd' });
  assert.equal(w.wt.create(s.id).baseBranch, 'main');
});

// ---------------------------------------------------------------- status
test('status tracks branch, base, head, commits ahead/behind, committed and uncommitted files', () => {
  const w = world(); const { worktree } = w.feature('status');
  let st = w.wt.status(worktree);
  assert.equal(st.ahead, 0); assert.equal(st.behind, 0); assert.deepEqual(st.touched, []); assert.equal(st.currentBranch, worktree.branch);

  commit(worktree.path, 'a.txt', 'a.txt\nCHANGED\nline3\n');
  writeFileSync(join(worktree.path, 'b.txt'), 'b.txt\nEDITED\nline3\n'); writeFileSync(join(worktree.path, 'new.txt'), 'new\n');
  commit(w.repo, 'base.txt', 'base.txt\nmain moved on\nline3\n'); // the base branch advances
  st = w.wt.status(worktree);
  assert.equal(st.ahead, 1); assert.equal(st.behind, 1);
  assert.deepEqual(st.committed, ['a.txt']); assert.deepEqual(st.uncommitted, ['b.txt', 'new.txt']); assert.deepEqual(st.touched, ['a.txt', 'b.txt', 'new.txt']);
  assert.ok(st.numstat.some((x) => x.path === 'a.txt' && x.added === 1 && x.deleted === 1));
  assert.equal(st.head, git(worktree.path, 'rev-parse', 'HEAD').trim());
});

// ---------------------------------------------------------------- exit criterion 1
test('EXIT 1: two isolated tasks work concurrently without writing into each other (or the main checkout)', async () => {
  const w = world('edit-then-hang');
  const A = w.feature('task a'), B = w.feature('task b');
  assert.notEqual(A.worktree.path, B.worktree.path);

  // The explicit binding: a session may run only in its own worktree.
  assert.throws(() => w.sup.start({ taskId: A.task.id, prompt: 'x', cwd: w.repo, model: 'm' }), WrongWorkdirError);
  assert.throws(() => w.sup.start({ taskId: A.task.id, prompt: 'x', cwd: B.worktree.path, model: 'm' }), WrongWorkdirError);
  assert.equal(w.store.getSession(A.session.id)!.status, 'queued', 'a refused start changes nothing');

  const ra = w.sup.start({ taskId: A.task.id, prompt: 'x', cwd: A.worktree.path, model: 'm' });
  const rb = w.sup.start({ taskId: B.task.id, prompt: 'x', cwd: B.worktree.path, model: 'm' });
  assert.equal(ra.status, 'running'); assert.equal(rb.status, 'running'); assert.equal(w.store.listWorktreeLocks().length, 2, 'two different locks');
  await until(() => existsSync(join(A.worktree.path, 'work.txt')) && existsSync(join(B.worktree.path, 'work.txt')));
  assert.equal(w.wt.status(A.worktree).busyRunId, ra.id);

  assert.ok(!existsSync(join(w.repo, 'work.txt')), 'nothing written into the main checkout');
  assert.equal(git(w.repo, 'status', '--porcelain').trim(), '');
  for (const x of [A, B]) {
    assert.deepEqual(w.wt.status(x.worktree).uncommitted, ['work.txt']);
    assert.equal(real((w.cps.latest(x.session.id)!.data as any).cwd), real(x.worktree.path), 'checkpoints name the session worktree');
  }
  await w.sup.pauseSession(A.session.id); await w.sup.pauseSession(B.session.id);
  assert.equal(readFileSync(join(A.worktree.path, 'work.txt'), 'utf8'), 'precious\n');
});

// ---------------------------------------------------------------- exit criterion 2
test('EXIT 2: integration conflicts are detected before any merge, and detection changes nothing', () => {
  const w = world();
  const A = w.feature('left'), B = w.feature('right'), C = w.feature('other file');
  commit(A.worktree.path, 'base.txt', 'base.txt\nLEFT\nline3\n', 'left');
  commit(B.worktree.path, 'base.txt', 'base.txt\nRIGHT\nline3\n', 'right');
  commit(C.worktree.path, 'b.txt', 'b.txt\nline2\nOTHER\n', 'other');
  writeFileSync(join(C.worktree.path, 'dirty.txt'), 'uncommitted\n');

  const heads = () => ({ main: git(w.repo, 'rev-parse', 'main').trim(), a: git(w.repo, 'rev-parse', A.worktree.branch).trim(), b: git(w.repo, 'rev-parse', B.worktree.branch).trim() });
  const before = heads(); const statusBefore = [A, B, C].map((x) => git(x.worktree.path, 'status', '--porcelain'));

  assert.equal(w.wt.mergeCheck(A.worktree).clean, true, 'each branch alone merges cleanly');
  assert.equal(w.wt.mergeCheck(B.worktree).clean, true);
  const c = w.wt.mergeCheck(C.worktree); assert.equal(c.clean, true); assert.deepEqual(c.uncommittedNotIncluded, ['dirty.txt']); assert.match(c.note!, /uncommitted/);

  const o = w.wt.overview(w.project.id);
  assert.deepEqual(o.overlaps.map((x) => x.files), [['base.txt']], 'A and B touch the same file; C does not');
  assert.deepEqual(o.integration.pairConflicts.map((p) => [p.a, p.b, p.conflicts]), [[A.worktree.branch, B.worktree.branch, ['base.txt']]]);
  assert.equal(o.integration.order[0].branch, C.worktree.branch, 'the branch with no conflicts goes first');
  assert.ok(o.integration.commands.some((x) => /merge --no-ff/.test(x)) && o.integration.commands.every((x) => !/--force|reset|clean/.test(x)));

  assert.deepEqual(heads(), before, 'no ref moved'); assert.deepEqual([A, B, C].map((x) => git(x.worktree.path, 'status', '--porcelain')), statusBefore, 'no file touched');

  // Once A lands on main, B (which edited the same lines) is now known to conflict, before anyone merges it.
  git(w.repo, 'merge', '--no-ff', '-q', '-m', 'land A', A.worktree.branch);
  const bAfter = w.wt.mergeCheck(B.worktree);
  assert.equal(bAfter.clean, false); assert.deepEqual(bAfter.conflicts, ['base.txt']);
  assert.equal(git(w.repo, 'status', '--porcelain').trim(), '', 'checking left main clean');
});

// ---------------------------------------------------------------- removal
test('remove never discards uncommitted work, never deletes the branch, and refuses while a run is active', async () => {
  const w = world('edit-then-hang'); const { session, task, worktree } = w.feature('removal');
  const run = w.sup.start({ taskId: task.id, prompt: 'x', cwd: worktree.path, model: 'm' });
  await until(() => existsSync(join(worktree.path, 'work.txt')));
  let prev = w.wt.removalPreview(worktree);
  assert.equal(prev.canRemove, false); assert.ok(prev.blockers.some((b) => b.includes(run.id)) && prev.blockers.some((b) => /work\.txt/.test(b)));
  failsWith(() => w.wt.remove(worktree), 409, /refusing to remove/);
  await w.sup.pauseSession(session.id);

  failsWith(() => w.wt.remove(worktree), 409, /uncommitted/);
  assert.equal(readFileSync(join(worktree.path, 'work.txt'), 'utf8'), 'precious\n', 'the file survived the refused removal');

  commit(worktree.path, 'work.txt', 'precious\n', 'save work');
  prev = w.wt.removalPreview(worktree); assert.equal(prev.canRemove, true); assert.equal(prev.unmergedCommits, 1); assert.match(prev.note, /branch .* stays/i);
  const done = w.wt.remove(worktree);
  assert.equal(done.status, 'removed'); assert.ok(!existsSync(worktree.path));
  assert.equal(git(w.repo, 'rev-parse', '--verify', worktree.branch).trim().length, 40, 'branch and its commit are still there');
  assert.equal(w.store.getSession(session.id)!.worktreePath, null); assert.equal(w.wt.get(session.id), undefined);
  assert.ok(w.store.listEvents(session.id).some((e) => e.type === 'worktree.removed'));
  assert.equal(w.store.listWorktrees(w.project.id).length, 1, 'the record is kept'); assert.equal(w.store.listWorktrees(w.project.id, 'active').length, 0);
});

test('a worktree whose directory was deleted by hand can be forgotten cleanly', () => {
  const w = world(); const { worktree } = w.feature('gone');
  rmSync(worktree.path, { recursive: true, force: true });
  const st = w.wt.status(worktree); assert.equal(st.exists, false);
  assert.equal(w.wt.remove(worktree).status, 'removed');
});

// ---------------------------------------------------------------- HTTP
test('HTTP: create, run in the worktree, inspect, merge-check, preview and remove', async () => {
  const argsFile = join(tmp, 'wt-args.json');
  const w = world('record-prompt', { FAKE_ARGS_FILE: argsFile });
  const server = createApi(w.store, w.sup, { worktreeRoot: join(tmp, 'http-root') }); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const session = w.store.createSession({ projectId: w.project.id, title: 'http feature' }); const task = w.store.createTask({ sessionId: session.id, description: 'go' });
    assert.equal((await call(`/sessions/${session.id}/worktree`)).body, null);
    const created = await call(`/sessions/${session.id}/worktree`, {}); assert.equal(created.status, 201);
    assert.equal((await call(`/sessions/${session.id}/worktree`, {})).status, 409);

    const started = await call(`/tasks/${task.id}/runs`, { model: 'm' }); assert.equal(started.status, 202);
    await w.sup.waitFor(started.body.id);
    const rec = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.equal(real(rec.cwd), real(created.body.path), 'the worker ran inside the worktree');
    assert.ok(!existsSync(join(w.repo, 'part2.txt')) && existsSync(join(created.body.path, 'part2.txt')));

    const st = await call(`/sessions/${session.id}/worktree`); assert.deepEqual(st.body.uncommitted, ['part2.txt']);
    assert.equal((await call(`/sessions/${session.id}/worktree/merge-check`)).body.clean, true);
    const prev = await call(`/sessions/${session.id}/worktree/remove-preview`); assert.equal(prev.body.canRemove, false);
    const refused = await call(`/sessions/${session.id}/worktree/remove`, {}); assert.equal(refused.status, 409); assert.ok(refused.body.details.blockers.length);
    const o = await call(`/projects/${w.project.id}/worktrees`); assert.equal(o.body.worktrees.length, 1); assert.equal(o.body.integration.target, 'main');
    assert.equal((await call('/sessions/ses_nope/worktree')).status, 404);
    assert.equal((await call('/projects/prj_nope/worktrees')).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
});
