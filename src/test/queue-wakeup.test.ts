/**
 * WorkQueueManager: immediate wakeup and capacity-aware dispatch tests.
 *
 * Proves:
 * 1. Multiple queued jobs are dispatched in a single tick (capacity-aware loop)
 * 2. nudgeQueue() triggers an immediate dispatch cycle
 * 3. Dispatch respects the concurrency limit
 * 4. Jobs without a resolvable model are cooled and skipped, not blocking the queue
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
