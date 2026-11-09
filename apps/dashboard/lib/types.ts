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
export interface Drift { level: 'unchanged' | 'changed' | 'blocked'; notes: string[]; added: string[]; removed: string[] }
export interface Changes {
  available: boolean; branch: string | null; revision: string | null; status: string;
  files: { path: string; untracked: boolean }[]; diff: string; diffTruncated: boolean; computedAt: string;
  checkpoint: { id: string; seq: number; createdAt: string; matchesNow: boolean } | null;
}
