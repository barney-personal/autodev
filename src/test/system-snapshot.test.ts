/**
 * Tests for GET /api/system/snapshot.
 *
 * Covers happy path with populated DB, empty DB, and routing-brain zero-decisions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import type express from 'express';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type { RouteDecision, RouteDecisionMode } from '../shared/types.js';

interface TestResponse {
  status: number;
  body: any;
}

async function sendRequest(
  app: express.Express,
  method: 'GET',
  path: string,
): Promise<TestResponse> {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
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
  Sentry: {
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}));
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
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
  mode: RouteDecisionMode;
  created_at?: number;
  workflow_id?: string;
}) {
  const { insertRouteDecision } = await import('../server/db/routeDecisionQueries.js');
  return insertRouteDecision({
    id: randomUUID(),
    workflow_id: args.workflow_id ?? randomUUID(),
    cycle: 1,
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
  let originalMode: string | undefined;

  beforeEach(async () => {
    originalMode = process.env.ROUTING_BRAIN_MODE;
    delete process.env.ROUTING_BRAIN_MODE;
    await setupTestDb();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
    if (originalMode === undefined) delete process.env.ROUTING_BRAIN_MODE;
    else process.env.ROUTING_BRAIN_MODE = originalMode;
  });

  it('happy path — returns aggregated process, db, routing_brain, queue sections', async () => {
    const { upsertNote } = await import('../server/db/queries.js');
    upsertNote('setting:routing_brain_mode', 'shadow', null);

    await insertTestWorkflow({ status: 'running' });
    await insertTestWorkflow({ status: 'blocked' });
    await insertTestWorkflow({ status: 'complete' });

    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'assigned' });
    await insertTestJob({ status: 'running' });
    await insertTestJob({ status: 'done' });

    const now = Date.now();
    await insertDecision({ mode: 'shadow', created_at: now - 1000 });
    await insertDecision({ mode: 'live', created_at: now - 2000 });
    // Older than 30 days — must be excluded.
    await insertDecision({ mode: 'live', created_at: now - 31 * 24 * 60 * 60 * 1000 });

    const res = await sendRequest(app, 'GET', '/api/system/snapshot');
    expect(res.status).toBe(200);
    const body = res.body;

    expect(typeof body.process.uptime_seconds).toBe('number');
    expect(typeof body.process.rss_mb).toBe('number');
    expect(typeof body.process.node_version).toBe('string');
    expect(body.process.node_version).toMatch(/^v\d+/);

    expect(typeof body.db.last_workflow_created_at).toBe('number');
    expect(typeof body.db.last_job_completed_at).toBe('number');
    expect(body.db.workflow_counts_by_status).toMatchObject({
      running: 1,
      blocked: 1,
      complete: 1,
    });

    expect(body.routing_brain.mode).toBe('shadow');
    expect(body.routing_brain.total_decisions_30d).toBe(2);
    expect(body.routing_brain.by_mode_30d).toEqual({ shadow: 1, live: 1 });

    expect(body.queue.queued).toBe(1);
    // assigned + running = 2 active
    expect(body.queue.running).toBe(2);
    expect(body.queue.blocked).toBe(1);
  });

  it('empty DB — returns null timestamps, empty counts, mode=off', async () => {
    const res = await sendRequest(app, 'GET', '/api/system/snapshot');
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.db.last_workflow_created_at).toBeNull();
    expect(body.db.last_job_completed_at).toBeNull();
    expect(body.db.workflow_counts_by_status).toEqual({});

    expect(body.routing_brain.mode).toBe('off');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({});

    expect(body.queue.queued).toBe(0);
    expect(body.queue.running).toBe(0);
    expect(body.queue.blocked).toBe(0);
  });

  it('routing-brain zero decisions — populated workflows/jobs but no decisions', async () => {
    const { upsertNote } = await import('../server/db/queries.js');
    upsertNote('setting:routing_brain_mode', 'live', null);

    await insertTestWorkflow({ status: 'running' });
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'done' });

    const res = await sendRequest(app, 'GET', '/api/system/snapshot');
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.routing_brain.mode).toBe('live');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({});

    expect(typeof body.db.last_workflow_created_at).toBe('number');
    expect(typeof body.db.last_job_completed_at).toBe('number');
    expect(body.db.workflow_counts_by_status).toMatchObject({ running: 1 });

    expect(body.queue.queued).toBe(1);
  });
});
