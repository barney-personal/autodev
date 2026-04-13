/**
 * Workflow queue-wakeup tests.
 *
 * Verifies that all workflow job-creation paths (startWorkflow, resumeWorkflow,
 * and phase-handoff via onJobCompleted → spawnPhaseJob) call nudgeQueue() so
 * workflow-generated jobs are dispatched immediately instead of waiting for
 * the 2s poll interval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// Mock fs so pre-flight existsSync passes for test paths
vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => true) };
});

// Mock child_process so pre-flight git check passes
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
}));

// Mock SocketManager
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock PtyManager (prevent real tmux sessions)
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  ensureCodexTrusted: vi.fn(),
}));

// Mock AgentRunner (prevent real subprocess spawning)
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  getLogPath: vi.fn(() => '/tmp/test-log'),
  _resetCompletedJobsForTest: vi.fn(),
}));

// Mock ModelClassifier
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'circuit closed',
    recordModelLimited: () => {},
    recordModelAvailable: () => {},
    recordInfraFailure: () => {},
    recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
  getAvailableModel: vi.fn((model: string) => model),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

// Mock WorkflowPrompts
vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess'),
  buildReviewPrompt: vi.fn(() => 'mock review'),
  buildImplementPrompt: vi.fn(() => 'mock implement'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
}));

// Mock FailureClassifier
vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

describe('Workflow queue wakeups', () => {
  let nudgeQueueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();

    // Spy on nudgeQueue so we can verify it gets called
    const queueMod = await import('../server/orchestrator/WorkQueueManager.js');
    nudgeQueueSpy = vi.spyOn(queueMod, 'nudgeQueue');
  });

  afterEach(async () => {
    nudgeQueueSpy?.mockRestore();
    await cleanupTestDb();
  });

  it('startWorkflow calls nudgeQueue after inserting the assess job', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    const wf = await insertTestWorkflow({
      status: 'running',
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    startWorkflow(wf);

    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);
  });

  it('resumeWorkflow calls nudgeQueue after inserting the resumed job', async () => {
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    const wf = await insertTestWorkflow({
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    resumeWorkflow(wf);

    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);
  });

  it('assess→review phase handoff calls nudgeQueue', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const wf = await insertTestWorkflow({
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    // Write required notes so the assess→review transition succeeds
    queries.upsertNote(`workflow/${wf.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${wf.id}/contract`, '# contract', null);

    // Create a completed assess job
    const job = await insertTestJob({
      status: 'done',
      workflow_id: wf.id,
      workflow_phase: 'assess',
      workflow_cycle: 0,
      model: 'claude-sonnet-4-6',
    });

    nudgeQueueSpy.mockClear();
    onJobCompleted({ ...job, status: 'done' } as any);

    // spawnPhaseJob('review') should have triggered nudgeQueue
    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);

    // Verify a review job was actually created
    const jobs = queries.listJobs();
    const reviewJob = jobs.find((j: any) => j.workflow_phase === 'review');
    expect(reviewJob).toBeTruthy();
    expect(reviewJob!.workflow_id).toBe(wf.id);
  });

  it('review→implement phase handoff calls nudgeQueue', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const wf = await insertTestWorkflow({
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    // Plan with unchecked milestones so workflow doesn't complete
    queries.upsertNote(`workflow/${wf.id}/plan`, '- [ ] M1\n- [x] M2', null);

    const job = await insertTestJob({
      status: 'done',
      workflow_id: wf.id,
      workflow_phase: 'review',
      workflow_cycle: 1,
      model: 'claude-sonnet-4-6',
    });

    nudgeQueueSpy.mockClear();
    onJobCompleted({ ...job, status: 'done' } as any);

    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);

    const jobs = queries.listJobs();
    const implJob = jobs.find((j: any) => j.workflow_phase === 'implement');
    expect(implJob).toBeTruthy();
  });

  it('implement→review cycle advance calls nudgeQueue', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const wf = await insertTestWorkflow({
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      max_cycles: 10,
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    // Plan with unchecked milestones so workflow advances to next cycle
    queries.upsertNote(`workflow/${wf.id}/plan`, '- [ ] M1\n- [x] M2', null);

    const job = await insertTestJob({
      status: 'done',
      workflow_id: wf.id,
      workflow_phase: 'implement',
      workflow_cycle: 1,
      model: 'claude-sonnet-4-6',
    });

    nudgeQueueSpy.mockClear();
    onJobCompleted({ ...job, status: 'done' } as any);

    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);

    // Should have spawned a review job for cycle 2
    const jobs = queries.listJobs();
    const reviewJob = jobs.find((j: any) => j.workflow_phase === 'review' && j.workflow_cycle === 2);
    expect(reviewJob).toBeTruthy();
  });

  it('rate-limit fallback retry calls nudgeQueue', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure, isFallbackEligibleFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getFallbackModel, getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    const queries = await import('../server/db/queries.js');

    // Configure classifyJobFailure to return 'rate_limit'
    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit' as any);
    vi.mocked(isFallbackEligibleFailure).mockReturnValue(true);
    // Configure getFallbackModel to return a different model
    vi.mocked(getFallbackModel).mockReturnValue('codex');
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'claude-sonnet-4-6') return null;
      return model;
    });

    const wf = await insertTestWorkflow({
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    const job = await insertTestJob({
      status: 'failed',
      workflow_id: wf.id,
      workflow_phase: 'implement',
      workflow_cycle: 1,
      model: 'claude-sonnet-4-6',
    });

    nudgeQueueSpy.mockClear();
    onJobCompleted({ ...job, status: 'failed' } as any);

    // spawnPhaseJob with fallback model should trigger nudgeQueue
    expect(nudgeQueueSpy).toHaveBeenCalledTimes(1);

    // Verify a fallback job was created
    const jobs = queries.listJobs();
    const fallbackJob = jobs.find((j: any) =>
      j.workflow_phase === 'implement' && j.id !== job.id
    );
    expect(fallbackJob).toBeTruthy();
  });

  it('startWorkflow-created job is dispatched immediately via nudgeQueue + tick', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { startWorkQueue, stopWorkQueue, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);
    startWorkQueue();

    // Wait for initial tick to clear
    await new Promise(r => setTimeout(r, 50));
    vi.clearAllMocks();

    const wf = await insertTestWorkflow({
      status: 'running',
      use_worktree: 0,
      work_dir: '/tmp/test',
    });

    // startWorkflow inserts a job and nudges — the job should be dispatched
    // on the next microtask, not wait for the 2s poll
    startWorkflow(wf);

    // Wait for the nudge microtask to fire
    await new Promise(r => setTimeout(r, 50));

    // The assess job should have been picked up and dispatched
    const agentNewCalls = vi.mocked(socket.emitAgentNew).mock.calls;
    expect(agentNewCalls.length).toBe(1);

    stopWorkQueue();
  });
});
