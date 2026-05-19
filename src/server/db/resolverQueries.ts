/**
 * DB helpers for the Auto Resolver — resolver_runs + resolver_actions.
 *
 * Mirrors the shape of watcherQueries.ts: cast helper, allowlist for updates,
 * single insert helpers, and a couple of aggregate accessors the dispatcher
 * uses to decide whether to fire (lifetime attempts, daily cost).
 */
import { getDb } from './database.js';
import type {
  ResolverRun,
  ResolverAction,
  ResolverStatus,
  ResolverClassification,
  ResolverResumeOutcome,
  ResolverActionType,
  ResolverActionOutcome,
} from '../../shared/types.js';

function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── resolver_runs ───────────────────────────────────────────────────────────

export interface InsertResolverRunInput {
  id: string;
  workflow_id: string;
  trigger_reason: string;
  reason_fingerprint: string;
  attempt: number;
  model: string;
  status?: ResolverStatus;
}

export function insertResolverRun(input: InsertResolverRunInput): ResolverRun {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO resolver_runs (id, workflow_id, trigger_reason, reason_fingerprint, attempt, model, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.workflow_id,
    input.trigger_reason,
    input.reason_fingerprint,
    input.attempt,
    input.model,
    input.status ?? 'running',
    now,
  );
  return getResolverRunById(input.id)!;
}

export function getResolverRunById(id: string): ResolverRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM resolver_runs WHERE id = ?').get(id);
  return row ? cast<ResolverRun>(row) : null;
}

export function listResolverRunsForWorkflow(workflowId: string, limit = 50): ResolverRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM resolver_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(workflowId, limit);
  return rows.map((r: unknown) => cast<ResolverRun>(r));
}

export function listRecentResolverRuns(limit = 50): ResolverRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM resolver_runs ORDER BY started_at DESC LIMIT ?'
  ).all(limit);
  return rows.map((r: unknown) => cast<ResolverRun>(r));
}

export function findActiveResolverRun(workflowId: string, fingerprint: string): ResolverRun | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM resolver_runs WHERE workflow_id = ? AND reason_fingerprint = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
  ).get(workflowId, fingerprint);
  return row ? cast<ResolverRun>(row) : null;
}

export function findLatestResolverRunForFingerprint(workflowId: string, fingerprint: string): ResolverRun | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM resolver_runs WHERE workflow_id = ? AND reason_fingerprint = ? ORDER BY started_at DESC LIMIT 1'
  ).get(workflowId, fingerprint);
  return row ? cast<ResolverRun>(row) : null;
}

const RUN_UPDATE_ALLOWED = new Set([
  'classification',
  'status',
  'diagnosis',
  'recommended_action',
  'resume_outcome',
  'error_message',
  'finished_at',
]);

export function updateResolverRun(
  id: string,
  fields: Partial<Pick<ResolverRun,
    'classification' | 'status' | 'diagnosis' | 'recommended_action' |
    'resume_outcome' | 'error_message' | 'finished_at'>>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!RUN_UPDATE_ALLOWED.has(k)) throw new Error(`Field '${k}' not allowed for updateResolverRun`);
    sets.push(`"${k}" = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE resolver_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/** Atomically increment token + cost counters after each Resolver tool round. */
export function accumulateResolverUsage(
  id: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  deltaCostUsd: number,
  turnDelta = 1,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE resolver_runs SET
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      cache_create_tokens = cache_create_tokens + ?,
      cost_usd = cost_usd + ?,
      turn_count = turn_count + ?
    WHERE id = ?
  `).run(inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, deltaCostUsd, turnDelta, id);
}

/** Sum of cost_usd from resolver runs that started within the last `windowMs`.
 *  Used as the global daily-cap guard in the dispatcher. */
export function resolverCostUsdSince(sinceMs: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT SUM(cost_usd) AS total FROM resolver_runs WHERE started_at >= ?'
  ).get(sinceMs) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

/** Concurrency: count of currently-running resolver runs. */
export function countActiveResolverRuns(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM resolver_runs WHERE status = 'running'"
  ).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

// ─── resolver_actions ────────────────────────────────────────────────────────

export interface InsertResolverActionInput {
  id: string;
  resolver_id: string;
  workflow_id: string;
  type: ResolverActionType;
  payload: string;
  outcome?: ResolverActionOutcome;
  outcome_detail?: string | null;
}

export function insertResolverAction(input: InsertResolverActionInput): ResolverAction {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO resolver_actions (id, resolver_id, workflow_id, type, payload, outcome, outcome_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.resolver_id,
    input.workflow_id,
    input.type,
    input.payload,
    input.outcome ?? 'pending',
    input.outcome_detail ?? null,
    now,
  );
  return cast<ResolverAction>(db.prepare('SELECT * FROM resolver_actions WHERE id = ?').get(input.id));
}

export function updateResolverActionOutcome(
  id: string,
  outcome: ResolverActionOutcome,
  detail?: string | null,
): void {
  const db = getDb();
  db.prepare('UPDATE resolver_actions SET outcome = ?, outcome_detail = ? WHERE id = ?')
    .run(outcome, detail ?? null, id);
}

export function getResolverActionById(id: string): ResolverAction | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM resolver_actions WHERE id = ?').get(id);
  return row ? cast<ResolverAction>(row) : null;
}

export function listResolverActions(resolverId: string): ResolverAction[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM resolver_actions WHERE resolver_id = ? ORDER BY created_at ASC'
  ).all(resolverId);
  return rows.map((r: unknown) => cast<ResolverAction>(r));
}

// ─── lookup helpers used by tests ────────────────────────────────────────────

export function _truncateResolverTablesForTest(): void {
  const db = getDb();
  db.prepare('DELETE FROM resolver_actions').run();
  db.prepare('DELETE FROM resolver_runs').run();
}

// Bridge type so other modules don't need to import multiple packages.
export type {
  ResolverRun,
  ResolverAction,
  ResolverStatus,
  ResolverClassification,
  ResolverResumeOutcome,
  ResolverActionType,
  ResolverActionOutcome,
};
