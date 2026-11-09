import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { ClaudeCliAdapter } from '../../services/orchestrator/src/runtime/adapters/claude-cli.ts';
import { Supervisor } from '../../services/orchestrator/src/runtime/process-manager/supervisor.ts';
import { CheckpointService } from '../../services/orchestrator/src/checkpoints/checkpoint-service.ts';
import { createApi } from '../../services/orchestrator/src/api/server.ts';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'p4-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo() {
  const dir = join(tmp, `repo${++n}`); mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'base.txt'), 'base\n'); writeFileSync(join(dir, 'other.txt'), 'other\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init'); return dir;
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('condition not met in time');
};

async function setup(opts: { scenario?: string; allowedOrigins?: string[] } = {}) {
  const store = new Store(openDb(':memory:')); const repo = makeRepo();
  const cps = new CheckpointService(store);
  const adapter = new ClaudeCliAdapter({ command: process.execPath, baseArgs: [FIXTURE], env: { FAKE_SCENARIO: opts.scenario ?? 'ok' } });
  const sup = new Supervisor(store, adapter, { checkpoints: cps, checkpointIntervalMs: 0 });
  const server: Server = createApi(store, sup, { allowedOrigins: opts.allowedOrigins });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const project = store.createProject({ name: 'proj', repoPath: repo });
  const session = store.createSession({ projectId: project.id, title: 'sess' });
  const task = store.createTask({ sessionId: session.id, description: 'do it', acceptanceCriteria: ['a'] });
  // Raw http client so tests can set Host/Origin headers (fetch refuses some of them).
  const raw = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; json: any; text: string }>((res, rej) => {
    const rq = request({ host: '127.0.0.1', port, method, path, headers }, (r) => {
      let t = ''; r.on('data', (d) => (t += d)); r.on('end', () => { let json: any; try { json = JSON.parse(t); } catch { json = undefined; } res({ status: r.statusCode!, json, text: t }); });
    });
    rq.on('error', rej); if (body) rq.write(body); rq.end();
  });
  const close = async () => { await sup.shutdown(); server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return { store, repo, cps, sup, server, port, project, session, task, raw, close, base: `http://127.0.0.1:${port}` };
}
const JSONH = { 'content-type': 'application/json' };

// ---------------------------------------------------------------- request guard
test('guard: foreign Host header is refused (DNS rebinding)', async () => {
  const w = await setup();
  try {
    assert.equal((await w.raw('GET', '/health', { host: 'evil.example.com' })).status, 403);
    assert.equal((await w.raw('GET', '/health', { host: `localhost:${w.port}` })).status, 200);
    assert.equal((await w.raw('GET', '/health', { host: `127.0.0.1:${w.port}` })).status, 200);
  } finally { await w.close(); }
});

test('guard: a browser Origin is refused unless explicitly allowed', async () => {
  const closed = await setup();
  try {
    const r = await closed.raw('POST', '/projects', { ...JSONH, origin: 'http://evil.example.com' }, JSON.stringify({ name: 'x', repoPath: closed.repo }));
    assert.equal(r.status, 403); assert.equal(closed.store.listProjects().length, 1, 'nothing was created');
    assert.equal((await closed.raw('GET', '/sessions', { origin: 'http://localhost:3000' })).status, 403, 'even reads, by default');
  } finally { await closed.close(); }
  const open = await setup({ allowedOrigins: ['http://localhost:3000'] });
  try { assert.equal((await open.raw('GET', '/sessions', { origin: 'http://localhost:3000' })).status, 200); } finally { await open.close(); }
});

test('guard: a body that is not application/json is refused (cross-site form / no-cors fetch)', async () => {
  const w = await setup();
  try {
    const body = JSON.stringify({ name: 'x', repoPath: w.repo });
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])
      assert.equal((await w.raw('POST', '/projects', { 'content-type': ct, 'content-length': String(body.length) }, body)).status, 415, ct);
    assert.equal(w.store.listProjects().length, 1);
    assert.equal((await w.raw('POST', '/projects', { ...JSONH, 'content-length': String(body.length) }, body)).status, 201);
    const cancel = await w.raw('POST', `/runs/run_nope/cancel`);
    assert.equal(cancel.status, 404, 'a POST with no body needs no content-type');
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- listings
test('GET /projects, /sessions (newest first, with latest run) and /sessions/:id/runs', async () => {
  const w = await setup();
  try {
    const second = w.store.createSession({ projectId: w.project.id, title: 'newer' });
    const run = w.sup.start({ taskId: w.task.id, prompt: 'x', cwd: w.repo, model: 'claude-haiku-5-5' }); await w.sup.waitFor(run.id);
    assert.deepEqual((await w.raw('GET', '/projects')).json.map((p: any) => p.name), ['proj']);
    const list = (await w.raw('GET', '/sessions')).json;
    assert.deepEqual(list.map((x: any) => x.session.title), ['newer', 'sess'], 'newest first');
    assert.equal(list[0].latestRun, null); assert.equal(list[0].project.name, 'proj');
    assert.deepEqual([list[1].latestRun.status, list[1].latestRun.model, list[1].taskCount], ['completed', 'claude-haiku-5-5', 1]);
    assert.equal((await w.raw('GET', `/sessions/${w.session.id}/runs`)).json.length, 1);
    assert.equal((await w.raw('GET', `/sessions/${second.id}/runs`)).json.length, 0);
    assert.equal((await w.raw('GET', `/sessions/ses_nope/runs`)).status, 404);
  } finally { await w.close(); }
});

test('GET /runs/:id includes reported usage and artifact metadata; failed runs say usage is unavailable', async () => {
  const ok = await setup();
  try {
    const run = ok.sup.start({ taskId: ok.task.id, prompt: 'x', cwd: ok.repo, model: 'm' }); await ok.sup.waitFor(run.id);
    const d = (await ok.raw('GET', `/runs/${run.id}`)).json;
    assert.deepEqual(d.usage, { costUsd: 0.01, source: 'reported' }); assert.equal(d.sessionId, ok.session.id);
    assert.ok(d.artifacts.some((a: any) => a.kind === 'log' && a.bytes > 0)); assert.ok(!('content' in d.artifacts[0]), 'metadata only');
  } finally { await ok.close(); }
  const bad = await setup({ scenario: 'fail' });
  try {
    const run = bad.sup.start({ taskId: bad.task.id, prompt: 'x', cwd: bad.repo, model: 'm' }); await bad.sup.waitFor(run.id);
    assert.deepEqual((await bad.raw('GET', `/runs/${run.id}`)).json.usage, { source: 'unavailable' });
  } finally { await bad.close(); }
});

// ---------------------------------------------------------------- live stream (SSE)
async function openStream(url: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const frames: { id: string; event: string; data: any }[] = [];
  let buf = '';
  const done = (async () => {
    const reader = res.body!.getReader(); const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done: d } = await reader.read(); if (d) break;
        buf += dec.decode(value, { stream: true }); let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const f: any = {}; for (const line of block.split('\n')) { const k = line.indexOf(':'); if (k > 0) f[line.slice(0, k)] = line.slice(k + 1).trim(); }
          if (f.event) frames.push({ id: f.id, event: f.event, data: JSON.parse(f.data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { res, frames, abort: () => { ac.abort(); return done; } };
}

test('SSE: replays history, then streams new events live, in order, no duplicates', async () => {
  const w = await setup();
  try {
    const history = w.store.listEvents(w.session.id).length; assert.ok(history >= 2);
    const s = await openStream(`${w.base}/sessions/${w.session.id}/stream`);
    assert.match(s.res.headers.get('content-type')!, /text\/event-stream/);
    await until(() => s.frames.length === history);
    const live = w.store.appendEvent({ sessionId: w.session.id, type: 'custom.live', payload: { n: 1 } });
    await until(() => s.frames.length === history + 1);
    const last = s.frames.at(-1)!;
    assert.equal(last.event, 'session-event'); assert.equal(last.id, String(live.seq)); assert.equal(last.data.type, 'custom.live');
    const seqs = s.frames.map((f) => f.data.seq); assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    await s.abort();
  } finally { await w.close(); }
});

test('SSE: ?after= and Last-Event-ID resume without repeating events; events of other sessions are not leaked', async () => {
  const w = await setup();
  try {
    const other = w.store.createSession({ projectId: w.project.id, title: 'other' });
    for (let i = 0; i < 3; i++) w.store.appendEvent({ sessionId: w.session.id, type: 'tick', payload: { i } });
    const total = w.store.listEvents(w.session.id).length;
    const a = await openStream(`${w.base}/sessions/${w.session.id}/stream?after=${total - 2}`);
    await until(() => a.frames.length === 2); assert.deepEqual(a.frames.map((f) => f.data.seq), [total - 1, total]);
    const b = await openStream(`${w.base}/sessions/${w.session.id}/stream`, { 'last-event-id': String(total - 1) });
    await until(() => b.frames.length === 1); assert.equal(b.frames[0].data.seq, total);
    w.store.appendEvent({ sessionId: other.id, type: 'secret.other', payload: {} });
    w.store.appendEvent({ sessionId: w.session.id, type: 'mine', payload: {} });
    await until(() => a.frames.length === 3);
    assert.ok(![...a.frames, ...b.frames].some((f) => f.data.type === 'secret.other'));
    await a.abort(); await b.abort();
  } finally { await w.close(); }
});

test('SSE: a disconnected client is unsubscribed (no listener leak)', async () => {
  const w = await setup();
  try {
    const listeners = () => (w.store as any).listeners.size as number;
    const base = listeners();
    const s = await openStream(`${w.base}/sessions/${w.session.id}/stream`);
    await until(() => listeners() === base + 1);
    await s.abort();
    await until(() => listeners() === base);
    assert.doesNotThrow(() => w.store.appendEvent({ sessionId: w.session.id, type: 'after.close' }));
  } finally { await w.close(); }
});

test('SSE: a real run is visible live end to end', async () => {
  const w = await setup();
  try {
    const s = await openStream(`${w.base}/sessions/${w.session.id}/stream?after=${w.store.listEvents(w.session.id).at(-1)!.seq}`);
    const run = w.sup.start({ taskId: w.task.id, prompt: 'x', cwd: w.repo, model: 'm' });
    await until(() => s.frames.some((f) => f.data.type === 'run.status' && f.data.payload.to === 'completed'));
    const types = s.frames.map((f) => f.data.type);
    for (const t of ['session.status', 'run.created', 'agent.init', 'agent.message', 'agent.result', 'checkpoint.saved']) assert.ok(types.includes(t), t);
    await w.sup.waitFor(run.id); await s.abort();
  } finally { await w.close(); }
});

test('events are announced only after their transaction commits', () => {
  const store = new Store(openDb(':memory:'));
  const p = store.createProject({ name: 'p', repoPath: '/r' }); const s = store.createSession({ projectId: p.id, title: 't' });
  const seen: string[] = []; store.subscribe((e) => seen.push(e.type));
  assert.throws(() => (store as any).tx(() => { store.appendEvent({ sessionId: s.id, type: 'phantom' }); throw new Error('boom'); }), /boom/);
  assert.deepEqual(seen, [], 'rolled-back event never announced');
  assert.ok(!store.listEvents(s.id).some((e) => e.type === 'phantom'), 'and never persisted');
  store.transitionSession(s.id, 'running');
  assert.deepEqual(seen, ['session.status']);
  store.subscribe(() => { throw new Error('bad subscriber'); });
  assert.doesNotThrow(() => store.transitionSession(s.id, 'paused'), 'a broken subscriber cannot break a write');
});

// ---------------------------------------------------------------- changes + file viewer
test('GET changes: live files, untracked flags, diff, and checkpoint freshness', async () => {
  const w = await setup();
  try {
    const clean = (await w.raw('GET', `/sessions/${w.session.id}/changes`)).json;
    assert.equal(clean.available, true); assert.deepEqual(clean.files, []); assert.equal(clean.checkpoint, null); assert.equal(clean.branch, 'main');
    writeFileSync(join(w.repo, 'base.txt'), 'edited\n'); writeFileSync(join(w.repo, 'brand new.txt'), 'hello\n');
    const c = (await w.raw('GET', `/sessions/${w.session.id}/changes`)).json;
    assert.deepEqual(c.files.map((f: any) => [f.path, f.untracked]).sort(), [['base.txt', false], ['brand new.txt', true]]);
    assert.match(c.diff, /\+edited/); assert.ok(c.computedAt);
    w.cps.capture({ sessionId: w.session.id, reason: 'manual', nextAction: 'x' });
    assert.equal((await w.raw('GET', `/sessions/${w.session.id}/changes`)).json.checkpoint.matchesNow, true);
    writeFileSync(join(w.repo, 'base.txt'), 'edited again\n');
    assert.equal((await w.raw('GET', `/sessions/${w.session.id}/changes`)).json.checkpoint.matchesNow, false, 'checkpoint is now stale');
  } finally { await w.close(); }
});

test('GET changes on a non-git directory reports unavailable instead of failing', async () => {
  const w = await setup();
  try {
    const plain = join(tmp, 'plain'); mkdirSync(plain);
    const p = w.store.createProject({ name: 'plain', repoPath: plain }); const s = w.store.createSession({ projectId: p.id, title: 'x' });
    const c = (await w.raw('GET', `/sessions/${s.id}/changes`)).json;
    assert.equal(c.available, false); assert.deepEqual(c.files, []);
  } finally { await w.close(); }
});

test('GET file: only files git reports as changed; traversal, binary and oversized files are refused', async () => {
  const w = await setup();
  try {
    writeFileSync(join(w.repo, 'new.txt'), 'untracked body\n'); writeFileSync(join(w.repo, 'base.txt'), 'tracked edit\n');
    writeFileSync(join(w.repo, 'bin.dat'), Buffer.from([1, 2, 0, 3])); writeFileSync(join(w.repo, 'huge.txt'), 'x'.repeat(200 * 1024 + 1));
    const get = (p: string) => w.raw('GET', `/sessions/${w.session.id}/file?path=${encodeURIComponent(p)}`);
    assert.deepEqual((await get('new.txt')).json, { path: 'new.txt', size: 15, content: 'untracked body\n' });
    assert.equal((await get('base.txt')).json.content, 'tracked edit\n');
    assert.equal((await get('other.txt')).status, 404, 'tracked but unchanged: not served');
    for (const evil of ['../repo1/base.txt', '..\\..\\Windows\\win.ini', '/etc/passwd', 'C:\\Windows\\win.ini', '.git/config', ''])
      assert.equal((await get(evil)).status, 404, evil);
    assert.equal((await get('bin.dat')).status, 415); assert.equal((await get('huge.txt')).status, 413);
  } finally { await w.close(); }
});
