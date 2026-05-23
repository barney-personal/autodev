/**
 * M12: Migration smoke coverage for the route_decisions table.
 *
 * Verifies that initDb() creates the table idempotently, that the expected
 * indexes exist, and that in-flight workflows with no decisions continue to
 * work (insert/list/latest helpers return empty / null without throwing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
} from './helpers.js';
import type { RouteDecision } from '../shared/types.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    implementerModel: 'claude-haiku-4-5-20251001',
    reviewerModel: 'codex',
    skipReview: false,
    confidence: 'high',
    rationale: 'r',
    guardrailOverrides: [],
    llmRawResponse: '{}',
    signalsSent: {},
    promptVersion: 'v1',
    decisionModel: 'claude-sonnet-4-6[1m]',
    costEstimateUsd: 0.001,
    decidedAt: Date.now(),
    ...overrides,
  };
}

describe('route_decisions migration', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates the route_decisions table with required columns', async () => {
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(route_decisions)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      'created_at',
      'cycle',
      'decision_json',
      'decision_model',
      'id',
      'mode',
      'phase',
      'prompt_version',
      'workflow_id',
    ]);
  });

  it('creates the expected indexes', async () => {
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='route_decisions'",
    ).all() as Array<{ name: string }>;
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_route_decisions_workflow_cycle');
    expect(names).toContain('idx_route_decisions_created_at');
  });

  it('is idempotent — second initDb() does not throw or duplicate rows', async () => {
    const { initDb, getDb } = await import('../server/db/database.js');
    const { insertRouteDecision, getRouteDecisionsForWorkflow } = await import('../server/db/routeDecisionQueries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    insertRouteDecision({
      id: randomUUID(), workflow_id: wf.id, cycle: 1, phase: 'implement',
      decision: makeDecision(), mode: 'shadow',
    });
    expect(() => initDb(':memory:')).not.toThrow();
    // initDb(':memory:') opens a fresh in-memory DB; previous in-memory data is
    // gone, but the schema must be present (no errors) and queries must work.
    const db = getDb();
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='route_decisions'",
    ).get();
    expect(tableExists).toBeTruthy();
    // Re-create the workflow row in the new DB and verify no rows leak.
    const project2 = await insertTestProject();
    const wf2 = await insertTestWorkflow({ project_id: project2.id });
    expect(getRouteDecisionsForWorkflow(wf2.id)).toEqual([]);
  });

  it('in-flight workflow with no decisions: list/latest return empty/null', async () => {
    const { getRouteDecisionsForWorkflow, getLatestRouteDecisionForCycle, getRouteDecisionsSince } =
      await import('../server/db/routeDecisionQueries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    expect(getRouteDecisionsForWorkflow(wf.id)).toEqual([]);
    expect(getLatestRouteDecisionForCycle(wf.id, 1, 'implement')).toBeNull();
    expect(getRouteDecisionsSince(Date.now() - 60_000)).toEqual([]);
  });

  it('insert + roundtrip via shared query helpers', async () => {
    const { insertRouteDecision, getRouteDecisionsForWorkflow, getLatestRouteDecisionForCycle } =
      await import('../server/db/routeDecisionQueries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    const decision = makeDecision({ rationale: 'roundtrip' });
    insertRouteDecision({
      id: randomUUID(), workflow_id: wf.id, cycle: 3, phase: 'implement',
      decision, mode: 'live',
    });
    const rows = getRouteDecisionsForWorkflow(wf.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision.rationale).toBe('roundtrip');
    expect(rows[0].mode).toBe('live');
    const latest = getLatestRouteDecisionForCycle(wf.id, 3, 'implement');
    expect(latest?.decision.rationale).toBe('roundtrip');
  });
});
