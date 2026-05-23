/**
 * Unit tests for GET /api/system/snapshot.
 *
 * Covers:
 * - Happy path: workflows, jobs, and route decisions are aggregated correctly
 * - Empty DB: all counts are 0 and nulls are returned where appropriate
 * - Zero routing-brain decisions: mode is deterministic, decision counts are 0
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
} from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type express from 'express';
import type { RouteDecision, RouteDecisionMode } from '../shared/types.js';

interface TestResponse {
  status: number;
  body: any;
}

async function sendRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<TestResponse> {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function request(app: express.Express) {
  return {
    get: (path: string) => sendRequest(app, 'GET', path),
  };
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
  mode: RouteDecisionMode;
  created_at?: number;
}) {
  const { insertRouteDecision } = await import('../server/db/routeDecisionQueries.js');
  return insertRouteDecision({
    id: randomUUID(),
    workflow_id: args.workflow_id,
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
  let savedRoutingBrainMode: string | undefined;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
    savedRoutingBrainMode = process.env.ROUTING_BRAIN_MODE;
    delete process.env.ROUTING_BRAIN_MODE;
  });

  afterEach(async () => {
    if (savedRoutingBrainMode !== undefined) {
      process.env.ROUTING_BRAIN_MODE = savedRoutingBrainMode;
    } else {
      delete process.env.ROUTING_BRAIN_MODE;
    }
    await cleanupTestDb();
  });

  it('happy path: aggregates workflows, jobs, and route decisions correctly', async () => {
    const project = await insertTestProject();

    // Insert workflows with different statuses
    const wfRunning = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    await insertTestWorkflow({ project_id: project.id, status: 'blocked' });

    // Insert jobs with various statuses
    const { insertJob } = await import('../server/db/queries.js');
    insertJob({ id: randomUUID(), title: 'queued job', description: 'q', context: null, priority: 0, status: 'queued' });
    insertJob({ id: randomUUID(), title: 'assigned job', description: 'a', context: null, priority: 0, status: 'assigned' });
    insertJob({ id: randomUUID(), title: 'running job', description: 'r', context: null, priority: 0, status: 'running' });
    insertJob({ id: randomUUID(), title: 'done job', description: 'd', context: null, priority: 0, status: 'done' });

    // Insert 2 recent route decisions (shadow + live) and 1 stale (older than 30d)
    const now = Date.now();
    const staleMs = now - 31 * 24 * 60 * 60 * 1000;
    await insertDecision({ workflow_id: wfRunning.id, mode: 'shadow' });
    await insertDecision({ workflow_id: wfRunning.id, mode: 'live' });
    await insertDecision({ workflow_id: wfRunning.id, mode: 'shadow', created_at: staleMs });

    const res = await request(app).get('/api/system/snapshot');
    expect(res.status).toBe(200);

    const { body } = res;

    // process
    expect(body.process.node_version).toBe(process.version);
    expect(typeof body.process.uptime_seconds).toBe('number');
    expect(typeof body.process.rss_mb).toBe('number');

    // db
    expect(typeof body.db.last_workflow_created_at).toBe('number');
    expect(body.db.last_workflow_created_at).toBeGreaterThan(0);
    expect(typeof body.db.last_job_completed_at).toBe('number');
    expect(body.db.last_job_completed_at).toBeGreaterThan(0);
    expect(body.db.workflow_counts_by_status.running).toBe(1);
    expect(body.db.workflow_counts_by_status.complete).toBe(1);
    expect(body.db.workflow_counts_by_status.blocked).toBe(1);
    expect(body.db.workflow_counts_by_status.failed).toBe(0);
    expect(body.db.workflow_counts_by_status.cancelled).toBe(0);

    // queue: assigned + running = 2
    expect(body.queue.queued).toBe(1);
    expect(body.queue.running).toBe(2);
    expect(body.queue.blocked).toBe(1);

    // routing_brain: only 2 recent decisions (stale excluded)
    expect(body.routing_brain.total_decisions_30d).toBe(2);
    expect(body.routing_brain.by_mode_30d.shadow).toBe(1);
    expect(body.routing_brain.by_mode_30d.live).toBe(1);
    expect(body.routing_brain.by_mode_30d.fallback).toBe(0);
  });

  it('empty DB edge case: returns nulls and zeros', async () => {
    const res = await request(app).get('/api/system/snapshot');
    expect(res.status).toBe(200);

    const { body } = res;

    expect(body.db.last_workflow_created_at).toBeNull();
    expect(body.db.last_job_completed_at).toBeNull();

    // All five WorkflowStatus keys present and 0
    expect(body.db.workflow_counts_by_status).toEqual({
      running: 0,
      complete: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
    });

    expect(body.queue.queued).toBe(0);
    expect(body.queue.running).toBe(0);
    expect(body.queue.blocked).toBe(0);

    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({ shadow: 0, live: 0, fallback: 0 });
  });

  it('zero routing-brain decisions with other activity present', async () => {
    // Control routing-brain mode via env (no DB setting)
    process.env.ROUTING_BRAIN_MODE = 'shadow';

    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });

    const { insertJob } = await import('../server/db/queries.js');
    insertJob({ id: randomUUID(), title: 'queued job', description: 'q', context: null, priority: 0, status: 'queued' });
    insertJob({ id: randomUUID(), title: 'done job', description: 'd', context: null, priority: 0, status: 'done' });

    // No decisions inserted
    const res = await request(app).get('/api/system/snapshot');
    expect(res.status).toBe(200);

    const { body } = res;

    // Mode should reflect env var since no DB setting exists
    expect(body.routing_brain.mode).toBe('shadow');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({ shadow: 0, live: 0, fallback: 0 });

    // db and queue still reflect inserted data
    expect(body.db.workflow_counts_by_status.running).toBe(1);
    expect(body.db.workflow_counts_by_status.complete).toBe(1);
    expect(body.queue.queued).toBe(1);
    expect(typeof body.db.last_job_completed_at).toBe('number');
  });
});
