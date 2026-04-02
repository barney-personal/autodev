/**
 * Tests for workflow latency metrics: query layer, API endpoint, and health integration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject, insertTestWorkflow, insertTestJob } from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type express from 'express';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  startWorkflow: vi.fn((wf: any) => ({
    id: 'assess-job-id', title: 'Assess', status: 'queued',
    workflow_id: wf.id, workflow_phase: 'assess', workflow_cycle: 0,
  })),
  resumeWorkflow: vi.fn(),
  cleanupWorktree: vi.fn(),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  _resetForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
}));

// Helpers to insert agents with timing data
async function insertTestAgent(overrides: {
  id?: string; job_id: string; status?: string;
  started_at?: number; finished_at?: number | null; cost_usd?: number | null;
}) {
  const { insertAgent, updateAgent } = await import('../server/db/queries.js');
  const id = overrides.id ?? randomUUID();
  const agent = insertAgent({
    id,
    job_id: overrides.job_id,
    status: (overrides.status ?? 'done') as any,
    started_at: overrides.started_at ?? Date.now(),
    finished_at: overrides.finished_at ?? null,
  });
  // cost_usd is not part of insertAgent's INSERT columns, so set it via update
  if (overrides.cost_usd != null) {
    updateAgent(id, { cost_usd: overrides.cost_usd });
  }
  return agent;
}

let app: express.Express;

describe('getWorkflowMetrics', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns null for nonexistent workflow', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    expect(getWorkflowMetrics('nonexistent')).toBeNull();
  });

  it('returns empty phases for workflow with no jobs', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    const metrics = getWorkflowMetrics(wf.id);
    expect(metrics).not.toBeNull();
    expect(metrics!.phases).toHaveLength(0);
    expect(metrics!.summary.phase_count).toBe(0);
    expect(metrics!.summary.total_agent_ms).toBe(0);
    expect(metrics!.summary.total_cost_usd).toBe(0);
  });

  it('computes queue_wait_ms from agent start - job creation', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    const baseTime = 1_700_000_000_000;
    const job = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'done',
    });
    // Manually set job.created_at for deterministic timing
    const { getDb } = await import('../server/db/database.js');
    getDb().prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(baseTime, job.id);
    await insertTestAgent({ job_id: job.id, started_at: baseTime + 2000, finished_at: baseTime + 60000, cost_usd: 0.05 });

    const metrics = getWorkflowMetrics(wf.id)!;
    expect(metrics.phases).toHaveLength(1);
    expect(metrics.phases[0].queue_wait_ms).toBe(2000);
    expect(metrics.phases[0].agent_duration_ms).toBe(58000);
    expect(metrics.phases[0].agent_cost_usd).toBe(0.05);
  });

  it('computes handoff_ms between consecutive phases', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    const baseTime = 1_700_000_000_000;
    const { getDb } = await import('../server/db/database.js');

    // Phase 1: assess
    const job1 = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'done',
    });
    getDb().prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(baseTime, job1.id);
    await insertTestAgent({ job_id: job1.id, started_at: baseTime + 1000, finished_at: baseTime + 30000 });

    // Phase 2: review (created 500ms after assess agent finished)
    const job2 = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'review', status: 'done',
    });
    getDb().prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(baseTime + 30500, job2.id);
    await insertTestAgent({ job_id: job2.id, started_at: baseTime + 32000, finished_at: baseTime + 90000 });

    const metrics = getWorkflowMetrics(wf.id)!;
    expect(metrics.phases).toHaveLength(2);
    // Handoff from assess -> review: review.created_at - assess.finished_at = 30500 - 30000 = 500ms
    expect(metrics.phases[0].handoff_ms).toBe(500);
    // Last phase has no handoff
    expect(metrics.phases[1].handoff_ms).toBeNull();
  });

  it('computes summary aggregates correctly', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    const baseTime = 1_700_000_000_000;
    const { getDb } = await import('../server/db/database.js');

    // 3 phases with known timings
    const timings = [
      { phase: 'assess', cycle: 0, created: baseTime, started: baseTime + 1000, finished: baseTime + 10000, cost: 0.10 },
      { phase: 'review', cycle: 0, created: baseTime + 10200, started: baseTime + 11000, finished: baseTime + 20000, cost: 0.05 },
      { phase: 'implement', cycle: 1, created: baseTime + 20500, started: baseTime + 21000, finished: baseTime + 50000, cost: 0.20 },
    ];
    for (const t of timings) {
      const job = await insertTestJob({
        workflow_id: wf.id, workflow_cycle: t.cycle, workflow_phase: t.phase, status: 'done',
      });
      getDb().prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(t.created, job.id);
      await insertTestAgent({ job_id: job.id, started_at: t.started, finished_at: t.finished, cost_usd: t.cost });
    }

    const metrics = getWorkflowMetrics(wf.id)!;
    expect(metrics.summary.phase_count).toBe(3);
    // Queue waits: 1000 + 800 + 500 = 2300
    expect(metrics.summary.total_queue_wait_ms).toBe(2300);
    // Agent durations: 9000 + 9000 + 29000 = 47000
    expect(metrics.summary.total_agent_ms).toBe(47000);
    // Handoffs: (10200-10000) + (20500-20000) = 200 + 500 = 700
    expect(metrics.summary.total_handoff_ms).toBe(700);
    // Avg queue wait: 2300/3 ≈ 767
    expect(metrics.summary.avg_queue_wait_ms).toBe(767);
    // Avg handoff: 700/2 = 350 (only 2 handoffs, last phase has none)
    expect(metrics.summary.avg_handoff_ms).toBe(350);
    // Total cost: 0.35
    expect(metrics.summary.total_cost_usd).toBeCloseTo(0.35, 4);
    // Wall clock: finished status → last finished_at - first created_at = 50000 - baseTime...
    // but since status is 'complete', endTime = lastFinished = baseTime+50000
    // firstCreated = baseTime
    expect(metrics.summary.total_wall_clock_ms).toBe(50000);
  });

  it('uses current time for wall clock of running workflow', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    const baseTime = Date.now() - 60000; // started 60s ago
    const { getDb } = await import('../server/db/database.js');

    const job = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'running',
    });
    getDb().prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(baseTime, job.id);
    await insertTestAgent({ job_id: job.id, started_at: baseTime + 1000, finished_at: null });

    const metrics = getWorkflowMetrics(wf.id)!;
    // Wall clock should be approximately 60s (using Date.now() - baseTime)
    expect(metrics.summary.total_wall_clock_ms).toBeGreaterThanOrEqual(59000);
    expect(metrics.summary.total_wall_clock_ms).toBeLessThan(65000);
  });

  it('handles phases without agents gracefully', async () => {
    const { getWorkflowMetrics } = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });

    // Job with no agent (e.g. queued but not yet dispatched)
    await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'queued',
    });

    const metrics = getWorkflowMetrics(wf.id)!;
    expect(metrics.phases).toHaveLength(1);
    expect(metrics.phases[0].queue_wait_ms).toBeNull();
    expect(metrics.phases[0].agent_duration_ms).toBeNull();
    expect(metrics.phases[0].handoff_ms).toBeNull();
    expect(metrics.summary.avg_queue_wait_ms).toBeNull();
  });
});

describe('GET /api/workflows/:id/metrics', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns metrics for a workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    const job = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'done',
    });
    await insertTestAgent({ job_id: job.id, started_at: Date.now() - 5000, finished_at: Date.now(), cost_usd: 0.01 });

    const res = await request(app).get(`/api/workflows/${wf.id}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.workflow_id).toBe(wf.id);
    expect(res.body.phases).toHaveLength(1);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.phase_count).toBe(1);
    expect(res.body.summary.total_cost_usd).toBeCloseTo(0.01, 4);
  });

  it('also available via autonomous-agent-runs alias', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });

    const res = await request(app).get(`/api/autonomous-agent-runs/${wf.id}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.workflow_id).toBe(wf.id);
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await request(app).get('/api/workflows/nonexistent/metrics');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/health — workflow latency', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('includes latency data for running workflows', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running', title: 'Test Run' });
    const job = await insertTestJob({
      workflow_id: wf.id, workflow_cycle: 0, workflow_phase: 'assess', status: 'done',
    });
    await insertTestAgent({ job_id: job.id, started_at: Date.now() - 10000, finished_at: Date.now() - 5000, cost_usd: 0.02 });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.workflows.latency).toBeDefined();
    expect(res.body.checks.workflows.latency).toHaveLength(1);
    expect(res.body.checks.workflows.latency[0].id).toBe(wf.id);
    expect(res.body.checks.workflows.latency[0].title).toBe('Test Run');
    expect(res.body.checks.workflows.latency[0].wall_clock_ms).toBeGreaterThan(0);
    expect(res.body.checks.workflows.latency[0].total_cost_usd).toBeCloseTo(0.02, 4);
  });

  it('omits latency when no active workflows', async () => {
    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, status: 'complete' });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    // No latency key when no active workflows
    expect(res.body.checks.workflows.latency).toBeUndefined();
  });

  it('includes blocked workflows in latency', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'blocked', title: 'Blocked Run' });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.workflows.latency).toHaveLength(1);
    expect(res.body.checks.workflows.latency[0].id).toBe(wf.id);
  });
});
