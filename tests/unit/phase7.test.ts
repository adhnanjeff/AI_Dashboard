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
import { Router, RoutingError } from '../../services/orchestrator/src/routing/router.ts';
import { BudgetError, Scheduler } from '../../services/orchestrator/src/routing/scheduler.ts';
import { DEFAULT_POLICY, PolicyError, classify, estimateFor, route, validatePolicy } from '../../services/orchestrator/src/routing/policy.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p7-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

// One world: real supervisor + fixture worker. The worker's behaviour is switched per run via env.FAKE_SCENARIO.
function world(scenario = 'ok') {
  const db = openDb(':memory:'); const store = new Store(db); const repo = makeRepo();
  const project = store.createProject({ name: 'p7', repoPath: repo });
  const env: Record<string, string> = { FAKE_SCENARIO: scenario };
  const registry = new ProviderRegistry([new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env })]);
  const health = new ProviderHealthService(store);
  const sup = new Supervisor(store, registry, { checkpoints: new CheckpointService(store), checkpointIntervalMs: 0, health });
  const router = new Router(store); const providers = new ProviderService(store, registry, health);
  const sched = new Scheduler(store, sup, router, providers, registry);
  const feature = (title: string, description = 'do it', criteria: string[] = []) => {
    const session = store.createSession({ projectId: project.id, title });
    return { session, task: store.createTask({ sessionId: session.id, description, acceptanceCriteria: criteria }) };
  };
  const go = async (taskId: string, model?: string) => {
    const r = sched.launch({ taskId, prompt: 'x', cwd: repo, model, origin: 'run' });
    assert.equal(r.kind, 'started'); if (r.kind !== 'started') throw new Error('queued');
    await sup.waitFor(r.run.id); return { run: store.getRun(r.run.id)!, decision: r.decision! };
  };
  const policy = (patch: (p: typeof DEFAULT_POLICY) => void) => { const p = structuredClone(DEFAULT_POLICY); patch(p); return router.publish(p, 'test', 'test policy'); };
  return { db, store, repo, project, env, registry, health, sup, router, providers, sched, feature, go, policy };
}

// ---------------------------------------------------------------- classification and the rules
test('classify + route: the documented examples land on the documented tier, with the words that decided it', () => {
  const tier = (d: string, c: string[] = []) => route(DEFAULT_POLICY, classify(d, c), { failedAttempts: 0 });
  assert.equal(tier('Fix the typo in the README comment').tier, 'haiku');
  assert.equal(tier('Summarize what the logging module does').tier, 'haiku');
  assert.equal(tier('Extract all TODO comments into a list').tier, 'haiku');
  assert.equal(tier('Add subtract() to math.js').tier, 'haiku', 'small, low-risk coding');
  assert.equal(tier('Fix the crash when the cart is empty and add tests across the checkout flow, handling every currency', ['a', 'b', 'c', 'd', 'e']).tier, 'sonnet', 'ordinary substantive work');
  assert.equal(tier('Design the system architecture for the sync service and weigh the trade-offs').tier, 'opus');
  assert.equal(tier('Refactor the whole codebase to move every module to the new schema, across multiple services and the database').tier, 'opus');
  assert.equal(tier('Change the password hashing and the payment permission checks across multiple modules in production').tier, 'opus', 'risky and wide');
  const f = classify('Fix the typo in the README comment');
  assert.ok(f.signals.some((s) => /typo/.test(s)), 'the deciding word is reported');
  assert.match(tier('Add subtract() to math.js').reason, /rule "small-and-safe"/);
});

test('route is pure: the same inputs always give the same answer', () => {
  const f = classify('Add subtract() to math.js');
  assert.deepEqual(route(DEFAULT_POLICY, f, { failedAttempts: 1 }), route(structuredClone(DEFAULT_POLICY), structuredClone(f), { failedAttempts: 1 }));
});

test('policy validation: malformed policies are refused, unknown keys are dropped, estimates price unknown models high', () => {
  const bad = (mut: (p: any) => void, re: RegExp) => { const p = structuredClone(DEFAULT_POLICY) as any; mut(p); assert.throws(() => validatePolicy(p), (e: unknown) => e instanceof PolicyError && re.test((e as Error).message)); };
  bad((p) => { p.models.haiku = 'has spaces!'; }, /models\.haiku/);
  bad((p) => { p.rules[0].tier = 'gpt'; }, /tier/);
  bad((p) => { p.rules[1].id = p.rules[0].id; }, /duplicate/);
  bad((p) => { p.budgets.dailyUsd = -1; }, /dailyUsd/);
  bad((p) => { p.escalation.afterFailures = 0; }, /afterFailures/);
  bad((p) => { p.rules[0].types = ['nonsense']; }, /task type/);
  const ok = validatePolicy({ ...structuredClone(DEFAULT_POLICY), surprise: 1 }) as any; assert.equal(ok.surprise, undefined);
  assert.equal(estimateFor(DEFAULT_POLICY, 'claude-haiku-5-5'), 0.1);
  assert.equal(estimateFor(DEFAULT_POLICY, 'some-unknown-model'), 2, 'unknown model is priced at the highest estimate');
});

test('policy versions are immutable and every publish is audited', () => {
  const w = world();
  assert.equal(w.store.latestPolicy()!.version, 1);
  const v2 = w.policy((p) => { p.budgets.dailyUsd = 10; });
  assert.equal(v2.version, 2);
  assert.throws(() => w.db.prepare('UPDATE routing_policy SET note=? WHERE version=1').run('x'), /immutable/);
  assert.throws(() => w.db.prepare('DELETE FROM routing_policy WHERE version=1').run(), /never deleted/);
  assert.ok(w.store.listAudit().some((a) => a.action === 'policy.published' && a.subject === 'policy:2'));
  assert.throws(() => w.router.publish({ nope: true }, 'test'), (e: unknown) => e instanceof RoutingError && e.status === 400);
});

// ---------------------------------------------------------------- decisions are logged and reproducible
test('every launch logs its decision with the inputs it was made from; replay reproduces it, even after the policy changes', async () => {
  const w = world('ok'); const f = w.feature('s1', 'Add subtract() to math.js');
  const { run, decision } = await w.go(f.task.id);
  assert.equal(run.status, 'completed'); assert.equal(decision.mode, 'auto'); assert.equal(run.model, 'claude-haiku-5-5');
  const logged = w.store.listRouting(run.id); assert.equal(logged.length, 1);
  assert.equal(logged[0].policyVersion, '1'); assert.match(logged[0].reason, /small-and-safe/);
  assert.equal((logged[0].inputs as any).features.type, 'coding');
  assert.ok(w.store.listEvents(f.session.id).some((e) => e.type === 'routing.decided' && e.runId === run.id));

  w.policy((p) => { p.rules = []; p.defaultTier = 'opus'; }); // the world changes...
  const again = w.router.replay(logged[0].id);
  assert.equal(again.reproducible, true, 'replay uses the policy version the decision was made under');
  assert.equal(w.router.decide(f.task.id).model, 'claude-opus-5-5', '...and a NEW decision follows the new policy');
});

test('a manual model is honoured, logged as manual, and records what the policy would have done', async () => {
  const w = world('ok'); const f = w.feature('s1', 'Add subtract() to math.js');
  const { run, decision } = await w.go(f.task.id, 'claude-opus-5-5');
  assert.equal(run.model, 'claude-opus-5-5'); assert.equal(decision.mode, 'manual');
  const d = w.store.listRouting(run.id)[0];
  assert.match(d.reason, /chosen by the user; the policy would have used claude-haiku-5-5/);
  assert.equal((d.inputs as any).mode, 'manual'); assert.equal((d.inputs as any).route.model, 'claude-haiku-5-5');
  assert.equal(w.router.replay(d.id).reproducible, true);
});

// ---------------------------------------------------------------- escalation is bounded
test('escalation: failures move the model up on a schedule and stop at the attempt limit', async () => {
  const w = world('fail'); const f = w.feature('s1', 'Add subtract() to math.js');
  const models: string[] = [];
  for (let i = 0; i < 4; i++) { const { run } = await w.go(f.task.id); assert.equal(run.status, 'failed'); models.push(run.model); }
  assert.deepEqual(models, ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  const d3 = w.store.listRouting(w.store.listRunsForSession(f.session.id)[2].id)[0];
  assert.match(d3.reason, /escalated haiku -> sonnet after 2 failed attempt/);

  const runsBefore = w.store.listRunsForSession(f.session.id).length;
  assert.throws(() => w.sched.launch({ taskId: f.task.id, prompt: 'x', cwd: w.repo, origin: 'run' }), (e: unknown) => e instanceof RoutingError && e.status === 409 && /attempt limit reached/.test((e as Error).message));
  assert.equal(w.store.listRunsForSession(f.session.id).length, runsBefore, 'the refused attempt started nothing');
  const manual = await w.go(f.task.id, 'claude-opus-5-5'); // a person can still decide to try again
  assert.equal(manual.decision.mode, 'manual');
});

test('escalation analytics: the summary shows what escalated and how it ended', async () => {
  const w = world('fail'); const f = w.feature('s1', 'Add subtract() to math.js');
  await w.go(f.task.id); await w.go(f.task.id);
  w.env.FAKE_SCENARIO = 'usage'; w.env.FAKE_COST = '0.25';
  const last = await w.go(f.task.id); assert.equal(last.run.status, 'completed'); assert.equal(last.run.model, 'claude-sonnet-5-5');
  const s = w.router.summary();
  assert.equal(s.escalation.escalated, 1); assert.equal(s.escalation.escalatedCompleted, 1);
  assert.deepEqual(s.escalation.paths.map((p) => [p.from, p.to, p.completed]), [['haiku', 'sonnet', 1]]);
  // 2 failed haiku attempts are estimated at 0.1 each, the success reported 0.25
  assert.equal(s.acceptedTasks.count, 1); assert.equal(s.acceptedTasks.costPerAcceptedTask, 0.45);
  const sonnet = s.byModel.find((m) => m.model === 'claude-sonnet-5-5')!; assert.equal(sonnet.successRate, 1); assert.equal(sonnet.costPerCompletedRun, 0.25);
  const haiku = s.byModel.find((m) => m.model === 'claude-haiku-5-5')!; assert.equal(haiku.successRate, 0); assert.equal(haiku.costPerCompletedRun, null);
});

// ---------------------------------------------------------------- usage and cost honesty
test('usage: reported cost and tokens are stored; a run with no report is an estimate and is labelled as one', async () => {
  const w = world('usage'); w.env.FAKE_COST = '0.25';
  const a = w.feature('reported'); const ra = (await w.go(a.task.id)).run;
  const u = w.store.getUsage(ra.id)!; assert.deepEqual([u.costUsd, u.inputTokens, u.outputTokens, u.source], [0.25, 1200, 340, 'reported']);
  w.env.FAKE_SCENARIO = 'nocost';
  const b = w.feature('estimated'); const rb = (await w.go(b.task.id)).run;
  assert.equal(w.store.getUsage(rb.id), undefined, 'no row is invented when the provider reported nothing');
  const t = w.router.today();
  assert.equal(t.bySource.reported, 0.25); assert.equal(t.bySource.estimated, 0.1, 'haiku estimate for the unreported run');
  assert.equal(t.totalUsd, 0.35);
});

test('a run still in flight reserves its estimate against the budget, and the reservation turns into an estimate when it ends', async () => {
  const w = world('edit-then-hang'); const f = w.feature('hang');
  const r = w.sched.launch({ taskId: f.task.id, prompt: 'x', cwd: w.repo, origin: 'run' }); assert.equal(r.kind, 'started'); if (r.kind !== 'started') return;
  assert.equal(w.router.today().bySource.reserved, 0.1);
  await w.sup.cancel(r.run.id);
  const t = w.router.today(); assert.deepEqual([t.bySource.reserved, t.bySource.estimated], [0, 0.1]);
});

// ---------------------------------------------------------------- budgets are enforced
test('per-task budget: a launch that would exceed it is refused before anything starts, and the refusal is recorded', async () => {
  const w = world('usage'); w.env.FAKE_COST = '0.6';
  w.policy((p) => { p.budgets.perTaskUsd = 1; p.budgets.dailyUsd = 100; });
  const f = w.feature('s1');
  await w.go(f.task.id, 'claude-sonnet-5-5'); // spends 0.6 of 1.0
  const before = w.store.listRunsForSession(f.session.id).length;
  assert.throws(() => w.sched.launch({ taskId: f.task.id, prompt: 'x', cwd: w.repo, model: 'claude-sonnet-5-5', origin: 'run' }),
    (e: unknown) => e instanceof BudgetError && e.status === 409 && /task budget: \$0\.6 spent \+ \$0\.5 reserved .* exceed \$1/.test((e as Error).message));
  assert.equal(w.store.listRunsForSession(f.session.id).length, before, 'no run was created');
  assert.ok(w.store.listEvents(f.session.id).some((e) => e.type === 'routing.refused'));
});

test('daily budget: spend across sessions counts, and a cheaper model that still fits is allowed', async () => {
  const w = world('usage'); w.env.FAKE_COST = '0.6';
  w.policy((p) => { p.budgets.perTaskUsd = 100; p.budgets.dailyUsd = 1; });
  const a = w.feature('a'); await w.go(a.task.id, 'claude-sonnet-5-5');
  const b = w.feature('b');
  assert.throws(() => w.sched.launch({ taskId: b.task.id, prompt: 'x', cwd: w.repo, model: 'claude-sonnet-5-5', origin: 'run' }), (e: unknown) => e instanceof BudgetError && /daily budget/.test((e as Error).message));
  const cheap = await w.go(b.task.id, 'claude-haiku-5-5'); // 0.6 + 0.1 fits in 1.0
  assert.equal(cheap.run.status, 'completed');
  assert.equal(w.router.today().remainingUsd, 0);
});

test('a dry run (route-preview logic) explains the choice and the budget without starting anything', () => {
  const w = world('ok'); const f = w.feature('s1', 'Design the system architecture and weigh the trade-offs');
  const p = w.sched.preview(f.task.id);
  assert.equal(p.decision.model, 'claude-opus-5-5'); assert.match(p.decision.reason, /arch-or-risky/); assert.equal(p.decision.budget.ok, true);
  assert.equal(p.targets[0].available, true);
  assert.equal(w.store.listRunsForSession(f.session.id).length, 0);
});

// ---------------------------------------------------------------- over HTTP
function serve(w: ReturnType<typeof world>) {
  const server = createApi(w.store, w.sup);
  return new Promise<{ call: (m: string, p: string, b?: unknown) => Promise<{ status: number; json: any }>; close: () => void }>((res) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      res({ close: () => { server.closeAllConnections(); server.close(); },
        call: async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; } });
    });
  });
}

test('API: a run with no model is routed by policy; the run, policy, summary and replay endpoints tell the same story', async () => {
  const w = world('usage'); w.env.FAKE_COST = '0.25'; const f = w.feature('api', 'Add subtract() to math.js'); const s = await serve(w);
  try {
    const started = await s.call('POST', `/tasks/${f.task.id}/runs`, {});
    assert.equal(started.status, 202); assert.equal(started.json.model, 'claude-haiku-5-5'); assert.equal(started.json.routing.mode, 'auto');
    await w.sup.waitFor(started.json.id);
    const run = (await s.call('GET', `/runs/${started.json.id}`)).json;
    assert.deepEqual(run.usage, { costUsd: 0.25, source: 'reported' }, 'the existing usage field is unchanged');
    assert.deepEqual([run.cost.usd, run.cost.source, run.tokens.input, run.tokens.output], [0.25, 'reported', 1200, 340]);
    assert.match(run.routing[0].reason, /small-and-safe/);
    const replay = (await s.call('GET', `/routing/decisions/${run.routing[0].id}/replay`)).json; assert.equal(replay.reproducible, true);
    const sum = (await s.call('GET', '/usage/summary?days=1')).json; assert.equal(sum.runs, 1); assert.equal(sum.bySource.reported, 0.25);
    assert.equal((await s.call('GET', '/usage/summary?projectId=nope')).status, 404);
    const today = (await s.call('GET', '/routing/today')).json; assert.equal(today.limitUsd, 25);
  } finally { s.close(); }
});

test('API: publishing a policy validates it, versions it, and shows in the audit trail', async () => {
  const w = world(); const s = await serve(w);
  try {
    const cur = (await s.call('GET', '/routing/policy')).json; assert.equal(cur.version, 1);
    const bad = await s.call('PUT', '/routing/policy', { policy: { ...cur.policy, budgets: { ...cur.policy.budgets, dailyUsd: 0 } } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /dailyUsd/);
    const ok = await s.call('PUT', '/routing/policy', { policy: { ...cur.policy, budgets: { ...cur.policy.budgets, dailyUsd: 3 } }, note: 'tighter' });
    assert.equal(ok.status, 201); assert.equal(ok.json.version, 2);
    const after = (await s.call('GET', '/routing/policy')).json; assert.deepEqual([after.version, after.policy.budgets.dailyUsd, after.versions.length], [2, 3, 2]);
    assert.ok((await s.call('GET', '/audit')).json.some((a: any) => a.action === 'policy.published' && a.subject === 'policy:2'));
    assert.equal((await s.call('POST', '/tasks/nope/runs', {})).status, 404);
  } finally { s.close(); }
});

test('API: a budget refusal is a clear 409 and an unsupported provider/model combination is a 400', async () => {
  const w = world('ok'); const f = w.feature('api'); const s = await serve(w);
  try {
    assert.equal((await s.call('POST', `/tasks/${f.task.id}/runs`, { model: 'bad model!' })).status, 400);
    assert.equal((await s.call('POST', `/tasks/${f.task.id}/runs`, { provider: 'nope', model: 'm' })).status, 400);
    w.policy((p) => { p.budgets.perTaskUsd = 0.05; });
    const r = await s.call('POST', `/tasks/${f.task.id}/runs`, {}); // haiku estimate 0.1 > 0.05
    assert.equal(r.status, 409); assert.match(r.json.error, /budget limit/);
  } finally { s.close(); }
});
