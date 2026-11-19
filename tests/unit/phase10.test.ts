import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { MemoryService } from '../../services/orchestrator/src/memory/memory-service.ts';
import { Supervisor } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import { extractTs, extractPy, stripComments } from '../../services/orchestrator/src/indexing/extract.ts';
import { IndexError, RepoIndex } from '../../services/orchestrator/src/indexing/indexer.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'p10-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' }, devDependencies: { tsx: '^4' }, scripts: { test: 'node --test tests/*.test.ts', build: 'node build.mjs' } }, null, 2) + '\n',
  'src/math.ts': `// import { ghost } from './ghost.ts';\nexport function add(a: number, b: number) {\n  return a + b;\n}\n\nexport class Calc {\n  total = 0;\n  push(x: number) {\n    this.total = add(this.total, x);\n    return this;\n  }\n}\n\nexport const double = (x: number) => add(x, x);\n`,
  'src/util.ts': `import { add, Calc } from './math.ts';\nimport pad from 'left-pad';\nimport { readFileSync } from 'node:fs';\n\nexport function sum(list: number[]) {\n  const c = new Calc();\n  for (const x of list) c.push(x);\n  return add(0, c.total);\n}\n`,
  'src/index.ts': `import * as util from './util.ts';\n\nexport function main() {\n  return util.sum([1, 2]);\n}\n`,
  'tests/util.test.ts': `import { test } from 'node:test';\nimport { sum } from '../src/util.ts';\n\ntest('sums numbers', () => {\n  sum([1]);\n});\n`,
  'tests/index.test.ts': `import { test } from 'node:test';\nimport { main } from '../src/index.ts';\n\ntest('main runs', () => {\n  main();\n});\n`,
  'build.mjs': `console.log('build');\n`,
  'lib/__init__.py': '',
  'lib/helpers.py': `def helper():\n    return 1\n`,
  'app/__init__.py': '',
  'app/main.py': `from lib.helpers import helper\n\n\ndef run():\n    return helper()\n`,
  'tests/test_app.py': `from app.main import run\n\n\ndef test_run():\n    run()\n`,
};
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, c] of Object.entries(FILES)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}
function world() {
  const store = new Store(openDb(':memory:')); const repo = makeRepo(); const project = store.createProject({ name: 'demo', repoPath: repo });
  const memory = new MemoryService(store); const ix = new RepoIndex(store, memory);
  return { store, repo, project, memory, ix, sql: store.sql() };
}
type W = ReturnType<typeof world>;
const edgeRows = (w: W, kind: string, prov = 'extracted:%') => w.sql.all<any>(`SELECT e.*, f.name AS fname, t.name AS tname FROM knowledge_edge e JOIN knowledge_node f ON f.id=e.from_id JOIN knowledge_node t ON t.id=e.to_id WHERE e.project_id=? AND e.kind=? AND e.provenance LIKE ?`, w.project.id, kind, prov);

// ---------------------------------------------------------------- extraction
test('extraction records declarations, imports and call sites from the source, and ignores comments', () => {
  const p = extractTs('src/math.ts', FILES['src/math.ts']);
  assert.deepEqual(p.symbols.map((s) => `${s.kind}:${s.owner ? s.owner + '.' : ''}${s.name}@${s.line}`), ['function:add@2', 'class:Calc@6', 'method:Calc.push@8', 'function:double@14']);
  assert.equal(p.imports.length, 0, 'a commented-out import is not an import');
  assert.ok(p.calls.some((c) => c.name === 'add' && c.line === 9 && /this\.total = add/.test(c.text)), 'a call is recorded with its line and text');
  const u = extractTs('src/util.ts', FILES['src/util.ts']);
  assert.deepEqual(u.imports.map((i) => [i.spec, i.line, i.bindings.map((b) => `${b.imported}>${b.local}`).join(',')]), [['./math.ts', 1, 'add>add,Calc>Calc'], ['left-pad', 2, 'default>pad'], ['node:fs', 3, 'readFileSync>readFileSync']]);
  const multi = extractTs('a.ts', `import {\n  a as x,\n  type B,\n} from './b.ts';\nconst { c } = require('./c.cjs');\nexport * from './d.ts';\nconst m = await import('./e.ts');\n`);
  assert.deepEqual(multi.imports.map((i) => [i.spec, i.line]), [['./b.ts', 1], ['./d.ts', 6], ['./c.cjs', 5], ['./e.ts', 7]]);
  assert.deepEqual(multi.imports[0].bindings, [{ imported: 'a', local: 'x' }, { imported: 'B', local: 'B' }]);
  const t = extractTs('t.test.ts', FILES['tests/util.test.ts']);
  assert.ok(t.isTest && t.symbols.some((s) => s.kind === 'test-case' && s.name === 'sums numbers'));
  const py = extractPy('app/main.py', FILES['app/main.py']);
  assert.deepEqual(py.imports.map((i) => [i.spec, i.line]), [['lib.helpers', 1]]);
  assert.deepEqual(py.symbols.map((s) => `${s.kind}:${s.name}@${s.line}`), ['function:run@4']);
  assert.equal(stripComments('a\n/* x\ny */ b // c\nd', 'ts'), 'a\n    \n     b \nd', 'line numbers survive comment stripping');
});

// ---------------------------------------------------------------- graph facts with provenance
test('indexing builds files, symbols, imports, calls, tests and manifest relationships, each with path, line and provenance', () => {
  const w = world(); const r = w.ix.index(w.project.id);
  assert.equal(r.mode, 'full'); assert.ok(r.files >= 11 && r.symbols >= 10 && r.edges > 20, JSON.stringify(r));
  const imp = edgeRows(w, 'imports').map((e) => `${e.fname} -> ${e.tname} @${e.path}:${e.line}`);
  assert.ok(imp.includes('src/util.ts -> src/math.ts @src/util.ts:1'));
  assert.ok(imp.includes('src/index.ts -> src/util.ts @src/index.ts:1'));
  assert.ok(imp.includes('app/main.py -> lib/helpers.py @app/main.py:1'), 'python absolute imports resolve inside the repo');
  assert.ok(!imp.some((i) => i.includes('ghost')), 'no edge from a commented-out import');
  const ext = edgeRows(w, 'imports_external').map((e) => `${e.fname} -> ${e.tname}:${e.line}`);
  assert.ok(ext.includes('src/util.ts -> left-pad:2') && ext.includes('src/util.ts -> node:fs:3'));
  assert.equal(w.sql.one<any>("SELECT kind FROM knowledge_node WHERE name='left-pad'")!.kind, 'dependency', 'declared in package.json: a dependency, not an unknown module');
  assert.equal(w.sql.one<any>("SELECT kind FROM knowledge_node WHERE name='node:fs'")!.kind, 'external');
  const dep = edgeRows(w, 'depends_on').map((e) => `${e.fname}>${e.tname} ${e.path}:${e.line} ${e.evidence}`);
  assert.ok(dep.some((d) => d.startsWith('package:demo>left-pad package.json:') && d.includes('"left-pad": "1.0.0"')));
  const calls = edgeRows(w, 'calls').map((e) => `${e.fname.split('#')[1]} -> ${e.tname}`);
  assert.ok(calls.includes('Calc.push@8 -> src/math.ts#add@2'), 'a call inside a method resolves to the function in the same file');
  assert.ok(calls.includes('sum@5 -> src/math.ts#add@2'), 'a call resolves across files through the import binding');
  assert.ok(calls.includes('main@3 -> src/util.ts#sum@5'), 'a namespace call (util.sum) resolves');
  assert.ok(calls.includes('Calc.push@8 -> src/math.ts#add@2') && calls.includes('double@14 -> src/math.ts#add@2'));
  assert.ok(calls.includes('run@4 -> lib/helpers.py#helper@1'));
  const tests = edgeRows(w, 'tests').map((e) => `${e.fname} -> ${e.tname}`);
  assert.ok(tests.includes('tests/util.test.ts -> src/util.ts') && tests.includes('tests/test_app.py -> app/main.py'));
  const runs = edgeRows(w, 'runs').map((e) => e.tname);
  assert.ok(runs.includes('tests/util.test.ts') && runs.includes('tests/index.test.ts') && runs.includes('build.mjs'), 'package scripts link to the files they run, including globs');
  for (const row of w.sql.all<any>("SELECT provenance, verified, path FROM knowledge_edge WHERE project_id=?", w.project.id)) { assert.match(row.provenance, /^extracted:regex-v1$/); assert.equal(row.verified, 1); }
});

// ---------------------------------------------------------------- queries
test('graph queries return source-linked answers: dependents, dependencies, related tests and relevant files', () => {
  const w = world(); w.ix.index(w.project.id);
  const dependents = w.ix.dependents(w.project.id, 'src/math.ts', 2).results;
  assert.deepEqual(dependents.map((d) => [d.path, d.depth, d.evidence.line]), [['src/util.ts', 1, 1], ['src/index.ts', 2, 1], ['tests/util.test.ts', 2, 2]], 'importers include test files, with the line of the import');
  assert.equal(dependents[0].evidence.evidence, "import { add, Calc } from './math.ts';", 'the evidence is the source text that proves the link');
  assert.deepEqual(w.ix.dependencies(w.project.id, 'src/util.ts').results.map((d) => d.path), ['src/math.ts']);
  const t = w.ix.testsFor(w.project.id, ['src/math.ts']).tests.map((x) => [x.test.path, x.depth]);
  assert.deepEqual(t, [['tests/util.test.ts', 2], ['tests/index.test.ts', 3]]);
  assert.deepEqual(w.ix.testsFor(w.project.id, ['lib/helpers.py']).tests.map((x) => x.test.path), ['tests/test_app.py']);
  const rel = w.ix.relevant(w.project.id, { query: 'sum the numbers in a list' });
  assert.equal(rel.files[0].path, 'src/util.ts'); assert.match(rel.files[0].reasons[0].why, /declares function sum \(line 5\)/);
  const m = rel.files.find((f) => f.path === 'src/math.ts')!; assert.ok(m && m.reasons.some((r) => /imported by src\/util\.ts/.test(r.why) && r.evidence?.line === 1));
  assert.ok(rel.files.some((f) => f.path === 'tests/util.test.ts' && f.isTest));
  assert.throws(() => w.ix.dependents(w.project.id, 'nope.ts'), (e: unknown) => e instanceof IndexError && e.status === 404);
  assert.ok(w.ix.search(w.project.id, 'Calc').some((x) => x.name === 'src/math.ts#Calc'));
});

test('a node can be inspected with its edges and the source lines it points at, and the source is flagged once it changes', () => {
  const w = world(); w.ix.index(w.project.id);
  const sym = w.ix.search(w.project.id, 'math.ts#Calc.push')[0]; assert.ok(sym);
  const nd = w.ix.node(sym.id) as any;
  assert.equal(nd.node.line, 8); assert.equal(nd.source.highlight, 8); assert.match(nd.source.lines.join('\n'), /push\(x: number\)/); assert.equal(nd.source.changedSinceIndexed, false);
  assert.ok(nd.out.some((e: any) => e.kind === 'calls' && e.other.name === 'src/math.ts#add' && e.line === 9 && /add\(this\.total/.test(e.evidence)));
  assert.ok(nd.in.some((e: any) => e.kind === 'contains'));
  writeFileSync(join(w.repo, 'src/math.ts'), FILES['src/math.ts'] + '// edited\n');
  assert.equal((w.ix.node(sym.id) as any).source.changedSinceIndexed, true);
});

// ---------------------------------------------------------------- staleness and incremental indexing
test('staleness is detected from file content, and incremental indexing re-reads only what changed', () => {
  const w = world(); w.ix.index(w.project.id);
  let st = w.ix.status(w.project.id); assert.equal(st.stale, false); assert.equal(st.reason, 'Up to date.'); assert.equal(st.indexedRevision, st.headRevision);

  const future = new Date(Date.now() + 5000); utimesSync(join(w.repo, 'src/index.ts'), future, future); // timestamp only
  assert.equal(w.ix.status(w.project.id).stale, false, 'a touched file with the same content is not stale');

  writeFileSync(join(w.repo, 'src/util.ts'), FILES['src/util.ts'] + '\nexport function extra() {\n  return add(1, 2);\n}\n');
  writeFileSync(join(w.repo, 'src/new.ts'), `import { sum } from './util.ts';\nexport const z = () => sum([]);\n`);
  unlinkSync(join(w.repo, 'build.mjs'));
  st = w.ix.status(w.project.id);
  assert.equal(st.stale, true); assert.deepEqual([st.changed, st.added, st.removed], [['src/util.ts'], ['src/new.ts'], ['build.mjs']]);
  assert.match(st.reason, /1 changed, 1 new, 1 deleted/);

  const r = w.ix.index(w.project.id);
  assert.equal(r.mode, 'incremental'); assert.equal(r.parsed, 2); assert.equal(r.removed, 1); assert.ok(r.unchanged >= 8);
  assert.equal(w.ix.status(w.project.id).stale, false);
  assert.ok(w.ix.search(w.project.id, 'util.ts#extra').length === 1, 'the new symbol is in the graph');
  assert.ok(edgeRows(w, 'imports').some((e) => e.fname === 'src/new.ts' && e.tname === 'src/util.ts'));
  assert.ok(!edgeRows(w, 'runs').some((e) => e.tname === 'build.mjs'), 'edges to a deleted file are gone');
  assert.equal(w.sql.one<any>("SELECT COUNT(*) AS c FROM knowledge_node WHERE name='build.mjs'")!.c, 0);
  assert.ok(w.ix.dependents(w.project.id, 'src/util.ts').results.some((d) => d.path === 'src/new.ts'), 'a dependent added later shows up without a full re-index');

  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'later');
  st = w.ix.status(w.project.id); assert.equal(st.stale, false); assert.match(st.reason, /HEAD moved/);
});

test('re-indexing is deterministic: the same repository gives the same graph', () => {
  const a = world(), b = world();
  const dump = (w: W) => w.sql.all<any>("SELECT kind, name FROM knowledge_node WHERE project_id=? ORDER BY kind, name", w.project.id).map((r) => `${r.kind}|${r.name}`).join('\n') +
    '\n' + w.sql.all<any>("SELECT e.kind, f.name AS a, t.name AS b, e.line FROM knowledge_edge e JOIN knowledge_node f ON f.id=e.from_id JOIN knowledge_node t ON t.id=e.to_id WHERE e.project_id=? ORDER BY 1,2,3,4", w.project.id).map((r) => `${r.kind}|${r.a}|${r.b}|${r.line}`).join('\n');
  a.ix.index(a.project.id); b.ix.index(b.project.id); b.ix.index(b.project.id, { full: true });
  assert.equal(dump(a), dump(b));
});

// ---------------------------------------------------------------- session graph: features, requirements, decisions, runs
test('a session graph links the feature to its requirements, runs, decisions and the code it touched, with tests and dependents, and flags stale data', () => {
  const w = world(); w.ix.index(w.project.id);
  const session = w.store.createSession({ projectId: w.project.id, title: 'Add doubling' });
  const task = w.store.createTask({ sessionId: session.id, description: 'make add() reusable', acceptanceCriteria: ['add stays pure', 'double() uses add'] });
  w.store.createRun({ taskId: task.id, role: 'coder', provider: 'p', model: 'claude-sonnet-5-5' });
  w.memory.add({ projectId: w.project.id, sessionId: session.id, category: 'decisions', content: 'Keep add() pure in src/math.ts so it can be tested alone', role: 'user' });
  w.store.saveCheckpoint({ sessionId: session.id, nextAction: 'review', data: { changedFiles: ['src/math.ts', 'src/brand-new.ts'] } });

  const g = w.ix.sessionGraph(session.id); const kinds = (k: string) => g.nodes.filter((x) => x.kind === k);
  assert.equal(kinds('feature').length, 1); assert.equal(kinds('requirement').length, 2); assert.equal(kinds('run').length, 1); assert.equal(kinds('decision').length, 1);
  const files = g.nodes.filter((x) => x.kind === 'file').map((x) => `${x.name}:${x.role}`);
  assert.ok(files.includes('src/math.ts:touched file') && files.includes('src/util.ts:depends on touched file') && files.includes('tests/util.test.ts:test'));
  assert.deepEqual(g.touchedNotInIndex, ['src/brand-new.ts'], 'work that is not in the index is said so');
  const rec = g.edges.filter((e) => e.provenance.startsWith('recorded:')).map((e) => e.kind).sort();
  assert.deepEqual(rec, ['decided', 'executed_by', 'has_requirement', 'has_requirement', 'mentions', 'touched'].sort());
  assert.ok(g.edges.filter((e) => e.provenance.startsWith('extracted:')).every((e) => e.verified && e.path && e.line));

  const again = w.ix.sessionGraph(session.id); assert.equal(again.nodes.length, g.nodes.length); assert.equal(again.edges.length, g.edges.length, 'linking is idempotent');

  writeFileSync(join(w.repo, 'src/math.ts'), FILES['src/math.ts'] + 'export const triple = (x: number) => add(x, add(x, x));\n');
  const stale = w.ix.sessionGraph(session.id).staleness; assert.equal(stale.stale, true); assert.deepEqual(stale.changed, ['src/math.ts']);
});

// ---------------------------------------------------------------- inferred relationships
test('model-proposed relationships are stored as inferred, need a rationale, survive re-indexing, and never masquerade as extracted facts', () => {
  const w = world(); w.ix.index(w.project.id);
  const id = (name: string) => w.ix.search(w.project.id, name)[0].id;
  const from = id('src/math.ts'), to = id('tests/index.test.ts');
  const bad = (i: any, re: RegExp) => assert.throws(() => w.ix.addInferred(w.project.id, i), (e: unknown) => e instanceof IndexError && re.test((e as Error).message));
  bad({ fromId: from, toId: to, kind: 'calls', rationale: 'long enough rationale' }, /must be one of/);
  bad({ fromId: from, toId: to, kind: 'relates_to', rationale: 'short' }, /rationale/);
  bad({ fromId: from, toId: 'kn_nope', kind: 'relates_to', rationale: 'long enough rationale' }, /not found/);
  const e = w.ix.addInferred(w.project.id, { fromId: from, toId: to, kind: 'relates_to', rationale: 'Arithmetic helpers are what the entry-point test exercises', model: 'claude-sonnet-5-5' });
  assert.equal(e.verified, false); assert.equal(e.provenance, 'inferred:llm:claude-sonnet-5-5');
  writeFileSync(join(w.repo, 'src/other.ts'), 'export const o = 1;\n'); w.ix.index(w.project.id);
  assert.equal(w.ix.inferredEdges(w.project.id).length, 1, 'an incremental re-index keeps it');
  assert.ok((w.ix.node(from) as any).out.some((x: any) => x.kind === 'relates_to' && x.verified === false && x.provenance.startsWith('inferred:')));
  const extracted = w.sql.one<any>("SELECT id FROM knowledge_edge WHERE provenance LIKE 'extracted:%' LIMIT 1")!.id;
  assert.throws(() => w.ix.removeInferred(extracted), (er: unknown) => er instanceof IndexError && er.status === 409);
  w.ix.removeInferred(e.id); assert.equal(w.ix.inferredEdges(w.project.id).length, 0);
  assert.ok(w.store.listAudit(20).some((a) => a.action === 'index.inferred_edge'));
});

// ---------------------------------------------------------------- a real repository (this one)
test('on this repository the graph finds the code behind a real feature, with links back to the source, and notices when it goes stale', () => {
  const store = new Store(openDb(':memory:')); const project = store.createProject({ name: 'self', repoPath: ROOT }); const ix = new RepoIndex(store);
  const r = ix.index(project.id); assert.ok(r.files > 60 && r.symbols > 400);
  const rel = ix.relevant(project.id, { query: 'routing policy escalation budget' }).files.map((f) => f.path);
  assert.ok(rel.includes('services/orchestrator/src/routing/policy.ts') && rel.includes('services/orchestrator/src/routing/router.ts'), rel.join(', '));
  const dep = ix.dependents(project.id, 'services/orchestrator/src/routing/policy.ts', 2).results.map((d) => d.path);
  assert.ok(dep.includes('services/orchestrator/src/routing/router.ts') && dep.includes('services/orchestrator/src/routing/scheduler.ts'));
  assert.ok(ix.testsFor(project.id, ['services/orchestrator/src/routing/policy.ts']).tests.some((t) => t.test.path === 'tests/unit/phase7.test.ts'));
  const hit = ix.search(project.id, 'routing/router.ts#Router.replay')[0]; assert.ok(hit);
  const nd = ix.node(hit.id) as any; assert.match(nd.source.lines.join('\n'), /replay\(/);
  assert.equal(ix.status(project.id).indexedRevision, ix.status(project.id).headRevision);
});

// ---------------------------------------------------------------- HTTP
test('the HTTP API indexes, reports staleness, searches, inspects nodes and serves a session graph', async () => {
  const w = world();
  const sup = new Supervisor(w.store, new ClaudeCliAdapter({ command: process.execPath, baseArgs: [] }), {});
  const server = createApi(w.store, sup, { worktreeRoot: join(tmp, 'http-wt') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const port = (server.address() as AddressInfo).port;
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  const pid = w.project.id;
  try {
    assert.equal((await call('GET', `/projects/${pid}/index`)).json.indexed, false);
    assert.equal((await call('POST', `/projects/${pid}/index`, {})).json.mode, 'full');
    const s = (await call('GET', `/projects/${pid}/index`)).json; assert.equal(s.stale, false); assert.ok(s.symbols > 10);
    const found = (await call('GET', `/projects/${pid}/graph/search?q=Calc`)).json; assert.ok(found.length >= 2);
    const f = (await call('GET', `/projects/${pid}/graph/files?path=src/math.ts&depth=2`)).json; assert.equal(f.dependents.length, 3); assert.ok(f.tests.length >= 2);
    assert.equal((await call('GET', `/projects/${pid}/graph/files?path=zzz.ts`)).status, 404);
    const rel = (await call('GET', `/projects/${pid}/graph/relevant?query=${encodeURIComponent('sum the list')}`)).json; assert.equal(rel.files[0].path, 'src/util.ts');
    const node = (await call('GET', `/graph/nodes/${found.find((x: any) => x.kind === 'symbol').id}`)).json; assert.ok(node.source.lines.length);
    const session = w.store.createSession({ projectId: pid, title: 'g' });
    const g = (await call('GET', `/sessions/${session.id}/graph`)).json; assert.ok(g.nodes.some((x: any) => x.kind === 'feature'));
    const i = await call('POST', `/projects/${pid}/graph/inferred`, { fromId: found[0].id, toId: found[1].id, kind: 'relates_to', rationale: 'both appear in the same example' }); assert.equal(i.status, 201);
    assert.equal((await call('POST', `/projects/${pid}/graph/inferred`, { fromId: found[0].id, toId: found[1].id, kind: 'relates_to', rationale: 'x' })).status, 400);
    assert.equal((await call('POST', `/graph/edges/${i.json.id}/remove`, {})).status, 200);
    writeFileSync(join(w.repo, 'src/late.ts'), 'export const late = 1;\n');
    assert.equal((await call('GET', `/projects/${pid}/index`)).json.stale, true);
  } finally { server.closeAllConnections(); server.close(); }
});
