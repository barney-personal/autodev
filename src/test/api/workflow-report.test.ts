import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestWorkflow, insertTestJob } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));
vi.mock('../../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => []),
  getSnapshot: vi.fn(() => null),
  attachPty: vi.fn(),
  startInteractiveAgent: vi.fn(),
}));
vi.mock('../../server/orchestrator/WorkflowManager.js', () => ({
  startWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  pushAndCreatePr: vi.fn(() => null),
  getPrCreationOutcome: vi.fn(() => 'no_publishable_commits'),
  pushBranch: vi.fn(() => ({ ok: true })),
  createWorkflowPr: vi.fn(() => ({ ok: false, error: 'mock' })),
  probeRecoverableWorkflowWork: vi.fn(() => ({ status: 'clean', detail: 'clean', baseRef: 'origin/main' })),
  cleanupWorktree: vi.fn(),
  quarantineWorktree: vi.fn(() => ({ ok: true, path: '/tmp/q' })),
  captureAgentCreatedPrUrl: vi.fn(() => ({ found: false })),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  _resetForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
}));

let app: express.Express;

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('AUTH_TOKEN', '');
  await setupTestDb();
  vi.clearAllMocks();
  app = createTestApp();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTestDb();
});

async function seedCompleted() {
  const { insertAgent, updateAgent, upsertNote, insertVerifyRun, updateWorkflow } = await import('../../server/db/queries.js');
  const wf = await insertTestWorkflow({ id: 'wf-report-complete', title: 'Completed run', task: 'Do the work', status: 'complete', milestones_total: 2, milestones_done: 2 });
  updateWorkflow(wf.id, { pr_url: 'https://github.com/example/repo/pull/7', worktree_branch: 'workflow/report' });
  upsertNote(`workflow/${wf.id}/plan`, '- [x] M1\n- [x] M2', null);
  const job = await insertTestJob({ workflow_id: wf.id, workflow_phase: 'implement', workflow_cycle: 1, status: 'done', description: 'SENTINEL_PROMPT' });
  insertAgent({ id: 'ag-report-1', job_id: job.id, status: 'done', started_at: 1_000_000, finished_at: 1_060_000 });
  updateAgent('ag-report-1', { cost_usd: 1.5, diff: 'SENTINEL_DIFF' });
  insertVerifyRun({ id: 'vr-report-1', workflow_id: wf.id, cycle: 1, attempt: 1, command: 'npm test', exit_code: 0, stdout: 'SENTINEL_STDOUT', stderr: 'SENTINEL_STDERR', duration_ms: 5000, created_at: 1_100_000 });
  return wf;
}

describe('GET /api/workflows/:id/report', () => {
  it('returns 404 JSON for an unknown workflow', async () => {
    const res = await request(app).get('/api/workflows/nope/report');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('downloads a Markdown attachment with safe headers for a completed run', async () => {
    const wf = await seedCompleted();
    const res = await request(app).get(`/api/workflows/${wf.id}/report`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="autodev-workflow-wf-report-complete-report.md"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('# Workflow report: Completed run');
    expect(res.text).toContain('point-in-time snapshot');
    expect(res.text).toContain('[Open pull request](https://github.com/example/repo/pull/7)');
    expect(res.text).toContain('1 verification run: 1 passed');
    expect(res.text).toContain('USD 1.50 (1 of 1 attempts had recorded cost)');
    expect(res.text).not.toMatch(/SENTINEL_/);
  });

  it('is also served under the autonomous-agent-runs alias', async () => {
    const wf = await seedCompleted();
    const res = await request(app).get(`/api/autonomous-agent-runs/${wf.id}/report`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  it('reports a sparse blocked workflow as unavailable rather than zero', async () => {
    const { updateWorkflow } = await import('../../server/db/queries.js');
    const wf = await insertTestWorkflow({ status: 'blocked' });
    updateWorkflow(wf.id, { blocked_reason: 'branch push failed: auth' });
    await insertTestJob({ workflow_id: wf.id, workflow_phase: 'assess', workflow_cycle: 0, status: 'failed' });
    const res = await request(app).get(`/api/workflows/${wf.id}/report`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('## Blocked reason');
    expect(res.text).toContain('branch push failed: auth');
    expect(res.text).toContain('Unavailable — no agent attempts recorded');
    expect(res.text).toContain('No plan saved');
    expect(res.text).not.toMatch(/\$0\.00|USD 0\.0000/);
  });

  it('returns a generic 500 without leaking internals when generation fails', async () => {
    const wf = await insertTestWorkflow();
    const { getDb } = await import('../../server/db/database.js');
    getDb().prepare('DROP TABLE verify_runs').run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/workflows/${wf.id}/report`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'failed to generate report' });
    expect(res.text).not.toMatch(/verify_runs|no such table|\.ts|at /);
  });

  describe('auth and origin policy (unchanged, inherited from authMiddleware)', () => {
    it('allows anonymous access when AUTH_TOKEN is unset or empty', async () => {
      const wf = await seedCompleted();
      vi.stubEnv('AUTH_TOKEN', '');
      expect((await request(app).get(`/api/workflows/${wf.id}/report`)).status).toBe(200);
      vi.unstubAllEnvs();
      const saved = process.env.AUTH_TOKEN;
      delete process.env.AUTH_TOKEN;
      try {
        expect((await request(app).get(`/api/workflows/${wf.id}/report`)).status).toBe(200);
      } finally {
        if (saved !== undefined) process.env.AUTH_TOKEN = saved;
      }
    });

    it('requires credentials when AUTH_TOKEN is set and accepts bearer or session cookie', async () => {
      const wf = await seedCompleted();
      vi.stubEnv('AUTH_TOKEN', 'report-secret');
      const { sessionCookie } = await import('../../server/lib/auth.js');
      const url = `/api/workflows/${wf.id}/report`;
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url).set('Authorization', 'Bearer wrong')).status).toBe(403);
      expect((await request(app).get(url).set('Authorization', 'Bearer report-secret')).status).toBe(200);
      const cookie = sessionCookie(false).split(';')[0];
      expect((await request(app).get(url).set('Cookie', cookie)).status).toBe(200);
    });

    it('rejects cross-origin requests and accepts same-host origins', async () => {
      const wf = await seedCompleted();
      const url = `/api/workflows/${wf.id}/report`;
      const cross = await request(app).get(url).set('Origin', 'https://evil.example');
      expect(cross.status).toBe(403);
      expect(cross.text).not.toContain('Workflow report');
      const same = await request(app).get(url).set('Host', 'localhost:3456').set('Origin', 'http://localhost:3456');
      expect(same.status).toBe(200);
    });
  });
});
