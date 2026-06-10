CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  work_dir   TEXT,
  model      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  context     TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',
  priority    INTEGER NOT NULL DEFAULT 0,
  work_dir    TEXT,
  max_turns   INTEGER NOT NULL DEFAULT 50,
  model       TEXT,
  effort      TEXT,
  template_id TEXT REFERENCES templates(id),
  use_worktree       INTEGER NOT NULL DEFAULT 0,
  scheduled_at       INTEGER,
  repeat_interval_ms INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  status          TEXT NOT NULL DEFAULT 'starting',
  pid             INTEGER,
  session_id      TEXT,
  parent_agent_id TEXT,
  exit_code       INTEGER,
  error_message   TEXT,
  status_message  TEXT,
  output_read     INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE TABLE IF NOT EXISTS agent_output (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  seq         INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  question     TEXT NOT NULL,
  answer       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  asked_at     INTEGER NOT NULL,
  answered_at  INTEGER,
  timeout_ms   INTEGER NOT NULL DEFAULT 300000
);

CREATE TABLE IF NOT EXISTS file_locks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  file_path   TEXT NOT NULL,
  reason      TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agents_status   ON agents(status);
CREATE INDEX IF NOT EXISTS idx_output_agent    ON agent_output(agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_questions_agent ON questions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_locks_active    ON file_locks(file_path, released_at);
