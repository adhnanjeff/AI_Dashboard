import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../domain/ids.ts';
import { redact, redactString } from '../domain/redact.ts';
import { assertApprovalTransition, assertWorkTransition, type ApprovalState, type WorkState } from '../domain/states.ts';
import type * as T from '../domain/types.ts';

const now = () => new Date().toISOString();
const j = (v: unknown) => JSON.stringify(v);
const p = <X>(s: string): X => JSON.parse(s);

// The only writer to the database. Every status change goes through here, so the state
// machine and the audit trail (events) cannot be bypassed.
export class Store {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  // Live subscribers (the SSE endpoint). Events are announced only AFTER the transaction that wrote
  // them commits, so a rolled-back change is never shown to a viewer.
  private listeners = new Set<(e: T.DomainEvent) => void>();
  private pending: T.DomainEvent[] | null = null;
  subscribe(fn: (e: T.DomainEvent) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private announce(e: T.DomainEvent) { for (const l of this.listeners) { try { l(e); } catch { /* a broken subscriber must not break writes */ } } }

  private tx<R>(fn: () => R): R {
    this.db.exec('BEGIN IMMEDIATE');
    this.pending = [];
    try {
      const r = fn(); this.db.exec('COMMIT');
      const out = this.pending; this.pending = null; out.forEach((e) => this.announce(e));
      return r;
    } catch (e) { this.pending = null; this.db.exec('ROLLBACK'); throw e; }
  }
  private one<R>(sql: string, ...a: any[]): R | undefined { return this.db.prepare(sql).get(...a) as R | undefined; }
  private all<R>(sql: string, ...a: any[]): R[] { return this.db.prepare(sql).all(...a) as R[]; }

  // ---- projects
  createProject(i: { name: string; repoPath: string; defaultBranch?: string; settings?: object; memoryRefs?: string[] }): T.Project {
    const id = newId('prj'), createdAt = now();
    this.db.prepare('INSERT INTO project VALUES (?,?,?,?,?,?,?)')
      .run(id, i.name, i.repoPath, i.defaultBranch ?? 'main', j(i.settings ?? {}), j(i.memoryRefs ?? []), createdAt);
    return this.getProject(id)!;
  }
  getProject(id: string): T.Project | undefined {
    const r = this.one<any>('SELECT * FROM project WHERE id=?', id);
    return r && { id: r.id, name: r.name, repoPath: r.repo_path, defaultBranch: r.default_branch,
      settings: p(r.settings), memoryRefs: p(r.memory_refs), createdAt: r.created_at };
  }
  listProjects() { return this.all<any>('SELECT id FROM project ORDER BY created_at').map((r) => this.getProject(r.id)!); }

  // ---- sessions
  createSession(i: { projectId: string; title: string }): T.Session {
    return this.tx(() => {
      const id = newId('ses'), t = now();
      this.db.prepare("INSERT INTO session (id,project_id,title,status,created_at,updated_at) VALUES (?,?,?, 'queued',?,?)")
        .run(id, i.projectId, i.title, t, t);
      this.appendEvent({ sessionId: id, type: 'session.created', payload: { title: i.title } });
      return this.getSession(id)!;
    });
  }
  getSession(id: string): T.Session | undefined {
    const r = this.one<any>('SELECT * FROM session WHERE id=?', id);
    return r && { id: r.id, projectId: r.project_id, title: r.title, status: r.status, worktreePath: r.worktree_path,
      checkpointId: r.checkpoint_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  listSessions(projectId?: string): T.Session[] {
    const rows = projectId
      ? this.all<any>('SELECT id FROM session WHERE project_id=? ORDER BY created_at', projectId)
      : this.all<any>('SELECT id FROM session ORDER BY created_at');
    return rows.map((r) => this.getSession(r.id)!);
  }
  setWorktree(sessionId: string, path: string | null) {
    this.db.prepare('UPDATE session SET worktree_path=?, updated_at=? WHERE id=?').run(path, now(), sessionId);
  }
  transitionSession(id: string, to: WorkState, reason?: string): T.Session {
    return this.tx(() => {
      const s = this.getSession(id); if (!s) throw new Error(`session not found: ${id}`);
      assertWorkTransition('session', s.status, to);
      this.db.prepare('UPDATE session SET status=?, updated_at=? WHERE id=?').run(to, now(), id);
      this.appendEvent({ sessionId: id, type: 'session.status', payload: { from: s.status, to, reason } });
      return this.getSession(id)!;
    });
  }

  // ---- tasks
  createTask(i: { sessionId: string; description: string; acceptanceCriteria?: string[]; dependsOn?: string[]; priority?: number }): T.Task {
    return this.tx(() => {
      const id = newId('tsk'), t = now();
      this.db.prepare("INSERT INTO task VALUES (?,?,?,?,?,?, 'queued',?,?)")
        .run(id, i.sessionId, redactString(i.description), j(i.acceptanceCriteria ?? []), j(i.dependsOn ?? []), i.priority ?? 0, t, t);
      this.appendEvent({ sessionId: i.sessionId, type: 'task.created', payload: { taskId: id } });
      return this.getTask(id)!;
    });
  }
  getTask(id: string): T.Task | undefined {
    const r = this.one<any>('SELECT * FROM task WHERE id=?', id);
    return r && { id: r.id, sessionId: r.session_id, description: r.description, acceptanceCriteria: p(r.acceptance_criteria),
      dependsOn: p(r.depends_on), priority: r.priority, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  listTasks(sessionId: string) { return this.all<any>('SELECT id FROM task WHERE session_id=? ORDER BY created_at', sessionId).map((r) => this.getTask(r.id)!); }
  transitionTask(id: string, to: WorkState, reason?: string): T.Task {
    return this.tx(() => {
      const tk = this.getTask(id); if (!tk) throw new Error(`task not found: ${id}`);
      assertWorkTransition('task', tk.status, to);
      this.db.prepare('UPDATE task SET status=?, updated_at=? WHERE id=?').run(to, now(), id);
      this.appendEvent({ sessionId: tk.sessionId, type: 'task.status', payload: { taskId: id, from: tk.status, to, reason } });
      return this.getTask(id)!;
    });
  }

  // ---- agent runs
  createRun(i: { taskId: string; role: string; provider: string; model: string; idempotencyKey?: string }): T.AgentRun {
    return this.tx(() => {
      const id = newId('run'), tk = this.getTask(i.taskId); if (!tk) throw new Error(`task not found: ${i.taskId}`);
      this.db.prepare("INSERT INTO agent_run (id,task_id,role,provider,model,status,idempotency_key) VALUES (?,?,?,?,?, 'queued', ?)")
        .run(id, i.taskId, i.role, i.provider, i.model, i.idempotencyKey ?? null);
      this.appendEvent({ sessionId: tk.sessionId, runId: id, type: 'run.created', payload: { role: i.role, model: i.model } });
      return this.getRun(id)!;
    });
  }
  getRun(id: string): T.AgentRun | undefined {
    const r = this.one<any>('SELECT * FROM agent_run WHERE id=?', id);
    return r && { id: r.id, taskId: r.task_id, role: r.role, provider: r.provider, model: r.model, pid: r.pid,
      cliSessionId: r.cli_session_id, status: r.status, exitCode: r.exit_code, terminationReason: r.termination_reason,
      startedAt: r.started_at, endedAt: r.ended_at, idempotencyKey: r.idempotency_key };
  }
  listRunsForSession(sessionId: string): T.AgentRun[] {
    return this.all<{ id: string }>('SELECT r.id FROM agent_run r JOIN task t ON t.id=r.task_id WHERE t.session_id=? ORDER BY r.rowid', sessionId)
      .map((r) => this.getRun(r.id)!);
  }
  latestRunIdForSession(sessionId: string): string | undefined {
    return this.one<{ id: string }>('SELECT r.id FROM agent_run r JOIN task t ON t.id=r.task_id WHERE t.session_id=? ORDER BY r.rowid DESC LIMIT 1', sessionId)?.id;
  }
  getRunByKey(key: string): T.AgentRun | undefined {
    const r = this.one<{ id: string }>('SELECT id FROM agent_run WHERE idempotency_key=?', key);
    return r && this.getRun(r.id);
  }

  // ---- worktree locks (one writer per working directory)
  getWorktreeLock(path: string): T.WorktreeLock | undefined {
    const r = this.one<any>('SELECT * FROM worktree_lock WHERE path=?', path);
    return r && { path: r.path, sessionId: r.session_id, runId: r.run_id, acquiredAt: r.acquired_at };
  }
  /** Returns the current holder if the path is already locked, otherwise takes the lock and returns undefined. */
  acquireWorktreeLock(path: string, sessionId: string, runId: string): T.WorktreeLock | undefined {
    try {
      this.db.prepare('INSERT INTO worktree_lock VALUES (?,?,?,?)').run(path, sessionId, runId, now());
      this.appendEvent({ sessionId, runId, type: 'worktree.locked', payload: { path } });
      return undefined;
    } catch (e: any) {
      const holder = this.getWorktreeLock(path);
      if (holder) return holder;
      throw e;
    }
  }
  releaseWorktreeLocksForRun(runId: string) {
    const held = this.all<any>('SELECT * FROM worktree_lock WHERE run_id=?', runId);
    this.db.prepare('DELETE FROM worktree_lock WHERE run_id=?').run(runId);
    for (const h of held) this.appendEvent({ sessionId: h.session_id, runId, type: 'worktree.unlocked', payload: { path: h.path } });
  }
  listWorktreeLocks(): T.WorktreeLock[] {
    return this.all<any>('SELECT * FROM worktree_lock ORDER BY acquired_at')
      .map((r) => ({ path: r.path, sessionId: r.session_id, runId: r.run_id, acquiredAt: r.acquired_at }));
  }
  listRuns(status?: WorkState): T.AgentRun[] {
    const rows = status ? this.all<any>('SELECT id FROM agent_run WHERE status=?', status) : this.all<any>('SELECT id FROM agent_run');
    return rows.map((r) => this.getRun(r.id)!);
  }
  transitionRun(id: string, to: WorkState, info: { pid?: number; cliSessionId?: string; exitCode?: number; reason?: string } = {}): T.AgentRun {
    return this.tx(() => {
      const r = this.getRun(id); if (!r) throw new Error(`run not found: ${id}`);
      assertWorkTransition('run', r.status, to);
      const t = now(), terminal = ['failed', 'completed', 'cancelled'].includes(to) ? 1 : 0;
      this.db.prepare(`UPDATE agent_run SET status=?, pid=COALESCE(?,pid), cli_session_id=COALESCE(?,cli_session_id),
        exit_code=COALESCE(?,exit_code), termination_reason=COALESCE(?,termination_reason),
        started_at=CASE WHEN ?='running' AND started_at IS NULL THEN ? ELSE started_at END,
        ended_at=CASE WHEN ?=1 THEN ? ELSE ended_at END WHERE id=?`)
        .run(to, info.pid ?? null, info.cliSessionId ?? null, info.exitCode ?? null, info.reason ?? null, to, t, terminal, t, id);
      const tk = this.getTask(r.taskId)!;
      this.appendEvent({ sessionId: tk.sessionId, runId: id, type: 'run.status', payload: { from: r.status, to, ...info } });
      return this.getRun(id)!;
    });
  }

  // ---- events (append-only, per-session sequence)
  appendEvent(i: { sessionId: string; type: string; runId?: string; payload?: Record<string, unknown> }): T.DomainEvent {
    const row = this.one<{ m: number | null }>('SELECT MAX(seq) AS m FROM event WHERE session_id=?', i.sessionId);
    const seq = (row?.m ?? 0) + 1, id = newId('evt'), t = now(), payload = redact(i.payload ?? {});
    this.db.prepare('INSERT INTO event VALUES (?,?,?,?,?,?,?)').run(id, i.sessionId, seq, i.type, i.runId ?? null, j(payload), t);
    const ev: T.DomainEvent = { id, sessionId: i.sessionId, seq, type: i.type, runId: i.runId ?? null, payload, createdAt: t };
    if (this.pending) this.pending.push(ev); else this.announce(ev);
    return ev;
  }
  listEvents(sessionId: string, afterSeq = 0): T.DomainEvent[] {
    return this.all<any>('SELECT * FROM event WHERE session_id=? AND seq>? ORDER BY seq', sessionId, afterSeq)
      .map((r) => ({ id: r.id, sessionId: r.session_id, seq: r.seq, type: r.type, runId: r.run_id, payload: p(r.payload), createdAt: r.created_at }));
  }

  // ---- checkpoints
  saveCheckpoint(i: { sessionId: string; nextAction: string; gitState?: T.Checkpoint['gitState']; data?: Record<string, unknown> }): T.Checkpoint {
    return this.tx(() => {
      const row = this.one<{ m: number | null }>('SELECT MAX(seq) AS m FROM checkpoint WHERE session_id=?', i.sessionId);
      const seq = (row?.m ?? 0) + 1, id = newId('chk');
      this.db.prepare('INSERT INTO checkpoint VALUES (?,?,?,?,?,?,?)')
        .run(id, i.sessionId, seq, redactString(i.nextAction), j(redact(i.gitState ?? {})), j(redact(i.data ?? {})), now());
      this.db.prepare('UPDATE session SET checkpoint_id=?, updated_at=? WHERE id=?').run(id, now(), i.sessionId);
      this.appendEvent({ sessionId: i.sessionId, type: 'checkpoint.saved', payload: { checkpointId: id, seq } });
      return this.latestCheckpoint(i.sessionId)!;
    });
  }
  listCheckpoints(sessionId: string): T.Checkpoint[] {
    return this.all<any>('SELECT * FROM checkpoint WHERE session_id=? ORDER BY seq', sessionId).map((r) => ({
      id: r.id, sessionId: r.session_id, seq: r.seq, nextAction: r.next_action, gitState: p(r.git_state), data: p(r.data), createdAt: r.created_at }));
  }
  latestCheckpoint(sessionId: string): T.Checkpoint | undefined {
    const r = this.one<any>('SELECT * FROM checkpoint WHERE session_id=? ORDER BY seq DESC LIMIT 1', sessionId);
    return r && { id: r.id, sessionId: r.session_id, seq: r.seq, nextAction: r.next_action,
      gitState: p(r.git_state), data: p(r.data), createdAt: r.created_at };
  }

  // ---- artifacts
  addArtifact(i: { sessionId: string; runId?: string; kind: T.Artifact['kind']; path?: string; content?: string }): T.Artifact {
    const id = newId('art'), t = now(), content = i.content == null ? null : redactString(i.content);
    this.db.prepare('INSERT INTO artifact VALUES (?,?,?,?,?,?,?)').run(id, i.sessionId, i.runId ?? null, i.kind, i.path ?? null, content, t);
    return { id, sessionId: i.sessionId, runId: i.runId ?? null, kind: i.kind, path: i.path ?? null, content, createdAt: t };
  }
  listArtifacts(sessionId: string): T.Artifact[] {
    return this.all<any>('SELECT * FROM artifact WHERE session_id=? ORDER BY created_at', sessionId)
      .map((r) => ({ id: r.id, sessionId: r.session_id, runId: r.run_id, kind: r.kind, path: r.path, content: r.content, createdAt: r.created_at }));
  }

  // ---- routing decisions
  recordRouting(i: Omit<T.RoutingDecision, 'id' | 'createdAt'>): T.RoutingDecision {
    const id = newId('rte'), t = now();
    this.db.prepare('INSERT INTO routing_decision VALUES (?,?,?,?,?,?,?,?)')
      .run(id, i.runId, i.provider, i.model, i.policyVersion, i.reason, j(i.usage), t);
    return { ...i, id, createdAt: t };
  }
  listRouting(runId: string): T.RoutingDecision[] {
    return this.all<any>('SELECT * FROM routing_decision WHERE run_id=? ORDER BY created_at', runId).map((r) => ({
      id: r.id, runId: r.run_id, provider: r.provider, model: r.model, policyVersion: r.policy_version,
      reason: r.reason, usage: p(r.usage), createdAt: r.created_at }));
  }

  // ---- approvals
  requestApproval(i: { sessionId: string; action: string; evidence?: Record<string, unknown> }): T.Approval {
    return this.tx(() => {
      const id = newId('apr');
      this.db.prepare("INSERT INTO approval VALUES (?,?,?,?, 'pending', NULL, NULL, ?)")
        .run(id, i.sessionId, i.action, j(redact(i.evidence ?? {})), now());
      this.appendEvent({ sessionId: i.sessionId, type: 'approval.requested', payload: { approvalId: id, action: i.action } });
      return this.getApproval(id)!;
    });
  }
  getApproval(id: string): T.Approval | undefined {
    const r = this.one<any>('SELECT * FROM approval WHERE id=?', id);
    return r && { id: r.id, sessionId: r.session_id, action: r.action, evidence: p(r.evidence), status: r.status,
      approver: r.approver, decidedAt: r.decided_at, createdAt: r.created_at };
  }
  decideApproval(id: string, to: Exclude<ApprovalState, 'pending'>, approver: string): T.Approval {
    return this.tx(() => {
      const a = this.getApproval(id); if (!a) throw new Error(`approval not found: ${id}`);
      if (!approver.trim()) throw new Error('approver identity is required');
      assertApprovalTransition(a.status, to);
      this.db.prepare('UPDATE approval SET status=?, approver=?, decided_at=? WHERE id=?').run(to, approver, now(), id);
      this.appendEvent({ sessionId: a.sessionId, type: 'approval.decided', payload: { approvalId: id, status: to, approver } });
      return this.getApproval(id)!;
    });
  }

  // ---- git worktrees (one active per session)
  private wtRow(r: any): T.Worktree {
    return { id: r.id, projectId: r.project_id, sessionId: r.session_id, path: r.path, branch: r.branch, baseBranch: r.base_branch,
      baseRevision: r.base_revision, status: r.status, createdAt: r.created_at, removedAt: r.removed_at };
  }
  createWorktree(i: { projectId: string; sessionId: string; path: string; branch: string; baseBranch: string; baseRevision: string }): T.Worktree {
    return this.tx(() => {
      const id = newId('wt'), t = now();
      this.db.prepare('INSERT INTO worktree (id,project_id,session_id,path,branch,base_branch,base_revision,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, i.projectId, i.sessionId, i.path, i.branch, i.baseBranch, i.baseRevision, t);
      this.db.prepare('UPDATE session SET worktree_path=?, updated_at=? WHERE id=?').run(i.path, t, i.sessionId);
      this.appendEvent({ sessionId: i.sessionId, type: 'worktree.created', payload: { worktreeId: id, path: i.path, branch: i.branch, baseRevision: i.baseRevision } });
      return this.getWorktree(id)!;
    });
  }
  getWorktree(id: string): T.Worktree | undefined { const r = this.one<any>('SELECT * FROM worktree WHERE id=?', id); return r && this.wtRow(r); }
  activeWorktreeForSession(sessionId: string): T.Worktree | undefined {
    const r = this.one<any>("SELECT * FROM worktree WHERE session_id=? AND status='active'", sessionId); return r && this.wtRow(r);
  }
  listWorktrees(projectId: string, status?: 'active' | 'removed'): T.Worktree[] {
    return this.all<any>(`SELECT * FROM worktree WHERE project_id=?${status ? ' AND status=?' : ''} ORDER BY created_at, rowid`, ...[projectId, ...(status ? [status] : [])]).map((r) => this.wtRow(r));
  }
  markWorktreeRemoved(id: string): T.Worktree {
    return this.tx(() => {
      const w = this.getWorktree(id); if (!w) throw new Error(`worktree not found: ${id}`);
      const t = now();
      this.db.prepare("UPDATE worktree SET status='removed', removed_at=? WHERE id=?").run(t, id);
      this.db.prepare('UPDATE session SET worktree_path=NULL, updated_at=? WHERE id=? AND worktree_path=?').run(t, w.sessionId, w.path);
      this.appendEvent({ sessionId: w.sessionId, type: 'worktree.removed', payload: { worktreeId: id, path: w.path, branch: w.branch } });
      return this.getWorktree(id)!;
    });
  }

  // ---- memory (content is immutable; only status/seen_count/updated_at change)
  private memRow(r: any): T.MemoryEntry {
    return { id: r.id, scope: r.scope, projectId: r.project_id, sessionId: r.session_id, category: r.category, content: r.content,
      authorRole: r.author_role, trust: r.trust, source: { kind: r.source_kind, ref: r.source_ref }, status: r.status,
      supersededBy: r.superseded_by, seenCount: r.seen_count, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  addMemory(i: { scope: 'project' | 'session'; projectId: string; sessionId?: string; category: string; content: string; contentHash: string;
    authorRole: string; trust: 'user' | 'agent'; source: { kind: string; ref?: string | null } }): T.MemoryEntry {
    return this.tx(() => {
      const id = newId('mem'), t = now();
      this.db.prepare(`INSERT INTO memory_entry (id,scope,project_id,session_id,category,content,content_hash,author_role,trust,source_kind,source_ref,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, i.scope, i.projectId, i.sessionId ?? null, i.category, redactString(i.content), i.contentHash, i.authorRole, i.trust, i.source.kind, i.source.ref ?? null, t, t);
      if (i.sessionId) this.appendEvent({ sessionId: i.sessionId, type: 'memory.added', payload: { memoryId: id, category: i.category, authorRole: i.authorRole } });
      return this.getMemory(id)!;
    });
  }
  getMemory(id: string): T.MemoryEntry | undefined { const r = this.one<any>('SELECT * FROM memory_entry WHERE id=?', id); return r && this.memRow(r); }
  findActiveMemoryByHash(i: { projectId: string; scope: string; sessionId?: string; category: string; contentHash: string }): T.MemoryEntry | undefined {
    const r = this.one<any>(`SELECT * FROM memory_entry WHERE project_id=? AND scope=? AND COALESCE(session_id,'')=? AND category=? AND content_hash=? AND status='active'`,
      i.projectId, i.scope, i.sessionId ?? '', i.category, i.contentHash);
    return r && this.memRow(r);
  }
  /** Project-scope entries of a project, or the session-scope entries of one session. */
  listMemory(o: { projectId: string; sessionId?: string; status?: T.MemoryEntry['status'] }): T.MemoryEntry[] {
    const where = o.sessionId ? "scope='session' AND session_id=?" : "scope='project' AND project_id=?";
    return this.all<any>(`SELECT * FROM memory_entry WHERE ${where}${o.status ? ' AND status=?' : ''} ORDER BY created_at, rowid`,
      ...[o.sessionId ?? o.projectId, ...(o.status ? [o.status] : [])]).map((r) => this.memRow(r));
  }
  touchMemory(id: string) { this.db.prepare('UPDATE memory_entry SET seen_count=seen_count+1, updated_at=? WHERE id=?').run(now(), id); return this.getMemory(id)!; }
  setMemoryStatus(id: string, status: 'superseded' | 'archived', supersededBy?: string): T.MemoryEntry {
    this.db.prepare("UPDATE memory_entry SET status=?, superseded_by=?, updated_at=? WHERE id=? AND status='active'").run(status, supersededBy ?? null, now(), id);
    return this.getMemory(id)!;
  }

  // ---- knowledge graph (schema only in Phase 1; indexing arrives in Phase 10)
  addNode(i: Omit<T.KnowledgeNode, 'id'>): T.KnowledgeNode {
    const id = newId('kn');
    this.db.prepare('INSERT INTO knowledge_node VALUES (?,?,?,?,?,?)').run(id, i.projectId, i.kind, i.name, i.provenance, i.verified ? 1 : 0);
    return { id, ...i };
  }
  addEdge(i: Omit<T.KnowledgeEdge, 'id'>): T.KnowledgeEdge {
    const id = newId('ke');
    this.db.prepare('INSERT INTO knowledge_edge VALUES (?,?,?,?,?,?)').run(id, i.fromId, i.toId, i.kind, i.provenance, i.verified ? 1 : 0);
    return { id, ...i };
  }
  listEdges(nodeId: string): T.KnowledgeEdge[] {
    return this.all<any>('SELECT * FROM knowledge_edge WHERE from_id=? OR to_id=?', nodeId, nodeId)
      .map((r) => ({ id: r.id, fromId: r.from_id, toId: r.to_id, kind: r.kind, provenance: r.provenance, verified: !!r.verified }));
  }
}
