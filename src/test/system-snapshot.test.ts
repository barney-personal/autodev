/**
 * Tests for GET /api/system/snapshot.
 *
 * Covers:
 *  - happy path with seeded workflows, jobs (queued/assigned/running/blocked),
 *    and recent route decisions
 *  - empty DB returns zeroed counts and null timestamps
 *  - routing_brain.total_decisions_30d is 0 when only older-than-30d decisions
 *    exist
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type express from 'express';
import type { RouteDecision, RouteDecisionMode } from '../shared/types.js';

interface TestResponse {
  status: number;
  body: any;
}

async function getJson(app: express.Express, path: string): Promise<TestResponse> {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}));
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  getQueueMetrics: vi.fn(() => ({})),
  _resetForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => []),
  getSnapshot: vi.fn(() => null),
  attachPty: vi.fn(),
  startInteractiveAgent: vi.fn(),
}));
vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));
vi.mock('../server/orchestrator/JobWatcherManager.js', () => ({
  requestTickNow: vi.fn(() => ({ ok: true })),
  requestStartNow: vi.fn(() => ({ ok: true })),
  stopWatcherForAgent: vi.fn(() => true),
}));
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    implementerModel: 'claude-haiku-4-5-20251001',
    reviewerModel: 'codex',
    skipReview: false,
    confidence: 'high',
    rationale: 'test',
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

async function insertDecision(args: {
  workflow_id: string;
  cycle: number;
  mode: RouteDecisionMode;
  created_at?: number;
}) {
  const { insertRouteDecision } = await import('../server/db/routeDecisionQueries.js');
  return insertRouteDecision({
    id: randomUUID(),
    workflow_id: args.workflow_id,
    cycle: args.cycle,
    phase: 'implement',
    decision: makeDecision(),
    mode: args.mode,
    prompt_version: 'v1',
    decision_model: 'claude-sonnet-4-6[1m]',
    created_at: args.created_at,
  });
}

describe('GET /api/system/snapshot', () => {
  let app: express.Express;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('happy path: aggregates workflows, jobs, decisions, and queue', async () => {
    const project = await insertTestProject();
    const wf1 = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    await insertTestWorkflow({ project_id: project.id, status: 'blocked' });

    // Queue mix: queued, running, assigned, plus a blocked queued job
    // depending on an active parent.
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'running' });
    await insertTestJob({ status: 'assigned' });
    const parent = await insertTestJob({ status: 'running' });
    const { insertJob } = await import('../server/db/queries.js');
    insertJob({
      id: randomUUID(),
      title: 'blocked-on-dep',
      description: 'b',
      context: null,
      priority: 0,
      status: 'queued',
      depends_on: JSON.stringify([parent.id]) as any,
    });
    // Done job to populate last_job_completed_at
    await insertTestJob({ status: 'done' });

    await insertDecision({ workflow_id: wf1.id, cycle: 1, mode: 'shadow' });
    await insertDecision({ workflow_id: wf1.id, cycle: 2, mode: 'live' });
    await insertDecision({ workflow_id: wf1.id, cycle: 3, mode: 'shadow' });

    const res = await getJson(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    expect(res.body.process.node_version).toBe(process.version);
    expect(typeof res.body.process.uptime_seconds).toBe('number');
    expect(typeof res.body.process.rss_mb).toBe('number');

    expect(res.body.db.workflow_counts_by_status).toEqual({
      running: 1,
      complete: 2,
      blocked: 1,
    });
    expect(typeof res.body.db.last_workflow_created_at).toBe('string');
    expect(new Date(res.body.db.last_workflow_created_at).toString()).not.toBe('Invalid Date');
    expect(typeof res.body.db.last_job_completed_at).toBe('string');

    expect(res.body.routing_brain.total_decisions_30d).toBe(3);
    expect(res.body.routing_brain.by_mode_30d).toEqual({ shadow: 2, live: 1 });
    expect(['off', 'shadow', 'live']).toContain(res.body.routing_brain.mode);

    expect(res.body.queue).toEqual({ queued: 1, running: 3, blocked: 1 });
  });

  it('empty DB: returns zero counts and null timestamps', async () => {
    const res = await getJson(app, '/api/system/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.db).toEqual({
      last_workflow_created_at: null,
      last_job_completed_at: null,
      workflow_counts_by_status: {},
    });
    expect(res.body.routing_brain.total_decisions_30d).toBe(0);
    expect(res.body.routing_brain.by_mode_30d).toEqual({});
    expect(res.body.queue).toEqual({ queued: 0, running: 0, blocked: 0 });
    expect(typeof res.body.process.uptime_seconds).toBe('number');
  });

  it('routing_brain: 0 decisions when only older-than-30d decisions exist', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    const eightyDaysAgo = Date.now() - 80 * 86_400_000;
    await insertDecision({ workflow_id: wf.id, cycle: 1, mode: 'shadow', created_at: eightyDaysAgo });
    await insertDecision({ workflow_id: wf.id, cycle: 2, mode: 'live', created_at: eightyDaysAgo });

    const res = await getJson(app, '/api/system/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.routing_brain.total_decisions_30d).toBe(0);
    expect(res.body.routing_brain.by_mode_30d).toEqual({});
  });
});
