/**
 * WorkQueueManager: immediate wakeup, capacity-aware dispatch, and reentrancy guard tests.
 *
 * Proves:
 * 1. Multiple queued jobs are dispatched in a single tick (capacity-aware loop)
 * 2. nudgeQueue() triggers an immediate dispatch cycle
 * 3. Dispatch respects the concurrency limit
 * 4. Jobs without a resolvable model are cooled and skipped, not blocking the queue
 * 5. Concurrent tick() invocations do not double-dispatch (reentrancy guard)
 * 6. A nudge arriving during an in-flight tick results in eventual dispatch via re-tick
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestJob,
} from './helpers.js';

// Mock SocketManager
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock AgentRunner (prevent real subprocess spawning)
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  getLogPath: vi.fn(() => '/tmp/test-log'),
  _resetCompletedJobsForTest: vi.fn(),
}));

// Mock PtyManager (prevent real tmux sessions)
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  ensureCodexTrusted: vi.fn(),
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
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
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

describe('WorkQueueManager: capacity-aware dispatch', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('dispatches multiple ready jobs in a single tick', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const socket = await import('../server/socket/SocketManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

    setMaxConcurrent(10);

    // Insert 3 queued jobs with models already set (no classification needed)
    await insertTestJob({ title: 'Job A', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    await insertTestJob({ title: 'Job B', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    await insertTestJob({ title: 'Job C', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Run one tick
    await _tickForTest();

    // All 3 jobs should have been dispatched (agents created)
    const agentNewCalls = vi.mocked(socket.emitAgentNew).mock.calls;
    expect(agentNewCalls.length).toBe(3);

    // All 3 should have had startInteractiveAgent called
    expect(vi.mocked(startInteractiveAgent).mock.calls.length).toBe(3);
  });

  it('respects the concurrency limit', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const socket = await import('../server/socket/SocketManager.js');
    const { insertAgent } = await import('../server/db/queries.js');

    // Set low concurrency
    setMaxConcurrent(2);

    // Pre-existing running agent (counts against limit)
    const existingJob = await insertTestJob({ title: 'Existing', model: 'claude-sonnet-4-6', status: 'assigned' });
    insertAgent({ id: 'existing-agent', job_id: existingJob.id, status: 'running' });

    // Insert 3 queued jobs
    await insertTestJob({ title: 'Job A', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    await insertTestJob({ title: 'Job B', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    await insertTestJob({ title: 'Job C', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    await _tickForTest();

    // Only 1 should be dispatched (2 max - 1 existing = 1 slot)
    const agentNewCalls = vi.mocked(socket.emitAgentNew).mock.calls;
    expect(agentNewCalls.length).toBe(1);
  });

  it('skips jobs with no resolvable model and continues to next job', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { resolveModel } = await import('../server/orchestrator/ModelClassifier.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);

    // First job has no model (resolveModel returns null)
    const noModelJob = await insertTestJob({ title: 'No Model', model: null, work_dir: '/tmp/nonexistent', priority: 10 });
    // Second job has a model
    await insertTestJob({ title: 'Has Model', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent', priority: 0 });

    // resolveModel returns null for the first job, model for the second
    vi.mocked(resolveModel).mockImplementation(async (job: any) => {
      if (job.id === noModelJob.id) return null;
      return job.model ?? 'claude-sonnet-4-6';
    });

    await _tickForTest();

    // Should have dispatched the second job despite the first being unresolvable
    const agentNewCalls = vi.mocked(socket.emitAgentNew).mock.calls;
    expect(agentNewCalls.length).toBe(1);
  });
});

describe('WorkQueueManager: nudgeQueue', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');
    stopWorkQueue();
    await cleanupTestDb();
  });

  it('nudgeQueue triggers dispatch without waiting for poll interval', async () => {
    const { startWorkQueue, stopWorkQueue, nudgeQueue, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);

    // Start the queue (begins normal polling)
    startWorkQueue();

    // Wait for initial tick to clear
    await new Promise(r => setTimeout(r, 50));
    vi.clearAllMocks();

    // Insert a job AFTER the initial tick
    await insertTestJob({ title: 'Nudged Job', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Nudge the queue — should dispatch on next microtask, not wait for 2s poll
    nudgeQueue();

    // Wait for the microtask to resolve
    await new Promise(r => setTimeout(r, 50));

    // The job should have been dispatched
    const agentNewCalls = vi.mocked(socket.emitAgentNew).mock.calls;
    expect(agentNewCalls.length).toBe(1);

    stopWorkQueue();
  });

  it('multiple nudges within the same microtask coalesce into one tick', async () => {
    const { startWorkQueue, stopWorkQueue, nudgeQueue, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { resolveModel } = await import('../server/orchestrator/ModelClassifier.js');

    setMaxConcurrent(10);
    startWorkQueue();

    // Wait for initial tick to clear
    await new Promise(r => setTimeout(r, 50));

    let resolveCallCount = 0;
    vi.mocked(resolveModel).mockImplementation(async (job: any) => {
      resolveCallCount++;
      return job.model ?? 'claude-sonnet-4-6';
    });

    // Insert a job
    await insertTestJob({ title: 'Coalesce Test', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Multiple synchronous nudges
    nudgeQueue();
    nudgeQueue();
    nudgeQueue();

    // Wait for microtask
    await new Promise(r => setTimeout(r, 50));

    // resolveModel should have been called exactly once (one tick, one job)
    expect(resolveCallCount).toBe(1);

    stopWorkQueue();
  });
});

describe('WorkQueueManager: dispatch failure cleans up agent', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('marks agent as failed when runAgent throws', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');
    const { listAgents, listJobs } = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);

    // Insert a Codex job that will use runAgent (not startInteractiveAgent)
    await insertTestJob({ title: 'Failing Codex Job', model: 'codex', work_dir: '/tmp/nonexistent' });

    // Make runAgent throw (simulating writeFileSync/openSync failure)
    vi.mocked(runAgent).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await _tickForTest();

    // The job should be marked as failed
    const jobs = listJobs();
    const failedJob = jobs.find((j: any) => j.title === 'Failing Codex Job');
    expect(failedJob?.status).toBe('failed');

    // The agent should also be marked as failed (not left in 'starting')
    const agents = listAgents();
    const agent = agents.find((a: any) => a.job_id === failedJob?.id);
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('failed');
    expect(agent!.error_message).toContain('ENOSPC');
    expect(agent!.finished_at).not.toBeNull();

    // emitAgentUpdate should have been called with the failed agent
    const agentUpdateCalls = vi.mocked(socket.emitAgentUpdate).mock.calls;
    expect(agentUpdateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('marks agent as failed when startInteractiveAgent throws', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');
    const { listAgents } = await import('../server/db/queries.js');

    setMaxConcurrent(10);

    // Insert a Claude job that will use startInteractiveAgent
    await insertTestJob({ title: 'Failing Claude Job', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Make startInteractiveAgent throw
    vi.mocked(startInteractiveAgent).mockImplementationOnce(() => {
      throw new Error('tmux session creation failed');
    });

    await _tickForTest();

    // The agent should be marked as failed
    const agents = listAgents();
    const agent = agents.find((a: any) => a.status === 'failed' && a.error_message?.includes('tmux'));
    expect(agent).toBeDefined();
    expect(agent!.finished_at).not.toBeNull();
  });

  it('handles dispatch failure before agent row is created', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { resolveModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { listAgents, getJobById } = await import('../server/db/queries.js');

    setMaxConcurrent(10);

    const job = await insertTestJob({ title: 'Pre-Agent Fail', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Make resolveModel throw (failure before agent row is created)
    vi.mocked(resolveModel).mockImplementationOnce(async () => {
      throw new Error('classification API down');
    });

    await _tickForTest();

    // Job should be failed
    const updatedJob = getJobById(job.id);
    expect(updatedJob!.status).toBe('failed');

    // No orphaned starting agents
    const startingAgents = listAgents('starting' as any);
    expect(startingAgents).toHaveLength(0);
  });
});

describe('WorkQueueManager: tick() reentrancy guard', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { stopWorkQueue } = await import('../server/orchestrator/WorkQueueManager.js');
    stopWorkQueue();
    await cleanupTestDb();
  });

  it('concurrent tick() calls do not double-dispatch a single job', async () => {
    const { _tickForTest, setMaxConcurrent } = await import('../server/orchestrator/WorkQueueManager.js');
    const { resolveModel } = await import('../server/orchestrator/ModelClassifier.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);

    // Hold resolveModel open so tick1 stays in-flight when tick2 starts
    let unblockResolve!: () => void;
    vi.mocked(resolveModel).mockImplementation(async (job: any) => {
      await new Promise<void>(r => { unblockResolve = r; });
      return (job as any).model ?? 'claude-sonnet-4-6';
    });

    await insertTestJob({ title: 'Job A', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });

    // Start tick1 — it will enter tick(), set _tickInProgress=true, then block on resolveModel.
    // Because tick() runs synchronously up to its first await, _tickInProgress is already true
    // by the time _tickForTest() returns its Promise.
    const tick1 = _tickForTest();

    // tick2 arrives while tick1 is in-flight: tick() sees _tickInProgress=true,
    // sets _retickRequested=true, and returns without dispatching anything.
    const tick2 = _tickForTest();

    // Unblock tick1 and let both settle
    unblockResolve();
    await Promise.all([tick1, tick2]);

    // Only one agent should have been created (tick2 was a no-op, not a second dispatch)
    expect(vi.mocked(socket.emitAgentNew).mock.calls.length).toBe(1);
  });

  it('a nudge during an in-flight tick results in eventual dispatch via re-tick', async () => {
    const { startWorkQueue, stopWorkQueue, nudgeQueue, setMaxConcurrent } =
      await import('../server/orchestrator/WorkQueueManager.js');
    const { resolveModel } = await import('../server/orchestrator/ModelClassifier.js');
    const socket = await import('../server/socket/SocketManager.js');

    setMaxConcurrent(10);
    startWorkQueue();

    // Let the startup tick drain (queue is empty, exits immediately)
    await new Promise(r => setTimeout(r, 50));
    vi.clearAllMocks();

    // resolveModel for Job A blocks until we release it
    let unblockA!: () => void;
    vi.mocked(resolveModel).mockImplementation(async (job: any) => {
      if ((job as any).title === 'Job A') {
        await new Promise<void>(r => { unblockA = r; });
      }
      return (job as any).model ?? 'claude-sonnet-4-6';
    });

    // Insert Job A and nudge — tick starts and blocks inside resolveModel
    await insertTestJob({ title: 'Job A', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    nudgeQueue();

    // Flush microtasks: nudge microtask fires, tick() runs until await resolveModel
    await new Promise(r => setTimeout(r, 0));

    // At this point _tickInProgress is true. Insert Job B and nudge.
    // The nudge's microtask will call tick(), which will see _tickInProgress=true
    // and set _retickRequested=true instead of running a second concurrent tick.
    await insertTestJob({ title: 'Job B', model: 'claude-sonnet-4-6', work_dir: '/tmp/nonexistent' });
    nudgeQueue();

    // Flush: nudge microtask fires, tick() returns early with _retickRequested=true
    await new Promise(r => setTimeout(r, 0));

    // Unblock resolveModel — tick1 finishes dispatching A, then sees _retickRequested
    // and schedules a follow-up tick that dispatches B
    unblockA();

    // Wait for the re-tick to fire and finish
    await new Promise(r => setTimeout(r, 50));

    // Both Job A and Job B should have been dispatched exactly once each
    expect(vi.mocked(socket.emitAgentNew).mock.calls.length).toBe(2);

    stopWorkQueue();
  });
});
