import { getDb } from './database.js';
import type { RouteDecision, RouteDecisionMode, RouteDecisionRow } from '../../shared/types.js';

interface RawRouteDecisionRow {
  id: string;
  workflow_id: string;
  cycle: number;
  phase: string;
  decision_json: string;
  mode: string;
  prompt_version: string;
  decision_model: string;
  created_at: number;
}

function parseRow(raw: RawRouteDecisionRow): RouteDecisionRow {
  let decision: RouteDecision;
  try {
    decision = JSON.parse(raw.decision_json) as RouteDecision;
  } catch {
    // Should not happen — we always JSON.stringify before insert. Surface a
    // best-effort empty payload rather than throwing, so list/latest helpers
    // do not break for rows with corrupt JSON.
    decision = {
      implementerModel: '',
      reviewerModel: null,
      skipReview: false,
      confidence: 'low',
      rationale: 'corrupt decision_json',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: raw.prompt_version,
      decisionModel: raw.decision_model,
      costEstimateUsd: 0,
      decidedAt: raw.created_at,
    };
  }
  return {
    id: raw.id,
    workflow_id: raw.workflow_id,
    cycle: raw.cycle,
    phase: raw.phase,
    decision,
    mode: raw.mode as RouteDecisionMode,
    prompt_version: raw.prompt_version,
    decision_model: raw.decision_model,
    created_at: raw.created_at,
  };
}

export interface InsertRouteDecisionInput {
  id: string;
  workflow_id: string;
  cycle: number;
  phase: string;
  decision: RouteDecision;
  mode: RouteDecisionMode;
  prompt_version?: string;
  decision_model?: string;
  created_at?: number;
}

export function insertRouteDecision(input: InsertRouteDecisionInput): RouteDecisionRow {
  const db = getDb();
  const createdAt = input.created_at ?? Date.now();
  const promptVersion = input.prompt_version ?? input.decision.promptVersion;
  const decisionModel = input.decision_model ?? input.decision.decisionModel;
  db.prepare(`
    INSERT INTO route_decisions
      (id, workflow_id, cycle, phase, decision_json, mode, prompt_version, decision_model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.workflow_id,
    input.cycle,
    input.phase,
    JSON.stringify(input.decision),
    input.mode,
    promptVersion,
    decisionModel,
    createdAt,
  );
  return {
    id: input.id,
    workflow_id: input.workflow_id,
    cycle: input.cycle,
    phase: input.phase,
    decision: input.decision,
    mode: input.mode,
    prompt_version: promptVersion,
    decision_model: decisionModel,
    created_at: createdAt,
  };
}

export function getRouteDecisionsForWorkflow(workflowId: string): RouteDecisionRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM route_decisions
    WHERE workflow_id = ?
    ORDER BY cycle ASC, created_at ASC
  `).all(workflowId) as unknown as RawRouteDecisionRow[];
  return rows.map(parseRow);
}

export function getLatestRouteDecisionForCycle(
  workflowId: string,
  cycle: number,
  phase?: string,
): RouteDecisionRow | null {
  const db = getDb();
  const row = phase
    ? db.prepare(`
        SELECT * FROM route_decisions
        WHERE workflow_id = ? AND cycle = ? AND phase = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(workflowId, cycle, phase)
    : db.prepare(`
        SELECT * FROM route_decisions
        WHERE workflow_id = ? AND cycle = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(workflowId, cycle);
  return row ? parseRow(row as unknown as RawRouteDecisionRow) : null;
}

export function getRouteDecisionsSince(sinceMs: number): RouteDecisionRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM route_decisions
    WHERE created_at >= ?
    ORDER BY created_at ASC
  `).all(sinceMs) as unknown as RawRouteDecisionRow[];
  return rows.map(parseRow);
}

/**
 * Count route decisions since sinceMs, grouped by mode. Uses SQL aggregation
 * to avoid fetching and parsing decision_json for every row.
 * All three RouteDecisionMode keys (shadow, live, fallback) are always present
 * in the returned byMode map, defaulting to 0.
 */
export function countRouteDecisionsByModeSince(sinceMs: number): {
  total: number;
  byMode: Record<RouteDecisionMode, number>;
} {
  const db = getDb();
  const rows = db.prepare(`
    SELECT mode, COUNT(*) as cnt
    FROM route_decisions
    WHERE created_at >= ?
    GROUP BY mode
  `).all(sinceMs) as { mode: string; cnt: number }[];
  const byMode: Record<RouteDecisionMode, number> = { shadow: 0, live: 0, fallback: 0 };
  let total = 0;
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(byMode, row.mode)) {
      byMode[row.mode as RouteDecisionMode] = row.cnt;
    }
    total += row.cnt;
  }
  return { total, byMode };
}
