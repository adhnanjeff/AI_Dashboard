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

// ---- Phase 9: workflows
export type StepStatus = 'pending' | 'running' | 'waiting_approval' | 'passed' | 'failed' | 'skipped' | 'cancelled';
export interface WorkflowSummary { id: string; projectId: string; title: string; goal: string; status: 'draft' | 'running' | 'completed' | 'failed' | 'cancelled'; haltedReason: string | null; createdAt: string; updatedAt: string; steps: number; passed: number; running: number; waiting: number }
export interface WorkflowStep {
  id: string; kind: string; title?: string; role?: string; needs: string[]; prompt?: string; command?: string[]; verifies?: string; reviews?: string; fixer?: string; maxAttempts: number;
  state: { status: StepStatus; attempts: number; sessionId: string | null; runId: string | null; approvalId: string | null; startedAt: string | null; endedAt: string | null; detail: Record<string, any> };
  run: { status: string; model: string; provider: string; reason: string | null; costUsd: number | null } | null;
}
export interface WorkflowDetail { workflow: WorkflowSummary & { definition: { concurrency: number }; createdBy: string }; steps: WorkflowStep[]; approvals: { step: string; id: string; action: string; status: 'pending' | 'approved' | 'rejected'; approver: string | null; decidedAt: string | null }[] }
export interface WorkflowTransition { id: number; stepKey: string | null; fromStatus: string | null; toStatus: string; reason: string; at: string }
export interface WorkflowEvidence { id: number; stepKey: string; attempt: number; kind: string; summary: string; createdAt: string; content?: string }

// ---- Phase 10: repository index and graph
export interface IndexStatus { indexed: boolean; stale: boolean; reason: string; indexedRevision: string | null; headRevision: string | null; indexedAt: string | null; extractor: string | null; files: number; symbols: number; edges: number; changed: string[]; added: string[]; removed: string[] }
export interface GraphNodeBrief { id: string; kind: string; name: string; path: string | null; line: number | null; symbolKind: string | null; verified: boolean; provenance: string }
export interface GraphEvidence { edgeId: string; kind: string; provenance: string; verified: boolean; path: string | null; line: number | null; evidence: string }
export interface GraphNodeDetail { node: GraphNodeBrief & { meta: Record<string, any>; sessionId: string | null }; out: (GraphEvidence & { other: GraphNodeBrief })[]; in: (GraphEvidence & { other: GraphNodeBrief })[]; source: { path: string; startLine: number; highlight: number; lines: string[]; changedSinceIndexed: boolean; missing?: boolean } | null }
export interface RelevantFile { path: string; score: number; isTest: boolean; reasons: { why: string; evidence?: GraphEvidence }[] }
export interface FileLinks { dependencies: (GraphNodeBrief & { depth: number; evidence: GraphEvidence })[]; dependents: (GraphNodeBrief & { depth: number; via: string; evidence: GraphEvidence })[]; tests: { test: GraphNodeBrief; covers: string[]; depth: number; evidence: GraphEvidence }[] }
export interface SessionGraph { session: { id: string; title: string }; nodes: (GraphNodeBrief & { role: string })[]; edges: (GraphEvidence & { from: string; to: string })[]; touched: string[]; touchedNotInIndex: string[]; staleness: IndexStatus; note: string | null }

// ---- Phase 11: Agent Factory
export type FactoryState = 'queued' | 'running' | 'paused' | 'blocked' | 'waiting_approval' | 'failed' | 'completed' | 'cancelled' | 'skipped';
export interface FactoryItem {
  key: string; source: 'session' | 'workflow'; label: string; station: string; state: FactoryState; rawStatus: string; kind: string; role: string | null;
  model: string | null; provider: string | null; attempt: number | null; sessionId: string | null; runId: string | null; workflowId: string | null; workflowTitle: string | null; stepKey: string | null;
  startedAt: string | null; endedAt: string | null; updatedAt: string | null; lastOutput: string | null; note: string | null; demo: boolean;
}
export interface FactoryActivity { at: string; source: 'event' | 'workflow'; type: string; text: string; sessionId: string | null; workflowId: string | null; stepKey: string | null }
export interface FactorySnapshot {
  generatedAt: string; stations: { id: string; label: string; blurb: string; counts: Record<string, number>; total: number }[];
  items: FactoryItem[]; activity: FactoryActivity[]; totals: { real: number; demo: number; active: number }; note: string;
}

// ---- Phase 12: approvals, permissions, protected actions
export type ApprovalViewState = 'pending' | 'approved' | 'rejected' | 'used' | 'expired';
export interface ApprovalRisk { level: 'high' | 'medium' | 'info'; text: string }
export interface ApprovalView {
  id: string; sessionId: string; action: string; actionLabel: string | null; sessionTitle: string | null; projectId: string | null;
  evidence: Record<string, any>; status: 'pending' | 'approved' | 'rejected'; state: ApprovalViewState; approver: string | null; decidedAt: string | null; createdAt: string;
  subject: string | null; requestedBy: string | null; expiresAt: string | null; consumedAt: string | null; consumedBy: string | null; decidedVia: string | null; risk: string | null;
}
export interface PolicyInfo {
  profiles: { id: string; label: string; description: string; grants: string[]; elevated: boolean; allowedTools: string[]; disallowedTools: string[] }[];
  roleDefaults: Record<string, string>; protectedActions: Record<string, { label: string; risk: string }>;
  decisionTokenRequired: boolean; separationOfDuties: boolean; approvalTtlMs: number; ciConfigured: boolean;
}
