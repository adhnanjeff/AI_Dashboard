// Phase 0 spike: prove launch / capture / cancel / resume / worktree against the real Claude CLI.
// Usage: node spike/spike.ts <launch|cancel|resume|checkpoint|worktree>
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '.sandbox/testrepo');
const OUT = resolve(ROOT, '.sandbox/out');
mkdirSync(OUT, { recursive: true });

const MODEL = 'claude-haiku-5-5';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

type Ev = Record<string, any>;

function runClaude(opts: { cwd: string; prompt: string; sessionId?: string; resume?: string; cancelAfterMs?: number; tag: string }) {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write'];
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.resume) args.push('--resume', opts.resume);
  return new Promise<{ events: Ev[]; code: number | null; cancelled: boolean; pid: number }>((done) => {
    const child = spawn('claude', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const events: Ev[] = []; let buf = ''; let cancelled = false;
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const e = JSON.parse(line); events.push(e); console.log(`[${opts.tag}] ${e.type}${e.subtype ? '/' + e.subtype : ''}`); } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[${opts.tag}:err] ${d}`));
    if (opts.cancelAfterMs) setTimeout(() => {
      cancelled = true;
      // /T kills the whole tree (claude spawns Bash/tool children), not just the parent
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* already gone */ }
    }, opts.cancelAfterMs);
    child.on('close', (code) => {
      writeFileSync(resolve(OUT, `${opts.tag}.events.json`), JSON.stringify(events, null, 1));
      done({ events, code, cancelled, pid: child.pid! });
    });
  });
}

const summarize = (events: Ev[]) => {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const res = events.find((e) => e.type === 'result');
  return { session_id: init?.session_id, model: init?.model, result: res?.result?.slice?.(0, 120), is_error: res?.is_error, cost: res?.total_cost_usd };
};

const cmd = process.argv[2];

if (cmd === 'launch') {
  const sessionId = randomUUID();
  const r = await runClaude({ cwd: REPO, tag: 'launch', sessionId,
    prompt: 'Create a file notes.txt containing the single line: step one done. Then reply with the word DONE.' });
  console.log({ exit: r.code, ...summarize(r.events), sessionIdWeChose: sessionId });
  writeFileSync(resolve(OUT, 'last-session.txt'), sessionId);
  console.log('git status:\n' + git(REPO, 'status', '--short'));
} else if (cmd === 'cancel') {
  const r = await runClaude({ cwd: REPO, tag: 'cancel', cancelAfterMs: 4000,
    prompt: 'Write a 2000-word essay about git worktrees into essay.txt, one paragraph at a time using separate Edit calls.' });
  console.log({ exit: r.code, cancelled: r.cancelled, events: r.events.length });
  const left = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'essay about git worktrees' }).Count`], { encoding: 'utf8' }).trim();
  console.log('orphan processes matching prompt:', left || '0');
} else if (cmd === 'resume') {
  const sid = readFileSync(resolve(OUT, 'last-session.txt'), 'utf8').trim();
  const r = await runClaude({ cwd: REPO, tag: 'resume', resume: sid,
    prompt: 'What file did you create earlier in this session and what did it contain?' });
  console.log({ exit: r.code, ...summarize(r.events), resumedFrom: sid });
} else if (cmd === 'checkpoint') {
  // Portable resume: a fresh session, no --resume, seeded only from checkpoint + current git state.
  const cp = { task: 'Create notes.txt with two lines: "step one done" and "step two done".', done: ['notes.txt has line 1'],
    next: 'append line 2', status: git(REPO, 'status', '--short'), diff: git(REPO, 'diff', 'HEAD') };
  writeFileSync(resolve(OUT, 'checkpoint.json'), JSON.stringify(cp, null, 1));
  const r = await runClaude({ cwd: REPO, tag: 'checkpoint',
    prompt: `Resume this task from a checkpoint. First inspect the current files with git status/diff equivalents (Read), then finish only the next step.\nCHECKPOINT:\n${JSON.stringify(cp)}` });
  console.log({ exit: r.code, ...summarize(r.events) });
  console.log('notes.txt:', existsSync(resolve(REPO, 'notes.txt')) ? readFileSync(resolve(REPO, 'notes.txt'), 'utf8') : '(missing)');
} else if (cmd === 'worktree') {
  const wt = resolve(ROOT, '.sandbox/wt-feature');
  git(REPO, 'worktree', 'add', '-b', 'feature/spike', wt);
  writeFileSync(resolve(wt, 'uncommitted.txt'), 'precious work\n');
  console.log('worktrees:\n' + git(REPO, 'worktree', 'list'));
  // simulate crash: nothing cleans up; then verify the work survives and a safe (non-force) remove refuses.
  try { git(REPO, 'worktree', 'remove', wt); console.log('UNEXPECTED: remove succeeded'); }
  catch (e: any) { console.log('safe remove refused (good):', String(e.stderr || e.message).split('\n')[0]); }
  console.log('uncommitted file survives:', existsSync(resolve(wt, 'uncommitted.txt')));
  git(REPO, 'worktree', 'remove', '--force', wt); git(REPO, 'branch', '-D', 'feature/spike');
  console.log('cleaned up');
} else console.log('usage: node spike/spike.ts <launch|cancel|resume|checkpoint|worktree>');
