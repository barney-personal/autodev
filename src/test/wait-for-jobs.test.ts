import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock socket before any import that touches it
vi.mock('../server/socket/SocketManager.js', () => ({
  initSocketManager: vi.fn(),
  getIo: vi.fn(() => ({ emit: vi.fn() })),
  emitSnapshot: vi.fn(),
  emitAgentNew: vi.fn(),
  emitAgentUpdate: vi.fn(),
  emitAgentOutput: vi.fn(),
  emitJobNew: vi.fn(),
  emitJobUpdate: vi.fn(),
  emitWorkflowNew: vi.fn(),
  emitWorkflowUpdate: vi.fn(),
  emitDebateNew: vi.fn(),
  emitDebateUpdate: vi.fn(),
  emitWarningNew: vi.fn(),
  emitQuestionNew: vi.fn(),
  emitQuestionAnswered: vi.fn(),
  emitLockAcquired: vi.fn(),
  emitLockReleased: vi.fn(),
  emitProjectNew: vi.fn(),
  emitPtyData: vi.fn(),
  emitPtyClosed: vi.fn(),
  emitDiscussionNew: vi.fn(),
  emitDiscussionMessage: vi.fn(),
  emitDiscussionUpdate: vi.fn(),
  emitProposalNew: vi.fn(),
  emitProposalUpdate: vi.fn(),
  emitProposalMessage: vi.fn(),
  emitPrNew: vi.fn(),
  emitPrReviewNew: vi.fn(),
  emitPrReviewUpdate: vi.fn(),
  emitPrReviewMessage: vi.fn(),
}));

describe('wait_for_jobs backoff', () => {
  it('uses progressive polling intervals capped at 5s', async () => {
    const { nextWaitPollMs } = await import('../server/mcp/tools/waitForJobs.js');

    expect(nextWaitPollMs(0)).toBe(500);
    expect(nextWaitPollMs(1)).toBe(1000);
    expect(nextWaitPollMs(2)).toBe(2000);
    expect(nextWaitPollMs(3)).toBe(3000);
    expect(nextWaitPollMs(4)).toBe(5000);
    expect(nextWaitPollMs(99)).toBe(5000);
  });
});

describe('JobCompletionNotifier', () => {
  it('notifies listeners when a terminal event fires', async () => {
    const { notifyJobTerminal, onAnyTerminal } = await import(
      '../server/orchestrator/JobCompletionNotifier.js'
    );

    const wakeup = onAnyTerminal(['job-a', 'job-b']);
    // Simulate job-b reaching terminal state
    notifyJobTerminal('job-b', 'done');

    const result = await wakeup.promise;
    expect(result).toBe('job-b');
  });

  it('ignores non-terminal statuses', async () => {
    const { notifyJobTerminal, onAnyTerminal } = await import(
      '../server/orchestrator/JobCompletionNotifier.js'
    );

    const wakeup = onAnyTerminal(['job-c']);

    // These should NOT resolve the promise
    notifyJobTerminal('job-c', 'running');
    notifyJobTerminal('job-c', 'assigned');
    notifyJobTerminal('job-c', 'queued');

    // Give the event loop a chance to process
    await new Promise(resolve => setTimeout(resolve, 50));

    // Now send a terminal event
    notifyJobTerminal('job-c', 'failed');
    const result = await wakeup.promise;
    expect(result).toBe('job-c');
  });

  it('cancel() removes listeners without leaking', async () => {
    const { onAnyTerminal, _getEmitter } = await import(
      '../server/orchestrator/JobCompletionNotifier.js'
    );

    const emitter = _getEmitter();
    const before = emitter.listenerCount('terminal:job-d');

    const wakeup = onAnyTerminal(['job-d']);
    expect(emitter.listenerCount('terminal:job-d')).toBe(before + 1);

    wakeup.cancel();
    expect(emitter.listenerCount('terminal:job-d')).toBe(before);
  });

  it('handles cancelled status as terminal', async () => {
    const { notifyJobTerminal, onAnyTerminal } = await import(
      '../server/orchestrator/JobCompletionNotifier.js'
    );

    const wakeup = onAnyTerminal(['job-e']);
    notifyJobTerminal('job-e', 'cancelled');
    const result = await wakeup.promise;
    expect(result).toBe('job-e');
  });
});

describe('wait_for_jobs event-driven wakeup (integration)', () => {
  beforeEach(async () => {
    const { setupTestDb } = await import('./helpers.js');
    await setupTestDb();
  });

  afterEach(async () => {
    const { cleanupTestDb } = await import('./helpers.js');
    await cleanupTestDb();
  });

  it('wakes within 500ms when a waited job reaches terminal state via updateJobStatus', async () => {
    const queries = await import('../server/db/queries.js');
    const { waitForJobsHandler } = await import('../server/mcp/tools/waitForJobs.js');

    // Create a job and agent
    const job = queries.insertJob({
      id: 'wake-job-1',
      title: 'Test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({ id: 'wake-agent-1', job_id: job.id, status: 'running' });

    const startMs = Date.now();

    // Start waiting in the background
    const waitPromise = waitForJobsHandler('wake-agent-1', {
      job_ids: [job.id],
      timeout_ms: 30000,
    });

    // Give the handler time to enter its poll loop
    await new Promise(resolve => setTimeout(resolve, 50));

    // Now mark the job as done — this should wake the handler immediately
    queries.updateJobStatus(job.id, 'done');

    const result = JSON.parse(await waitPromise);
    const elapsedMs = Date.now() - startMs;

    // Should have woken up well within 500ms of the terminal event
    // (the 50ms initial delay plus event delivery should be < 500ms total)
    expect(elapsedMs).toBeLessThan(500);
    expect(result).toBeInstanceOf(Array);
    expect(result[0].status).toBe('done');
  });

  it('wakes on watchdog/recovery terminal transition (failed)', async () => {
    const queries = await import('../server/db/queries.js');
    const { waitForJobsHandler } = await import('../server/mcp/tools/waitForJobs.js');

    const job = queries.insertJob({
      id: 'wake-job-2',
      title: 'Test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({ id: 'wake-agent-2', job_id: job.id, status: 'running' });

    const startMs = Date.now();

    const waitPromise = waitForJobsHandler('wake-agent-2', {
      job_ids: [job.id],
      timeout_ms: 30000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Simulate watchdog marking the job as failed
    queries.updateJobStatus(job.id, 'failed');

    const result = JSON.parse(await waitPromise);
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(500);
    expect(result).toBeInstanceOf(Array);
    expect(result[0].status).toBe('failed');
  });

  it('cleans up listeners after the wait completes', async () => {
    const queries = await import('../server/db/queries.js');
    const { waitForJobsHandler } = await import('../server/mcp/tools/waitForJobs.js');
    const { _getEmitter } = await import('../server/orchestrator/JobCompletionNotifier.js');

    const emitter = _getEmitter();

    const job = queries.insertJob({
      id: 'cleanup-job-1',
      title: 'Test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({ id: 'cleanup-agent-1', job_id: job.id, status: 'running' });

    const listenersBefore = emitter.listenerCount('terminal:cleanup-job-1');

    const waitPromise = waitForJobsHandler('cleanup-agent-1', {
      job_ids: [job.id],
      timeout_ms: 30000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    // Should have a listener now
    expect(emitter.listenerCount('terminal:cleanup-job-1')).toBeGreaterThan(listenersBefore);

    // Complete the job
    queries.updateJobStatus(job.id, 'done');
    await waitPromise;

    // Listeners should be cleaned up
    expect(emitter.listenerCount('terminal:cleanup-job-1')).toBe(listenersBefore);
  });

  it('wakes immediately for already-terminal jobs without waiting', async () => {
    const queries = await import('../server/db/queries.js');
    const { waitForJobsHandler } = await import('../server/mcp/tools/waitForJobs.js');

    // Job is already done before we start waiting
    const job = queries.insertJob({
      id: 'already-done-1',
      title: 'Test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({ id: 'already-agent-1', job_id: job.id, status: 'done' });

    const startMs = Date.now();
    const result = JSON.parse(await waitForJobsHandler('already-agent-1', {
      job_ids: [job.id],
      timeout_ms: 30000,
    }));
    const elapsedMs = Date.now() - startMs;

    // Should return immediately on the first check
    expect(elapsedMs).toBeLessThan(100);
    expect(result).toBeInstanceOf(Array);
    expect(result[0].status).toBe('done');
  });

  it('handles multi-job waits where jobs complete at different times', async () => {
    const queries = await import('../server/db/queries.js');
    const { waitForJobsHandler } = await import('../server/mcp/tools/waitForJobs.js');

    const job1 = queries.insertJob({
      id: 'multi-job-1',
      title: 'Test 1',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    const job2 = queries.insertJob({
      id: 'multi-job-2',
      title: 'Test 2',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({ id: 'multi-agent-1', job_id: job1.id, status: 'running' });

    const waitPromise = waitForJobsHandler('multi-agent-1', {
      job_ids: [job1.id, job2.id],
      timeout_ms: 30000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Complete first job — handler should wake and re-enter loop
    queries.updateJobStatus(job1.id, 'done');
    await new Promise(resolve => setTimeout(resolve, 50));

    // Complete second job — handler should wake and return
    queries.updateJobStatus(job2.id, 'done');

    const result = JSON.parse(await waitPromise);
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(2);
    expect(result[0].status).toBe('done');
    expect(result[1].status).toBe('done');
  });
});
