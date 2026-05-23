/**
 * Tests for GET /api/system/snapshot.
 *
 * Covers:
 * - Happy path with seeded workflows, jobs, routing-brain decisions, and a mode note
 * - Empty-DB edge case (null timestamps, all-zero counts, default mode, empty decisions)
 * - Zero routing_brain decisions (routing section returns zeros while other sections populate)
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

// ─── Mocks (must come before any server module imports) ──────────────────────

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

async function get(app: express.Express, path: string) {
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
    implementerModel: 'claude-sonnet-4-6',
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/system/snapshot', () => {
  let app: express.Express;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('happy path — full seeded state', async () => {
    const project = await insertTestProject();

    // Workflows across different statuses
    await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'running' });
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    await insertTestWorkflow({ project_id: project.id, status: 'blocked' });
    await insertTestWorkflow({ project_id: project.id, status: 'failed' });

    // A done job to anchor last_job_completed_at
    const doneJob = await insertTestJob({ status: 'done' });

    // Queued and running jobs for the queue section
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'queued' });
    await insertTestJob({ status: 'running' });

    // Routing-brain mode note
    const { upsertNote } = await import('../server/db/queries.js');
    upsertNote('setting:routing_brain_mode', 'shadow', null);

    // Route decisions — 2 shadow within 30d, 1 live within 30d, 1 shadow older than 30d (excluded)
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    const oldCutoff = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await insertDecision({ workflow_id: wf.id, cycle: 1, mode: 'shadow' });
    await insertDecision({ workflow_id: wf.id, cycle: 2, mode: 'shadow' });
    await insertDecision({ workflow_id: wf.id, cycle: 3, mode: 'live' });
    await insertDecision({ workflow_id: wf.id, cycle: 4, mode: 'shadow', created_at: oldCutoff });

    const res = await get(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    const body = res.body;

    // process section
    expect(typeof body.process.uptime_seconds).toBe('number');
    expect(body.process.uptime_seconds).toBeGreaterThan(0);
    expect(typeof body.process.rss_mb).toBe('number');
    expect(body.process.rss_mb).toBeGreaterThan(0);
    expect(body.process.node_version).toBe(process.version);

    // db section
    expect(typeof body.db.last_workflow_created_at).toBe('number');
    expect(body.db.last_workflow_created_at).toBeGreaterThan(0);
    expect(typeof body.db.last_job_completed_at).toBe('number');
    expect(body.db.last_job_completed_at).toBeGreaterThanOrEqual(doneJob.updated_at);
    expect(body.db.workflow_counts_by_status).toMatchObject({
      running: 3,   // 2 + the wf we created for decisions
      complete: 1,
      blocked: 1,
      failed: 1,
      cancelled: 0,
    });

    // routing_brain section
    expect(body.routing_brain.mode).toBe('shadow');
    expect(body.routing_brain.total_decisions_30d).toBe(3); // excludes old one
    expect(body.routing_brain.by_mode_30d).toEqual({ shadow: 2, live: 1 });

    // queue section
    expect(body.queue.queued).toBe(2);
    expect(body.queue.running).toBe(1);
    expect(body.queue.blocked).toBe(1); // 1 blocked workflow
  });

  it('empty DB — null timestamps, zeros everywhere, off mode', async () => {
    const res = await get(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    const body = res.body;

    expect(typeof body.process.uptime_seconds).toBe('number');
    expect(typeof body.process.rss_mb).toBe('number');
    expect(body.process.node_version).toBe(process.version);

    expect(body.db.last_workflow_created_at).toBeNull();
    expect(body.db.last_job_completed_at).toBeNull();
    expect(body.db.workflow_counts_by_status).toEqual({
      running: 0, complete: 0, blocked: 0, failed: 0, cancelled: 0,
    });

    expect(body.routing_brain.mode).toBe('off');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({});

    expect(body.queue.queued).toBe(0);
    expect(body.queue.running).toBe(0);
    expect(body.queue.blocked).toBe(0);
  });

  it('zero routing_brain decisions — other sections still populate', async () => {
    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    await insertTestJob({ status: 'done' });
    await insertTestJob({ status: 'queued' });

    const { upsertNote } = await import('../server/db/queries.js');
    upsertNote('setting:routing_brain_mode', 'live', null);

    const res = await get(app, '/api/system/snapshot');
    expect(res.status).toBe(200);

    const body = res.body;

    // Non-routing sections should be populated
    expect(body.db.last_workflow_created_at).not.toBeNull();
    expect(body.db.last_job_completed_at).not.toBeNull();
    expect(body.db.workflow_counts_by_status.complete).toBe(1);
    expect(body.queue.queued).toBe(1);

    // Routing section should return zeros
    expect(body.routing_brain.mode).toBe('live');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({});
  });
});
