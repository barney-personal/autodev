/**
 * Recovery idempotency and socket error isolation tests (M7b).
 *
 * (a) Model-fallback idempotency: duplicate _onJobCompleted spawns exactly one fallback job
 * (b) CLI-retry idempotency: duplicate at MAX_CLI_RETRIES does NOT spawn alt-provider twice
 * (c) updateAndEmit socket error isolation: workflow state updates despite emitWorkflowUpdate throw
 * (d) startWorkflow socket error isolation: returns job when emitJobNew throws
 * (e) resumeWorkflow socket error isolation: returns job when emitJobNew throws
 * (f) updateAndEmit null-return path: no throw when DB update returns null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn((m: string) => m === 'claude-sonnet-4-6' ? 'codex' : null),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
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
  pushAndCreatePr: vi.fn(() => null),
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Recovery idempotency (validates Fix-M4b)
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowManager: recovery idempotency (Fix-M4b)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('(a) model-fallback: duplicate onJobCompleted spawns exactly one fallback job', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { isFallbackEligibleFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel, getFallbackModel } = await import('../server/orchestrator/ModelClassifier.js');

    // Make this failure eligible for model fallback
    vi.mocked(isFallbackEligibleFailure).mockReturnValue(true);
    // Mark the failing model as unavailable so getWorkflowFallbackModel doesn't early-return
    vi.mocked(getAvailableModel).mockImplementation((m: string) =>
      m === 'claude-sonnet-4-6' ? 'codex' : m
    );
    vi.mocked(getFallbackModel).mockReturnValue('codex');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'claude-sonnet-4-6',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const failedJob = await insertTestJob({
      id: 'fallback-idem-job-1',
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // First call: should spawn a fallback job
    onJobCompleted(failedJob, { force: true });

    const jobsAfterFirst = queries.listJobs();
    const fallbackJobs1 = jobsAfterFirst.filter(j =>
      j.workflow_id === workflow.id && j.id !== failedJob.id
    );
    expect(fallbackJobs1).toHaveLength(1);
    expect(fallbackJobs1[0].model).toBe('codex');

    // Second call (force to bypass _processedJobs): should NOT spawn another
    onJobCompleted(failedJob, { force: true });

    const jobsAfterSecond = queries.listJobs();
    const fallbackJobs2 = jobsAfterSecond.filter(j =>
      j.workflow_id === workflow.id && j.id !== failedJob.id
    );
    // Still exactly 1 fallback job — the second call was a no-op
    expect(fallbackJobs2).toHaveLength(1);

    // Workflow should still be running (not blocked) — the duplicate returned early
    const wf = queries.getWorkflowById(workflow.id);
    expect(wf!.status).toBe('running');
  });

  it('(b) cli-retry at MAX_CLI_RETRIES: duplicate does not spawn alt-provider twice', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { isSameModelRetryEligible } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel, getAlternateProviderModel } = await import('../server/orchestrator/ModelClassifier.js');

    // Make failure eligible for same-model retry
    vi.mocked(isSameModelRetryEligible).mockReturnValue(true);
    // Provide an alternate provider model
    vi.mocked(getAlternateProviderModel).mockReturnValue('codex');
    // Mark the failing model as unavailable so getWorkflowFallbackModel finds codex
    vi.mocked(getAvailableModel).mockImplementation((m: string) =>
      m === 'claude-sonnet-4-6' ? 'codex' : m
    );

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
      implementer_model: 'claude-sonnet-4-6',
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Set CLI retry count to 3 (MAX_CLI_RETRIES) so it falls through to alt-provider
    queries.upsertNote(`workflow/${workflow.id}/cli-retry/implement/cycle-2`, '3', null);

    const failedJob = await insertTestJob({
      id: 'cli-retry-idem-job',
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // First call: should spawn alt-provider job
    onJobCompleted(failedJob, { force: true });

    const jobsAfterFirst = queries.listJobs();
    const altJobs1 = jobsAfterFirst.filter(j =>
      j.workflow_id === workflow.id && j.id !== failedJob.id
    );
    expect(altJobs1).toHaveLength(1);
    expect(altJobs1[0].model).toBe('codex');

    // Second call: should NOT spawn another alt-provider
    onJobCompleted(failedJob, { force: true });

    const jobsAfterSecond = queries.listJobs();
    const altJobs2 = jobsAfterSecond.filter(j =>
      j.workflow_id === workflow.id && j.id !== failedJob.id
    );
    expect(altJobs2).toHaveLength(1);

    // Workflow still running — duplicate returned early
    const wf = queries.getWorkflowById(workflow.id);
    expect(wf!.status).toBe('running');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Socket error isolation (validates M2b + Fix-C4d)
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowManager: socket error isolation', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('(c) updateAndEmit socket error: workflow state updates despite emitWorkflowUpdate throw', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Make emitWorkflowUpdate throw on first call to test the try-catch in updateAndEmit
    vi.mocked(socket.emitWorkflowUpdate).mockImplementationOnce(() => {
      throw new Error('WebSocket closed');
    });

    const job = await insertTestJob({
      id: 'socket-error-update-job',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Trigger assess→review transition — updateAndEmit's first call will have socket error
    onJobCompleted(job);

    // Despite the socket error, workflow state should have been updated in DB
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated).not.toBeNull();
    // Phase should have advanced to review — the socket error in updateAndEmit was caught
    expect(updated!.current_phase).toBe('review');
    expect(updated!.current_cycle).toBe(1);
    // Status should still be running (not blocked or errored)
    expect(updated!.status).toBe('running');
  });

  it('(d) startWorkflow: returns job and updates state when emitJobNew throws', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'idle',
      current_cycle: 0,
      use_worktree: 0,
      work_dir: process.cwd(), // Must be a real git repo for pre-flight checks
    });

    // Make emitJobNew throw
    vi.mocked(socket.emitJobNew).mockImplementationOnce(() => {
      throw new Error('Socket transport closed');
    });

    const job = startWorkflow(workflow);

    // Job should be returned despite socket error
    expect(job).toBeDefined();
    expect(job!.workflow_id).toBe(workflow.id);
    expect(job!.workflow_phase).toBe('assess');

    // Workflow state should be updated
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.current_phase).toBe('assess');
    expect(updated!.current_cycle).toBe(0);
  });

  it('(e) resumeWorkflow: returns job and transitions to running when emitJobNew throws', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 2,
      use_worktree: 0,
      work_dir: process.cwd(),
    });

    // Make emitJobNew throw
    vi.mocked(socket.emitJobNew).mockImplementationOnce(() => {
      throw new Error('Socket transport closed');
    });

    const job = resumeWorkflow(workflow);

    // Job should be returned despite socket error
    expect(job).toBeDefined();
    expect(job!.workflow_id).toBe(workflow.id);
    expect(job!.workflow_phase).toBe('implement');

    // Workflow should be running now (transitioned from blocked)
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('running');
  });

  it('(f) updateAndEmit null-return path: no throw when DB update returns null', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      id: 'null-update-job',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Mock updateWorkflow to return null on the SECOND call (first is the milestones
    // update from assess handler, second is the phase/cycle update from spawnPhaseJob).
    // This simulates the workflow being deleted between reads.
    const origUpdateWorkflow = queries.updateWorkflow;
    let callCount = 0;
    const warnSpy = vi.spyOn(console, 'warn');
    vi.spyOn(queries, 'updateWorkflow').mockImplementation((...args) => {
      callCount++;
      if (callCount === 2) return null as any;
      return origUpdateWorkflow(...args);
    });

    // Should NOT throw — the null-return path logs a warning and returns
    expect(() => onJobCompleted(job)).not.toThrow();

    // Verify the warning was logged
    const nullWarnings = warnSpy.mock.calls.filter(call =>
      typeof call[0] === 'string' && call[0].includes('updateAndEmit') && call[0].includes('not found')
    );
    expect(nullWarnings.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });
});
