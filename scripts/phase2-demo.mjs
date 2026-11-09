// Drives the running orchestrator API like a client would.
//   node scripts/phase2-demo.mjs run      real task: add subtract() to math.js, wait, print result
//   node scripts/phase2-demo.mjs cancel   long task, cancelled after a few seconds
// Env: API (default http://127.0.0.1:4317)  REPO (default .sandbox/testrepo)  MODEL (default claude-haiku-5-5)
import { resolve } from 'node:path';

const API = process.env.API ?? 'http://127.0.0.1:4317';
const REPO = resolve(process.env.REPO ?? '.sandbox/testrepo');
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5';
const mode = process.argv[2];
if (!['run', 'cancel'].includes(mode)) { console.log('usage: phase2-demo.mjs <run|cancel>'); process.exit(1); }

const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
};

const task = mode === 'run'
  ? { description: 'Add an exported function subtract(a, b) to math.js, next to add. Change nothing else. Reply DONE.',
      acceptanceCriteria: ['subtract(5,3) returns 2', 'add is unchanged'] }
  : { description: 'Write a 3000-word essay about git worktrees into essay.txt, one paragraph per separate Edit call.', acceptanceCriteria: [] };

const project = await call('POST', '/projects', { name: 'demo-repo', repoPath: REPO });
const session = await call('POST', '/sessions', { projectId: project.id, title: `phase2 ${mode}` });
const t = await call('POST', `/sessions/${session.id}/tasks`, task);
const run = await call('POST', `/tasks/${t.id}/runs`, { model: MODEL, timeoutMs: 180000 });
console.log(`started run ${run.id}  pid=${run.pid}  status=${run.status}`);

if (mode === 'cancel') {
  await new Promise((r) => setTimeout(r, 5000));
  console.log('cancelling...');
  const c = await call('POST', `/runs/${run.id}/cancel`);
  console.log(`after cancel: status=${c.status} reason="${c.terminationReason}"`);
} else {
  for (let r = run; r.active !== false; ) {
    await new Promise((x) => setTimeout(x, 2000));
    r = await call('GET', `/runs/${run.id}`);
    console.log(`  status=${r.status}`);
  }
}

const final = await call('GET', `/runs/${run.id}`);
console.log('\nrun:', { status: final.status, pid: final.pid, exitCode: final.exitCode, reason: final.terminationReason, active: final.active });
const s = await call('GET', `/sessions/${session.id}`);
console.log('session:', s.session.status, '| task:', s.tasks[0].status);
console.log('\nevents:');
for (const e of await call('GET', `/sessions/${session.id}/events`)) console.log(` #${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 100)}`);
console.log(`\nlog:  GET ${API}/runs/${run.id}/log`);
