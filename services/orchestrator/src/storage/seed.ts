import type { Store } from './store.ts';

// Demo data only. Everything seeded is named "demo" so it can never be mistaken for real runtime data.
export function seedDemo(store: Store) {
  const project = store.createProject({ name: 'demo-project', repoPath: 'C:/AI Dashboard/.sandbox/testrepo' });
  const s1 = store.createSession({ projectId: project.id, title: 'demo: add subtract() to math.js' });
  const t1 = store.createTask({ sessionId: s1.id, description: 'Add subtract(a, b) to math.js',
    acceptanceCriteria: ['subtract(5,3) === 2', 'existing add() unchanged'] });
  const run = store.createRun({ taskId: t1.id, role: 'coder', provider: 'claude-code-cli', model: 'claude-haiku-5-5' });
  store.recordRouting({ runId: run.id, provider: 'claude-code-cli', model: 'claude-haiku-5-5', policyVersion: 'demo-0',
    reason: 'simple edit -> Haiku', usage: { source: 'unavailable' } });
  store.transitionSession(s1.id, 'running'); store.transitionTask(t1.id, 'running'); store.transitionRun(run.id, 'running', { pid: 1234 });
  store.saveCheckpoint({ sessionId: s1.id, nextAction: 'write subtract() and run tests', gitState: { branch: 'main', revision: 'demo' } });
  const s2 = store.createSession({ projectId: project.id, title: 'demo: queued feature' });
  return { project, sessions: [s1, s2] };
}
