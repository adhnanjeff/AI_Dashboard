import { createHash, timingSafeEqual } from 'node:crypto';
import type { Approval } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import { PROFILES, isProfileId, needsElevation, profileForRole, type Profile, type ProfileId } from './profiles.ts';

export class PolicyError extends Error {
  status: number; details?: unknown;
  constructor(status: number, message: string, details?: unknown) { super(message); this.status = status; this.details = details; }
}

/** Every action that needs a person. The risk line is what the approver reads first. */
export const PROTECTED_ACTIONS = {
  'merge.protected': { label: 'Merge into a protected branch', risk: 'Changes the history of a protected branch. Undoing it means a revert commit.' },
  'merge.branch': { label: 'Merge into a branch', risk: 'Adds the agent work to the target branch.' },
  'worktree.discard': { label: 'Discard a workspace that has unsaved or unmerged work', risk: 'Uncommitted files in the workspace are deleted and cannot be recovered. Commits stay on their branch.' },
  'permission.elevate': { label: 'Give an agent more than file access', risk: 'The agent can act outside its workspace, so repository text or web content could steer real actions.' },
} as const;
export type ProtectedAction = keyof typeof PROTECTED_ACTIONS;

export interface PolicyOptions {
  /** Secret that a decision must carry. Held by the dashboard server and withheld from agent processes. Unset = open (tests, local scripts). */
  decisionToken?: string;
  /** Branches whose merges are "protected". The project's default branch is always protected. */
  protectedBranches?: string[];
  /** If true, the person who requested an action cannot approve it. */
  separationOfDuties?: boolean;
  /** How long an approval stays usable once requested. Default 1 hour. */
  approvalTtlMs?: number;
}

// Names an agent or the engine could write into an `approver` field. A decision is a human act.
const RESERVED_APPROVER = /^(agent|system|workflow|orchestrator|engine|claude|assistant|bot|ai|model|reviewer|tester|coder|planner|docs|policy)([\s:_-].*)?$/i;
const digest = (s: string) => createHash('sha256').update(s).digest();

export class PolicyService {
  readonly store: Store; readonly opts: Required<Pick<PolicyOptions, 'separationOfDuties' | 'approvalTtlMs'>> & PolicyOptions;
  constructor(store: Store, opts: PolicyOptions = {}) {
    this.store = store; this.opts = { ...opts, separationOfDuties: opts.separationOfDuties ?? false, approvalTtlMs: opts.approvalTtlMs ?? 60 * 60_000 };
  }

  // ---------------------------------------------------------------- permission profiles
  profileForRole(role: string | undefined): ProfileId { return profileForRole(role); }
  profile(id: ProfileId): Profile { return PROFILES[id]; }
  matrix() { return Object.values(PROFILES); }

  /**
   * The only way a run gets a profile. Roles get their default for free; anything elevated needs an approval for this
   * profile on this task. The approval is used up here, so it cannot start a second run.
   */
  authorizeProfile(i: { role?: string; requested?: string; taskId: string; approvalId?: string; actor?: string }): ProfileId {
    const requested = i.requested ?? this.profileForRole(i.role);
    if (!isProfileId(requested)) throw new PolicyError(400, `unknown permission profile "${i.requested}"`);
    if (!needsElevation(requested)) {
      // A role that only reads can never be talked into writing by passing a profile name.
      const base = this.profileForRole(i.role);
      if (PROFILES[requested].grants.includes('edit') && !PROFILES[base].grants.includes('edit')) {
        this.denied('profile.denied', i.taskId, { role: i.role, requested, reason: 'role is read-only' });
        throw new PolicyError(403, `role "${i.role}" is read-only and cannot be given the "${requested}" profile`);
      }
      return requested;
    }
    if (!i.approvalId) { this.denied('profile.denied', i.taskId, { role: i.role, requested, reason: 'no approval' }); throw new PolicyError(403, `the "${requested}" profile needs an approved request (action permission.elevate)`); }
    this.consume(i.approvalId, 'permission.elevate', `profile:${requested}@task:${i.taskId}`, i.actor ?? 'supervisor');
    this.store.audit(i.actor ?? 'supervisor', 'profile.elevated', i.taskId, { profile: requested, approvalId: i.approvalId, role: i.role ?? null });
    return requested;
  }

  // ---------------------------------------------------------------- who may decide
  /** Normalises and checks the name on a decision, and checks the decision channel. Throws 403 otherwise. */
  authorizeDecision(approver: unknown, token: string | undefined): string {
    if (this.opts.decisionToken && !(token && timingSafeEqual(digest(token), digest(this.opts.decisionToken)))) {
      this.store.audit('unknown', 'approval.decision.refused', '-', { reason: 'missing or wrong decision token' });
      throw new PolicyError(403, 'decisions can only be made through the dashboard by a person: the decision token is missing or wrong');
    }
    const name = typeof approver === 'string' ? approver.trim() : '';
    if (!name) throw new PolicyError(400, 'approver is required: enter the name of the person deciding');
    if (name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new PolicyError(400, 'approver name is not valid');
    if (RESERVED_APPROVER.test(name)) { this.store.audit(name.slice(0, 40), 'approval.decision.refused', '-', { reason: 'reserved approver name' }); throw new PolicyError(403, `"${name}" is a name used by automated parts of the system; a person must decide`); }
    return name;
  }

  /** Decide an approval through the human channel. The name is checked, self-approval can be refused, and the decision is audited. */
  decide(id: string, decision: 'approved' | 'rejected', approver: unknown, token: string | undefined): Approval {
    const name = this.authorizeDecision(approver, token);
    const a = this.store.getApproval(id); if (!a) throw new PolicyError(404, 'approval not found');
    if (a.status !== 'pending') throw new PolicyError(409, `this approval was already ${a.status}`);
    if (a.expiresAt && a.expiresAt <= new Date().toISOString()) throw new PolicyError(409, 'this approval request has expired; ask for a new one');
    if (decision === 'approved' && this.opts.separationOfDuties && a.requestedBy && a.requestedBy.toLowerCase() === name.toLowerCase()) {
      this.store.audit(name, 'approval.decision.refused', id, { reason: 'requester cannot approve own request' });
      throw new PolicyError(403, 'the person who asked for this cannot also approve it');
    }
    return this.store.decideApproval(id, decision, name, this.opts.decisionToken ? 'human-token' : 'direct');
  }

  // ---------------------------------------------------------------- protected actions
  isProtectedBranch(defaultBranch: string, branch: string): boolean {
    const names = new Set([defaultBranch, 'main', 'master', ...(this.opts.protectedBranches ?? [])]);
    return names.has(branch) || (this.opts.protectedBranches ?? []).some((p) => p.endsWith('*') && branch.startsWith(p.slice(0, -1)));
  }

  /** Asks a person. The request is stored with exactly what would happen (`subject`), so an approval cannot be reused for something else. */
  request(action: ProtectedAction, i: { sessionId: string; subject: string; requestedBy: string; evidence?: Record<string, unknown>; risk?: string }): Approval {
    return this.store.requestApproval({ sessionId: i.sessionId, action, subject: i.subject, requestedBy: i.requestedBy, evidence: i.evidence ?? {},
      ttlMs: this.opts.approvalTtlMs, risk: i.risk ?? PROTECTED_ACTIONS[action].risk });
  }

  /** Spends an approval or throws. Nothing a caller says ("it was approved") matters: only this check does. */
  consume(approvalId: unknown, action: ProtectedAction, subject: string, by: string): Approval {
    const fail = (why: string, status = 403): never => { this.store.audit(by, 'policy.denied', String(approvalId ?? '-'), { action, subject, why }); throw new PolicyError(status, `${PROTECTED_ACTIONS[action].label} was refused: ${why}`); };
    if (typeof approvalId !== 'string' || !approvalId) return fail('no approval was given');
    const a = this.store.getApproval(approvalId);
    if (!a) return fail('that approval does not exist', 404);
    if (a.action !== action) return fail(`that approval is for "${a.action}", not "${action}"`);
    if (a.subject !== subject) return fail('that approval is for something else (a different branch, commit or task)');
    if (a.status === 'pending') return fail('it is still waiting for a person to decide');
    if (a.status === 'rejected') return fail('a person rejected it');
    if (a.consumedAt) return fail('it was already used once; ask for a new approval');
    if (a.expiresAt && a.expiresAt <= new Date().toISOString()) return fail('it has expired; ask for a new approval');
    if (!this.store.consumeApproval(approvalId, { action, subject, by })) return fail('it could not be used (another request used it first)');
    this.store.audit(by, 'policy.approval.used', approvalId, { action, subject, approver: a.approver });
    return this.store.getApproval(approvalId)!;
  }

  denied(action: string, subject: string, details: Record<string, unknown>) { this.store.audit('policy', action, subject, details); }
}
