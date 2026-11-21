// Append-only list. Never edit an applied migration; add a new version instead.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, default_branch TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', memory_refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','blocked','failed','completed','cancelled')),
  worktree_path TEXT, checkpoint_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE task (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','blocked','failed','completed','cancelled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_run (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, pid INTEGER, cli_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','blocked','failed','completed','cancelled')),
  exit_code INTEGER, termination_reason TEXT, started_at TEXT, ended_at TEXT
);
-- Append-only: seq is monotonic per session, UNIQUE guards against duplicate writers.
CREATE TABLE event (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), seq INTEGER NOT NULL,
  type TEXT NOT NULL, run_id TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TABLE checkpoint (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), seq INTEGER NOT NULL,
  next_action TEXT NOT NULL, git_state TEXT NOT NULL DEFAULT '{}', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE (session_id, seq)
);
CREATE TABLE artifact (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('diff','log','test-report','spec','other')),
  path TEXT, content TEXT, created_at TEXT NOT NULL
);
CREATE TABLE routing_decision (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_run(id), provider TEXT NOT NULL, model TEXT NOT NULL,
  policy_version TEXT NOT NULL, reason TEXT NOT NULL, usage TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE approval (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), action TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  approver TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE knowledge_node (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), kind TEXT NOT NULL, name TEXT NOT NULL,
  provenance TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE knowledge_edge (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES knowledge_node(id), to_id TEXT NOT NULL REFERENCES knowledge_node(id),
  kind TEXT NOT NULL, provenance TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_session_project ON session(project_id);
CREATE INDEX idx_task_session ON task(session_id);
CREATE INDEX idx_run_task ON agent_run(task_id);
`,
  },
  {
    version: 2,
    sql: `
-- A retried "start/resume" request with the same key returns the original run instead of starting another.
ALTER TABLE agent_run ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_run_idempotency ON agent_run(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- At most one writer per working directory. PRIMARY KEY makes acquisition atomic.
CREATE TABLE worktree_lock (
  path TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
  run_id TEXT NOT NULL REFERENCES agent_run(id), acquired_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- Project memory (scope='project', shared) and session memory (scope='session', one feature) are kept apart.
-- Rows are never deleted and their text/author/source never change: superseding or archiving only flips status.
CREATE TABLE memory_entry (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','session')),
  project_id TEXT NOT NULL REFERENCES project(id),
  session_id TEXT REFERENCES session(id),
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_role TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('user','agent')),
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  superseded_by TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'session') = (session_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_memory_dedupe ON memory_entry(project_id, scope, COALESCE(session_id,''), category, content_hash) WHERE status = 'active';
CREATE INDEX idx_memory_owner ON memory_entry(project_id, session_id, status);
CREATE TRIGGER memory_no_delete BEFORE DELETE ON memory_entry BEGIN SELECT RAISE(ABORT, 'memory is never deleted; archive it'); END;
CREATE TRIGGER memory_immutable BEFORE UPDATE OF content, content_hash, author_role, trust, source_kind, source_ref, scope, project_id, session_id, category, created_at
  ON memory_entry BEGIN SELECT RAISE(ABORT, 'memory content, author and source are immutable'); END;
`,
  },
  {
    version: 4,
    sql: `
-- One isolated git worktree per session. Rows are kept after removal (status='removed') as a record.
CREATE TABLE worktree (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX idx_worktree_session_active ON worktree(session_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_worktree_path_active ON worktree(path) WHERE status = 'active';
CREATE INDEX idx_worktree_project ON worktree(project_id, status);
`,
  },
  {
    version: 5,
    sql: `
-- Phase 7: versioned routing policy, per-run usage, and the inputs each routing decision was made from.
ALTER TABLE routing_decision ADD COLUMN inputs TEXT NOT NULL DEFAULT '{}';
CREATE TABLE routing_policy (
  version INTEGER PRIMARY KEY, config TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER routing_policy_no_update BEFORE UPDATE ON routing_policy BEGIN SELECT RAISE(ABORT, 'a policy version is immutable; publish a new version'); END;
CREATE TRIGGER routing_policy_no_delete BEFORE DELETE ON routing_policy BEGIN SELECT RAISE(ABORT, 'policy versions are never deleted'); END;
-- One row per run, written only when the provider reported something. A missing row means "unavailable".
CREATE TABLE usage_record (
  run_id TEXT PRIMARY KEY REFERENCES agent_run(id),
  session_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
  source TEXT NOT NULL CHECK (source IN ('reported')), created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_created ON usage_record(created_at);
CREATE INDEX idx_usage_project ON usage_record(project_id, created_at);
`,
  },
  {
    version: 6,
    sql: `
-- Phase 8: authorized provider accounts (references only, never secrets), health, queue, handoffs, audit trail.
ALTER TABLE agent_run ADD COLUMN account_id TEXT;
CREATE TABLE provider_account (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL,
  config_dir TEXT, credential_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (provider, label)
);
-- account_id '' is the implicit default account (the CLI's own login).
CREATE TABLE provider_health (
  provider TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '',
  limited_until TEXT, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, account_id)
);
CREATE TABLE queue_item (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), session_id TEXT NOT NULL REFERENCES session(id),
  request TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','started','cancelled','abandoned')),
  reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_queue_status ON queue_item(status, created_at);
CREATE TABLE handoff (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
  from_run_id TEXT, from_provider TEXT, from_account_id TEXT,
  to_provider TEXT NOT NULL, to_account_id TEXT, to_model TEXT NOT NULL, to_run_id TEXT,
  checkpoint_id TEXT, drift_level TEXT, fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','queued','refused')),
  reason TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '[]', actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_handoff_session ON handoff(session_id, created_at);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  subject TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
`,
  },
  {
    version: 7,
    sql: `
-- Phase 9: multi-agent workflows. Definition is immutable JSON; progress is per step; every transition and every piece of evidence is append-only.
CREATE TABLE workflow (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), title TEXT NOT NULL, goal TEXT NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','running','completed','failed','cancelled')),
  halted_reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER workflow_definition_fixed BEFORE UPDATE OF definition, goal, project_id ON workflow BEGIN SELECT RAISE(ABORT, 'a workflow definition cannot be changed after it is created'); END;
CREATE TABLE workflow_step (
  workflow_id TEXT NOT NULL REFERENCES workflow(id), key TEXT NOT NULL, kind TEXT NOT NULL, role TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','passed','failed','skipped','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, session_id TEXT, task_id TEXT, run_id TEXT, approval_id TEXT,
  started_at TEXT, ended_at TEXT, detail TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (workflow_id, key)
);
CREATE TABLE workflow_transition (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflow(id), step_key TEXT,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX idx_wft_wf ON workflow_transition(workflow_id, id);
CREATE TRIGGER wft_no_update BEFORE UPDATE ON workflow_transition BEGIN SELECT RAISE(ABORT, 'workflow history is append-only'); END;
CREATE TRIGGER wft_no_delete BEFORE DELETE ON workflow_transition BEGIN SELECT RAISE(ABORT, 'workflow history is append-only'); END;
CREATE TABLE workflow_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflow(id), step_key TEXT NOT NULL,
  attempt INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_wfe_wf ON workflow_evidence(workflow_id, id);
CREATE TRIGGER wfe_no_update BEFORE UPDATE ON workflow_evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER wfe_no_delete BEFORE DELETE ON workflow_evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
`,
  },
  {
    version: 8,
    sql: `
-- Phase 10: repository index. The Phase 1 graph tables gain source locations; files get a content hash for staleness.
ALTER TABLE knowledge_node ADD COLUMN path TEXT;
ALTER TABLE knowledge_node ADD COLUMN line INTEGER;
ALTER TABLE knowledge_node ADD COLUMN end_line INTEGER;
ALTER TABLE knowledge_node ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_node ADD COLUMN session_id TEXT;
ALTER TABLE knowledge_edge ADD COLUMN project_id TEXT;
ALTER TABLE knowledge_edge ADD COLUMN path TEXT;
ALTER TABLE knowledge_edge ADD COLUMN line INTEGER;
ALTER TABLE knowledge_edge ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_kn_project ON knowledge_node(project_id, kind);
CREATE INDEX idx_kn_path ON knowledge_node(project_id, path);
CREATE UNIQUE INDEX idx_kn_name ON knowledge_node(project_id, kind, name);
CREATE INDEX idx_ke_from ON knowledge_edge(from_id);
CREATE INDEX idx_ke_to ON knowledge_edge(to_id);
CREATE INDEX idx_ke_project ON knowledge_edge(project_id, kind);
CREATE TABLE index_file (
  project_id TEXT NOT NULL REFERENCES project(id), path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  lang TEXT NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY (project_id, path)
);
CREATE TABLE index_state (
  project_id TEXT PRIMARY KEY REFERENCES project(id), revision TEXT, branch TEXT, extractor TEXT NOT NULL,
  files INTEGER NOT NULL, symbols INTEGER NOT NULL, edges INTEGER NOT NULL, full_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_mode TEXT NOT NULL
);
`,
  },
  {
    version: 9,
    sql: `
-- Phase 12: approvals become single-use, subject-bound decisions made through a human channel.
ALTER TABLE approval ADD COLUMN subject TEXT;
ALTER TABLE approval ADD COLUMN requested_by TEXT;
ALTER TABLE approval ADD COLUMN expires_at TEXT;
ALTER TABLE approval ADD COLUMN consumed_at TEXT;
ALTER TABLE approval ADD COLUMN consumed_by TEXT;
ALTER TABLE approval ADD COLUMN decided_via TEXT;
ALTER TABLE approval ADD COLUMN risk TEXT;
CREATE INDEX idx_approval_status ON approval(status, created_at);
-- A request cannot be edited, re-decided or reused behind the application's back, and is never deleted.
CREATE TRIGGER approval_request_fixed BEFORE UPDATE OF action, subject, requested_by, expires_at, evidence ON approval BEGIN SELECT RAISE(ABORT, 'an approval request cannot be edited after it is created'); END;
CREATE TRIGGER approval_no_delete BEFORE DELETE ON approval BEGIN SELECT RAISE(ABORT, 'approvals are kept permanently'); END;
CREATE TRIGGER approval_decision_once BEFORE UPDATE OF status ON approval WHEN OLD.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'an approval is decided only once'); END;
CREATE TRIGGER approval_consume_once BEFORE UPDATE OF consumed_at ON approval WHEN OLD.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'an approval is used only once'); END;
`,
  },
];
