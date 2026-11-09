export const WORK_STATES = ['queued', 'running', 'paused', 'blocked', 'failed', 'completed', 'cancelled'] as const;
export type WorkState = (typeof WORK_STATES)[number];

// One table for Session, Task and AgentRun. completed/cancelled are terminal.
// failed -> queued is the only way back (an explicit, recorded retry).
const WORK: Record<WorkState, readonly WorkState[]> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'blocked', 'failed', 'completed', 'cancelled'],
  paused: ['running', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  failed: ['queued'],
  completed: [],
  cancelled: [],
};

export const APPROVAL_STATES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
const APPROVAL: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export class InvalidTransitionError extends Error {
  entity: string; from: string; to: string;
  constructor(entity: string, from: string, to: string) {
    super(`${entity}: invalid transition ${from} -> ${to}`);
    this.entity = entity; this.from = from; this.to = to;
  }
}

export const canTransition = (from: WorkState, to: WorkState) => WORK[from].includes(to);
export const isTerminal = (s: WorkState) => WORK[s].length === 0;

export function assertWorkTransition(entity: string, from: WorkState, to: WorkState) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(entity, from, to);
}
export function assertApprovalTransition(from: ApprovalState, to: ApprovalState) {
  if (!APPROVAL[from].includes(to)) throw new InvalidTransitionError('approval', from, to);
}
