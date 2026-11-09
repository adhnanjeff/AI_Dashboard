// Manual test client for Phase 3 (checkpoint / pause / crash recovery / resume) against a RUNNING orchestrator.
//   node scripts/phase3-demo.mjs start     create project/session/task, start a real multi-file task
//   node scripts/phase3-demo.mjs pause     pause it (stops the worker, saves a checkpoint)
//   node scripts/phase3-demo.mjs status    session, run, checkpoint, drift check, files in the repo
//   node scripts/phase3-demo.mjs resume    resume from the checkpoint with a fresh worker and wait for it
// Env: API (default http://127.0.0.1:4317)  REPO (default .sandbox/testrepo)  MODEL (default claude-haiku-5-5)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API = process.env.API ?? 'http://127.0.0.1:4317';
const REPO = resolve(process.env.REPO ?? '.sandbox/testrepo');
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5';
const STATE = resolve('.sandbox/p3-demo.json');
const mode = process.argv[2];
if (!['start', 'pause', 'status', 'resume'].includes(mode)) { console.log('usage: phase3-demo.mjs <start|pause|status|resume>'); process.exit(1); }

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const need = (r, what) => { if (r.status >= 400) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const load = () => { if (!existsSync(STATE)) { console.log('no demo state; run "start" first'); process.exit(1); } return JSON.parse(readFileSync(STATE, 'utf8')); };
const parts = () => readdirSync(REPO).filter((f) => /^part\d+\.txt$/.test(f)).sort();
const hash = (f) => createHash('sha256').update(readFileSync(join(REPO, f))).digest('hex').slice(0, 10);

if (mode === 'start') {
  const project = need(await call('POST', '/projects', { name: 'p3-demo', repoPath: REPO }), 'project');
  const session = need(await call('POST', '/sessions', { projectId: project.id, title: 'phase3 demo' }), 'session');
  const task = need(await call('POST', `/sessions/${session.id}/tasks`, {
    description: 'Create six files named part1.txt through part6.txt in the current directory, in order, one Write call per file. ' +
      'Each file must contain one paragraph of about 120 words about a different aspect of git worktrees. Reply DONE when all six exist.',
    acceptanceCriteria: ['part1.txt .. part6.txt all exist', 'each has a paragraph'] }), 'task');
  const run = need(await call('POST', `/tasks/${task.id}/runs`, { model: MODEL, timeoutMs: 300000 }, { 'idempotency-key': `demo-start-${Date.now()}` }), 'run');
  writeFileSync(STATE, JSON.stringify({ session: session.id, task: task.id, run: run.id }));
  console.log(`started run ${run.id} (pid ${run.pid}). Files appear in ${REPO}.`);
  console.log('Now pause it (node scripts/phase3-demo.mjs pause) or kill the server while files are appearing.');
} else {
  const { session, run } = load();
  if (mode === 'pause') {
    const r = await call('POST', `/sessions/${session}/pause`);
    console.log(r.status === 200 ? `paused: run=${r.json.run.status} session=${r.json.session.status} (${r.json.run.terminationReason})` : `could not pause: ${JSON.stringify(r.json)}`);
  }
  if (mode === 'resume') {
    const r = await call('POST', `/sessions/${session}/resume`, { model: MODEL, timeoutMs: 300000 }, { 'idempotency-key': `demo-resume-${Date.now()}` });
    if (r.status >= 400) { console.log(`resume refused (${r.status}): ${r.json.error}`); if (r.json.drift) console.log('drift:', r.json.drift); process.exit(1); }
    console.log(`resumed with new run ${r.json.run.id}; drift=${r.json.drift?.level}`, r.json.drift?.notes?.length ? r.json.drift.notes : '');
    for (let x = r.json.run; x.active !== false; ) { await new Promise((t) => setTimeout(t, 2000)); x = (await call('GET', `/runs/${r.json.run.id}`)).json; console.log(`  resumed run: ${x.status}`); }
  }
  // common report
  const s = (await call('GET', `/sessions/${session}`)).json;
  const runs = (await call('GET', `/runs/${run}`)).json;
  console.log('\nsession:', s.session.status, '| task:', s.tasks[0].status, '| first run:', runs.status, `(${runs.terminationReason})`);
  const cp = await call('GET', `/sessions/${session}/checkpoint`);
  if (cp.status === 200) {
    const d = cp.json.data;
    console.log(`latest checkpoint: seq ${cp.json.seq}, reason "${d.reason}", at event #${d.lastEventSeq}`);
    console.log(`  next action: ${cp.json.nextAction}`);
    console.log(`  changed files at checkpoint: ${d.changedFiles.join(', ') || '(none)'}`);
  }
  const chk = await call('GET', `/sessions/${session}/resume-check`);
  if (chk.status === 200) console.log(`resume-check: drift=${chk.json.drift.level}`, chk.json.drift.notes.length ? chk.json.drift.notes : '');
  const f = parts(); console.log(`files in repo: ${f.length ? f.map((x) => `${x}[${hash(x)}]`).join(' ') : '(none)'}`);
  console.log('locks held:', (await call('GET', '/worktree-locks')).json.length);
}
