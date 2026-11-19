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
import { Supervisor } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { ProviderRegistry } from '../../services/orchestrator/src/providers/registry.ts';
import { ProviderHealthService } from '../../services/orchestrator/src/providers/health.ts';
import { ProviderService } from '../../services/orchestrator/src/providers/accounts.ts';
import { Router } from '../../services/orchestrator/src/routing/router.ts';
import { DEFAULT_POLICY } from '../../services/orchestrator/src/routing/policy.ts';
import { Scheduler } from '../../services/orchestrator/src/routing/scheduler.ts';
import { WorktreeService } from '../../services/orchestrator/src/worktrees/worktree-service.ts';
import { WorkflowEngine, WorkflowError, parseFindings } from '../../services/orchestrator/src/workflows/engine.ts';
import { DefinitionError, featureTemplate, validateWorkflow } from '../../services/orchestrator/src/workflows/definition.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p9-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const CHECK = `import { add } from './src/add.mjs';\nif (add(2, 3) !== 5) { console.error('expected 5 but got ' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n`;
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); writeFileSync(join(dir, 'check.mjs'), CHECK); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
const until = async (fn: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error('condition not met in time');
};
// A directive for the fake worker, carried inside a step prompt.
const fake = (d: Record<string, unknown>) => `FAKE ${JSON.stringify(d)}`;
const write = (path: string, content: string, when: Record<string, string> = {}) => fake({ write: { path, content }, ...when });
const NODE = process.execPath;

function world(o: { allowed?: string[] } = {}) {
  const db = openDb(':memory:'); const store = new Store(db); const repo = makeRepo();
  const project = store.createProject({ name: 'p9', repoPath: repo });
  const adapter = new ClaudeCliAdapter({ command: NODE, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: 'directed' } });
  const registry = new ProviderRegistry([adapter]);
  const health = new ProviderHealthService(store);
  const sup = new Supervisor(store, registry, { checkpoints: new CheckpointService(store), checkpointIntervalMs: 0, health });
  const router = new Router(store); const providers = new ProviderService(store, registry, health, {});
  const sched = new Scheduler(store, sup, router, providers, registry);
  const worktrees = new WorktreeService(store, { root: join(tmp, `wt${n}`) });
  const engine = new WorkflowEngine({ store, supervisor: sup, scheduler: sched, worktrees, allowedCommands: o.allowed });
  const drive = (pred: () => boolean, ms?: number) => until(() => { engine.tick(); return pred(); }, ms);
  const status = (id: string) => engine.get(id).workflow.status;
  const step = (id: string, key: string) => engine.get(id).steps.find((s) => s.id === key)!;
  const sstatus = (id: string, key: string) => step(id, key).state.status;
  const mk = (title: string, definition: unknown, goal = 'add numbers') => engine.create({ projectId: project.id, title, goal, definition });
  return { db, store, repo, project, sup, router, sched, worktrees, engine, drive, status, step, sstatus, mk };
}
type W = ReturnType<typeof world>;
const settled = (w: W, id: string) => w.drive(() => ['completed', 'failed', 'cancelled'].includes(w.status(id)));

// ---------------------------------------------------------------- schema
test('the schema accepts a sound workflow and rejects unknown ids, cycles, shell strings and writing reviewers', () => {
  const ok = validateWorkflow({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'c', kind: 'check', command: ['npm', 'test'], verifies: 'a' }] });
  assert.equal(ok.concurrency, 2);
  assert.deepEqual(ok.steps[1].needs, ['a'], 'a check automatically needs the step it verifies');
  assert.equal(ok.steps[1].fixer, 'a', 'and defaults to sending failures back to it');
  const bad = (def: unknown, re: RegExp) => assert.throws(() => validateWorkflow(def), (e: unknown) => e instanceof DefinitionError && re.test((e as Error).message));
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x', needs: ['b'] }, { id: 'b', kind: 'agent', prompt: 'y', needs: ['a'] }] }, /cycle/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x', needs: ['ghost'] }] }, /unknown step "ghost"/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'a', kind: 'agent', prompt: 'y' }] }, /twice/);
  bad({ steps: [{ id: 'a', kind: 'agent' }] }, /needs a prompt/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x', role: 'wizard' }] }, /unknown role/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'c', kind: 'check', command: 'npm test && rm -rf /', verifies: 'a' }] }, /argument list/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'r', kind: 'review', reviews: 'a', role: 'coder' }] }, /read-only role/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'm', kind: 'merge_ready', needs: ['a'] }] }, /exactly one integrate/);
  bad({ steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'i', kind: 'integrate', needs: ['a'] }, { id: 'c', kind: 'check', command: ['x'], verifies: 'i', fixer: 'i' }] }, /fixer must be an agent/);
  bad({ concurrency: 9, steps: [{ id: 'a', kind: 'agent', prompt: 'x' }] }, /concurrency/);
  bad({ steps: [] }, /1\.\.40/);
  const t = featureTemplate({ parts: [{ id: 'one', prompt: 'p' }, { id: 'two', prompt: 'q' }], checks: [{ id: 'unit', command: ['npm', 'test'] }] });
  assert.deepEqual(t.steps.map((s) => s.id), ['one', 'two', 'integrate', 'unit', 'review', 'merge-ready']);
});

test('only allow-listed programs can run as checks, and reviewer findings are parsed strictly', () => {
  const w = world();
  assert.throws(() => w.mk('x', { steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'c', kind: 'check', command: ['curl', 'http://evil'], verifies: 'a' }] }),
    (e: unknown) => e instanceof WorkflowError && e.status === 400 && /not on the allow-list/.test((e as Error).message));
  assert.throws(() => w.mk('x', { steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'c', kind: 'check', command: ['/usr/bin/git', 'status'], verifies: 'a' }] }), /bare program name/);
  assert.deepEqual(parseFindings('noise\nFINDING: HIGH | src/a.ts | bad thing\nFINDING: nope | x | y\nFINDING: low | | tidy up'),
    [{ severity: 'high', path: 'src/a.ts', message: 'bad thing' }, { severity: 'low', path: '', message: 'tidy up' }]);
});

// ---------------------------------------------------------------- the demonstration (roadmap exit criteria)
test('a feature is completed by isolated agents: plan, parallel work, failing check, correction, review finding, correction, approval, with every step recorded', async () => {
  const w = world();
  const base = git(w.repo, 'rev-parse', 'main').trim();
  const def = featureTemplate({
    parts: [
      { id: 'lib', prompt: ['Implement add().', write('src/add.mjs', 'export const add = (a, b) => a - b;\n', { unless: 'did not pass' }),
        write('src/add.mjs', 'export const add = (a, b) => a + b;\n', { when: 'Check "test" failed' }), write('src/reviewed.txt', 'ok\n', { when: 'Review "review" failed' })].join('\n') },
      { id: 'docs', role: 'docs', prompt: ['Document add().', write('docs/feature.md', '# add\n')].join('\n') },
    ],
    checks: [{ id: 'test', command: [NODE, 'check.mjs'] }],
    reviewPrompt: ['Review the change.', fake({ result: 'FINDING: high | src/add.mjs | no input validation' }), fake({ result: 'NO_FINDINGS', ifFile: 'src/reviewed.txt' })].join('\n'),
  });
  const wf = w.mk('demo', def); assert.equal(wf.status, 'draft');
  const plan = w.engine.evidenceList(wf.id).find((e: any) => e.kind === 'plan'); assert.ok(plan, 'the plan is recorded before anything runs');
  w.engine.start(wf.id);

  await w.drive(() => w.sstatus(wf.id, 'merge-ready') === 'waiting_approval');
  assert.equal(w.status(wf.id), 'running', 'it stops at the human gate; it does not finish by itself');
  assert.equal(git(w.repo, 'rev-parse', 'main').trim(), base, 'nothing was merged into the base branch');
  const pending = w.engine.get(wf.id).approvals[0]; assert.equal(pending.status, 'pending'); assert.match(pending.action, /^Merge orch\//);

  assert.throws(() => w.engine.decide(wf.id, 'merge-ready', 'approved', '  '), (e: unknown) => e instanceof WorkflowError && e.status === 400, 'an approver identity is required');
  assert.throws(() => w.engine.decide(wf.id, 'lib', 'approved', 'alice'), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  w.engine.decide(wf.id, 'merge-ready', 'approved', 'alice');
  await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'completed');
  assert.equal(git(w.repo, 'rev-parse', 'main').trim(), base, 'approval marks it merge-ready; the merge itself is still the person\'s');

  // retry history: the coder was corrected twice (a failing check, then a review finding), each time re-verifying downstream
  assert.equal(w.step(wf.id, 'lib').state.attempts, 3);
  assert.equal(w.step(wf.id, 'test').state.attempts, 3);
  assert.equal(w.step(wf.id, 'review').state.attempts, 2);
  const tr = w.engine.transitions(wf.id);
  assert.equal(tr.filter((t: any) => /^correction: check "test" failed/.test(t.reason)).length, 1);
  assert.equal(tr.filter((t: any) => /^correction: review "review" failed/.test(t.reason)).length, 1);
  assert.ok(tr.filter((t: any) => /^correction: re-run after "lib"/.test(t.reason)).length >= 4);

  // evidence: test output, review findings, routing, readiness, approval
  const ev = w.engine.evidenceList(wf.id, { full: true }) as any[];
  const checks = ev.filter((e) => e.kind === 'check');
  assert.equal(checks.length, 3);
  assert.match(checks[0].content, /expected 5 but got -1/); assert.match(checks[0].summary, /exit 1/); assert.match(checks[2].summary, /passed/);
  const found = ev.filter((e) => e.kind === 'review-findings').map((e) => JSON.parse(e.content));
  assert.equal(found[0].findings[0].severity, 'high'); assert.equal(found[1].findings.length, 0);
  assert.equal(ev.filter((e) => e.kind === 'routed').length, 2);
  assert.ok(ev.some((e) => e.kind === 'merge-readiness' && JSON.parse(e.content).mergeCheck.clean === true));
  assert.ok(ev.some((e) => e.kind === 'approval' && /approved by alice/.test(e.summary)));
  assert.ok(ev.filter((e) => e.kind === 'run').length >= 6, 'agent activity: every attempt of every agent is recorded');

  // isolation: every agent attempt had its own session and worktree; the integration holds both parts' work
  const sessions = new Set(w.engine.get(wf.id).steps.map((s) => s.state.sessionId).filter(Boolean));
  assert.ok(sessions.size >= 4);
  const integ = w.step(wf.id, 'integrate').state.detail;
  assert.equal(readFileSync(join(integ.workspace, 'src/add.mjs'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.ok(existsSync(join(integ.workspace, 'docs/feature.md')));
  assert.equal(w.step(wf.id, 'lib').state.detail.workspace !== w.step(wf.id, 'docs').state.detail.workspace, true);

  const rec = w.engine.record(wf.id);
  assert.ok(rec.transitions.length > 20 && rec.evidence.length > 15 && rec.retryHistory.length >= 2);
  assert.ok(w.store.listAudit(100).some((a) => a.action === 'workflow.completed'));
});

// ---------------------------------------------------------------- scheduling and isolation
test('independent steps run at the same time in separate worktrees; a dependent step waits for both', async () => {
  const w = world();
  const slow = (f: string) => ['work', write(f, 'x\n'), fake({ sleep: 900 })].join('\n');
  const wf = w.mk('par', { concurrency: 2, steps: [{ id: 'one', kind: 'agent', prompt: slow('one.txt') }, { id: 'two', kind: 'agent', prompt: slow('two.txt') },
    { id: 'three', kind: 'agent', needs: ['one', 'two'], prompt: 'after both' }] });
  w.engine.start(wf.id);
  let both = false, thirdEarly = false;
  await w.drive(() => {
    const a = w.sstatus(wf.id, 'one'), b = w.sstatus(wf.id, 'two');
    if (a === 'running' && b === 'running') both = true;
    if (w.sstatus(wf.id, 'three') !== 'pending' && !(a === 'passed' && b === 'passed')) thirdEarly = true;
    return w.status(wf.id) === 'completed';
  });
  assert.ok(both, 'both ran concurrently'); assert.ok(!thirdEarly, 'the dependent step never started early');
  const paths = ['one', 'two', 'three'].map((k) => w.step(wf.id, k).state.detail.workspace);
  assert.equal(new Set(paths).size, 3, 'three different worktrees');
  assert.ok(existsSync(join(paths[0], 'one.txt')) && !existsSync(join(paths[0], 'two.txt')), 'work did not leak between worktrees');
  assert.ok(!existsSync(join(w.repo, 'one.txt')), 'and nothing was written into the main checkout');
});

test('concurrency is a limit: with 1, steps never overlap', async () => {
  const w = world();
  const wf = w.mk('serial', { concurrency: 1, steps: [{ id: 'one', kind: 'agent', prompt: `x\n${fake({ sleep: 300 })}` }, { id: 'two', kind: 'agent', prompt: `y\n${fake({ sleep: 300 })}` }] });
  w.engine.start(wf.id);
  let overlap = false;
  await w.drive(() => { if (w.sstatus(wf.id, 'one') === 'running' && w.sstatus(wf.id, 'two') === 'running') overlap = true; return w.status(wf.id) === 'completed'; });
  assert.ok(!overlap);
});

test('a "when" condition skips a step, and a failed check can be tolerated to run a fallback', async () => {
  const w = world();
  const wf = w.mk('cond', { steps: [
    { id: 'a', kind: 'agent', prompt: 'x' },
    { id: 'flaky', kind: 'check', command: [NODE, '-e', 'process.exit(3)'], verifies: 'a', maxAttempts: 1, fixer: undefined },
    { id: 'on-pass', kind: 'agent', prompt: 'only if flaky passed', needs: ['flaky'], when: { step: 'flaky', status: 'passed' } },
    { id: 'on-fail', kind: 'agent', prompt: `only if flaky failed\n${write('fallback.txt', 'used\n')}`, needs: ['flaky'], when: { step: 'flaky', status: 'failed' } },
  ] });
  w.engine.start(wf.id);
  await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'completed', 'a failure that something is explicitly waiting on does not stop the workflow');
  assert.equal(w.sstatus(wf.id, 'flaky'), 'failed'); assert.equal(w.sstatus(wf.id, 'on-pass'), 'skipped'); assert.equal(w.sstatus(wf.id, 'on-fail'), 'passed');
  assert.ok(w.engine.transitions(wf.id).some((t: any) => /an upstream step did not pass/.test(t.reason)));
});

// ---------------------------------------------------------------- stopping rules
test('retries are bounded: a check that keeps failing with different output stops at its attempt limit', async () => {
  const w = world();
  const wf = w.mk('bounded', { steps: [{ id: 'lib', kind: 'agent', prompt: 'x', maxAttempts: 4 },
    { id: 'chk', kind: 'check', verifies: 'lib', maxAttempts: 2, command: [NODE, '-e', 'console.error(Math.random().toString(36).slice(2).replace(/[0-9]/g,"q")); process.exit(1)'] }] });
  w.engine.start(wf.id); await settled(w, wf.id);
  const g = w.engine.get(wf.id);
  assert.equal(g.workflow.status, 'failed'); assert.match(g.workflow.haltedReason!, /still failing after 2 attempt/);
  assert.equal(w.step(wf.id, 'chk').state.attempts, 2); assert.equal(w.step(wf.id, 'lib').state.attempts, 2);
  assert.equal(w.store.listRunsForSession(w.step(wf.id, 'lib').state.sessionId!).length, 1);
});

test('an identical repeated failure stops at once: another correction cannot help', async () => {
  const w = world();
  const wf = w.mk('same', { steps: [{ id: 'lib', kind: 'agent', prompt: 'x', maxAttempts: 5 },
    { id: 'chk', kind: 'check', verifies: 'lib', maxAttempts: 5, command: [NODE, '-e', 'console.error("always broken at line 12"); process.exit(1)'] }] });
  w.engine.start(wf.id); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /same check failure repeated/);
  assert.equal(w.step(wf.id, 'lib').state.attempts, 2, 'one correction, then it stopped');
});

test('a budget limit stops the workflow before the agent starts, and no run is created', async () => {
  const w = world();
  const p = structuredClone(DEFAULT_POLICY); p.budgets.perTaskUsd = 0.05; w.router.publish(p, 'test', 'tight');
  const wf = w.mk('budget', { steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'b', kind: 'agent', prompt: 'y', needs: ['a'] }] });
  w.engine.start(wf.id); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /budget limit/);
  assert.equal(w.sstatus(wf.id, 'b'), 'cancelled');
  assert.equal(w.store.listRuns().length, 0);
});

test('a failing agent is retried with the failure as feedback, then the workflow stops at the limit', async () => {
  const w = world();
  const wf = w.mk('flop', { steps: [{ id: 'a', kind: 'agent', prompt: `x\n${fake({ fail: true })}`, maxAttempts: 2 }, { id: 'b', kind: 'agent', prompt: 'never', needs: ['a'] }] });
  w.engine.start(wf.id); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /retry limit reached \(2\/2\)/);
  assert.equal(w.sstatus(wf.id, 'b'), 'cancelled'); assert.equal(w.store.listRuns().length, 2);
  assert.ok(w.engine.transitions(wf.id).some((t: any) => /^retry: attempt 1 failed/.test(t.reason)));
});

test('a review step is read-only: if the reviewer changes anything the step fails, and a planner cannot leave changes either', async () => {
  const w = world();
  const wf = w.mk('ro', { steps: [{ id: 'a', kind: 'agent', prompt: 'x' }, { id: 'rev', kind: 'review', reviews: 'a', maxAttempts: 1, prompt: `review\n${write('sneaky.txt', 'edited\n')}` }] });
  w.engine.start(wf.id); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /role violation/);
  assert.ok(w.engine.evidenceList(wf.id).some((e: any) => e.kind === 'role-violation'));

  const w2 = world();
  const wf2 = w2.mk('planner', { steps: [{ id: 'plan', kind: 'agent', role: 'planner', maxAttempts: 1, prompt: `plan\n${write('oops.txt', 'x\n')}` }] });
  w2.engine.start(wf2.id); await settled(w2, wf2.id);
  assert.equal(w2.status(wf2.id), 'failed'); assert.match(w2.engine.get(wf2.id).workflow.haltedReason!, /role violation: "planner" is read-only/);
});

test('parts that edit the same lines stop at integration with the conflict recorded, and nothing is merged', async () => {
  const w = world(); const base = git(w.repo, 'rev-parse', 'main').trim();
  const wf = w.mk('clash', featureTemplate({ parts: [{ id: 'p1', prompt: `x\n${write('a.txt', 'one\n')}` }, { id: 'p2', prompt: `y\n${write('a.txt', 'two\n')}` }], checks: [] }));
  w.engine.start(wf.id); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /merge conflict while integrating "p2": a\.txt/);
  const c = JSON.parse((w.engine.evidenceList(wf.id, { full: true }) as any[]).find((e) => e.kind === 'merge-conflict').content);
  assert.deepEqual(c.conflicts, ['a.txt']); assert.deepEqual(c.alreadyMerged, ['p1']);
  assert.equal(git(w.repo, 'rev-parse', 'main').trim(), base);
});

// ---------------------------------------------------------------- the human gate
test('a rejection stops the workflow; approval cannot be skipped', async () => {
  const w = world();
  const wf = w.mk('reject', featureTemplate({ parts: [{ id: 'p', prompt: `x\n${write('n.txt', '1\n')}` }], checks: [], reviewPrompt: `r\n${fake({ result: 'NO_FINDINGS' })}` }));
  w.engine.start(wf.id);
  await w.drive(() => w.sstatus(wf.id, 'merge-ready') === 'waiting_approval');
  await new Promise((r) => setTimeout(r, 200)); w.engine.tick();
  assert.equal(w.sstatus(wf.id, 'merge-ready'), 'waiting_approval', 'it waits as long as it takes');
  w.engine.decide(wf.id, 'merge-ready', 'rejected', 'bob'); await settled(w, wf.id);
  assert.equal(w.status(wf.id), 'failed'); assert.match(w.engine.get(wf.id).workflow.haltedReason!, /rejected by bob/);
  assert.equal(w.engine.get(wf.id).approvals[0].status, 'rejected');
});

test('cancelling stops running agents, cancels what has not started and rejects open approvals', async () => {
  const w = world();
  const wf = w.mk('cancel', { steps: [{ id: 'a', kind: 'agent', prompt: `x\n${fake({ sleep: 20_000 })}` }, { id: 'b', kind: 'agent', needs: ['a'], prompt: 'y' }] });
  w.engine.start(wf.id); await w.drive(() => w.sstatus(wf.id, 'a') === 'running' && !!w.step(wf.id, 'a').state.runId);
  const runId = w.step(wf.id, 'a').state.runId!;
  await w.engine.cancel(wf.id);
  assert.equal(w.status(wf.id), 'cancelled'); assert.equal(w.sstatus(wf.id, 'a'), 'cancelled'); assert.equal(w.sstatus(wf.id, 'b'), 'cancelled');
  assert.equal(w.store.getRun(runId)!.status, 'cancelled');
  await assert.rejects(() => w.engine.cancel(wf.id), (e: unknown) => e instanceof WorkflowError && e.status === 409);
});

// ---------------------------------------------------------------- durability and history
test('state lives in the database: a second engine instance continues a workflow the first one started', async () => {
  const w = world();
  const wf = w.mk('restart', featureTemplate({ parts: [{ id: 'p', prompt: `x\n${write('add.txt', '1\n')}` }], checks: [{ id: 'c', command: [NODE, '-e', 'setTimeout(()=>{},300)'] }], reviewPrompt: `r\n${fake({ result: 'NO_FINDINGS' })}` }));
  w.engine.start(wf.id);
  await w.drive(() => w.sstatus(wf.id, 'c') === 'running'); // first engine dies with a check in flight
  const second = new WorkflowEngine({ store: w.store, supervisor: w.sup, scheduler: w.sched, worktrees: w.worktrees });
  await until(() => { second.tick(); return second.get(wf.id).steps.find((s) => s.id === 'merge-ready')!.state.status === 'waiting_approval'; });
  second.decide(wf.id, 'merge-ready', 'approved', 'alice'); second.tick();
  assert.equal(second.get(wf.id).workflow.status, 'completed');
});

test('history and evidence are append-only and a definition cannot be edited after creation', () => {
  const w = world();
  const wf = w.mk('imm', { steps: [{ id: 'a', kind: 'agent', prompt: 'x' }] });
  assert.throws(() => w.db.exec("UPDATE workflow_transition SET reason='forged'"), /append-only/);
  assert.throws(() => w.db.exec('DELETE FROM workflow_transition'), /append-only/);
  assert.throws(() => w.db.exec("UPDATE workflow_evidence SET content='forged'"), /append-only/);
  assert.throws(() => w.db.exec('DELETE FROM workflow_evidence'), /append-only/);
  assert.throws(() => w.db.exec("UPDATE workflow SET goal='other'"), /cannot be changed/);
  assert.throws(() => w.engine.start('wfl_nope'), (e: unknown) => e instanceof WorkflowError && e.status === 404);
  w.engine.start(wf.id); assert.throws(() => w.engine.start(wf.id), (e: unknown) => e instanceof WorkflowError && e.status === 409);
});

// ---------------------------------------------------------------- over HTTP
test('the HTTP API creates a workflow from a template, runs it, and gates it on an explicit approval', async () => {
  const w = world();
  const server = createApi(w.store, w.sup, { worktreeRoot: join(tmp, 'http-wt'), workflowIntervalMs: 50 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  try {
    assert.ok((await call('GET', '/workflows/roles')).json.reviewer);
    assert.equal((await call('POST', '/workflows', { projectId: w.project.id, title: 'bad', goal: 'g', definition: { steps: [{ id: 'a', kind: 'agent' }] } })).status, 400);
    const c = await call('POST', '/workflows', { projectId: w.project.id, title: 'http', goal: 'g',
      template: { parts: [{ id: 'p', prompt: `x\n${write('n.txt', '1\n')}` }], checks: [{ id: 'c', command: [NODE, '-e', 'process.exit(0)'] }], reviewPrompt: `r\n${fake({ result: 'NO_FINDINGS' })}` } });
    assert.equal(c.status, 201); const id = c.json.id;
    assert.equal((await call('POST', `/workflows/${id}/start`)).json.status, 'running');
    await until(async () => false, 1).catch(() => undefined);
    const deadline = Date.now() + 60_000; let g: any;
    while (Date.now() < deadline) { g = (await call('GET', `/workflows/${id}`)).json; if (g.steps.find((s: any) => s.id === 'merge-ready').state.status === 'waiting_approval') break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(g.steps.find((s: any) => s.id === 'merge-ready').state.status, 'waiting_approval');
    assert.equal((await call('POST', `/workflows/${id}/steps/merge-ready/approve`, {})).status, 400, 'approver required');
    assert.equal((await call('POST', `/workflows/${id}/steps/merge-ready/approve`, { approver: 'alice' })).status, 200);
    for (let i = 0; i < 100 && (await call('GET', `/workflows/${id}`)).json.workflow.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call('GET', `/workflows/${id}`)).json.workflow.status, 'completed');
    assert.ok((await call('GET', `/workflows/${id}/evidence?full=1`)).json.some((e: any) => e.kind === 'check' && e.content));
    assert.ok((await call('GET', `/workflows/${id}/transitions`)).json.length > 10);
    assert.ok((await call('GET', `/workflows/${id}/record`)).json.retryHistory);
    assert.equal((await call('GET', `/workflows?projectId=${w.project.id}`)).json.length, 1);
    assert.equal((await call('GET', '/workflows/wfl_missing')).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
});
