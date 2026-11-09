import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/orchestrator/src/storage/db.ts';
import { Store } from '../../services/orchestrator/src/storage/store.ts';
import { seedDemo } from '../../services/orchestrator/src/storage/seed.ts';
import { canTransition, isTerminal, WORK_STATES, InvalidTransitionError } from '../../services/orchestrator/src/domain/states.ts';
import { redactString, redact } from '../../services/orchestrator/src/domain/redact.ts';

const mem = () => new Store(openDb(':memory:'));
const setup = (s: Store) => {
  const project = s.createProject({ name: 'p', repoPath: '/r' });
  const session = s.createSession({ projectId: project.id, title: 't' });
  return { project, session };
};

test('state machine: legal and illegal transitions', () => {
  assert.ok(canTransition('queued', 'running'));
  assert.ok(canTransition('failed', 'queued'));
  assert.ok(!canTransition('queued', 'completed'));
  assert.ok(!canTransition('completed', 'running'));
  assert.ok(!canTransition('cancelled', 'queued'));
  for (const s of ['completed', 'cancelled'] as const) assert.ok(isTerminal(s));
  assert.equal(WORK_STATES.filter(isTerminal).length, 2);
});

test('store rejects an invalid transition and leaves state unchanged', () => {
  const s = mem(); const { session } = setup(s);
  assert.throws(() => s.transitionSession(session.id, 'completed'), InvalidTransitionError);
  assert.equal(s.getSession(session.id)!.status, 'queued');
  assert.equal(s.listEvents(session.id).filter((e) => e.type === 'session.status').length, 0);
});

test('session lifecycle writes an ordered, gap-free event log', () => {
  const s = mem(); const { session } = setup(s);
  s.transitionSession(session.id, 'running'); s.transitionSession(session.id, 'paused'); s.transitionSession(session.id, 'running');
  s.transitionSession(session.id, 'completed');
  const seqs = s.listEvents(session.id).map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal(s.listEvents(session.id, 2)[0].seq, 3);
});

test('events are append-only at the database level', () => {
  const db = openDb(':memory:'); const s = new Store(db); const { session } = setup(s);
  assert.throws(() => db.exec("UPDATE event SET type='x'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM event'), /append-only/);
  assert.ok(s.listEvents(session.id).length > 0);
});

test('agent run records pid, exit code, timestamps and terminal state', () => {
  const s = mem(); const { session } = setup(s);
  const task = s.createTask({ sessionId: session.id, description: 'd' });
  const run = s.createRun({ taskId: task.id, role: 'coder', provider: 'claude-code-cli', model: 'm' });
  const started = s.transitionRun(run.id, 'running', { pid: 42, cliSessionId: 'abc' });
  assert.equal(started.pid, 42); assert.ok(started.startedAt); assert.equal(started.endedAt, null);
  const done = s.transitionRun(run.id, 'cancelled', { exitCode: 1, reason: 'user' });
  assert.equal(done.exitCode, 1); assert.equal(done.terminationReason, 'user'); assert.ok(done.endedAt);
  assert.equal(done.pid, 42, 'earlier fields are preserved');
  assert.throws(() => s.transitionRun(run.id, 'running'), InvalidTransitionError);
});

test('checkpoints version per session and the session points at the latest', () => {
  const s = mem(); const { session } = setup(s);
  const c1 = s.saveCheckpoint({ sessionId: session.id, nextAction: 'a' });
  const c2 = s.saveCheckpoint({ sessionId: session.id, nextAction: 'b', gitState: { branch: 'x' } });
  assert.deepEqual([c1.seq, c2.seq], [1, 2]);
  assert.equal(s.getSession(session.id)!.checkpointId, c2.id);
  assert.equal(s.latestCheckpoint(session.id)!.gitState.branch, 'x');
});

test('approvals need an approver identity and cannot be re-decided', () => {
  const s = mem(); const { session } = setup(s);
  const a = s.requestApproval({ sessionId: session.id, action: 'merge' });
  assert.throws(() => s.decideApproval(a.id, 'approved', ' '), /approver/);
  assert.equal(s.decideApproval(a.id, 'approved', 'adhnan').status, 'approved');
  assert.throws(() => s.decideApproval(a.id, 'rejected', 'adhnan'), InvalidTransitionError);
});

test('redaction removes secrets before they are persisted', () => {
  assert.equal(redactString('key sk-ant-api03-abcdefghijklmnop end'), 'key [REDACTED:anthropic-key] end');
  assert.match(redactString('token=ghp_abcdefghijklmnopqrstuvwxyz1234'), /REDACTED/);
  assert.match(redactString('password: hunter22'), /REDACTED/);
  assert.deepEqual(redact({ a: ['Bearer abcdefghijklmnop12345'] }), { a: ['Bearer [REDACTED]'] });
  const s = mem(); const { session } = setup(s);
  s.appendEvent({ sessionId: session.id, type: 'log', payload: { line: 'ANTHROPIC key sk-ant-api03-abcdefghijklmnop' } });
  s.addArtifact({ sessionId: session.id, kind: 'log', content: 'password=supersecret1' });
  assert.ok(!JSON.stringify(s.listEvents(session.id)).includes('sk-ant-api03'));
  assert.ok(!s.listArtifacts(session.id)[0].content!.includes('supersecret1'));
});

test('foreign keys and status constraints are enforced by the database', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.exec("INSERT INTO session VALUES ('s','nope','t','queued',NULL,NULL,'x','x')"), /FOREIGN KEY/);
  const s = new Store(db); const { project } = setup(s);
  assert.throws(() => db.exec(`INSERT INTO session VALUES ('s2','${project.id}','t','bogus',NULL,NULL,'x','x')`), /CHECK/);
});

test('migrations are idempotent across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-')); const path = join(dir, 'a.db');
  try {
    openDb(path).close(); const db = openDb(path);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM schema_migration').get() as any).c, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EXIT CRITERIA: session survives an application restart without losing authoritative state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-')); const path = join(dir, 'restart.db');
  try {
    const db1 = openDb(path); const s1 = new Store(db1);
    const { sessions: [session] } = seedDemo(s1);
    const before = { session: s1.getSession(session.id), events: s1.listEvents(session.id), cp: s1.latestCheckpoint(session.id),
      tasks: s1.listTasks(session.id) };
    db1.close(); // simulate process exit

    const db2 = openDb(path);
    const s2 = new Store(db2); // simulate fresh start
    assert.deepEqual(s2.getSession(session.id), before.session);
    assert.deepEqual(s2.listEvents(session.id), before.events);
    assert.deepEqual(s2.latestCheckpoint(session.id), before.cp);
    assert.deepEqual(s2.listTasks(session.id), before.tasks);
    assert.equal(s2.getSession(session.id)!.status, 'running');
    // and it is still writable with the correct next sequence number
    s2.transitionSession(session.id, 'paused');
    assert.equal(s2.listEvents(session.id).at(-1)!.seq, before.events.length + 1);
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('knowledge edges keep provenance and verified flag', () => {
  const s = mem(); const { project } = setup(s);
  const a = s.addNode({ projectId: project.id, kind: 'file', name: 'math.js', provenance: 'git', verified: true });
  const b = s.addNode({ projectId: project.id, kind: 'test', name: 'math.test.js', provenance: 'llm', verified: false });
  s.addEdge({ fromId: b.id, toId: a.id, kind: 'tests', provenance: 'llm-inferred', verified: false });
  assert.equal(s.listEdges(a.id)[0].verified, false);
});
