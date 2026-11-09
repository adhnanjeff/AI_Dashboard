import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Checkpointing may only ever READ a repository. Allow-listing subcommands makes
// "never reset, clean, or overwrite uncommitted files" a property of the code, not a convention.
const READ_ONLY = new Set(['status', 'diff', 'rev-parse', 'ls-files', 'log']);

export function readGit(cwd: string, ...args: string[]): string {
  if (!READ_ONLY.has(args[0])) throw new Error(`git ${args[0]} is not allowed in checkpoint code (read-only)`);
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    // status normally refreshes the index and takes index.lock; that could collide with the agent's own git use.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

export interface GitSnapshot {
  available: boolean;
  branch?: string;
  revision?: string;
  status: string;            // short human-readable status
  changedFiles: string[];    // tracked files with changes + untracked files
  untracked: string[];
  diff: string;              // tracked changes vs HEAD (untracked files are listed, not diffed)
  diffTruncated: boolean;
  fingerprint: string;       // changes iff revision, branch, status, diff or untracked content changes
}

const DIFF_CAP = 1024 * 1024;
const HASH_CAP = 5 * 1024 * 1024;

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function snapshot(cwd: string): GitSnapshot {
  const empty: GitSnapshot = { available: false, status: 'not a git repository', changedFiles: [], untracked: [], diff: '', diffTruncated: false, fingerprint: sha('no-git') };
  if (!existsSync(cwd)) return empty;
  try { readGit(cwd, 'rev-parse', '--is-inside-work-tree'); } catch { return empty; }

  let revision: string | undefined;
  try { revision = readGit(cwd, 'rev-parse', 'HEAD').trim(); } catch { /* repository has no commits yet */ }
  let branch: string | undefined;
  try { branch = readGit(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* ignore */ }
  if (branch === 'HEAD' && revision) branch = `(detached ${revision.slice(0, 8)})`;

  // -z: NUL separated, never quoted. Renames/copies are followed by an extra "original path" entry.
  const entries = readGit(cwd, 'status', '--porcelain=v1', '-z', '-uall').split('\0').filter(Boolean);
  const changed: string[] = []; const untracked: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2); const path = entries[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;
    (code === '??' ? untracked : changed).push(path);
  }
  const status = readGit(cwd, 'status', '--short', '-uall').trim() || 'clean';

  let diff = '';
  try { diff = revision ? readGit(cwd, 'diff', 'HEAD', '--no-color', '--no-ext-diff') : readGit(cwd, 'diff', '--cached', '--no-color') + readGit(cwd, 'diff', '--no-color'); }
  catch { /* leave empty; status still describes the change */ }
  const diffTruncated = diff.length > DIFF_CAP;
  if (diffTruncated) diff = diff.slice(0, DIFF_CAP) + '\n[diff truncated]\n';

  const untrackedHashes = untracked.map((p) => {
    try { const f = join(cwd, p); const s = statSync(f); return s.size <= HASH_CAP ? `${p}:${sha(readFileSync(f))}` : `${p}:size${s.size}`; }
    catch { return `${p}:unreadable`; }
  });
  const fingerprint = sha(JSON.stringify({ revision, branch, status, diff, untrackedHashes }));
  return { available: true, branch, revision, status, changedFiles: [...changed, ...untracked], untracked, diff, diffTruncated, fingerprint };
}
