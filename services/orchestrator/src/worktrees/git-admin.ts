import { spawnSync } from 'node:child_process';

// The only place that runs git commands which can create or remove a directory. Like checkpoints/git.ts, safety is a
// property of the code: commands that could lose work (reset, clean, checkout, stash, rebase, merge, push, branch -D)
// are simply not in the allow-list, and force flags are refused everywhere.
const READS = new Set(['rev-parse', 'rev-list', 'merge-base', 'merge-tree', 'diff', 'status', 'ls-files', 'log', 'check-ref-format', 'show-ref', 'for-each-ref']);
// `worktree remove` without --force already refuses a dirty tree; `prune` only forgets entries whose directory is gone.
const WORKTREE_SUBCOMMANDS = new Set(['add', 'remove', 'list', 'prune']);
const FORBIDDEN_FLAGS = new Set(['--force', '-f', '-ff', '-D', '--hard', '--delete']);

export interface GitResult { code: number; stdout: string; stderr: string }

export function adminGit(cwd: string, ...args: string[]): GitResult {
  const allowed = READS.has(args[0]) || (args[0] === 'worktree' && WORKTREE_SUBCOMMANDS.has(args[1]));
  if (!allowed) throw new Error(`git ${args.slice(0, 2).join(' ')} is not allowed in worktree code`);
  if (args.some((a) => FORBIDDEN_FLAGS.has(a))) throw new Error('force/destructive git flags are never allowed');
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Like adminGit but throws on a non-zero exit, with git's own message. */
export function git(cwd: string, ...args: string[]): string {
  const r = adminGit(cwd, ...args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed (${r.code})`);
  return r.stdout;
}
