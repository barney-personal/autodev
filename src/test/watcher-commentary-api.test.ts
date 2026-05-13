/**
 * API-route test for GET /api/agents/:id/commentary.
 *
 * Regression: the query-param parser used `parseInt(raw) || DEFAULT`, which
 * left negative numbers untouched. The result was clamped only against an
 * upper bound (Math.min(-1, 1000) === -1) and passed straight to SQLite,
 * which treats `LIMIT -1` as "no limit" — bypassing the row cap entirely
 * and letting a caller paginate the whole table in one request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type express from 'express';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
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

describe('GET /api/agents/:id/commentary — limit query param', () => {
  let app: express.Express;
  let agentId: string;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
    // Seed 50 commentary rows.
    for (let i = 0; i < 50; i++) {
      queries.insertCommentary({
        id: randomUUID(),
        watcher_id: watcher.id,
        agent_id: agentId,
        severity: 'info',
        headline: `entry-${i}`,
      });
    }
  });

  afterEach(async () => { await cleanupTestDb(); });

  it('clamps negative limit to the default (does not pass -1 through to SQLite)', async () => {
    // Spy on the underlying query so we can prove the value the route
    // resolves — not just the response body row count, which depends on
    // how many rows we seeded. The bug was that `parseInt('-1') || DEFAULT`
    // returned -1 (truthy, not NaN) and `Math.min(-1, 1000) === -1` got
    // passed straight to SQLite (`LIMIT -1` = no limit).
    const queries = await import('../server/db/queries.js');
    const spy = vi.spyOn(queries, 'listCommentaryForAgent');
    try {
      const res = await request(app).get(`/api/agents/${agentId}/commentary?limit=-1`);
      expect(res.status).toBe(200);
      // The route must have passed the default (500), not -1.
      expect(spy).toHaveBeenCalledWith(agentId, 500);
    } finally { spy.mockRestore(); }
  });

  it('honours a positive limit smaller than the default', async () => {
    const queries = await import('../server/db/queries.js');
    const spy = vi.spyOn(queries, 'listCommentaryForAgent');
    try {
      const res = await request(app).get(`/api/agents/${agentId}/commentary?limit=10`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(agentId, 10);
      expect(res.body).toHaveLength(10);
    } finally { spy.mockRestore(); }
  });

  it('clamps a limit above the hard ceiling (1000)', async () => {
    const queries = await import('../server/db/queries.js');
    const spy = vi.spyOn(queries, 'listCommentaryForAgent');
    try {
      const res = await request(app).get(`/api/agents/${agentId}/commentary?limit=99999`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(agentId, 1000);
    } finally { spy.mockRestore(); }
  });

  it('falls back to the default for non-numeric limit', async () => {
    const queries = await import('../server/db/queries.js');
    const spy = vi.spyOn(queries, 'listCommentaryForAgent');
    try {
      const res = await request(app).get(`/api/agents/${agentId}/commentary?limit=banana`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(agentId, 500);
    } finally { spy.mockRestore(); }
  });

  it('treats limit=0 as default (does not return zero rows by accident)', async () => {
    const queries = await import('../server/db/queries.js');
    const spy = vi.spyOn(queries, 'listCommentaryForAgent');
    try {
      const res = await request(app).get(`/api/agents/${agentId}/commentary?limit=0`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(agentId, 500);
    } finally { spy.mockRestore(); }
  });
});
