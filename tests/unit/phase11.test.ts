import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import { Supervisor } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { ProviderRegistry } from '../../services/orchestrator/src/providers/registry.ts';
import { ProviderHealthService } from '../../services/orchestrator/src/providers/health.ts';
import { ProviderService } from '../../services/orchestrator/src/providers/accounts.ts';
import { Router } from '../../services/orchestrator/src/routing/router.ts';
import { Scheduler } from '../../services/orchestrator/src/routing/scheduler.ts';
import { WorktreeService } from '../../services/orchestrator/src/worktrees/worktree-service.ts';
import { WorkflowEngine } from '../../services/orchestrator/src/workflows/engine.ts';
import { featureTemplate } from '../../services/orchestrator/src/workflows/definition.ts';
import { buildFactorySnapshot } from '../../services/orchestrator/src/factory/snapshot.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p11-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
const until = async (fn: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error('condition not met in time');
};
const fake = (d: Record<string, unknown>) => `FAKE ${JSON.stringify(d)}`;
const NODE = process.execPath;

function world() {
  const db = openDb(':memory:'); const store = new Store(db); const repo = makeRepo();
  const project = store.createProject({ name: 'p11', repoPath: repo });
  const adapter = new ClaudeCliAdapter({ command: NODE, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: 'directed' } });
  const registry = new ProviderRegistry([adapter]); const health = new ProviderHealthService(store);
  const sup = new Supervisor(store, registry, { checkpoints: new CheckpointService(store), checkpointIntervalMs: 0, health });
  const sched = new Scheduler(store, sup, new Router(store), new ProviderService(store, registry, health, {}), registry);
  const worktrees = new WorktreeService(store, { root: join(tmp, `wt${n}`) });
  const engine = new WorkflowEngine({ store, supervisor: sup, scheduler: sched, worktrees });
  const drive = (pred: () => boolean) => until(() => { engine.tick(); return pred(); });
  return { store, repo, project, sup, engine, drive };
}

test('with no work there is nothing in the factory: no items, no activity, no invented agents', () => {
  const w = world(); const s = buildFactorySnapshot(w.store, w.engine);
  assert.deepEqual(s.items, []); assert.deepEqual(s.activity, []);
  assert.deepEqual(s.stations.map((x) => x.id), ['planning', 'coding', 'testing', 'reviewing', 'integration']);
  assert.ok(s.stations.every((x) => x.total === 0));
  assert.deepEqual(s.totals, { real: 0, demo: 0, active: 0 });
});

test('a standalone session shows its stored status; seeded demo sessions are flagged and counted separately', () => {
  const w = world();
  const real = w.store.createSession({ projectId: w.project.id, title: 'Add export' }); w.store.createTask({ sessionId: real.id, description: 'x' });
  w.store.createSession({ projectId: w.project.id, title: 'demo: left edit' });
  const s = buildFactorySnapshot(w.store, w.engine);
  const a = s.items.find((i) => i.label === 'Add export')!; const d = s.items.find((i) => i.label === 'demo: left edit')!;
  assert.equal(a.state, 'queued'); assert.equal(a.rawStatus, 'queued'); assert.equal(a.demo, false); assert.equal(a.source, 'session'); assert.equal(a.station, 'coding');
  assert.equal(a.model, null, 'no run yet, so no model is claimed');
  assert.equal(d.demo, true);
  assert.deepEqual(s.totals, { real: 1, demo: 1, active: 0 });
  assert.equal(s.items.length, 2);
});

test('workflow steps are placed at the right stations with real state, model, evidence links and the approval request; workflow sessions are not listed twice', async () => {
  const w = world();
  const def = featureTemplate({
    parts: [{ id: 'lib', prompt: `build\n${fake({ write: { path: 'n.txt', content: '1\n' } })}` }, { id: 'docs', role: 'docs', prompt: `docs\n${fake({ write: { path: 'd.md', content: '# d\n' } })}` }],
    checks: [{ id: 'unit', command: [NODE, '-e', 'process.exit(0)'] }], reviewPrompt: `review\n${fake({ result: 'NO_FINDINGS' })}`,
  });
  const wf = w.engine.create({ projectId: w.project.id, title: 'Feature', goal: 'g', definition: def }); w.engine.start(wf.id);
  const step = (k: string) => w.engine.get(wf.id).steps.find((s) => s.id === k)!;
  await w.drive(() => step('merge-ready').state.status === 'waiting_approval');
  const s = buildFactorySnapshot(w.store, w.engine);
  const it = (k: string) => s.items.find((i) => i.key === `wf:${wf.id}:${k}`)!;
  assert.equal(it('lib').station, 'coding'); assert.equal(it('docs').station, 'coding'); assert.equal(it('integrate').station, 'integration');
  assert.equal(it('unit').station, 'testing'); assert.equal(it('review').station, 'reviewing'); assert.equal(it('merge-ready').station, 'integration');
  assert.equal(it('lib').state, 'completed'); assert.equal(it('lib').rawStatus, 'passed');
  assert.ok(it('lib').model && it('lib').sessionId && it('lib').runId, 'a finished agent step links to its real session and run');
  assert.equal(it('unit').runId, null, 'a check runs a command, not a model, and claims no model');
  assert.equal(it('merge-ready').state, 'waiting_approval');
  assert.match(it('merge-ready').note ?? '', /./, 'the pending approval is shown');
  assert.equal(s.items.filter((i) => i.source === 'session').length, 0, 'workflow sessions (steps and anchor) are not repeated as standalone work');
  assert.equal(s.totals.active, 1);
  assert.ok(s.stations.find((x) => x.id === 'coding')!.counts.completed === 2);
  assert.ok(s.activity.some((a) => a.source === 'workflow' && a.stepKey === 'lib'), 'workflow history appears in the activity feed');
  assert.ok(s.activity.some((a) => a.type === 'run.status'), 'so do runtime events');
  const times = s.activity.map((a) => a.at); assert.deepEqual([...times].sort().reverse(), times, 'newest first');
  await w.engine.cancel(wf.id);
});

test('a failed check is shown as failed with its recorded reason, not as success', async () => {
  const w = world();
  const def = featureTemplate({ parts: [{ id: 'p', prompt: `x\n${fake({ write: { path: 'n.txt', content: '1\n' } })}` }], checks: [{ id: 'bad', command: [NODE, '-e', 'console.error("boom"); process.exit(1)'] }], maxAttempts: 1 });
  const wf = w.engine.create({ projectId: w.project.id, title: 'Broken', goal: 'g', definition: def }); w.engine.start(wf.id);
  await w.drive(() => w.engine.get(wf.id).workflow.status === 'failed');
  const s = buildFactorySnapshot(w.store, w.engine); const bad = s.items.find((i) => i.stepKey === 'bad')!;
  assert.equal(bad.state, 'failed'); assert.ok(bad.note, 'the failure text is carried through');
  assert.equal(s.items.find((i) => i.stepKey === 'review')!.state, 'cancelled', 'steps that never ran are shown as the engine recorded them: cancelled, never as passed');
  assert.ok(s.stations.find((x) => x.id === 'testing')!.counts.failed === 1);
});

test('the HTTP endpoint serves the snapshot, can be limited to a project, and rejects an unknown project', async () => {
  const w = world(); w.store.createSession({ projectId: w.project.id, title: 'One' });
  const other = w.store.createProject({ name: 'other', repoPath: makeRepo() }); w.store.createSession({ projectId: other.id, title: 'Two' });
  const server = createApi(w.store, w.sup, { worktreeRoot: join(tmp, 'http-wt') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port; const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, json: await r.json() as any }; };
  try {
    const all = await get('/factory'); assert.equal(all.status, 200); assert.equal(all.json.items.length, 2);
    const one = await get(`/factory?projectId=${w.project.id}`); assert.deepEqual(one.json.items.map((i: any) => i.label), ['One']);
    assert.equal((await get('/factory?projectId=prj_missing')).status, 404);
    const post = await fetch(`http://127.0.0.1:${port}/factory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.ok(post.status >= 400, 'read-only');
  } finally { server.closeAllConnections(); server.close(); }
});
