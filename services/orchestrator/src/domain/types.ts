import type { WorkState, ApprovalState } from './states.ts';

export interface Project {
  id: string; name: string; repoPath: string; defaultBranch: string;
  settings: Record<string, unknown>; memoryRefs: string[]; createdAt: string;
}
export interface Session {
  id: string; projectId: string; title: string; status: WorkState;
  worktreePath: string | null; checkpointId: string | null; createdAt: string; updatedAt: string;
}
export interface Task {
  id: string; sessionId: string; description: string; acceptanceCriteria: string[];
  dependsOn: string[]; priority: number; status: WorkState; createdAt: string; updatedAt: string;
}
export interface AgentRun {
  id: string; taskId: string; role: string; provider: string; model: string;
  pid: number | null; cliSessionId: string | null; status: WorkState;
  exitCode: number | null; terminationReason: string | null; startedAt: string | null; endedAt: string | null;
  idempotencyKey: string | null; accountId?: string | null;
}
export interface WorktreeLock { path: string; sessionId: string; runId: string; acquiredAt: string }
export interface DomainEvent {
  id: string; sessionId: string; seq: number; type: string; runId: string | null;
  payload: Record<string, unknown>; createdAt: string;
}
export interface Checkpoint {
  id: string; sessionId: string; seq: number; nextAction: string;
  gitState: { branch?: string; revision?: string; status?: string };
  data: Record<string, unknown>; createdAt: string;
}
export interface Artifact {
  id: string; sessionId: string; runId: string | null; kind: 'diff' | 'log' | 'test-report' | 'spec' | 'other';
  path: string | null; content: string | null; createdAt: string;
}
export interface RoutingDecision {
  id: string; runId: string; provider: string; model: string; policyVersion: string; reason: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; source: 'reported' | 'estimated' | 'unavailable' };
  inputs?: Record<string, unknown>;
  createdAt: string;
}
export interface Approval {
  id: string; sessionId: string; action: string; evidence: Record<string, unknown>;
  status: ApprovalState; approver: string | null; decidedAt: string | null; createdAt: string;
}
export interface Worktree {
  id: string; projectId: string; sessionId: string; path: string; branch: string;
  baseBranch: string; baseRevision: string; status: 'active' | 'removed'; createdAt: string; removedAt: string | null;
}
export interface MemoryEntry {
  id: string; scope: 'project' | 'session'; projectId: string; sessionId: string | null;
  category: string; content: string; authorRole: string; trust: 'user' | 'agent';
  source: { kind: string; ref: string | null };
  status: 'active' | 'superseded' | 'archived'; supersededBy: string | null; seenCount: number;
  createdAt: string; updatedAt: string;
}
export interface KnowledgeNode { id: string; projectId: string; kind: string; name: string; provenance: string; verified: boolean }
export interface KnowledgeEdge { id: string; fromId: string; toId: string; kind: string; provenance: string; verified: boolean }

// ---- Phase 7: usage. Cost is only ever 'reported' (the provider said so), 'estimated' (policy estimate for a
// run that ended without a report) or 'reserved' (a run still in flight, counted at its estimate).
export interface UsageRecord {
  runId: string; sessionId: string; taskId: string; projectId: string; provider: string; model: string;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null; source: 'reported'; createdAt: string;
}
export interface RunCostRow {
  runId: string; taskId: string; sessionId: string; projectId: string; provider: string; model: string; role: string;
  status: WorkState; startedAt: string; costUsd: number | null; inputTokens: number | null; outputTokens: number | null; reported: boolean;
}
export interface PolicyVersion { version: number; config: unknown; note: string | null; createdBy: string; createdAt: string }

// ---- Phase 8: providers, health, queue, handoff, audit
export interface ProviderAccount {
  id: string; provider: string; label: string; configDir: string | null; credentialRef: string | null;
  priority: number; enabled: boolean; lastUsedAt: string | null; createdAt: string;
}
export interface ProviderHealth {
  provider: string; accountId: string; limitedUntil: string | null; lastError: string | null;
  consecutiveFailures: number; lastOutcome: string | null; updatedAt: string;
}
export interface QueueItem {
  id: string; taskId: string; sessionId: string; request: Record<string, unknown>;
  status: 'queued' | 'started' | 'cancelled' | 'abandoned'; reason: string; attempts: number; runId: string | null;
  createdAt: string; updatedAt: string;
}
export interface HandoffRecord {
  id: string; sessionId: string; fromRunId: string | null; fromProvider: string | null; fromAccountId: string | null;
  toProvider: string; toAccountId: string | null; toModel: string; toRunId: string | null;
  checkpointId: string | null; driftLevel: string | null; fingerprint: string | null;
  status: 'started' | 'queued' | 'refused'; reason: string; notes: string[]; actor: string; createdAt: string;
}
export interface AuditEntry { id: number; at: string; actor: string; action: string; subject: string; details: Record<string, unknown> }
