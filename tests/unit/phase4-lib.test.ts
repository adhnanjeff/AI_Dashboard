import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff } from '../../apps/dashboard/lib/diff.ts';
import { describeEvent, mergeEvents, refreshHint } from '../../apps/dashboard/lib/events.ts';
import { availableActions, isDemo, stateMeta, STATE_META } from '../../apps/dashboard/lib/status.ts';
import { bytes, duration, relativeTime, usd } from '../../apps/dashboard/lib/format.ts';
import type { DomainEvent, Run, SessionDetail } from '../../apps/dashboard/lib/types.ts';

const ev = (seq: number, type = 'x', payload: any = {}): DomainEvent => ({ id: `e${seq}`, sessionId: 's', seq, type, runId: null, payload, createdAt: '2026-01-01T00:00:00Z' });

// ---------------------------------------------------------------- diff parser
test('diff parser: modified file with numbered lines and counts', () => {
  const d = parseUnifiedDiff('diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
  assert.equal(d.files.length, 1);
  const f = d.files[0];
  assert.deepEqual([f.path, f.status, f.additions, f.deletions], ['a.txt', 'modified', 1, 1]);
  assert.deepEqual(f.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text]),
    [['ctx', 1, 1, 'one'], ['del', 2, null, 'two'], ['add', null, 2, 'TWO'], ['ctx', 3, 3, 'three']]);
});

test('diff parser: added, deleted, renamed, binary, no-newline marker, truncation, spaces in names', () => {
  const text = [
    'diff --git a/new file.txt b/new file.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new file.txt', '@@ -0,0 +1 @@', '+hi', '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/old.txt b/renamed.txt', 'similarity index 100%', 'rename from old.txt', 'rename to renamed.txt',
    'diff --git a/pic.png b/pic.png', 'index 1..2 100644', 'Binary files a/pic.png and b/pic.png differ',
    '[diff truncated]', ''].join('\n');
  const d = parseUnifiedDiff(text);
  assert.deepEqual(d.files.map((f) => [f.path, f.status]), [['new file.txt', 'added'], ['gone.txt', 'deleted'], ['renamed.txt', 'renamed'], ['pic.png', 'modified']]);
  assert.equal(d.files[0].hunks[0].lines[0].noNewline, true);
  assert.equal(d.files[2].oldPath, 'old.txt'); assert.equal(d.files[3].binary, true); assert.equal(d.truncated, true);
});

test('diff parser: empty and garbage input never throws', () => {
  assert.deepEqual(parseUnifiedDiff(''), { files: [], truncated: false });
  assert.doesNotThrow(() => parseUnifiedDiff('@@ -x +y @@\n+++\n---\n\n\u0000garbage'));
  assert.equal(parseUnifiedDiff('no diff here').files.length, 0);
});

test('diff parser agrees with REAL git output (modify, add, delete, rename, multiple hunks)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p4d-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(dir, 'a.txt'), lines); writeFileSync(join(dir, 'gone.txt'), 'bye\n'); writeFileSync(join(dir, 'old name.txt'), 'rename me please, enough content to match\n');
    git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), lines.replace('line 2\n', 'LINE 2\n').replace('line 38\n', 'LINE 38\n'));
    rmSync(join(dir, 'gone.txt')); renameSync(join(dir, 'old name.txt'), join(dir, 'new name.txt'));
    writeFileSync(join(dir, 'added.txt'), 'a\nb\n'); git('add', '-A');
    const d = parseUnifiedDiff(git('diff', 'HEAD', '--no-color', '--no-ext-diff'));
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    assert.equal(byPath['a.txt'].hunks.length, 2, 'two separate hunks');
    assert.deepEqual([byPath['a.txt'].additions, byPath['a.txt'].deletions], [2, 2]);
    assert.equal(byPath['gone.txt'].status, 'deleted'); assert.equal(byPath['added.txt'].status, 'added'); assert.equal(byPath['added.txt'].additions, 2);
    assert.equal(byPath['new name.txt'].status, 'renamed'); assert.equal(byPath['new name.txt'].oldPath, 'old name.txt');
    // line numbers must line up with the real file
    const second = byPath['a.txt'].hunks[1].lines.find((l) => l.kind === 'add')!; assert.equal(second.newNo, 38); assert.equal(second.text, 'LINE 38');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- events
test('mergeEvents is idempotent, ordered, and keeps identity when nothing is new', () => {
  const a = [ev(1), ev(2)];
  assert.equal(mergeEvents(a, []), a); assert.equal(mergeEvents(a, [ev(1), ev(2)]), a, 'replay after reconnect changes nothing');
  assert.deepEqual(mergeEvents(a, [ev(4), ev(3), ev(2)]).map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(mergeEvents([], [ev(2), ev(1), ev(2)]).map((e) => e.seq), [1, 2]);
});

test('describeEvent words known events and tolerates unknown ones', () => {
  assert.deepEqual(describeEvent(ev(1, 'run.status', { from: 'running', to: 'failed', reason: 'exit code 2', exitCode: 2, pid: 9 })),
    { title: 'Run running → failed', detail: 'exit code 2 · exit 2 · pid 9', tone: 'bad' });
  assert.equal(describeEvent(ev(1, 'session.status', { from: 'queued', to: 'running' })).tone, 'info');
  const m = describeEvent(ev(1, 'agent.message', { text: 'x'.repeat(500), tools: ['Write'] }));
  assert.ok(m.detail!.length < 300 && m.detail!.includes('uses Write'));
  assert.equal(describeEvent(ev(1, 'agent.tool_result', { isError: true, summary: 'nope' })).tone, 'bad');
  assert.match(describeEvent(ev(1, 'agent.result', { ok: true, text: 'DONE', costUsd: 0.006 })).detail!, /cost \$0\.0060/);
  assert.deepEqual(describeEvent(ev(1, 'future.thing', { a: 1 })), { title: 'future.thing', tone: 'muted' });
  assert.doesNotThrow(() => describeEvent({ ...ev(1, 'run.status'), payload: undefined as any }));
});

test('refreshHint only asks for refetches when something relevant happened', () => {
  assert.deepEqual(refreshHint(ev(1, 'run.status')), { session: true, changes: true });
  assert.deepEqual(refreshHint(ev(1, 'agent.tool_result')), { session: false, changes: true });
  assert.deepEqual(refreshHint(ev(1, 'agent.message')), { session: false, changes: false });
});

// ---------------------------------------------------------------- status / actions
const detail = (status: any, tasks: any[], checkpoint: any = null): SessionDetail => ({ session: { status } as any, tasks, checkpoint });
const run = (status: any): Run => ({ status } as Run);

test('availableActions offers only what can work', () => {
  const queuedTask = [{ status: 'queued' }]; const cp = { id: 'c' };
  assert.deepEqual(availableActions(detail('queued', queuedTask), []), { start: true, cancel: false, resume: false, why: 'Not started yet.' });
  assert.equal(availableActions(detail('running', [{ status: 'running' }], cp), [run('running')]).cancel, true);
  assert.equal(availableActions(detail('running', [{ status: 'running' }], cp), [run('running')]).resume, false, 'no resume while a run is active');
  assert.equal(availableActions(detail('paused', [{ status: 'paused' }], cp), [run('cancelled')]).resume, true);
  assert.equal(availableActions(detail('failed', [{ status: 'failed' }], cp), [run('failed')]).resume, true);
  assert.equal(availableActions(detail('failed', [{ status: 'failed' }], null), [run('failed')]).resume, false, 'nothing to resume from');
  const done = availableActions(detail('completed', [{ status: 'completed' }], cp), [run('completed')]);
  assert.deepEqual([done.start, done.cancel, done.resume], [false, false, false]);
  assert.equal(availableActions(detail('queued', [{ status: 'completed' }]), []).start, false);
});

test('every state has a label, a glyph and a tone; unknown states degrade gracefully', () => {
  for (const [k, m] of Object.entries(STATE_META)) { assert.ok(m.label && m.glyph && m.tone, k); }
  assert.equal(new Set(Object.values(STATE_META).map((m) => m.glyph)).size, Object.keys(STATE_META).length, 'glyphs are distinct, so colour is never the only cue');
  assert.deepEqual(stateMeta('mystery'), { label: 'mystery', glyph: '?', tone: 'muted' });
  assert.equal(isDemo('demo: add subtract() to math.js'), true); assert.equal(isDemo('real work'), false);
});

// ---------------------------------------------------------------- format
test('time, duration, size and cost formatting', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(relativeTime('2026-01-01T11:59:58Z', now), 'just now'); assert.equal(relativeTime('2026-01-01T11:59:30Z', now), '30s ago');
  assert.equal(relativeTime('2026-01-01T11:30:00Z', now), '30m ago'); assert.equal(relativeTime('2026-01-01T09:00:00Z', now), '3h ago');
  assert.equal(relativeTime('2025-12-30T12:00:00Z', now), '2d ago'); assert.equal(relativeTime(null, now), '—'); assert.equal(relativeTime('garbage', now), '—');
  assert.equal(duration('2026-01-01T11:59:00Z', '2026-01-01T11:59:42Z'), '42s'); assert.equal(duration('2026-01-01T11:00:00Z', '2026-01-01T11:02:05Z'), '2m 5s');
  assert.equal(duration('2026-01-01T11:00:00Z', null, now), '1h 0m'); assert.equal(duration(null, null), '—'); assert.equal(duration('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), '—');
  assert.equal(bytes(512), '512 B'); assert.equal(bytes(2048), '2.0 KB'); assert.equal(bytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(usd(0.0060298), '$0.0060'); assert.equal(usd(1.234), '$1.23');
});
