import { getDb, withTransaction } from './database.js';
import { validateTransition } from '../orchestrator/StateTransitions.js';
import type { FileLock, Template, Note, Project, BatchTemplate, Debate, Job } from '../../shared/types.js';

// A raw database row before casting to a typed interface.

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── File Locks ───────────────────────────────────────────────────────────────

export function insertFileLock(lock: FileLock): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_locks (id, agent_id, file_path, reason, acquired_at, expires_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(lock.id, lock.agent_id, lock.file_path, lock.reason, lock.acquired_at, lock.expires_at, lock.released_at);
}

export function getFileLockById(id: string): FileLock | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM file_locks WHERE id = ?').get(id);
  return row ? cast<FileLock>(row) : null;
}

export function getActiveLocksForFile(filePath: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path = ? AND released_at IS NULL AND expires_at > ?
  `).all(filePath, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getActiveLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL AND expires_at > ?
  `).all(agentId, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getAllActiveLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND expires_at > ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function releaseLock(id: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE id = ?').run(Date.now(), id);
}

export function releaseLocksForAgent(agentId: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE agent_id = ? AND released_at IS NULL').run(Date.now(), agentId);
}

// Returns active (not released, not expired) locks held by agents in terminal
// states (done/failed/cancelled). Used by the watchdog orphan-lock sweep.
export function getActiveLocksForTerminalAgents(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT fl.* FROM file_locks fl
    JOIN agents a ON fl.agent_id = a.id
    WHERE fl.released_at IS NULL
      AND fl.expires_at > ?
      AND a.status IN ('done', 'failed', 'cancelled')
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns unreleased locks whose TTL has expired. These are stale rows that
// no longer block anything (getAllActiveLocks filters by expires_at > now)
// but should be cleaned up to prevent DB bloat.
export function getExpiredUnreleasedLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND expires_at <= ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all unreleased locks for an agent regardless of TTL expiry.
// Used by releaseAll so that expired-but-unreleased locks still emit lock:released events.
export function getAllUnreleasedLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL'
  ).all(agentId);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getActiveLocksForFiles(filePaths: string[]): FileLock[] {
  if (filePaths.length === 0) return [];
  const db = getDb();
  const now = Date.now();
  const placeholders = filePaths.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path IN (${placeholders}) AND released_at IS NULL AND expires_at > ?
  `).all(...filePaths, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all active checkout:: locks. Used to find checkout locks that might
// conflict with a file lock (the caller filters by prefix).
export function getAllActiveCheckoutLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks
    WHERE file_path LIKE 'checkout::%' AND released_at IS NULL AND expires_at > ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all active non-checkout file locks whose path starts with dirPath + '/'.
// Used when acquiring a checkout lock to find blocking file locks under that directory.
export function getActiveFileLocksUnderPath(dirPath: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks
    WHERE file_path LIKE ? AND file_path NOT LIKE 'checkout::%'
      AND released_at IS NULL AND expires_at > ?
  `).all(dirPath + '/%', now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function insertTemplate(template: Template): Template {
  const db = getDb();
  db.prepare(`
    INSERT INTO templates (id, name, content, work_dir, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(template.id, template.name, template.content, template.work_dir ?? null, template.model ?? null, template.created_at, template.updated_at);
  return getTemplateById(template.id)!;
}

export function getTemplateById(id: string): Template | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  return row ? cast<Template>(row) : null;
}

export function listTemplates(): Template[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
  return rows.map((r: any) => cast<Template>(r));
}

const TEMPLATE_UPDATE_ALLOWED_FIELDS = new Set(['name', 'content', 'work_dir', 'model']);

export function updateTemplate(id: string, fields: Partial<Pick<Template, 'name' | 'content' | 'work_dir' | 'model'>>): Template | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    if (!TEMPLATE_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateTemplate`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTemplateById(id);
}

export function deleteTemplate(id: string): void {
  withTransaction(() => {
    const db = getDb();
    // Null out any jobs that referenced this template before deleting
    db.prepare('UPDATE jobs SET template_id = NULL WHERE template_id = ?').run(id);
    db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  });
}

// ─── Notes (shared scratchpad) ────────────────────────────────────────────────

export function upsertNote(key: string, value: string, agentId: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO notes (key, value, agent_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(key, value, agentId, Date.now());
}

/**
 * Atomically insert a note only if the key does not already exist.
 * Returns true if this caller inserted the row (winner), false if the key
 * already existed (duplicate — another caller won the race).
 * Uses INSERT OR IGNORE so concurrent callers are safe without external locking.
 */
export function insertNoteIfNotExists(key: string, value: string, agentId: string | null): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO notes (key, value, agent_id, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(key, value, agentId, Date.now());
  return result.changes > 0;
}

export function getNote(key: string): Note | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM notes WHERE key = ?').get(key);
  return row ? cast<Note>(row) : null;
}

export function listNotes(prefix?: string): Note[] {
  const db = getDb();
  let rows: unknown[];
  if (prefix) {
    rows = db.prepare("SELECT * FROM notes WHERE key LIKE ? ORDER BY key ASC").all(prefix.replace(/%/g, '\\%') + '%');
  } else {
    rows = db.prepare('SELECT * FROM notes ORDER BY key ASC').all();
  }
  return rows.map((r: any) => cast<Note>(r));
}

export function deleteNote(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM notes WHERE key = ?').run(key);
}

/**
 * Clean up stale scratchpad notes that haven't been updated in a while.
 * Excludes system notes (setting:*, recovery:*, workflow/*, eye:*) which
 * are managed by specific subsystems.
 * Returns number of notes deleted.
 */
export function pruneStaleNotes(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(`
    DELETE FROM notes
    WHERE updated_at < ?
      AND key NOT LIKE 'setting:%'
      AND key NOT LIKE 'recovery:%'
      AND key NOT LIKE 'workflow/%'
      AND key NOT LIKE 'eye:%'
      AND key NOT LIKE 'job-resume:%'
  `).run(cutoff);
  return result.changes;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function insertProject(project: Project): Project {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(project.id, project.name, project.description, project.created_at, project.updated_at);
  return getProjectById(project.id)!;
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? cast<Project>(row) : null;
}

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY name ASC').all();
  return rows.map((r: any) => cast<Project>(r));
}

const PROJECT_UPDATE_ALLOWED_FIELDS = new Set(['name', 'description']);

export function updateProject(id: string, fields: Partial<Pick<Project, 'name' | 'description'>>): Project | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    if (!PROJECT_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateProject`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

export function deleteProject(id: string): void {
  withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    // Archive all jobs in this project and unlink them from it
    db.prepare('UPDATE jobs SET archived_at = ?, project_id = NULL, updated_at = ? WHERE project_id = ? AND archived_at IS NULL').run(now, now, id);
    db.prepare('UPDATE jobs SET project_id = NULL, updated_at = ? WHERE project_id = ?').run(now, id);
    // Unlink debate jobs before deleting debates (debates.project_id is NOT NULL w/ FK constraint)
    db.prepare('UPDATE jobs SET debate_id = NULL WHERE debate_id IN (SELECT id FROM debates WHERE project_id = ?)').run(id);
    db.prepare('DELETE FROM debates WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
}

// ─── Batch Templates ──────────────────────────────────────────────────────────

interface BatchTemplateRow {
  id: string;
  name: string;
  items: string; // JSON string
  created_at: number;
  updated_at: number;
}

function rowToBatchTemplate(row: BatchTemplateRow): BatchTemplate {
  return { ...row, items: JSON.parse(row.items) };
}

export function insertBatchTemplate(bt: { id: string; name: string; items: string[]; created_at: number; updated_at: number }): BatchTemplate {
  const db = getDb();
  db.prepare(`
    INSERT INTO batch_templates (id, name, items, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bt.id, bt.name, JSON.stringify(bt.items), bt.created_at, bt.updated_at);
  return getBatchTemplateById(bt.id)!;
}

export function getBatchTemplateById(id: string): BatchTemplate | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM batch_templates WHERE id = ?').get(id);
  return row ? rowToBatchTemplate(cast<BatchTemplateRow>(row)) : null;
}

export function listBatchTemplates(): BatchTemplate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM batch_templates ORDER BY name ASC').all();
  return rows.map((r: any) => rowToBatchTemplate(cast<BatchTemplateRow>(r)));
}

export function updateBatchTemplate(id: string, fields: Partial<Pick<BatchTemplate, 'name' | 'items'>>): BatchTemplate | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    values.push(fields.name);
  }
  if (fields.items !== undefined) {
    sets.push('items = ?');
    values.push(JSON.stringify(fields.items));
  }
  values.push(id);
  db.prepare(`UPDATE batch_templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getBatchTemplateById(id);
}

export function deleteBatchTemplate(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM batch_templates WHERE id = ?').run(id);
}

// ─── Debates ──────────────────────────────────────────────────────────────────

export function insertDebate(debate: Debate): Debate {
  const db = getDb();
  db.prepare(`
    INSERT INTO debates (id, title, task, claude_model, codex_model, max_rounds, current_round, status, consensus, project_id, work_dir, max_turns, template_id, post_action_prompt, post_action_role, post_action_job_id, post_action_verification, verification_review_job_id, verification_response_job_id, verification_round, loop_count, current_loop, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    debate.id, debate.title, debate.task, debate.claude_model, debate.codex_model,
    debate.max_rounds, debate.current_round, debate.status, debate.consensus,
    debate.project_id, debate.work_dir, debate.max_turns, debate.template_id,
    debate.post_action_prompt ?? null, debate.post_action_role ?? null, debate.post_action_job_id ?? null,
    debate.post_action_verification ?? 0,
    debate.verification_review_job_id ?? null, debate.verification_response_job_id ?? null,
    debate.verification_round ?? 0,
    debate.loop_count ?? 1, debate.current_loop ?? 0,
    debate.created_at, debate.updated_at
  );
  return getDebateById(debate.id)!;
}

export function getDebateById(id: string): Debate | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM debates WHERE id = ?').get(id);
  return row ? cast<Debate>(row) : null;
}

export function listDebates(): Debate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM debates ORDER BY created_at DESC').all();
  return rows.map((r: any) => cast<Debate>(r));
}

const DEBATE_UPDATE_ALLOWED_FIELDS = new Set(['current_round', 'status', 'consensus', 'post_action_job_id', 'verification_review_job_id', 'verification_response_job_id', 'verification_round', 'current_loop']);

export function updateDebate(id: string, fields: Partial<Pick<Debate, 'current_round' | 'status' | 'consensus' | 'post_action_job_id' | 'verification_review_job_id' | 'verification_response_job_id' | 'verification_round' | 'current_loop'>>): Debate | null {
  if (fields.status) {
    const current = getDebateById(id);
    try {
      validateTransition('debate', current?.status, fields.status, id);
    } catch (err) {
      console.warn((err as Error).message);
    }
  }
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    if (!DEBATE_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateDebate`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE debates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getDebateById(id);
}

export function getJobsForDebate(debateId: string): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE debate_id = ? ORDER BY debate_loop ASC, debate_round ASC, created_at ASC').all(debateId);
  return rows.map((r: any) => cast<Job>(r));
}

export function getJobsForDebateRound(debateId: string, loop: number, round: number): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE debate_id = ? AND debate_loop = ? AND debate_round = ?').all(debateId, loop, round);
  return rows.map((r: any) => cast<Job>(r));
}
