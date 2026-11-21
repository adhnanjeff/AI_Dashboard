import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Approval, Worktree } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import type { WorktreeService } from '../worktrees/worktree-service.ts';
import { PolicyError, type PolicyService } from './policy-service.ts';

/**
 * The only code that can change a protected branch or delete unsaved work. Each operation has two halves:
 *  request  -> gathers evidence and asks a person (stored, immutable, expires);
 *  execute  -> re-checks the world, spends exactly one matching approval, then acts.
 * Nothing else in the orchestrator merges. A caller that says "it was approved" gets nothing: only a stored,
 * human-decided, unexpired, unused approval for this exact branch and commit is accepted.
 */

export interface CiStatus { state: 'success' | 'failure' | 'pending' | 'unknown'; detail: string; source: string }
/** Where CI / branch-protection status comes from. Plug in a real one; the default honestly says it does not know. */
export interface CiProvider { status(repoPath: string, sha: string, branch: string): CiStatus }
export const NO_CI: CiProvider = { status: () => ({ state: 'unknown', detail: 'No CI or branch-protection integration is configured, so required checks were not verified by the system.', source: 'none' }) };

export interface Risk { level: 'high' | 'medium' | 'info'; text: string }
const SENSITIVE = [/(^|\/)\.github\/workflows\//, /(^|\/)\.env(\.|$)/, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/, /(^|\/)Dockerfile/, /(^|\/)migrations?\//i, /(^|\/)\.claude\//, /(^|\/)CODEOWNERS$/, /\.(pem|key)$/, /(^|\/)package\.json$/];

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

export class ProtectedOps {
  private store: Store; private policy: PolicyService; private worktrees: WorktreeService; private ci: CiProvider;
  constructor(d: { store: Store; policy: PolicyService; worktrees: WorktreeService; ci?: CiProvider }) { this.store = d.store; this.policy = d.policy; this.worktrees = d.worktrees; this.ci = d.ci ?? NO_CI; }

  // ---------------------------------------------------------------- protected merge
  private subjectOf = (branch: string, head: string, target: string) => `merge:${branch}@${head}->${target}`;

  /** Everything a person needs in one place: diff, test evidence, unresolved findings, CI and risks. */
  mergeEvidence(i: { projectId: string; branch: string; head: string; target: string; worktree?: Worktree; workflowId?: string }) {
    const project = this.store.getProject(i.projectId)!; const q = this.store.sql(); const protectedTarget = this.policy.isProtectedBranch(project.defaultBranch, i.target);
    const risks: Risk[] = [];
    let files: { path: string; added: number | null; deleted: number | null }[] = [];
    const numstat = git(project.repoPath, 'diff', '--numstat', `${i.target}...${i.head}`);
    if (numstat.code === 0) files = numstat.out.split('\n').filter(Boolean).map((l) => { const [a, d, ...p] = l.split('\t'); return { path: p.join('\t'), added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) }; });
    const added = files.reduce((n, f) => n + (f.added ?? 0), 0), deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
    const mc = i.worktree ? this.worktrees.mergeCheck(i.worktree, i.target) : (() => { const r = git(project.repoPath, 'merge-tree', '--write-tree', '--name-only', '--no-messages', i.target, i.head); return { clean: r.code === 0, conflicts: r.code === 1 ? r.out.split('\n').slice(1).filter(Boolean) : [], ahead: 0, behind: 0 }; })();

    // tests and review: only what the workflow engine actually recorded
    const tests: { step: string; summary: string; passed: boolean }[] = []; let findings: { severity: string; path: string; message: string }[] = []; let sessions: string[] = i.worktree ? [i.worktree.sessionId] : [];
    if (i.workflowId) {
      const latest = new Map<string, any>();
      for (const e of q.all<any>("SELECT step_key, kind, summary, content FROM workflow_evidence WHERE workflow_id=? AND kind IN ('check','review-findings') ORDER BY id", i.workflowId)) latest.set(`${e.kind}:${e.step_key}`, e);
      for (const [k, e] of latest) {
        if (k.startsWith('check:')) tests.push({ step: e.step_key, summary: e.summary, passed: /-> passed\b/.test(e.summary) });
        else { try { findings = findings.concat(JSON.parse(e.content).findings ?? []); } catch { /* unreadable evidence is shown as none, and the risk below says so */ } }
      }
      sessions = sessions.concat(q.all<any>('SELECT session_id FROM workflow_step WHERE workflow_id=? AND session_id IS NOT NULL', i.workflowId).map((r) => r.session_id));
    }
    const ci = this.ci.status(project.repoPath, i.head, i.branch);
    const injected = sessions.length ? Number(q.one<any>(`SELECT COUNT(*) AS n FROM event WHERE type='security.untrusted_instruction' AND session_id IN (${sessions.map(() => '?').join(',')})`, ...sessions)?.n ?? 0) : 0;

    if (protectedTarget) risks.push({ level: 'high', text: `${i.target} is a protected branch.` });
    if (!mc.clean) risks.push({ level: 'high', text: `Merging would conflict: ${mc.conflicts.slice(0, 5).join(', ') || 'unknown'}.` });
    if (!tests.length) risks.push({ level: 'high', text: 'No test evidence is recorded for this branch. Nothing shows that it was tested.' });
    for (const t of tests.filter((x) => !x.passed)) risks.push({ level: 'high', text: `Check "${t.step}" did not pass: ${t.summary}` });
    if (findings.length) risks.push({ level: findings.some((f) => ['high', 'critical'].includes(f.severity)) ? 'high' : 'medium', text: `${findings.length} reviewer finding(s) were left unresolved.` });
    const touched = files.filter((f) => SENSITIVE.some((re) => re.test(f.path))).map((f) => f.path);
    if (touched.length) risks.push({ level: 'medium', text: `Touches sensitive files: ${touched.slice(0, 6).join(', ')}.` });
    if (added + deleted > 1000) risks.push({ level: 'medium', text: `Large change: ${added} lines added, ${deleted} removed.` });
    if (injected) risks.push({ level: 'medium', text: `${injected} tool result(s) during this work contained text that tried to give the agent orders (recorded, not obeyed).` });
    if (ci.state === 'failure' || ci.state === 'pending') risks.push({ level: 'high', text: `CI is ${ci.state}: ${ci.detail}` });
    if (ci.state === 'unknown') risks.push({ level: 'info', text: ci.detail });
    if (mc.behind) risks.push({ level: 'info', text: `The branch is ${mc.behind} commit(s) behind ${i.target}.` });

    return { kind: 'merge', projectId: i.projectId, branch: i.branch, head: i.head, target: i.target, protectedTarget, workflowId: i.workflowId ?? null,
      diff: { files, added, deleted }, mergeCheck: { clean: mc.clean, conflicts: mc.conflicts, ahead: mc.ahead, behind: mc.behind }, tests, findings, ci, injectedInstructions: injected, risks };
  }

  /** Ask a person to approve merging one agent branch, at its current commit, into the target branch. */
  requestMerge(i: { projectId: string; branch: string; target?: string; requestedBy: string; workflowId?: string }): Approval {
    const project = this.store.getProject(i.projectId); if (!project) throw new PolicyError(404, 'project not found');
    if (!i.requestedBy?.trim()) throw new PolicyError(400, 'requestedBy is required');
    if (!/^orch\/[\w./-]+$/.test(i.branch)) throw new PolicyError(400, 'only agent branches (orch/…) can be merged through the orchestrator');
    const target = i.target ?? project.defaultBranch;
    if (target === i.branch || target.startsWith('orch/')) throw new PolicyError(400, 'the target must be a normal branch, not an agent branch');
    const head = git(project.repoPath, 'rev-parse', '--verify', `${i.branch}^{commit}`); if (head.code !== 0) throw new PolicyError(404, `branch ${i.branch} does not exist`);
    if (git(project.repoPath, 'rev-parse', '--verify', `${target}^{commit}`).code !== 0) throw new PolicyError(404, `target branch ${target} does not exist`);
    const worktree = this.store.listWorktrees(project.id, 'active').find((w) => w.branch === i.branch);
    let anchor = worktree?.sessionId;
    if (i.workflowId) {
      const row = this.store.sql().one<any>("SELECT content FROM workflow_evidence WHERE workflow_id=? AND kind='anchor'", i.workflowId); anchor = row?.content ?? anchor;
    }
    if (!anchor) { // a branch with no live worktree still needs a session to hang the request on: use the newest session of the project
      anchor = this.store.listSessions(project.id).at(-1)?.id; if (!anchor) throw new PolicyError(400, 'no session to attach the approval request to');
    }
    const ev = this.mergeEvidence({ projectId: project.id, branch: i.branch, head: head.out, target, worktree, workflowId: i.workflowId });
    const action = ev.protectedTarget ? 'merge.protected' : 'merge.branch';
    return this.policy.request(action, { sessionId: anchor, subject: this.subjectOf(i.branch, head.out, target), requestedBy: i.requestedBy.trim(), evidence: ev as unknown as Record<string, unknown> });
  }

  /** Performs an approved merge. Every precondition is checked BEFORE the approval is spent, so a refusal does not waste it. */
  executeMerge(approvalId: string, actor: string): { merged: true; branch: string; target: string; head: string; newHead: string; approvalId: string } {
    const a = this.store.getApproval(approvalId); if (!a) throw new PolicyError(404, 'approval not found');
    const ev = a.evidence as any;
    if (a.action !== 'merge.protected' && a.action !== 'merge.branch') throw new PolicyError(403, `that approval is for "${a.action}", not a merge`);
    const project = this.store.getProject(ev.projectId); if (!project) throw new PolicyError(404, 'project not found');
    const { branch, head, target } = ev as { branch: string; head: string; target: string };
    const repo = project.repoPath; const refuse = (why: string, status = 409): never => { this.store.audit(actor, 'merge.refused', approvalId, { branch, target, why }); throw new PolicyError(status, `merge not done: ${why}`); };

    const now = git(repo, 'rev-parse', '--verify', `${branch}^{commit}`);
    if (now.code !== 0) refuse(`branch ${branch} no longer exists`);
    if (now.out !== head) refuse(`${branch} changed after it was approved (approved ${head.slice(0, 8)}, now ${now.out.slice(0, 8)}). Ask for a new approval so the person sees what will actually be merged.`);
    if (git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').out !== target) refuse(`the repository must have ${target} checked out. The orchestrator will not switch branches for you.`);
    if (git(repo, 'status', '--porcelain', '--untracked-files=no').out) refuse(`the ${target} checkout has uncommitted changes; commit or stash them first.`);
    const mt = git(repo, 'merge-tree', '--write-tree', '--name-only', '--no-messages', target, head);
    if (mt.code !== 0) refuse(`merging would conflict${mt.code === 1 ? `: ${mt.out.split('\n').slice(1).filter(Boolean).slice(0, 5).join(', ')}` : ''}`);
    const ci = this.ci.status(repo, head, branch); if (ci.state === 'failure' || ci.state === 'pending') refuse(`CI is ${ci.state}: ${ci.detail}`);
    if (ev.protectedTarget && Array.isArray(ev.tests) && ev.tests.some((t: any) => !t.passed)) refuse('a recorded check did not pass');

    this.policy.consume(approvalId, a.action as 'merge.branch', this.subjectOf(branch, head, target), actor); // spends the approval; throws if anything about it is wrong
    const name = git(repo, 'config', 'user.name').out || 'AI Control Center', email = git(repo, 'config', 'user.email').out || 'control-center@localhost';
    const msg = `Merge ${branch} into ${target}\n\nApproved by ${a.approver} (${approvalId}). Merged by the AI Engineering Control Center at the approved commit ${head}.`;
    const m = git(repo, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'merge', '--no-ff', '-m', msg, head);
    if (m.code !== 0) {
      git(repo, 'merge', '--abort');
      this.store.audit(actor, 'merge.failed', approvalId, { branch, target, head, error: (m.err || m.out).slice(0, 400) });
      throw new PolicyError(409, `git could not complete the merge (${(m.err || m.out).slice(0, 200)}). Nothing was changed. The approval was used; ask for a new one.`);
    }
    const newHead = git(repo, 'rev-parse', 'HEAD').out;
    this.store.audit(actor, 'merge.executed', approvalId, { branch, target, head, newHead, approver: a.approver, protectedTarget: !!ev.protectedTarget });
    this.store.appendEvent({ sessionId: a.sessionId, type: 'merge.executed', payload: { branch, target, head, newHead, approvalId } });
    return { merged: true, branch, target, head, newHead, approvalId };
  }

  // ---------------------------------------------------------------- discarding unsaved work
  private discardSubject = (w: Worktree, head: string | null, uncommitted: number) => `discard:${w.id}@${head ?? 'none'}:${uncommitted}`;

  /** The normal `remove` refuses to lose work. This is the path for when a person decides to lose it, knowingly. */
  requestDiscard(sessionId: string, requestedBy: string): Approval {
    const w = this.store.activeWorktreeForSession(sessionId); if (!w) throw new PolicyError(404, 'this session has no active workspace');
    if (!requestedBy?.trim()) throw new PolicyError(400, 'requestedBy is required');
    const st = this.worktrees.status(w);
    if (st.busyRunId) throw new PolicyError(409, `run ${st.busyRunId} is still working in it; stop it first`);
    if (!st.uncommitted.length && !st.ahead) throw new PolicyError(409, 'nothing would be lost: use the normal remove');
    const risks: Risk[] = [];
    if (st.uncommitted.length) risks.push({ level: 'high', text: `${st.uncommitted.length} uncommitted file(s) will be deleted for good: ${st.uncommitted.slice(0, 8).join(', ')}.` });
    if (st.ahead) risks.push({ level: 'info', text: `${st.ahead} commit(s) stay on branch ${w.branch}.` });
    return this.policy.request('worktree.discard', { sessionId, subject: this.discardSubject(w, st.head, st.uncommitted.length), requestedBy: requestedBy.trim(),
      evidence: { kind: 'discard', worktreeId: w.id, branch: w.branch, path: w.path, head: st.head, uncommitted: st.uncommitted, unmergedCommits: st.ahead, risks } });
  }

  executeDiscard(sessionId: string, approvalId: unknown, actor: string): Worktree {
    const w = this.store.activeWorktreeForSession(sessionId); if (!w) throw new PolicyError(404, 'this session has no active workspace');
    const st = this.worktrees.status(w);
    if (st.busyRunId) throw new PolicyError(409, `run ${st.busyRunId} is still working in it; stop it first`);
    this.policy.consume(approvalId, 'worktree.discard', this.discardSubject(w, st.head, st.uncommitted.length), actor); // the subject pins the exact state the person saw
    const project = this.store.getProject(w.projectId)!;
    if (existsSync(w.path)) {
      const r = git(project.repoPath, 'worktree', 'remove', '--force', w.path);
      if (r.code !== 0) throw new PolicyError(409, `git refused to remove the workspace: ${r.err}`);
    } else git(project.repoPath, 'worktree', 'prune');
    const done = this.store.markWorktreeRemoved(w.id);
    this.store.audit(actor, 'worktree.discarded', sessionId, { worktree: w.id, branch: w.branch, lostFiles: st.uncommitted, approvalId });
    return done;
  }
}
