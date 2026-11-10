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
