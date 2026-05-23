/**
 * Unit tests for GET /api/system/snapshot.
 *
 * Three scenarios:
 * 1. Happy path — DB populated with workflows, jobs, routing-brain notes, decisions.
 * 2. Empty DB — all counters zero, timestamps null, mode falls back to 'off'.
 * 3. Zero decisions — workflows/jobs/settings exist but no route_decisions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { randomUUID } from 'crypto';

// ─── Mocks (mirror routing-brain-api.test.ts) ────────────────────────────────
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendGet(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }
}

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
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/system/snapshot', () => {
  let app: express.Express;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('happy path — returns correct shape with populated DB', async () => {
    const { upsertNote, updateJobStatus } = await import('../server/db/queries.js');

    // Seed routing-brain mode
    upsertNote('setting:routing_brain_mode', 'shadow', null);

    // Insert project + workflows across two statuses (running + blocked)
    const project = await insertTestProject();
    const runningWf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'blocked' });

    // Insert jobs across statuses: queued, assigned, running, done
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'assigned' });
    await insertTestJob({ status: 'running' });
    const doneJob = await insertTestJob({ status: 'queued' });
    updateJobStatus(doneJob.id, 'done');

    // Insert route decisions: shadow + live
    await insertDecision({ workflow_id: runningWf.id, cycle: 1, mode: 'shadow' });
    await insertDecision({ workflow_id: runningWf.id, cycle: 2, mode: 'shadow' });
    await insertDecision({ workflow_id: runningWf.id, cycle: 3, mode: 'live' });

    const res = await sendGet(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    // Top-level keys
    expect(res.body).toHaveProperty('process');
    expect(res.body).toHaveProperty('db');
    expect(res.body).toHaveProperty('routing_brain');
    expect(res.body).toHaveProperty('queue');

    // process (dynamic — flexible assertions)
    expect(res.body.process.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(res.body.process.rss_mb).toBeGreaterThan(0);
    expect(res.body.process.node_version).toBe(process.version);

    // db — timestamps are non-null since we inserted rows
    expect(typeof res.body.db.last_workflow_created_at).toBe('number');
    expect(typeof res.body.db.last_job_completed_at).toBe('number');

    // workflow_counts_by_status — zero-filled for all statuses
    const wc = res.body.db.workflow_counts_by_status;
    expect(wc).toHaveProperty('running', 1);
    expect(wc).toHaveProperty('blocked', 1);
    expect(wc).toHaveProperty('complete', 0);
    expect(wc).toHaveProperty('failed', 0);
    expect(wc).toHaveProperty('cancelled', 0);

    // routing_brain
    expect(res.body.routing_brain.mode).toBe('shadow');
    expect(res.body.routing_brain.total_decisions_30d).toBe(3);
    expect(res.body.routing_brain.by_mode_30d).toEqual({ shadow: 2, live: 1, fallback: 0 });

    // queue — running = assigned + running, queued, blocked
    expect(res.body.queue.queued).toBe(1);
    expect(res.body.queue.running).toBe(2); // 1 assigned + 1 running
    expect(res.body.queue.blocked).toBe(1);
  });

  it('empty DB — timestamps null, counts zero-filled, mode defaults to off', async () => {
    const res = await sendGet(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    // process fields still valid
    expect(res.body.process.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(res.body.process.rss_mb).toBeGreaterThan(0);
    expect(res.body.process.node_version).toBe(process.version);

    // timestamps are null when nothing in DB
    expect(res.body.db.last_workflow_created_at).toBeNull();
    expect(res.body.db.last_job_completed_at).toBeNull();

    // all workflow statuses zero
    const wc = res.body.db.workflow_counts_by_status;
    expect(wc).toEqual({ running: 0, complete: 0, blocked: 0, failed: 0, cancelled: 0 });

    // routing_brain fallback
    expect(res.body.routing_brain.mode).toBe('off');
    expect(res.body.routing_brain.total_decisions_30d).toBe(0);
    expect(res.body.routing_brain.by_mode_30d).toEqual({ shadow: 0, live: 0, fallback: 0 });

    // queue all zero
    expect(res.body.queue.queued).toBe(0);
    expect(res.body.queue.running).toBe(0);
    expect(res.body.queue.blocked).toBe(0);
  });

  it('zero decisions — decision counts are 0 even when workflows/jobs/settings exist', async () => {
    const { upsertNote } = await import('../server/db/queries.js');

    upsertNote('setting:routing_brain_mode', 'live', null);
    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestJob({ status: 'queued' });

    // No route decisions inserted

    const res = await sendGet(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    expect(res.body.routing_brain.mode).toBe('live');
    expect(res.body.routing_brain.total_decisions_30d).toBe(0);
    expect(res.body.routing_brain.by_mode_30d).toEqual({ shadow: 0, live: 0, fallback: 0 });
  });
});
