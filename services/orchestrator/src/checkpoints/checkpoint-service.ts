import { existsSync } from 'node:fs';
import type { Checkpoint } from '../domain/types.ts';
import type { Store } from '../storage/store.ts';
import { snapshot, type GitSnapshot } from './git.ts';

// Portable resume state. Everything a fresh worker needs to continue without the original
// conversation. Fields marked "(later)" are placeholders for features that arrive in later phases.
export interface CheckpointData {
  version: 1;
  reason: string;
  cwd: string;
  taskId: string | null;
  runId: string | null;
  cliSessionId: string | null;
  request: { description: string; acceptanceCriteria: string[] } | null;
  steps: { taskId: string; description: string; status: string }[];   // current plan = the session's tasks
  lastRuntimeStatus: string | null;
  lastEventSeq: number;
  lastAgentMessage: string | null;
  changedFiles: string[];
  untracked: string[];
  diffArtifactId: string | null;
  diffTruncated: boolean;
  fingerprint: string;
  git: { available: boolean; branch?: string; revision?: string };
  notes: string[];       // decisions / rejected approaches / open questions (later: written by agents)
  checks: unknown[];     // build/test outcomes (later: Phase 9)
}

export interface Drift {
  level: 'unchanged' | 'changed' | 'blocked';
  notes: string[];
  added: string[];       // files that changed since the checkpoint
  removed: string[];     // files that were changed at the checkpoint but are clean now
}

export class CheckpointService {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** Working directory of a session: its worktree if it has one, otherwise the project repository. */
  workdirFor(sessionId: string): string {
    const s = this.store.getSession(sessionId); if (!s) throw new Error(`session not found: ${sessionId}`);
    return s.worktreePath ?? this.store.getProject(s.projectId)!.repoPath;
  }

  capture(i: { sessionId: string; reason: string; nextAction: string; cwd?: string; taskId?: string; runId?: string }): Checkpoint {
    const cwd = i.cwd ?? this.workdirFor(i.sessionId);
    const snap: GitSnapshot = snapshot(cwd);
    const tasks = this.store.listTasks(i.sessionId);
    const runId = i.runId ?? this.store.latestRunIdForSession(i.sessionId);
    const run = runId ? this.store.getRun(runId) : undefined;
    const task = (i.taskId ? this.store.getTask(i.taskId) : run ? this.store.getTask(run.taskId) : undefined) ?? tasks.at(-1);
    const events = this.store.listEvents(i.sessionId);
    const lastMsg = [...events].reverse().find((e) => e.type === 'agent.message' && String(e.payload.text ?? '').trim());

    let diffArtifactId: string | null = null;
    if (snap.diff) diffArtifactId = this.store.addArtifact({ sessionId: i.sessionId, runId: runId ?? undefined, kind: 'diff', content: snap.diff }).id;

    const data: CheckpointData = {
      version: 1, reason: i.reason, cwd, taskId: task?.id ?? null, runId: runId ?? null, cliSessionId: run?.cliSessionId ?? null,
      request: task ? { description: task.description, acceptanceCriteria: task.acceptanceCriteria } : null,
      steps: tasks.map((t) => ({ taskId: t.id, description: t.description, status: t.status })),
      lastRuntimeStatus: run?.status ?? null, lastEventSeq: events.at(-1)?.seq ?? 0,
      lastAgentMessage: lastMsg ? String(lastMsg.payload.text).slice(0, 1000) : null,
      changedFiles: snap.changedFiles, untracked: snap.untracked, diffArtifactId, diffTruncated: snap.diffTruncated,
      fingerprint: snap.fingerprint, git: { available: snap.available, branch: snap.branch, revision: snap.revision },
      notes: [], checks: [],
    };
    return this.store.saveCheckpoint({
      sessionId: i.sessionId, nextAction: i.nextAction,
      gitState: { branch: snap.branch, revision: snap.revision, status: snap.status },
      data: data as unknown as Record<string, unknown>,
    });
  }

  latest(sessionId: string): (Checkpoint & { data: CheckpointData }) | undefined {
    return this.store.latestCheckpoint(sessionId) as (Checkpoint & { data: CheckpointData }) | undefined;
  }

  /**
   * Compares the working directory with a checkpoint. Read-only.
   *   blocked   -> resuming would be unsafe (directory gone, no longer a repo, different branch)
   *   changed   -> files changed since the checkpoint; the worker is told and must inspect first
   *   unchanged -> identical
   */
  verify(cp: { data: CheckpointData }): Drift {
    const d = cp.data;
    if (!existsSync(d.cwd)) return { level: 'blocked', notes: [`working directory no longer exists: ${d.cwd}`], added: [], removed: [] };
    const now = snapshot(d.cwd);
    if (d.git.available && !now.available) return { level: 'blocked', notes: ['working directory is no longer a git repository'], added: [], removed: [] };
    if (!d.git.available) return { level: 'unchanged', notes: ['checkpoint was taken outside a git repository; nothing to compare'], added: [], removed: [] };
    if (d.git.branch && now.branch !== d.git.branch)
      return { level: 'blocked', notes: [`branch changed from "${d.git.branch}" to "${now.branch}" since the checkpoint`], added: [], removed: [] };
    if (now.fingerprint === d.fingerprint) return { level: 'unchanged', notes: [], added: [], removed: [] };

    const before = new Set(d.changedFiles), after = new Set(now.changedFiles);
    const added = [...after].filter((f) => !before.has(f)), removed = [...before].filter((f) => !after.has(f));
    const notes: string[] = [];
    if (d.git.revision && now.revision !== d.git.revision) notes.push(`HEAD moved from ${d.git.revision.slice(0, 8)} to ${now.revision?.slice(0, 8)} (new commits)`);
    if (added.length) notes.push(`changed since checkpoint: ${added.join(', ')}`);
    if (removed.length) notes.push(`no longer changed (committed or reverted): ${removed.join(', ')}`);
    if (!added.length && !removed.length) notes.push('file contents changed since the checkpoint');
    return { level: 'changed', notes, added, removed };
  }
}

/** The instructions a fresh worker receives. Deliberately omits the diff: the worker reads the live one itself. */
export function buildResumePrompt(cp: { nextAction: string; data: CheckpointData }, drift: Drift, memoryBlock = ''): string {
  const d = cp.data;
  const lines = [
    'You are RESUMING a task that was interrupted. You have no memory of earlier work; the repository is the source of truth.',
    '',
    `ORIGINAL TASK: ${d.request?.description ?? '(unknown)'}`,
    ...(d.request?.acceptanceCriteria.length ? ['ACCEPTANCE CRITERIA:', ...d.request.acceptanceCriteria.map((c) => `- ${c}`)] : []),
    '',
    `NEXT ACTION (from the checkpoint): ${cp.nextAction}`,
    ...(d.lastAgentMessage ? [`LAST THING THE PREVIOUS WORKER SAID: ${d.lastAgentMessage}`] : []),
    `WHY IT STOPPED: ${d.reason}`,
    '',
    d.changedFiles.length ? `FILES CHANGED SO FAR (may include unfinished work): ${d.changedFiles.join(', ')}` : 'No files were changed before the interruption.',
    ...(drift.level === 'changed' ? ['', 'WARNING: the repository differs from the checkpoint:', ...drift.notes.map((n) => `- ${n}`)] : []),
    ...(memoryBlock ? ['', memoryBlock] : []),
    '',
    'RULES:',
    '1. First inspect the real current state: read the changed files and check what exists. Do not assume the checkpoint is complete or correct.',
    '2. Do NOT delete, reset, revert or overwrite existing changes, including uncommitted ones. Build on them.',
    '3. Do only the remaining work for the task above, then reply DONE.',
  ];
  return lines.join('\n');
}
