/**
 * Tests for M1: Immediate queue wakeups and capacity-aware dispatch.
 *
 * Proves:
 * 1. Multiple ready jobs are dispatched in a single tick (capacity-aware loop)
 * 2. nudgeQueue() triggers dispatch without waiting for the 2s poll interval
 * 3. Workflow phase handoffs call nudgeQueue() so they don't depend on polling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob, insertTestProject, insertTestWorkflow, resetManagerState } from './helpers.js';

// Mock SocketManager
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock AgentRunner + PtyManager so dispatch doesn't actually spawn processes
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  reattachAgent: vi.fn(),
  getLogPath: vi.fn(() => '/dev/null'),
  cancelledAgents: new Set(),
  _resetCompletedJobsForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => ''),
  getSnapshot: vi.fn(() => ''),
  attachPty: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
}));

// Mock ModelClassifier so resolveModel just returns the job's model
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
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn((m: string) => m),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

describe('WorkQueueManager — capacity-aware dispatch', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    const { _resetForTest } = await import('../server/orchestrator/WorkQueueManager.js');
    _resetForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');
    stopWorkQueue();
    await cleanupTestDb();
  });

  it('dispatches multiple ready jobs in a single tick', async () => {
    const queries = await import('../server/db/queries.js');
    const { _tickForTest } = await import('../server/orchestrator/WorkQueueManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

    // Insert 3 queued jobs with explicit models (no API classification needed)
    await insertTestJob({ id: 'j1', title: 'Job 1', model: 'claude-sonnet-4-6' });
    await insertTestJob({ id: 'j2', title: 'Job 2', model: 'claude-sonnet-4-6' });
    await insertTestJob({ id: 'j3', title: 'Job 3', model: 'claude-sonnet-4-6' });

    // Single tick should dispatch all 3
    await _tickForTest();

    expect(vi.mocked(startInteractiveAgent)).toHaveBeenCalledTimes(3);

    // All 3 jobs should now be assigned (not still queued)
    const j1 = queries.getJobById('j1');
    const j2 = queries.getJobById('j2');
    const j3 = queries.getJobById('j3');
    expect(j1!.status).toBe('assigned');
    expect(j2!.status).toBe('assigned');
    expect(j3!.status).toBe('assigned');
  });

  it('respects concurrency limit during multi-dispatch', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

    setMaxConcurrent(2);

    await insertTestJob({ id: 'j1', title: 'Job 1', model: 'claude-sonnet-4-6' });
    await insertTestJob({ id: 'j2', title: 'Job 2', model: 'claude-sonnet-4-6' });
    await insertTestJob({ id: 'j3', title: 'Job 3', model: 'claude-sonnet-4-6' });

    await _tickForTest();

    // Only 2 should dispatch due to the concurrency cap
    expect(vi.mocked(startInteractiveAgent)).toHaveBeenCalledTimes(2);

    // Reset for other tests
    setMaxConcurrent(20);
  });

  it('nudgeQueue triggers dispatch without waiting for poll interval', async () => {
    const { nudgeQueue, startWorkQueue, stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

    // Start the queue (begins the 2s poll)
    startWorkQueue();
    // Wait for the initial tick to flush
    await new Promise(r => setTimeout(r, 50));
    vi.mocked(startInteractiveAgent).mockClear();

    // Insert a job and nudge — should dispatch within the microtask, not after 2s
    await insertTestJob({ id: 'nudge-j1', title: 'Nudge Job', model: 'claude-sonnet-4-6' });
    nudgeQueue();

    // The microtask should fire almost immediately
    await new Promise(r => setTimeout(r, 50));

    expect(vi.mocked(startInteractiveAgent)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(startInteractiveAgent).mock.calls[0][0] as any;
    expect(call.job.id).toBe('nudge-j1');

    stopWorkQueue();
  });
});

describe('WorkflowManager — nudgeQueue on phase handoff', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    const { _resetForTest } = await import('../server/orchestrator/WorkQueueManager.js');
    _resetForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');
    stopWorkQueue();
    await cleanupTestDb();
  });

  it('assess→review handoff creates a job and nudges the queue', async () => {
    const queries = await import('../server/db/queries.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const socket = await import('../server/socket/SocketManager.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Write the plan and contract notes that assess is expected to produce
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1: Do something\n- [ ] M2: Do another thing', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, 'Contract text', null);

    // Create and complete the assess job
    const assessJob = await insertTestJob({
      title: '[Workflow C0] Assess',
      status: 'done',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      model: 'claude-sonnet-4-6',
    });

    onJobCompleted(assessJob);

    // A review phase job should have been created
    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j => j.workflow_phase === 'review' && j.workflow_id === workflow.id);
    expect(reviewJob).toBeDefined();
    expect(reviewJob!.status).toBe('queued');
    expect(reviewJob!.workflow_cycle).toBe(1);

    // emitJobNew should have been called for the new review job
    expect(vi.mocked(socket.emitJobNew)).toHaveBeenCalled();
    const emittedJob = vi.mocked(socket.emitJobNew).mock.calls.find(
      (c: any[]) => c[0].workflow_phase === 'review'
    );
    expect(emittedJob).toBeDefined();
  });

  it('implement→review handoff creates next-cycle review job', async () => {
    const queries = await import('../server/db/queries.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      current_phase: 'implement',
      current_cycle: 1,
      status: 'running',
    });

    // Plan with unchecked milestones (workflow not complete yet)
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1: Done\n- [ ] M2: Not done', null);

    const implJob = await insertTestJob({
      title: '[Workflow C1] Implement',
      status: 'done',
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      model: 'claude-sonnet-4-6',
    });

    onJobCompleted(implJob);

    // Should advance to review for cycle 2
    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j => j.workflow_phase === 'review' && j.workflow_cycle === 2);
    expect(reviewJob).toBeDefined();
    expect(reviewJob!.status).toBe('queued');

    // Workflow current_cycle should be updated to 2
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.current_cycle).toBe(2);
  });
});
