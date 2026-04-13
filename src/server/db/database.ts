// @ts-ignore — node:sqlite is experimental in Node ≥22 and has no @types yet
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PragmaColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function getColumnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as PragmaColumnInfo[]).map(r => r.name);
}

let _db: DatabaseSync | null = null;

export function isDbInitialized(): boolean {
  return _db !== null;
}

export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Additive migrations — safe to run repeatedly
  const jobCols = getColumnNames(db, 'jobs');
  if (!jobCols.includes('model')) {
    db.exec('ALTER TABLE jobs ADD COLUMN model TEXT');
  }
  if (!jobCols.includes('template_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN template_id TEXT REFERENCES templates(id)');
  }
  if (!jobCols.includes('flagged')) {
    db.exec('ALTER TABLE jobs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('depends_on')) {
    db.exec('ALTER TABLE jobs ADD COLUMN depends_on TEXT');
  }
  if (!jobCols.includes('is_interactive')) {
    db.exec('ALTER TABLE jobs ADD COLUMN is_interactive INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('use_worktree')) {
    db.exec('ALTER TABLE jobs ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0');
  }

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  if (!jobCols.includes('project_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id)');

  const agentCols = getColumnNames(db, 'agents');
  if (!agentCols.includes('parent_agent_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN parent_agent_id TEXT');
  }
  if (!agentCols.includes('base_sha')) {
    db.exec('ALTER TABLE agents ADD COLUMN base_sha TEXT');
  }
  if (!agentCols.includes('diff')) {
    db.exec('ALTER TABLE agents ADD COLUMN diff TEXT');
  }
  if (!agentCols.includes('cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN cost_usd REAL');
  }
  if (!agentCols.includes('duration_ms')) {
    db.exec('ALTER TABLE agents ADD COLUMN duration_ms INTEGER');
  }
  if (!agentCols.includes('num_turns')) {
    db.exec('ALTER TABLE agents ADD COLUMN num_turns INTEGER');
  }
  if (!agentCols.includes('pending_wait_ids')) {
    db.exec('ALTER TABLE agents ADD COLUMN pending_wait_ids TEXT');
  }
  if (!agentCols.includes('estimated_input_tokens')) {
    db.exec('ALTER TABLE agents ADD COLUMN estimated_input_tokens INTEGER');
  }
  if (!agentCols.includes('estimated_output_tokens')) {
    db.exec('ALTER TABLE agents ADD COLUMN estimated_output_tokens INTEGER');
  }

  // FTS5 virtual table for full-text search across agent output
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS output_fts USING fts5(
      text_content,
      agent_id UNINDEXED
    )
  `);

  const tplCols = getColumnNames(db, 'templates');
  if (!tplCols.includes('work_dir')) {
    db.exec('ALTER TABLE templates ADD COLUMN work_dir TEXT');
  }
  if (!tplCols.includes('model')) {
    db.exec('ALTER TABLE templates ADD COLUMN model TEXT');
  }

  // Batch templates
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Notes (shared scratchpad across all agents)
  const notesCols = getColumnNames(db, 'notes');
  if (notesCols.length === 0) {
    db.exec(`
      CREATE TABLE notes (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        agent_id   TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // Debates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS debates (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      task          TEXT NOT NULL,
      claude_model  TEXT NOT NULL,
      codex_model   TEXT NOT NULL,
      max_rounds    INTEGER NOT NULL DEFAULT 3,
      current_round INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'running',
      consensus     TEXT,
      project_id    TEXT NOT NULL REFERENCES projects(id),
      work_dir      TEXT,
      max_turns     INTEGER NOT NULL DEFAULT 50,
      template_id   TEXT REFERENCES templates(id),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `);

  // Debate columns on jobs
  if (!jobCols.includes('debate_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_id TEXT REFERENCES debates(id)');
  }
  if (!jobCols.includes('debate_loop')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_loop INTEGER');
  }
  if (!jobCols.includes('debate_round')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_round INTEGER');
  }
  if (!jobCols.includes('debate_role')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_role TEXT');
  }
  if (!jobCols.includes('scheduled_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN scheduled_at INTEGER');
  }
  if (!jobCols.includes('repeat_interval_ms')) {
    db.exec('ALTER TABLE jobs ADD COLUMN repeat_interval_ms INTEGER');
  }
  if (!jobCols.includes('retry_policy')) {
    db.exec("ALTER TABLE jobs ADD COLUMN retry_policy TEXT NOT NULL DEFAULT 'none'");
  }
  if (!jobCols.includes('max_retries')) {
    db.exec('ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('retry_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('original_job_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN original_job_id TEXT');
  }
  if (!jobCols.includes('completion_checks')) {
    db.exec('ALTER TABLE jobs ADD COLUMN completion_checks TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_debate ON jobs(debate_id, debate_round)');

  // Post-debate action columns
  const debateCols = getColumnNames(db, 'debates');
  if (!debateCols.includes('post_action_prompt')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_prompt TEXT');
  }
  if (!debateCols.includes('post_action_role')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_role TEXT');
  }
  if (!debateCols.includes('post_action_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_job_id TEXT');
  }
  if (!debateCols.includes('post_action_verification')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_verification INTEGER NOT NULL DEFAULT 0');
  }
  if (!debateCols.includes('verification_review_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_review_job_id TEXT');
  }
  if (!debateCols.includes('verification_response_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_response_job_id TEXT');
  }
  if (!debateCols.includes('verification_round')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_round INTEGER NOT NULL DEFAULT 0');
  }
  if (!debateCols.includes('loop_count')) {
    db.exec('ALTER TABLE debates ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 1');
  }
  if (!debateCols.includes('current_loop')) {
    db.exec('ALTER TABLE debates ADD COLUMN current_loop INTEGER NOT NULL DEFAULT 0');
  }

  // ── Feature 6: Agent Health Monitoring ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_warnings (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      dismissed  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_warnings_agent ON agent_warnings(agent_id, dismissed)');

  // ── Feature 4: Worktree Cleanup ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      path       TEXT NOT NULL,
      branch     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cleaned_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_job ON worktrees(job_id)');

  // ── Feature 1: Mid-Task Nudge ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudges (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      message      TEXT NOT NULL,
      delivered    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_nudges_agent ON nudges(agent_id, delivered)');

  // ── Feature 5: Knowledge Base ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT,
      source     TEXT,
      agent_id   TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      title,
      content,
      kb_id UNINDEXED
    )
  `);

  // last_hit_at column on knowledge_base — tracks when entries are actually matched/used
  const kbCols = getColumnNames(db, 'knowledge_base');
  if (!kbCols.includes('last_hit_at')) {
    db.exec('ALTER TABLE knowledge_base ADD COLUMN last_hit_at INTEGER');
  }

  // ── Feature 3: Multi-Model Review Pipeline ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id              TEXT PRIMARY KEY,
      parent_job_id   TEXT NOT NULL,
      reviewer_job_id TEXT,
      model           TEXT NOT NULL,
      verdict         TEXT,
      summary         TEXT,
      created_at      INTEGER NOT NULL,
      completed_at    INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_parent ON reviews(parent_job_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_job_id)');

  if (!jobCols.includes('review_config')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_config TEXT');
  }
  if (!jobCols.includes('review_status')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_status TEXT');
  }
  if (!jobCols.includes('review_parent_job_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_parent_job_id TEXT');
  }
  if (!jobCols.includes('archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(archived_at)');
  if (!jobCols.includes('created_by_agent_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN created_by_agent_id TEXT');
  }
  if (!jobCols.includes('pre_debate_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN pre_debate_id TEXT REFERENCES debates(id)');
  }
  if (!jobCols.includes('pre_debate_summary')) {
    db.exec('ALTER TABLE jobs ADD COLUMN pre_debate_summary TEXT');
  }
  if (!jobCols.includes('stop_mode')) {
    db.exec("ALTER TABLE jobs ADD COLUMN stop_mode TEXT NOT NULL DEFAULT 'turns'");
  }
  if (!jobCols.includes('stop_value')) {
    db.exec('ALTER TABLE jobs ADD COLUMN stop_value REAL');
    // Backfill: existing rows get stop_value = max_turns
    db.exec("UPDATE jobs SET stop_value = max_turns WHERE stop_mode = 'turns' AND stop_value IS NULL");
  }

  // ── Eye: Discussions ───────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS discussions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, topic TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'question', priority TEXT NOT NULL DEFAULT 'medium',
    context TEXT, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status)');
  db.exec(`CREATE TABLE IF NOT EXISTS discussion_messages (
    id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL REFERENCES discussions(id),
    role TEXT NOT NULL, content TEXT NOT NULL, requires_reply INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_disc_msgs_discussion ON discussion_messages(discussion_id)');
  // Migration: add requires_reply to existing discussion_messages tables
  const discMsgCols = getColumnNames(db, 'discussion_messages');
  if (!discMsgCols.includes('requires_reply')) {
    db.exec('ALTER TABLE discussion_messages ADD COLUMN requires_reply INTEGER NOT NULL DEFAULT 1');
  }

  // ── Eye: Proposals ────────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL,
    estimated_complexity TEXT NOT NULL, category TEXT NOT NULL,
    evidence TEXT, implementation_plan TEXT,
    status TEXT NOT NULL DEFAULT 'pending', execution_job_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)');

  const proposalCols = getColumnNames(db, 'proposals');
  if (!proposalCols.includes('codex_confirmed')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_confirmed INTEGER');
  }
  if (!proposalCols.includes('codex_confidence')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_confidence REAL');
  }
  if (!proposalCols.includes('codex_reasoning')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_reasoning TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS proposal_messages (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prop_msgs_proposal ON proposal_messages(proposal_id)');

  // ── Eye: PR Reviews ────────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS pr_reviews (
    id TEXT PRIMARY KEY, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL,
    pr_title TEXT NOT NULL, pr_author TEXT, repo TEXT NOT NULL,
    summary TEXT NOT NULL, comments TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_reviews_status ON pr_reviews(status)');
  // Migration: add github_review_id if not present
  try { db.exec('ALTER TABLE pr_reviews ADD COLUMN github_review_id TEXT'); } catch { /* already exists */ }

  db.exec(`CREATE TABLE IF NOT EXISTS pr_review_messages (
    id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_review_msgs_review ON pr_review_messages(review_id)');

  // ── Workflows (structured plan/review/implement cycles) ─────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      task                TEXT NOT NULL,
      work_dir            TEXT,
      implementer_model   TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      reviewer_model      TEXT NOT NULL DEFAULT 'codex',
      max_cycles          INTEGER NOT NULL DEFAULT 10,
      current_cycle       INTEGER NOT NULL DEFAULT 0,
      current_phase       TEXT NOT NULL DEFAULT 'idle',
      status              TEXT NOT NULL DEFAULT 'running',
      milestones_total    INTEGER NOT NULL DEFAULT 0,
      milestones_done     INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT REFERENCES projects(id),
      max_turns_assess    INTEGER NOT NULL DEFAULT 50,
      max_turns_review    INTEGER NOT NULL DEFAULT 30,
      max_turns_implement INTEGER NOT NULL DEFAULT 100,
      template_id         TEXT REFERENCES templates(id),
      use_worktree        INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status)');

  if (!jobCols.includes('workflow_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN workflow_id TEXT REFERENCES workflows(id)');
  }
  if (!jobCols.includes('workflow_cycle')) {
    db.exec('ALTER TABLE jobs ADD COLUMN workflow_cycle INTEGER');
  }
  if (!jobCols.includes('workflow_phase')) {
    db.exec('ALTER TABLE jobs ADD COLUMN workflow_phase TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_workflow ON jobs(workflow_id, workflow_cycle)');

  // Workflow-level worktree columns (single worktree shared across all phases)
  const workflowCols = getColumnNames(db, 'workflows');
  if (!workflowCols.includes('stop_mode_assess')) {
    db.exec("ALTER TABLE workflows ADD COLUMN stop_mode_assess TEXT NOT NULL DEFAULT 'turns'");
    db.exec('ALTER TABLE workflows ADD COLUMN stop_value_assess REAL');
    db.exec("ALTER TABLE workflows ADD COLUMN stop_mode_review TEXT NOT NULL DEFAULT 'turns'");
    db.exec('ALTER TABLE workflows ADD COLUMN stop_value_review REAL');
    db.exec("ALTER TABLE workflows ADD COLUMN stop_mode_implement TEXT NOT NULL DEFAULT 'turns'");
    db.exec('ALTER TABLE workflows ADD COLUMN stop_value_implement REAL');
    // Backfill: existing rows get stop_value = max_turns per phase
    db.exec("UPDATE workflows SET stop_value_assess = max_turns_assess WHERE stop_mode_assess = 'turns' AND stop_value_assess IS NULL");
    db.exec("UPDATE workflows SET stop_value_review = max_turns_review WHERE stop_mode_review = 'turns' AND stop_value_review IS NULL");
    db.exec("UPDATE workflows SET stop_value_implement = max_turns_implement WHERE stop_mode_implement = 'turns' AND stop_value_implement IS NULL");
  }
  if (!workflowCols.includes('worktree_path')) {
    db.exec('ALTER TABLE workflows ADD COLUMN worktree_path TEXT');
  }
  if (!workflowCols.includes('worktree_branch')) {
    db.exec('ALTER TABLE workflows ADD COLUMN worktree_branch TEXT');
  }
  if (!workflowCols.includes('pr_url')) {
    db.exec('ALTER TABLE workflows ADD COLUMN pr_url TEXT');
  }
  if (!workflowCols.includes('blocked_reason')) {
    db.exec('ALTER TABLE workflows ADD COLUMN blocked_reason TEXT');
  }
  if (!workflowCols.includes('completion_threshold')) {
    db.exec('ALTER TABLE workflows ADD COLUMN completion_threshold REAL NOT NULL DEFAULT 1.0');
  }
  if (!workflowCols.includes('verify_command') && !workflowCols.includes('start_command')) {
    db.exec('ALTER TABLE workflows ADD COLUMN start_command TEXT');
  }
  // Rename verify_command -> start_command (verify is now agent-driven, this field
  // tells the verify agent how to start the app for smoke testing)
  if (workflowCols.includes('verify_command') && !workflowCols.includes('start_command')) {
    db.exec('ALTER TABLE workflows RENAME COLUMN verify_command TO start_command');
  }
  if (!workflowCols.includes('max_verify_retries')) {
    db.exec('ALTER TABLE workflows ADD COLUMN max_verify_retries INTEGER NOT NULL DEFAULT 2');
  }

  // ── Verify runs (live verification phase results) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS verify_runs (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      cycle       INTEGER NOT NULL,
      attempt     INTEGER NOT NULL,
      command     TEXT NOT NULL,
      exit_code   INTEGER,
      stdout      TEXT,
      stderr      TEXT,
      duration_ms INTEGER,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_verify_runs_workflow ON verify_runs(workflow_id, cycle)');

  // ── jobs.pr_url migration ──────────────────────────────────────────────────
  if (!jobCols.includes('pr_url')) {
    db.exec('ALTER TABLE jobs ADD COLUMN pr_url TEXT');
  }

  // ── Output deduplication: unique index on (agent_id, seq) ──────────────────
  // Allows INSERT OR IGNORE to safely de-duplicate replay of log files during
  // recovery. The old non-unique idx_output_agent index is superseded.
  // First, remove any existing duplicates so the unique index can be created.
  try {
    db.exec(`DELETE FROM agent_output WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM agent_output GROUP BY agent_id, seq
    )`);
  } catch { /* table may not exist yet */ }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_output_agent_seq ON agent_output(agent_id, seq)');

  // ── Periodic WAL checkpoint ────────────────────────────────────────────────
  // In WAL mode, the WAL file can grow unbounded if no checkpoints run.
  // Run a passive checkpoint on init to truncate any WAL growth from the
  // previous session, and set auto_checkpoint to a reasonable page count.
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    db.exec('PRAGMA wal_autocheckpoint = 1000'); // checkpoint every 1000 pages (~4MB)
  } catch { /* WAL checkpoint may fail if DB is freshly created */ }

  // ── Resilience Events ──────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS resilience_events (
      id          TEXT PRIMARY KEY,
      event_type  TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      details     TEXT,
      created_at  INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_resilience_events_type_time ON resilience_events(event_type, created_at)');

  // ── Workflow File Claims (M13/6B) ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_file_claims (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      file_path   TEXT NOT NULL,
      claimed_at  INTEGER NOT NULL,
      released_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wfc_workflow ON workflow_file_claims(workflow_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wfc_file ON workflow_file_claims(file_path) WHERE released_at IS NULL');

  // ── Performance indexes ────────────────────────────────────────────────────
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_job_id ON agents(job_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_workflow_phase ON jobs(workflow_id, workflow_phase)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_status_created ON workflows(status, created_at)');
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_context_eye ON jobs(status) WHERE json_extract(context, '$.eye') = 1");

  // ── FTS optimization ────────────────────────────────────────────────────────
  // Run FTS5 optimize on startup to merge internal b-trees. This keeps
  // full-text search fast after many inserts. Safe to run on every init —
  // it's a no-op if the index is already optimized.
  try {
    db.exec("INSERT INTO output_fts(output_fts) VALUES('optimize')");
  } catch { /* FTS optimize may fail on empty tables */ }
  try {
    db.exec("INSERT INTO kb_fts(kb_fts) VALUES('optimize')");
  } catch { /* FTS optimize may fail on empty tables */ }

  // ── Database integrity check ──────────────────────────────────────────────
  // Run a quick integrity check on startup to detect corruption early.
  // PRAGMA quick_check is fast (doesn't scan all data pages like integrity_check).
  try {
    const result = db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string } | undefined;
    if (result && result.quick_check !== 'ok') {
      console.error(`[db] INTEGRITY WARNING: quick_check returned "${result.quick_check}"`);
    }
  } catch (err) {
    console.error('[db] integrity check failed:', err);
  }

  // Clean up orphaned records: jobs stuck in 'assigned' status from a previous crash
  // (the agent dispatch was interrupted before it could run or fail).
  try {
    const stuck = db.prepare(
      "SELECT id FROM jobs WHERE status = 'assigned' AND updated_at < ?"
    ).all(Date.now() - 60_000) as Array<{ id: string }>;
    if (stuck.length > 0) {
      for (const row of stuck) {
        db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
      }
      console.log(`[db] reset ${stuck.length} stale assigned job(s) back to queued`);
    }
  } catch (err) {
    console.error('[db] stale job cleanup error:', err);
  }

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    // Run a final WAL checkpoint before closing to minimize WAL file size
    try {
      _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { /* ignore — may fail on :memory: DBs */ }
    _db.close();
    _db = null;
  }
}

// Track whether we are inside a withTransaction call (node:sqlite DatabaseSync
// does not expose an `inTransaction` property).
let _inTransaction = false;

/**
 * Run `fn` inside a SQLite transaction. On success, COMMIT. On error, ROLLBACK
 * and re-throw. Uses plain BEGIN (not BEGIN IMMEDIATE) so it plays nicely with
 * WAL mode concurrent reads.
 *
 * Guards:
 * - Nested calls: if already in a transaction, runs fn() directly (no nested BEGIN).
 * - Async callbacks: rejects Promises immediately, because the transaction would
 *   commit before awaits resolve, leading to silent data corruption.
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();

  // Guard: nested transactions -- just run the function directly
  if (_inTransaction) {
    return fn();
  }

  _inTransaction = true;
  db.exec('BEGIN');
  try {
    const result = fn();
    // Guard: async callbacks -- the transaction would commit before awaits resolve
    if (result instanceof Promise) {
      db.exec('ROLLBACK');
      _inTransaction = false;
      throw new Error('withTransaction does not support async callbacks -- the transaction would commit before awaits resolve');
    }
    db.exec('COMMIT');
    _inTransaction = false;
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
    _inTransaction = false;
    throw e;
  }
}
