import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from './helpers.js';
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
vi.mock('../server/orchestrator/DebateManager.js', () => ({
  spawnInitialRoundJobs: vi.fn(() => []),
  resolvePreDebateTerminal: vi.fn(),
}));
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
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
vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  startWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  pushAndCreatePr: vi.fn(() => null),
  getPrCreationOutcome: vi.fn(() => 'no_publishable_commits'),
  cleanupWorktree: vi.fn(),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  _resetForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock'),
  buildReviewPrompt: vi.fn(() => 'mock'),
  buildImplementPrompt: vi.fn(() => 'mock'),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Smart Title' }] }) };
  },
}));

const { mockCreateAutonomousAgentRun } = vi.hoisted(() => {
  const mockCreateAutonomousAgentRun = vi.fn((req: any) => ({
    workflow: {
      id: 'wf-test-1',
      title: req.title ?? 'Test Workflow',
      task: req.task,
      status: 'running',
      implementer_model: req.implementerModel ?? 'claude-sonnet-4-6',
      reviewer_model: req.reviewerModel ?? 'codex',
      work_dir: req.workDir ?? null,
      max_cycles: req.maxCycles ?? 10,
      current_cycle: 0,
      current_phase: 'assess',
      milestones_total: 0,
      milestones_done: 0,
      project_id: 'proj-test-1',
      use_worktree: req.useWorktree ? 1 : 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    project: { id: 'proj-test-1', name: 'Test Workflow', description: '', created_at: Date.now(), updated_at: Date.now() },
    jobs: [{ id: 'assess-job-1', title: 'Assess', status: 'queued' }],
  }));
  return { mockCreateAutonomousAgentRun };
});

vi.mock('../server/orchestrator/AutonomousAgentRunManager.js', () => ({
  createAutonomousAgentRun: mockCreateAutonomousAgentRun,
}));

let app: express.Express;

describe('POST /api/tasks', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    app = createTestApp();
  });
  afterEach(async () => {
    await cleanupTestDb();
  });

  it('creates a quick (job-routed) task', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'Fix a bug', preset: 'quick' });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('job');
    expect(res.body.job).toBeTruthy();
    expect(res.body.job.description).toBe('Fix a bug');
    expect(res.body.job.status).toBe('queued');
  });

  it('creates a reviewed (job-routed) task with review config', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'Refactor auth module', preset: 'reviewed' });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('job');
    expect(res.body.job).toBeTruthy();
    // Reviewed preset enables review — job should have review_config
    expect(res.body.job.review_config).toBeTruthy();
    const reviewConfig = JSON.parse(res.body.job.review_config);
    expect(reviewConfig.auto).toBe(true);
  });

  it('creates an autonomous (workflow-routed) task', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'Build new feature', preset: 'autonomous', useWorktree: false });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('workflow');
    expect(res.body.workflow).toBeTruthy();
    expect(res.body.project).toBeTruthy();
    expect(res.body.jobs).toBeTruthy();
    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for missing description', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns 400 for invalid iterations', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'test', iterations: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/iterations/i);
  });

  it('routes to workflow when iterations > 1 without preset', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'Multi-cycle task', iterations: 5, useWorktree: false });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('workflow');
    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
    const workflowReq = mockCreateAutonomousAgentRun.mock.calls[0][0];
    expect(workflowReq.maxCycles).toBe(5);
  });

  it('routes to job when iterations = 1 with review enabled', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'Review this', review: true, iterations: 1 });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('job');
    expect(res.body.job.review_config).toBeTruthy();
  });
});

describe('Legacy endpoints still work after TaskForm consolidation', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    app = createTestApp();
  });
  afterEach(async () => {
    await cleanupTestDb();
  });

  it('POST /api/jobs still creates a job', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .send({ description: 'Legacy job endpoint' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.description).toBe('Legacy job endpoint');
  });

  it('POST /api/autonomous-agent-runs still creates a workflow', async () => {
    const res = await request(app)
      .post('/api/autonomous-agent-runs')
      .send({ task: 'Legacy workflow endpoint', useWorktree: false });
    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeTruthy();
  });
});
