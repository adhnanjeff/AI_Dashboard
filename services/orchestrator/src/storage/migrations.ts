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
];
