import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject, insertTestWorkflow, insertTestJob } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});
vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
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
  startWorkflow: vi.fn((wf: any) => ({
    id: 'assess-job-id',
    title: 'Assess',
    status: 'queued',
    workflow_id: wf.id,
    workflow_phase: 'assess',
    workflow_cycle: 0,
  })),
  resumeWorkflow: vi.fn((wf: any) => ({
    id: 'resume-job-id',
    title: 'Resume',
    status: 'queued',
    workflow_id: wf.id,
  })),
  pushAndCreatePr: vi.fn(() => null),
  getPrCreationOutcome: vi.fn(() => 'no_publishable_commits'),
  cleanupWorktree: vi.fn(),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  _resetForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
}));

let app: express.Express;

async function insertAgent(jobId: string, overrides: Record<string, any> = {}) {
  const { insertAgent: dbInsert, getAgentWithJob } = await import('../../server/db/queries.js');
  const { randomUUID } = await import('crypto');
  const id = overrides.id ?? randomUUID();
  dbInsert({ id, job_id: jobId, status: overrides.status ?? 'running', ...overrides });
  return getAgentWithJob(id)!;
}

describe('GET /api/workflows', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/workflows');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all workflows', async () => {
    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, title: 'WF1' });
    await insertTestWorkflow({ project_id: project.id, title: 'WF2' });
    const res = await request(app).get('/api/workflows');
    expect(res.body.length).toBe(2);
  });
});

describe('GET /api/autonomous-agent-runs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('lists autonomous agent runs via the new alias route', async () => {
    const project = await insertTestProject();
    await insertTestWorkflow({ project_id: project.id, title: 'Run 1' });
    const res = await request(app).get('/api/autonomous-agent-runs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Run 1');
  });
});

describe('GET /api/workflows/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a workflow with plan and worklogs', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    const res = await request(app).get(`/api/workflows/${wf.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(wf.id);
    expect(res.body).toHaveProperty('plan');
    expect(res.body).toHaveProperty('worklogs');
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await request(app).get('/api/workflows/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/workflows/:id/jobs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns jobs for a workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });
    await insertTestJob({ workflow_id: wf.id, workflow_phase: 'assess' });
    await insertTestJob({ workflow_id: wf.id, workflow_phase: 'review' });
    const res = await request(app).get(`/api/workflows/${wf.id}/jobs`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await request(app).get('/api/workflows/nonexistent/jobs');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflows', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates a workflow', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .send({ task: 'Build a feature' });
    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeTruthy();
    expect(res.body.project).toBeTruthy();
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.workflow.task).toBe('Build a feature');
    expect(res.body.workflow.status).toBe('running');
  });

  it('sets custom title and models', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .send({
        task: 'Refactor auth',
        title: 'Auth Refactor',
        implementerModel: 'claude-opus-4-6',
        reviewerModel: 'claude-sonnet-4-6',
        maxCycles: 5,
      });
    expect(res.status).toBe(201);
    expect(res.body.workflow.title).toBe('Auth Refactor');
    expect(res.body.workflow.implementer_model).toBe('claude-opus-4-6');
    expect(res.body.workflow.max_cycles).toBe(5);
  });

  it('rejects missing task', async () => {
    const res = await request(app).post('/api/workflows').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/task/i);
  });

  it('rejects empty task', async () => {
    const res = await request(app).post('/api/workflows').send({ task: '  ' });
    expect(res.status).toBe(400);
  });

  it('clamps maxCycles to valid range', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .send({ task: 'test', maxCycles: 100 });
    expect(res.status).toBe(201);
    expect(res.body.workflow.max_cycles).toBeLessThanOrEqual(50);
  });

  it('emits socket events', async () => {
    const socket = await import('../../server/socket/SocketManager.js');
    await request(app).post('/api/workflows').send({ task: 'test' });
    expect(socket.emitWorkflowNew).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/autonomous-agent-runs', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('creates an autonomous agent run via the new route', async () => {
    const res = await request(app)
      .post('/api/autonomous-agent-runs')
      .send({ task: 'Ship the feature' });
    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeTruthy();
    expect(res.body.workflow.title).toMatch(/^Autonomous Agent Run:/);
    expect(res.body.jobs).toHaveLength(1);
  });
});

describe('POST /api/workflows/:id/cancel', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('cancels a running workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    const res = await request(app).post(`/api/workflows/${wf.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('cancels a blocked workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'blocked' });
    const res = await request(app).post(`/api/workflows/${wf.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('rejects cancelling a completed workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    const res = await request(app).post(`/api/workflows/${wf.id}/cancel`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await request(app).post('/api/workflows/nonexistent/cancel');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflows/:id/resume', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('resumes a blocked workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'blocked' });
    const res = await request(app).post(`/api/workflows/${wf.id}/resume`);
    expect(res.status).toBe(200);
    expect(res.body.workflow).toBeTruthy();
    expect(res.body.jobs).toHaveLength(1);
  });

  it('rejects resuming a running workflow', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    const res = await request(app).post(`/api/workflows/${wf.id}/resume`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });

  it('force=true resumes a running workflow by marking it blocked first', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'running' });
    const res = await request(app)
      .post(`/api/workflows/${wf.id}/resume`)
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.workflow).toBeTruthy();
    expect(res.body.jobs).toHaveLength(1);
    // resumeWorkflow should have been called with the updated (blocked) workflow object
    const { resumeWorkflow } = await import('../../server/orchestrator/WorkflowManager.js');
    expect(resumeWorkflow).toHaveBeenCalledTimes(1);
    const calledWith = (resumeWorkflow as any).mock.calls[0][0];
    expect(calledWith.status).toBe('blocked');
  });

  it('returns 500 JSON when resumeWorkflow throws', async () => {
    const { resumeWorkflow } = await import('../../server/orchestrator/WorkflowManager.js');
    (resumeWorkflow as any).mockImplementationOnce(() => {
      throw new Error('Worktree branch verification failed: expected branch xyz');
    });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'blocked' });
    const res = await request(app).post(`/api/workflows/${wf.id}/resume`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Worktree branch verification failed/);
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await request(app).post('/api/workflows/nonexistent/resume');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/workflows/:id/wrap-up', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('completes and cleans up when a draft PR is created', async () => {
    const { pushAndCreatePr, getPrCreationOutcome, cleanupWorktree } = await import('../../server/orchestrator/WorkflowManager.js');
    vi.mocked(pushAndCreatePr).mockReturnValue('https://github.com/test/repo/pull/42');
    vi.mocked(getPrCreationOutcome).mockReturnValue('created');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, {
      worktree_path: '/tmp/worktree',
      worktree_branch: 'workflow/test-branch',
    });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('draft_pr_created');
    expect(res.body.pr_url).toBe('https://github.com/test/repo/pull/42');
    expect(res.body.workflow.status).toBe('complete');
    expect(vi.mocked(cleanupWorktree)).toHaveBeenCalledTimes(1);
  });

  it('preserves the worktree and blocks the workflow when draft PR creation fails with publishable commits', async () => {
    const { pushAndCreatePr, getPrCreationOutcome, cleanupWorktree } = await import('../../server/orchestrator/WorkflowManager.js');
    vi.mocked(pushAndCreatePr).mockReturnValue(null);
    vi.mocked(getPrCreationOutcome).mockReturnValue('failed_with_publishable_commits');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, {
      worktree_path: '/tmp/worktree',
      worktree_branch: 'workflow/test-branch',
    });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);
    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('draft_pr_failed_preserved');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('blocked');
    expect(res.body.workflow.blocked_reason).toContain('Draft PR creation failed');
    expect(res.body.workflow.blocked_reason).toContain('/tmp/worktree');
    expect(vi.mocked(cleanupWorktree)).not.toHaveBeenCalled();
  });

  it('blocks with descriptive reason when worktree_path is missing but milestones_done > 0', async () => {
    const { getPrCreationOutcome, cleanupWorktree } = await import('../../server/orchestrator/WorkflowManager.js');
    vi.mocked(getPrCreationOutcome).mockReturnValue('no_publishable_commits');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      milestones_total: 5,
      milestones_done: 3,
    });
    // Deliberately do NOT set worktree_path — simulating lost metadata

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);
    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('missing_worktree_with_progress');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('blocked');
    expect(res.body.workflow.blocked_reason).toContain('worktree metadata missing');
    expect(res.body.workflow.blocked_reason).toContain('3/5 milestones');
    expect(vi.mocked(cleanupWorktree)).not.toHaveBeenCalled();
  });

  it('cancels wrap-up explicitly when there are no publishable commits', async () => {
    const { pushAndCreatePr, getPrCreationOutcome, cleanupWorktree } = await import('../../server/orchestrator/WorkflowManager.js');
    vi.mocked(pushAndCreatePr).mockReturnValue(null);
    vi.mocked(getPrCreationOutcome).mockReturnValue('no_publishable_commits');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, {
      worktree_path: '/tmp/worktree',
      worktree_branch: 'workflow/test-branch',
    });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('no_publishable_commits');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('cancelled');
    expect(vi.mocked(cleanupWorktree)).toHaveBeenCalledTimes(1);
  });

  it('cancels running agents with pid, tmux, snapshot, lock cleanup, and emitAgentUpdate during wrap-up (Fix-C17b)', async () => {
    const { pushAndCreatePr, getPrCreationOutcome } = await import('../../server/orchestrator/WorkflowManager.js');
    const { cancelledAgents } = await import('../../server/orchestrator/AgentRunner.js');
    const { getFileLockRegistry } = await import('../../server/orchestrator/FileLockRegistry.js');
    const { isTmuxSessionAlive, saveSnapshot } = await import('../../server/orchestrator/PtyManager.js');
    const { execFileSync } = await import('child_process');
    const queries = await import('../../server/db/queries.js');
    const socket = await import('../../server/socket/SocketManager.js');

    vi.mocked(pushAndCreatePr).mockReturnValue(null);
    vi.mocked(getPrCreationOutcome).mockReturnValue('no_publishable_commits');
    vi.mocked(isTmuxSessionAlive).mockReturnValue(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    try {
      const project = await insertTestProject();
      const workflow = await insertTestWorkflow({
        project_id: project.id,
        status: 'running',
        current_phase: 'implement',
        use_worktree: 1,
      });
      queries.updateWorkflow(workflow.id, {
        worktree_path: '/tmp/worktree',
        worktree_branch: 'workflow/test-branch',
      });

      const job = await insertTestJob({
        workflow_id: workflow.id,
        workflow_phase: 'implement',
        status: 'running',
      });
      const agent = await insertAgent(job.id, {
        id: 'wrapup-running-agent',
        status: 'running',
        pid: 4321,
      });

      const res = await request(app).post(`/api/workflows/${workflow.id}/wrap-up`);

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('no_publishable_commits');
      expect(cancelledAgents.has(agent.id)).toBe(true);

      // tmux snapshot saved before kill
      expect(vi.mocked(isTmuxSessionAlive)).toHaveBeenCalledWith(agent.id);
      expect(vi.mocked(saveSnapshot)).toHaveBeenCalledWith(agent.id);

      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', `orchestrator-${agent.id}`],
        { stdio: 'pipe' },
      );

      const registry = vi.mocked(getFileLockRegistry).mock.results[0]?.value;
      expect(registry.releaseAll).toHaveBeenCalledWith(agent.id);

      const updatedAgent = queries.getAgentById(agent.id);
      const updatedJob = queries.getJobById(job.id);
      expect(updatedAgent?.status).toBe('cancelled');
      expect(updatedAgent?.finished_at).toEqual(expect.any(Number));
      expect(updatedJob?.status).toBe('cancelled');

      // emitAgentUpdate called for cancelled agent
      expect(socket.emitAgentUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: agent.id,
        status: 'cancelled',
      }));
      expect(socket.emitJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: job.id,
        status: 'cancelled',
      }));
    } finally {
      killSpy.mockRestore();
    }
  });

  it('cancels waiting_user agents with pending question timeout and emitAgentUpdate during wrap-up (Fix-C16b)', async () => {
    const { pushAndCreatePr, getPrCreationOutcome } = await import('../../server/orchestrator/WorkflowManager.js');
    const { cancelledAgents } = await import('../../server/orchestrator/AgentRunner.js');
    const { getFileLockRegistry } = await import('../../server/orchestrator/FileLockRegistry.js');
    const { execFileSync } = await import('child_process');
    const queries = await import('../../server/db/queries.js');
    const socket = await import('../../server/socket/SocketManager.js');

    vi.mocked(pushAndCreatePr).mockReturnValue(null);
    vi.mocked(getPrCreationOutcome).mockReturnValue('no_publishable_commits');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    try {
      const project = await insertTestProject();
      const workflow = await insertTestWorkflow({
        project_id: project.id,
        status: 'running',
        current_phase: 'implement',
        use_worktree: 1,
      });
      queries.updateWorkflow(workflow.id, {
        worktree_path: '/tmp/worktree',
        worktree_branch: 'workflow/test-branch',
      });

      const job = await insertTestJob({
        workflow_id: workflow.id,
        workflow_phase: 'implement',
        status: 'running',
      });
      const agent = await insertAgent(job.id, {
        id: 'wrapup-waiting-agent',
        status: 'waiting_user',
        pid: 5555,
      });

      // Insert a pending question for this agent
      const { randomUUID } = await import('crypto');
      const questionId = randomUUID();
      queries.insertQuestion({
        id: questionId,
        agent_id: agent.id,
        question: 'Should I proceed?',
        answer: null,
        status: 'pending',
        asked_at: Date.now() - 60000,
        answered_at: null,
        timeout_ms: 300000,
      });

      const res = await request(app).post(`/api/workflows/${workflow.id}/wrap-up`);

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('no_publishable_commits');

      // waiting_user agent was cancelled
      expect(cancelledAgents.has(agent.id)).toBe(true);
      const updatedAgent = queries.getAgentById(agent.id);
      expect(updatedAgent?.status).toBe('cancelled');
      expect(updatedAgent?.finished_at).toEqual(expect.any(Number));

      // Process killed and tmux cleaned up
      expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', `orchestrator-${agent.id}`],
        { stdio: 'pipe' },
      );

      // Locks released
      const registry = vi.mocked(getFileLockRegistry).mock.results[0]?.value;
      expect(registry.releaseAll).toHaveBeenCalledWith(agent.id);

      // Pending question timed out
      const updatedQuestion = queries.getQuestionById(questionId);
      expect(updatedQuestion?.status).toBe('timeout');
      expect(updatedQuestion?.answer).toContain('Workflow wrapped up');
      expect(updatedQuestion?.answered_at).toEqual(expect.any(Number));

      // emitAgentUpdate called so UI updates immediately
      expect(socket.emitAgentUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: agent.id,
        status: 'cancelled',
      }));

      // Job also cancelled
      const updatedJob = queries.getJobById(job.id);
      expect(updatedJob?.status).toBe('cancelled');
      expect(socket.emitJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: job.id,
        status: 'cancelled',
      }));
    } finally {
      killSpy.mockRestore();
    }
  });
});
