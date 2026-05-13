import { getDb } from './database.js';
import type {
  JobWatcher,
  WatcherCommentary,
  WatcherAction,
  WatcherActionType,
  WatcherActionOutcome,
  WatcherSeverity,
  WatcherStatus,
} from '../../shared/types.js';

function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── job_watchers ────────────────────────────────────────────────────────────

export interface InsertWatcherInput {
  id: string;
  agent_id: string;
  job_id: string;
  model: string;
  status?: WatcherStatus;
}

export function insertWatcher(input: InsertWatcherInput): JobWatcher {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO job_watchers (id, agent_id, job_id, status, model, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.id, input.agent_id, input.job_id, input.status ?? 'starting', input.model, now);
  return getWatcherById(input.id)!;
}

export function getWatcherById(id: string): JobWatcher | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM job_watchers WHERE id = ?').get(id);
  return row ? cast<JobWatcher>(row) : null;
}

export function getWatcherByAgentId(agentId: string): JobWatcher | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM job_watchers WHERE agent_id = ?').get(agentId);
  return row ? cast<JobWatcher>(row) : null;
}

export function listActiveWatchers(): JobWatcher[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM job_watchers WHERE status IN ('starting','running') ORDER BY started_at ASC"
  ).all();
  return rows.map((r: unknown) => cast<JobWatcher>(r));
}

const WATCHER_UPDATE_ALLOWED = new Set([
  'status', 'tick_count', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_create_tokens', 'cost_usd', 'last_seq', 'last_tick_at', 'next_severity',
  'error_message', 'finished_at',
]);

export function updateWatcher(
  id: string,
  fields: Partial<Pick<JobWatcher,
    'status' | 'tick_count' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' |
    'cache_create_tokens' | 'cost_usd' | 'last_seq' | 'last_tick_at' | 'next_severity' |
    'error_message' | 'finished_at'>>
): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!WATCHER_UPDATE_ALLOWED.has(k)) throw new Error(`Field '${k}' not allowed for updateWatcher`);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE job_watchers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * Atomically increment a watcher's token + cost counters after each tick.
 * Used in the hot path; cheaper than a read+write round-trip.
 */
export function accumulateWatcherUsage(
  id: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  deltaCostUsd: number,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE job_watchers SET
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      cache_create_tokens = cache_create_tokens + ?,
      cost_usd = cost_usd + ?,
      tick_count = tick_count + 1,
      last_tick_at = ?
    WHERE id = ?
  `).run(inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, deltaCostUsd, Date.now(), id);
}

// ─── watcher_commentary ──────────────────────────────────────────────────────

export interface InsertCommentaryInput {
  id: string;
  watcher_id: string;
  agent_id: string;
  severity: WatcherSeverity;
  headline: string;
  detail?: string | null;
  evidence?: string | null;
}

export function insertCommentary(input: InsertCommentaryInput): WatcherCommentary {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO watcher_commentary (id, watcher_id, agent_id, severity, headline, detail, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.watcher_id, input.agent_id, input.severity,
    input.headline, input.detail ?? null, input.evidence ?? null, now,
  );
  return cast<WatcherCommentary>(db.prepare('SELECT * FROM watcher_commentary WHERE id = ?').get(input.id));
}

export function listCommentaryForAgent(agentId: string, limit = 200): WatcherCommentary[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM watcher_commentary WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?'
  ).all(agentId, limit);
  return rows.map((r: unknown) => cast<WatcherCommentary>(r));
}

export function getRecentCommentaryForAgent(agentId: string, limit = 8): WatcherCommentary[] {
  const db = getDb();
  // Newest-first, then reverse to preserve chronological order for the watcher's own context.
  const rows = db.prepare(
    'SELECT * FROM watcher_commentary WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(agentId, limit);
  return rows.map((r: unknown) => cast<WatcherCommentary>(r)).reverse();
}

// ─── watcher_actions ─────────────────────────────────────────────────────────

export interface InsertActionInput {
  id: string;
  watcher_id: string;
  agent_id: string;
  type: WatcherActionType;
  reason?: string | null;
  payload?: string | null;
  outcome?: WatcherActionOutcome;
  outcome_detail?: string | null;
}

export function insertAction(input: InsertActionInput): WatcherAction {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO watcher_actions (id, watcher_id, agent_id, type, reason, payload, outcome, outcome_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.watcher_id, input.agent_id, input.type,
    input.reason ?? null, input.payload ?? null,
    input.outcome ?? 'pending', input.outcome_detail ?? null, now,
  );
  return cast<WatcherAction>(db.prepare('SELECT * FROM watcher_actions WHERE id = ?').get(input.id));
}

export function updateActionOutcome(id: string, outcome: WatcherActionOutcome, detail?: string | null): void {
  const db = getDb();
  db.prepare('UPDATE watcher_actions SET outcome = ?, outcome_detail = ? WHERE id = ?')
    .run(outcome, detail ?? null, id);
}

export function listActionsForAgent(agentId: string, limit = 200): WatcherAction[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM watcher_actions WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?'
  ).all(agentId, limit);
  return rows.map((r: unknown) => cast<WatcherAction>(r));
}

export function countActionsForAgent(agentId: string, type: WatcherActionType): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM watcher_actions WHERE agent_id = ? AND type = ? AND outcome = 'applied'"
  ).get(agentId, type) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function lastActionAtForAgent(agentId: string, type: WatcherActionType): number | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(created_at) as t FROM watcher_actions WHERE agent_id = ? AND type = ?'
  ).get(agentId, type) as { t: number | null } | undefined;
  return row?.t ?? null;
}
