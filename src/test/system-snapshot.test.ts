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
  getQueueMetrics: vi.fn(() => ({})),
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

async function sendGet(app: express.Express, path: string) {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }
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

  it('returns full snapshot with seeded data', async () => {
    const { insertJob, upsertNote } = await import('../server/db/queries.js');
    const { insertRouteDecision } = await import('../server/db/routeDecisionQueries.js');

    const project = await insertTestProject();
    const wfRunning = await insertTestWorkflow({ status: 'running', project_id: project.id });
    const wfBlocked = await insertTestWorkflow({ status: 'blocked', project_id: project.id });
    await insertTestWorkflow({ status: 'completed', project_id: project.id });

    insertJob({
      id: randomUUID(),
      title: 'queued job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'queued',
    });
    insertJob({
      id: randomUUID(),
      title: 'running job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
    });
    const doneJobId = randomUUID();
    insertJob({
      id: doneJobId,
      title: 'done job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done',
    });

    upsertNote('setting:routing_brain_mode', 'live', null);

    const now = Date.now();
    insertRouteDecision({
      id: randomUUID(),
      workflow_id: wfRunning.id,
      cycle: 1,
      phase: 'implement',
      decision: {} as any,
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'test',
      created_at: now - 1000,
    });
    insertRouteDecision({
      id: randomUUID(),
      workflow_id: wfRunning.id,
      cycle: 2,
      phase: 'implement',
      decision: {} as any,
      mode: 'shadow',
      prompt_version: 'v1',
      decision_model: 'test',
      created_at: now - 2000,
    });
    // Old decision outside 30-day window — should be excluded
    insertRouteDecision({
      id: randomUUID(),
      workflow_id: wfBlocked.id,
      cycle: 1,
      phase: 'implement',
      decision: {} as any,
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'test',
      created_at: now - 31 * 86_400_000,
    });

    // Capture counts before GET for read-only guard
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    const wfCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM workflows').get() as any).c;
    const jobCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as any).c;
    const rdCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM route_decisions').get() as any).c;
    const noteCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as any).c;

    const { status, body } = await sendGet(app, '/api/system/snapshot');

    expect(status).toBe(200);

    // process
    expect(body.process.uptime_seconds).toBeTypeOf('number');
    expect(body.process.rss_mb).toBeTypeOf('number');
    expect(body.process.node_version).toMatch(/^v\d+/);

    // db
    expect(body.db.last_workflow_created_at).toBeTypeOf('number');
    expect(body.db.last_job_completed_at).toBeTypeOf('number');
    expect(body.db.workflow_counts_by_status).toEqual({
      running: 1,
      blocked: 1,
      completed: 1,
    });

    // routing_brain
    expect(body.routing_brain.mode).toBe('live');
    expect(body.routing_brain.total_decisions_30d).toBe(2);
    expect(body.routing_brain.by_mode_30d).toEqual({ live: 1, shadow: 1 });

    // queue
    expect(body.queue.queued).toBe(1);
    expect(body.queue.running).toBe(1);
    expect(body.queue.blocked).toBe(1);

    // Read-only guard: counts unchanged
    const wfCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM workflows').get() as any).c;
    const jobCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as any).c;
    const rdCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM route_decisions').get() as any).c;
    const noteCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as any).c;
    expect(wfCountAfter).toBe(wfCountBefore);
    expect(jobCountAfter).toBe(jobCountBefore);
    expect(rdCountAfter).toBe(rdCountBefore);
    expect(noteCountAfter).toBe(noteCountBefore);
  });

  it('returns correct defaults for empty DB', async () => {
    const { status, body } = await sendGet(app, '/api/system/snapshot');

    expect(status).toBe(200);
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

  it('returns 0 routing decisions when DB has other data but no route_decisions', async () => {
    const { upsertNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    await insertTestWorkflow({ status: 'running', project_id: project.id });
    upsertNote('setting:routing_brain_mode', 'live', null);

    const { status, body } = await sendGet(app, '/api/system/snapshot');

    expect(status).toBe(200);
    expect(body.routing_brain.mode).toBe('live');
    expect(body.routing_brain.total_decisions_30d).toBe(0);
    expect(body.routing_brain.by_mode_30d).toEqual({});
    expect(body.db.workflow_counts_by_status).toEqual({ running: 1 });
  });
});
