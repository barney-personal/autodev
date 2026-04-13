/**
 * Critical-path idempotency tests (M7a, part 1).
 *
 * Proves:
 * 1. finishJobHandler idempotency — calling twice returns 'Already completed.'
 *    on the second call and handleJobCompletion only runs once.
 * 2. handleJobCompletion dedup — calling twice for the same agent only fires
 *    workflow/debate callbacks once (via _completedJobs Set).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  ensureCodexTrusted: vi.fn(),
  disconnectAgent: vi.fn(),
}));

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
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
  exec: vi.fn((_cmd: string, _opts: any, cb: any) => {
    process.nextTick(() => cb(null, { stdout: '', stderr: '' }));
    return { on: vi.fn() };
  }),
}));

vi.mock('../server/orchestrator/CompletionChecks.js', () => ({
  runCompletionChecks: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

vi.mock('../server/orchestrator/MemoryTriager.js', () => ({
  triageLearnings: vi.fn(async () => {}),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(),
  clearRecoveryState: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/PrCreator.js', () => ({
  createPrForJob: vi.fn(async () => null),
  pushBranchForFailedJob: vi.fn(),
}));

vi.mock('../server/orchestrator/EyeConfig.js', () => ({
  buildEyePrompt: vi.fn(() => 'mock eye prompt'),
  isEyeJob: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

// Mock WorkflowManager and DebateManager so we can spy on onJobCompleted calls
vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: finishJobHandler idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('finishJobHandler: idempotency', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('returns "Already completed." on second call and only calls handleJobCompletion once', async () => {
    const queries = await import('../server/db/queries.js');
    const { finishJobHandler } = await import('../server/mcp/tools/finishJob.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');
    const { onJobCompleted: debateCallback } = await import('../server/orchestrator/DebateManager.js');

    // Create a job + agent in running state
    const job = await insertTestJob({ id: 'finish-idem-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'finish-idem-agent', job_id: job.id, status: 'running' });
    queries.updateJobStatus(job.id, 'running');

    // First call: should process normally
    const result1 = await finishJobHandler(agent.id, { result: 'Done!' });
    const parsed1 = JSON.parse(result1);
    expect(parsed1.ok).toBe(true);
    expect(parsed1.message).toBe('Task complete. Session closing.');

    // Verify agent is now in terminal state
    const agentAfter1 = queries.getAgentById(agent.id);
    expect(agentAfter1?.status).toBe('done');

    // Second call: should return 'Already completed.' without re-processing
    const result2 = await finishJobHandler(agent.id, { result: 'Done again!' });
    const parsed2 = JSON.parse(result2);
    expect(parsed2.ok).toBe(true);
    expect(parsed2.message).toBe('Already completed.');

    // Workflow/debate callbacks should have been called exactly once (from first call)
    // The second call short-circuits before handleJobCompletion
    expect(wfCallback).toHaveBeenCalledTimes(1);
    expect(debateCallback).toHaveBeenCalledTimes(1);
  });

  it('stores result text even on duplicate calls', async () => {
    const queries = await import('../server/db/queries.js');
    const { finishJobHandler } = await import('../server/mcp/tools/finishJob.js');

    const job = await insertTestJob({ id: 'finish-result-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'finish-result-agent', job_id: job.id, status: 'running' });
    queries.updateJobStatus(job.id, 'running');

    // First call
    await finishJobHandler(agent.id, { result: 'First result' });

    // Second call — result should still be stored even though processing is skipped
    await finishJobHandler(agent.id, { result: 'Second result' });

    // Both result events should be in agent_output (result text is never lost)
    const db = (await import('../server/db/database.js')).getDb();
    const outputs = db.prepare(
      "SELECT content FROM agent_output WHERE agent_id = ? AND event_type = 'result' ORDER BY seq"
    ).all(agent.id) as Array<{ content: string }>;
    expect(outputs).toHaveLength(2);
    expect(JSON.parse(outputs[0].content).result).toBe('First result');
    expect(JSON.parse(outputs[1].content).result).toBe('Second result');
  });

  it('promotes assigned jobs to running before completing them', async () => {
    const queries = await import('../server/db/queries.js');
    const { finishJobHandler } = await import('../server/mcp/tools/finishJob.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const job = await insertTestJob({ id: 'finish-assigned-job', status: 'assigned' });
      const agent = queries.insertAgent({ id: 'finish-assigned-agent', job_id: job.id, status: 'running' });

      const result = await finishJobHandler(agent.id, { result: 'Done from assigned' });
      expect(JSON.parse(result).ok).toBe(true);
      expect(queries.getJobById(job.id)?.status).toBe('done');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("illegal job transition 'assigned' → 'done'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: handleJobCompletion dedup
// ─────────────────────────────────────────────────────────────────────────────

describe('handleJobCompletion: dedup guard', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('fires callbacks once on first call, skips entirely on second call', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');
    const { onJobCompleted: debateCallback } = await import('../server/orchestrator/DebateManager.js');

    const job = await insertTestJob({ id: 'dedup-hc-job', status: 'running' });
    const agent = queries.insertAgent({ id: 'dedup-hc-agent', job_id: job.id, status: 'running' });
    queries.updateJobStatus(job.id, 'running');

    // First call: full processing
    await handleJobCompletion(agent.id, job, 'done');
    expect(wfCallback).toHaveBeenCalledTimes(1);
    expect(debateCallback).toHaveBeenCalledTimes(1);

    // Reset mock call counts (but NOT _completedJobs — that's the dedup state)
    vi.mocked(wfCallback).mockClear();
    vi.mocked(debateCallback).mockClear();

    // Second call with same agentId: should return early without calling callbacks
    await handleJobCompletion(agent.id, job, 'done');
    expect(wfCallback).toHaveBeenCalledTimes(0);
    expect(debateCallback).toHaveBeenCalledTimes(0);
  });

  it('different agents are processed independently', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');

    const job1 = await insertTestJob({ id: 'dedup-job-1', status: 'running' });
    const agent1 = queries.insertAgent({ id: 'dedup-agent-1', job_id: job1.id, status: 'running' });
    queries.updateJobStatus(job1.id, 'running');

    const job2 = await insertTestJob({ id: 'dedup-job-2', status: 'running' });
    const agent2 = queries.insertAgent({ id: 'dedup-agent-2', job_id: job2.id, status: 'running' });
    queries.updateJobStatus(job2.id, 'running');

    await handleJobCompletion(agent1.id, job1, 'done');
    await handleJobCompletion(agent2.id, job2, 'done');

    // Both agents processed — callbacks fired twice total (once each)
    expect(wfCallback).toHaveBeenCalledTimes(2);
  });

  it('ignores a late completion callback after the job is already terminal', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleJobCompletion } = await import('../server/orchestrator/AgentRunner.js');
    const { onJobCompleted: wfCallback } = await import('../server/orchestrator/WorkflowManager.js');
    const { onJobCompleted: debateCallback } = await import('../server/orchestrator/DebateManager.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const job = await insertTestJob({ id: 'late-terminal-job', status: 'running' });
      const agent = queries.insertAgent({ id: 'late-terminal-agent', job_id: job.id, status: 'done' });
      queries.updateJobStatus(job.id, 'running');
      queries.updateJobStatus(job.id, 'done');

      await handleJobCompletion(agent.id, job, 'failed');

      expect(queries.getJobById(job.id)?.status).toBe('done');
      expect(wfCallback).not.toHaveBeenCalled();
      expect(debateCallback).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("illegal job transition 'done' → 'failed'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
