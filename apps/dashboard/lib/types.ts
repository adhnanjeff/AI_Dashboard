// Shapes returned by the orchestrator API (see services/orchestrator/src/api/server.ts).
export type WorkState = 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'completed' | 'cancelled';

export interface Project { id: string; name: string; repoPath: string; defaultBranch: string }
export interface Session { id: string; projectId: string; title: string; status: WorkState; worktreePath: string | null; checkpointId: string | null; createdAt: string; updatedAt: string }
export interface Task { id: string; sessionId: string; description: string; acceptanceCriteria: string[]; status: WorkState }
export interface Run {
  id: string; taskId: string; role: string; provider: string; model: string; pid: number | null; cliSessionId: string | null;
  status: WorkState; exitCode: number | null; terminationReason: string | null; startedAt: string | null; endedAt: string | null;
}
export interface RunDetail extends Run {
  active: boolean; sessionId: string;
  usage: { costUsd?: number; source: 'reported' | 'unavailable' };
  cost?: RunCost; tokens?: { input: number | null; output: number | null } | null; routing?: RoutingInfo[];
  artifacts: { id: string; kind: string; createdAt: string; bytes: number }[];
}
export interface SessionSummary {
  session: Session; project: { id: string; name: string };
  latestRun: { id: string; status: WorkState; model: string; startedAt: string | null; endedAt: string | null } | null;
  taskCount: number;
}
export interface SessionDetail { session: Session; tasks: Task[]; checkpoint: Checkpoint | null }
export interface DomainEvent { id: string; sessionId: string; seq: number; type: string; runId: string | null; payload: Record<string, any>; createdAt: string }
export interface Checkpoint { id: string; seq: number; nextAction: string; createdAt: string; data: { reason: string; changedFiles: string[]; lastEventSeq: number; lastAgentMessage: string | null } }
export interface MemoryEntry {
  id: string; scope: 'project' | 'session'; projectId: string; sessionId: string | null; category: string; content: string;
  authorRole: string; trust: 'user' | 'agent'; source: { kind: string; ref: string | null };
  status: 'active' | 'superseded' | 'archived'; supersededBy: string | null; seenCount: number; createdAt: string; updatedAt: string;
}
export interface WorktreeRec { id: string; projectId: string; sessionId: string; path: string; branch: string; baseBranch: string; baseRevision: string; status: 'active' | 'removed'; createdAt: string }
export interface WorktreeStatus {
  worktree: WorktreeRec; exists: boolean; currentBranch: string | null; head: string | null; ahead: number; behind: number;
  uncommitted: string[]; committed: string[]; touched: string[]; numstat: { path: string; added: number | null; deleted: number | null }[]; busyRunId: string | null;
}
export interface MergeCheck { target: string; branch: string; clean: boolean; conflicts: string[]; ahead: number; behind: number; uncommittedNotIncluded: string[]; note: string | null; error?: string }
export interface RemovalPreview { canRemove: boolean; blockers: string[]; willRemoveDirectory: string; branchKept: string; unmergedCommits: number; note: string }
export interface WorktreeOverview {
  project: { id: string; name: string; defaultBranch: string };
  worktrees: WorktreeStatus[];
  overlaps: { a: string; b: string; sessionA: string; sessionB: string; files: string[] }[];
  integration: { target: string; integrationBranch: string; order: { sessionId: string; branch: string; clean: boolean; conflicts: string[]; uncommitted: number }[];
    pairConflicts: { a: string; b: string; conflicts: string[] }[]; commands: string[]; note: string };
}
export interface Handoff { generatedAt: string; markdown: string; facts: Record<string, unknown> }
export interface Drift { level: 'unchanged' | 'changed' | 'blocked'; notes: string[]; added: string[]; removed: string[] }
export interface Changes {
  available: boolean; branch: string | null; revision: string | null; status: string;
  files: { path: string; untracked: boolean }[]; diff: string; diffTruncated: boolean; computedAt: string;
  checkpoint: { id: string; seq: number; createdAt: string; matchesNow: boolean } | null;
}

// ---- Phase 7: routing, usage, budgets
export interface RoutingInfo { id: string; provider: string; model: string; policyVersion: string; reason: string; createdAt: string; inputs: Record<string, any> }
export interface RunCost { usd: number; source: 'reported' | 'estimated' | 'reserved'; note?: string }
export interface BudgetToday {
  policyVersion: number; since: string; limitUsd: number; perTaskLimitUsd: number; totalUsd: number; remainingUsd: number;
  bySource: { reported: number; estimated: number; reserved: number };
}
export interface ModelUsage { model: string; tier: string | null; runs: number; completed: number; failed: number; cancelled: number; running: number; costUsd: number; reportedRuns: number; estimatedRuns: number; successRate: number | null; costPerCompletedRun: number | null }
export interface UsageSummary {
  days: number; since: string; policyVersion: number; runs: number; totalUsd: number; bySource: { reported: number; estimated: number; reserved: number };
  tokens: { input: number; output: number; note: string };
  byModel: ModelUsage[];
  acceptedTasks: { count: number; costUsd: number; costPerAcceptedTask: number | null; tasksWithRuns: number };
  escalation: { decisions: number; escalated: number; manualOverrides: number; escalatedCompleted: number; escalatedFailed: number; paths: { from: string; to: string; runs: number; completed: number; failed: number }[] };
}
export interface PolicyRule { id: string; tier: string; reason: string; types?: string[]; minComplexity?: string; maxComplexity?: string; minRisk?: string; maxRisk?: string }
export interface RoutingPolicy {
  models: Record<string, string>; rules: PolicyRule[]; defaultTier: string;
  escalation: { afterFailures: number; maxTier: string; maxAttemptsPerTask: number };
  budgets: { perTaskUsd: number; dailyUsd: number; estimateUsd: Record<string, number> };
  extractionFirst: { enabled: boolean; minDescriptionChars: number };
}
export interface PolicyResponse { version: number; policy: RoutingPolicy; versions: { version: number; note: string | null; createdBy: string; createdAt: string }[] }

// ---- Phase 8: providers, accounts, queue, handoff, audit
export interface ProviderCaps { displayName: string; models: string[]; supportsNativeResume: boolean; canEditFiles: boolean; credentialEnv?: string; configDirEnv?: string }
export interface ProviderAccount { id: string; provider: string; label: string; configDir: string | null; credentialRef: string | null; priority: number; enabled: boolean; lastUsedAt: string | null }
export interface ProviderView {
  provider: string; capabilities: ProviderCaps | null; mode: 'default-login' | 'registered-accounts';
  accounts: { account: ProviderAccount | null; health: { limitedUntil: string | null; lastError: string | null; consecutiveFailures: number; lastOutcome: string | null } | null; availability: { available: boolean; until?: string; reason?: string } }[];
}
export interface QueueItem { id: string; taskId: string; sessionId: string; status: 'queued' | 'started' | 'cancelled' | 'abandoned'; reason: string; attempts: number; runId: string | null; createdAt: string }
export interface HandoffRec { id: string; fromProvider: string | null; toProvider: string; toModel: string; toRunId: string | null; status: 'started' | 'queued' | 'refused'; reason: string; notes: string[]; driftLevel: string | null; actor: string; createdAt: string }
export interface AuditEntry { id: number; at: string; actor: string; action: string; subject: string; details: Record<string, unknown> }
export interface SessionRouting { runId: string; status: string; model: string; provider: string; decisions: RoutingInfo[] }
