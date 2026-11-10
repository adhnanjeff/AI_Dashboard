import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { Worktree } from '../domain/types.ts';
import { snapshot } from '../checkpoints/git.ts';
import { lockKey } from '../runtime/process-manager/supervisor.ts';
import type { Store } from '../storage/store.ts';
import { adminGit, git } from './git-admin.ts';

export class WorktreeError extends Error {
  status: number; details?: unknown;
  constructor(status: number, msg: string, details?: unknown) { super(msg); this.status = status; this.details = details; }
}

export interface WorktreeStatus {
  worktree: Worktree; exists: boolean; currentBranch: string | null; head: string | null;
  ahead: number; behind: number;                       // commits on the branch not in base / in base not on the branch
  uncommitted: string[]; committed: string[]; touched: string[];
  numstat: { path: string; added: number | null; deleted: number | null }[];   // working tree vs base revision
  busyRunId: string | null;                            // a run is writing here right now
}
export interface MergeCheck {
  target: string; branch: string; clean: boolean; conflicts: string[]; ahead: number; behind: number;
  uncommittedNotIncluded: string[]; note: string | null; error?: string;
}
export interface RemovalPreview { canRemove: boolean; blockers: string[]; willRemoveDirectory: string; branchKept: string; unmergedCommits: number; note: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'session';
const uniq = (xs: string[]) => [...new Set(xs)].sort();
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// Creates, inspects and removes per-session git worktrees. It never resets, cleans, checks out, merges or force-removes:
// merging is left to the person (see integrationPlan), and removal refuses while anything uncommitted exists.
export class WorktreeService {
  private store: Store; private root?: string;
  constructor(store: Store, opts: { root?: string } = {}) { this.store = store; this.root = opts.root ?? process.env.ORCH_WORKTREE_ROOT; }

  create(sessionId: string): Worktree {
    const session = this.store.getSession(sessionId); if (!session) throw new WorktreeError(404, 'session not found');
    const project = this.store.getProject(session.projectId)!;
    if (this.store.activeWorktreeForSession(sessionId)) throw new WorktreeError(409, 'session already has a worktree');
    // The worktree must exist before the first run, so every checkpoint and run of the session refers to one directory.
    if (this.store.listRunsForSession(sessionId).length || session.status !== 'queued')
      throw new WorktreeError(409, 'a worktree can only be created for a session that has not started yet (before its first run)');

    const repo = resolve(project.repoPath);
    if (!snapshot(repo).available) throw new WorktreeError(409, `${repo} is not a git repository`);
    let baseBranch = project.defaultBranch, baseRevision: string;
    try { baseRevision = git(repo, 'rev-parse', '--verify', `${baseBranch}^{commit}`).trim(); }
    catch {
      try {
        baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); baseRevision = git(repo, 'rev-parse', 'HEAD').trim();
        if (baseBranch === 'HEAD') throw new Error('detached');
      } catch { throw new WorktreeError(409, `cannot find a base commit: branch "${project.defaultBranch}" does not exist and the repository has no usable HEAD`); }
    }

    const id8 = randomUUID().slice(0, 8), name = `${slug(session.title)}-${id8}`, branch = `orch/${name}`;
    if (adminGit(repo, 'check-ref-format', '--branch', branch).code !== 0) throw new WorktreeError(400, `invalid branch name ${branch}`);
    const root = resolve(this.root ?? join(dirname(repo), `${basename(repo)}.worktrees`));
    const rel = relative(repo, root);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new WorktreeError(400, 'worktree root must be outside the repository so task files are never part of it');
    const path = join(root, name);
    if (existsSync(path)) throw new WorktreeError(409, `${path} already exists`);
    mkdirSync(root, { recursive: true });

    const r = adminGit(repo, 'worktree', 'add', '-b', branch, path, baseRevision);
    if (r.code !== 0) throw new WorktreeError(409, `git could not create the worktree: ${(r.stderr || r.stdout).trim()}`);
    try { return this.store.createWorktree({ projectId: project.id, sessionId, path, branch, baseBranch, baseRevision }); }
    catch (e) { adminGit(repo, 'worktree', 'remove', path); throw e; } // brand new and clean, so a plain remove is safe
  }

  get(sessionId: string): Worktree | undefined { return this.store.activeWorktreeForSession(sessionId); }

  status(w: Worktree): WorktreeStatus {
    const exists = existsSync(w.path);
    const base: WorktreeStatus = { worktree: w, exists, currentBranch: null, head: null, ahead: 0, behind: 0, uncommitted: [], committed: [], touched: [], numstat: [], busyRunId: null };
    const holder = this.store.getWorktreeLock(lockKey(w.path));
    if (holder && this.store.getRun(holder.runId)?.status === 'running') base.busyRunId = holder.runId;
    if (!exists) return base;
    const snap = snapshot(w.path); if (!snap.available) return base;
    base.currentBranch = snap.branch ?? null; base.head = snap.revision ?? null; base.uncommitted = uniq(snap.changedFiles);
    const count = (range: string) => { const r = adminGit(w.path, 'rev-list', '--count', range); return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0; };
    base.ahead = count(`${w.baseRevision}..HEAD`);
    base.behind = count(`HEAD..${w.baseBranch}`);
    const c = adminGit(w.path, 'diff', '--name-only', w.baseRevision, 'HEAD'); base.committed = c.code === 0 ? uniq(lines(c.stdout)) : [];
    base.touched = uniq([...base.committed, ...base.uncommitted]);
    const n = adminGit(w.path, 'diff', '--numstat', w.baseRevision);
    if (n.code === 0) base.numstat = lines(n.stdout).map((l) => { const [a, d, ...p] = l.split('\t'); return { path: p.join('\t'), added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) }; });
    return base;
  }

  /**
   * Would merging this branch into `target` conflict? Uses `git merge-tree --write-tree`, which computes the merge in
   * memory (it only writes unreachable objects): no branch, index or file is touched. Only COMMITTED work is compared.
   */
  mergeCheck(w: Worktree, target = w.baseBranch): MergeCheck {
    const st = this.status(w);
    return { ...this.compare(w.branch, target, w.path), branch: w.branch, ahead: st.ahead, behind: st.behind, uncommittedNotIncluded: st.uncommitted,
      note: st.ahead === 0 ? 'nothing committed on this branch yet, so there is nothing to merge' : st.uncommitted.length ? 'uncommitted changes are not part of this check; commit them to include them' : null };
  }

  private compare(a: string, b: string, cwd: string): { target: string; clean: boolean; conflicts: string[]; error?: string } {
    const r = adminGit(existsSync(cwd) ? cwd : dirname(cwd), 'merge-tree', '--write-tree', '--name-only', '--no-messages', b, a);
    if (r.code === 0) return { target: b, clean: true, conflicts: [] };
    if (r.code === 1) return { target: b, clean: false, conflicts: uniq(lines(r.stdout).slice(1)) };
    return { target: b, clean: false, conflicts: [], error: (r.stderr || 'git merge-tree failed').trim() };
  }

  removalPreview(w: Worktree): RemovalPreview {
    const st = this.status(w); const blockers: string[] = [];
    if (st.busyRunId) blockers.push(`run ${st.busyRunId} is still working in it`);
    if (st.uncommitted.length) blockers.push(`${st.uncommitted.length} uncommitted file(s) would be lost: ${st.uncommitted.slice(0, 10).join(', ')}${st.uncommitted.length > 10 ? ', …' : ''}`);
    return { canRemove: blockers.length === 0, blockers, willRemoveDirectory: w.path, branchKept: w.branch, unmergedCommits: st.ahead,
      note: `Only the directory is removed. Branch ${w.branch} stays, so its ${st.ahead} commit(s) remain recoverable.` };
  }

  /** Removes the directory only if nothing would be lost. There is no force option. */
  remove(w: Worktree): Worktree {
    const prev = this.removalPreview(w);
    if (!prev.canRemove) throw new WorktreeError(409, `refusing to remove: ${prev.blockers.join('; ')}`, prev);
    const project = this.store.getProject(w.projectId)!;
    if (existsSync(w.path)) {
      const r = adminGit(project.repoPath, 'worktree', 'remove', w.path);
      if (r.code !== 0) throw new WorktreeError(409, `git refused to remove the worktree: ${(r.stderr || r.stdout).trim()}`);
    } else adminGit(project.repoPath, 'worktree', 'prune'); // directory already gone: just forget the stale git entry
    return this.store.markWorktreeRemoved(w.id);
  }

  /** Every active worktree of a project, which of them touch the same files, and a safe merge order. */
  overview(projectId: string) {
    const project = this.store.getProject(projectId); if (!project) throw new WorktreeError(404, 'project not found');
    const sts = this.store.listWorktrees(projectId, 'active').map((w) => this.status(w));
    const overlaps: { a: string; b: string; sessionA: string; sessionB: string; files: string[] }[] = [];
    for (let i = 0; i < sts.length; i++) for (let j = i + 1; j < sts.length; j++) {
      const B = new Set(sts[j].touched), files = sts[i].touched.filter((f) => B.has(f));
      if (files.length) overlaps.push({ a: sts[i].worktree.branch, b: sts[j].worktree.branch, sessionA: sts[i].worktree.sessionId, sessionB: sts[j].worktree.sessionId, files });
    }
    return { project: { id: project.id, name: project.name, defaultBranch: project.defaultBranch }, worktrees: sts, overlaps, integration: this.integrationPlan(project.id, sts) };
  }

  /**
   * Strategy (advice only; this service never merges): merge session branches one at a time into a throw-away
   * integration branch, never straight into the default branch. Branches that merge cleanly go first; branches that
   * would conflict with the target or with another planned branch are flagged so a person resolves them deliberately.
   */
  integrationPlan(projectId: string, sts = this.store.listWorktrees(projectId, 'active').map((w) => this.status(w))) {
    const project = this.store.getProject(projectId)!;
    const ready = sts.filter((s) => s.ahead > 0);
    const vsTarget = ready.map((s) => ({ s, check: this.mergeCheck(s.worktree, project.defaultBranch) }));
    const pairs: { a: string; b: string; conflicts: string[] }[] = [];
    for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++) {
      const c = this.compare(ready[i].worktree.branch, ready[j].worktree.branch, project.repoPath);
      if (!c.clean) pairs.push({ a: ready[i].worktree.branch, b: ready[j].worktree.branch, conflicts: c.conflicts });
    }
    const conflictCount = (b: string) => pairs.filter((p) => p.a === b || p.b === b).length;
    const order = [...vsTarget].sort((x, y) => Number(!x.check.clean) - Number(!y.check.clean) || conflictCount(x.s.worktree.branch) - conflictCount(y.s.worktree.branch));
    const integ = `orch/integration-${slug(project.name)}`;
    return {
      target: project.defaultBranch, integrationBranch: integ,
      order: order.map(({ s, check }) => ({ sessionId: s.worktree.sessionId, branch: s.worktree.branch, clean: check.clean, conflicts: check.conflicts, uncommitted: s.uncommitted.length })),
      pairConflicts: pairs,
      commands: [
        `git worktree add ../${slug(project.name)}-integration -b ${integ} ${project.defaultBranch}`,
        ...order.map(({ s }) => `git -C ../${slug(project.name)}-integration merge --no-ff ${s.worktree.branch}`),
        `# run the checks in the integration worktree, then fast-forward ${project.defaultBranch} to ${integ} yourself`,
      ],
      note: 'These commands are suggestions: the orchestrator never runs a merge. Uncommitted work is not merged; commit it first.',
    };
  }
}
