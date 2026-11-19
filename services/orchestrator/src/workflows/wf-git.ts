import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';

// Git and process helpers for the workflow engine. Like worktrees/git-admin.ts, safety is in the code: only the
// subcommands below exist, only inside worktrees on an `orch/` branch (created by this system), and nothing here can
// reset, clean, checkout, rebase, push, force or delete.

const IDENT = ['-c', 'user.name=AI Control Center', '-c', 'user.email=control-center@localhost', '-c', 'core.autocrlf=false'];
const run = (cwd: string, args: string[]) => {
  const r = spawnSync('git', [...IDENT, '-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').toString(), err: (r.stderr ?? '').toString() };
};
const ALLOWED = new Set(['status', 'add', 'commit', 'merge', 'diff', 'rev-parse', 'branch']);
function guarded(cwd: string, args: string[]) {
  if (!ALLOWED.has(args[0])) throw new Error(`git ${args[0]} is not allowed in workflow code`);
  if (args.some((a) => ['--force', '-f', '-D', '--hard'].includes(a))) throw new Error('force flags are never allowed');
  return run(cwd, args);
}
const branchOf = (cwd: string) => guarded(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
function assertOwned(cwd: string) {
  const b = branchOf(cwd);
  if (!b.startsWith('orch/')) throw new Error(`refusing to change ${cwd}: branch "${b}" is not a Control Center branch`);
  return b;
}

export const headOf = (cwd: string) => guarded(cwd, ['rev-parse', 'HEAD']).out.trim();
export const dirtyFiles = (cwd: string): string[] => guarded(cwd, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

/** Commit whatever is in the worktree onto its own orch/ branch, so the step's work is a durable, mergeable unit. */
export function snapshotCommit(cwd: string, message: string): { committed: boolean; head: string; files: string[] } {
  assertOwned(cwd);
  const files = dirtyFiles(cwd);
  if (!files.length) return { committed: false, head: headOf(cwd), files };
  const a = guarded(cwd, ['add', '-A']); if (a.code !== 0) throw new Error(`git add failed: ${a.err.trim()}`);
  const c = guarded(cwd, ['commit', '-q', '-m', message]); if (c.code !== 0) throw new Error(`git commit failed: ${(c.err || c.out).trim()}`);
  return { committed: true, head: headOf(cwd), files };
}

/** Merge another orch/ branch into this (clean, engine-owned) integration worktree. On conflict the merge is aborted and the tree left clean. */
export function mergeBranch(cwd: string, branch: string): { ok: boolean; conflicts: string[]; message: string } {
  assertOwned(cwd);
  if (!branch.startsWith('orch/')) throw new Error('can only merge Control Center branches');
  if (dirtyFiles(cwd).length) throw new Error('integration worktree is not clean');
  const m = guarded(cwd, ['merge', '--no-ff', '--no-edit', branch]);
  if (m.code === 0) return { ok: true, conflicts: [], message: (m.out || 'merged').trim().split('\n')[0] };
  const conflicts = guarded(cwd, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').map((l) => l.trim()).filter(Boolean);
  guarded(cwd, ['merge', '--abort']);
  return { ok: false, conflicts, message: (m.out + m.err).trim().slice(0, 500) };
}

// ---- deterministic checks: an argument list, never a shell string, and only allow-listed programs.
export const DEFAULT_ALLOWED_COMMANDS = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'pytest', 'python', 'python3', 'ruff', 'mypy', 'cargo', 'go', 'dotnet', 'make', 'git', 'gradle', 'mvn', 'semgrep', 'gitleaks'];
export const commandName = (argv: string[]) => basename(argv[0]).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
const WIN_CMD = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'eslint', 'prettier', 'vitest', 'jest']);
const SHELL_META = /[&|<>^"%`$;\r\n]/;

export function assertCommandAllowed(argv: string[], allowed: string[]) {
  const name = commandName(argv);
  if (argv[0] !== basename(argv[0]) && !/^node(\.exe)?$/i.test(basename(argv[0]))) throw new Error(`command "${argv[0]}" must be a bare program name`);
  if (!allowed.includes(name)) throw new Error(`command "${name}" is not on the allow-list (${allowed.join(', ')}); set ORCH_CHECK_COMMANDS to change it`);
}

export interface CheckResult { exitCode: number | null; timedOut: boolean; ms: number; output: string; error?: string }
export function runCommand(argv: string[], cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const t0 = Date.now(); const name = commandName(argv);
    const viaShell = process.platform === 'win32' && WIN_CMD.has(name);
    if (viaShell && argv.some((a) => SHELL_META.test(a))) return resolve({ exitCode: null, timedOut: false, ms: 0, output: '', error: 'argument contains a shell metacharacter, refused' });
    const file = name === 'node' ? process.execPath : argv[0];
    let child; try { child = spawn(file, argv.slice(1), { cwd, shell: viaShell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } }); }
    catch (e: any) { return resolve({ exitCode: null, timedOut: false, ms: 0, output: '', error: e.message }); }
    let buf = ''; const CAP = 200_000;
    const take = (d: Buffer) => { buf += d.toString(); if (buf.length > CAP) buf = buf.slice(-CAP); };
    child.stdout!.on('data', take); child.stderr!.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, timedOut, ms: Date.now() - t0, output: buf, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut, ms: Date.now() - t0, output: buf }); });
  });
}
