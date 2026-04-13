/**
 * Tests for recovery.ts startup wiring:
 * Verifies that runRecovery() calls reconcileBlockedPRs() as fire-and-forget.
 *
 * Heavy dependencies (AgentRunner, PtyManager, queries, etc.) are mocked so
 * recovery.ts can be imported without a live DB or tmux environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reconcileBlockedPRsSpy = vi.fn().mockResolvedValue(undefined);
const reconcileRunningWorkflowsSpy = vi.fn();
const workflowOnJobCompletedSpy = vi.fn();
const listAllRunningAgentsSpy = vi.fn(() => []);
const getAgentWithJobSpy = vi.fn();
const getJobByIdSpy = vi.fn();
const updateAgentSpy = vi.fn();
const updateJobStatusSpy = vi.fn();
const releaseLocksForAgentSpy = vi.fn();
const getPendingQuestionSpy = vi.fn(() => null);
const updateQuestionSpy = vi.fn();
const scheduleRepeatJobSpy = vi.fn();

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  reconcileBlockedPRs: reconcileBlockedPRsSpy,
  reconcileRunningWorkflows: reconcileRunningWorkflowsSpy,
  onJobCompleted: workflowOnJobCompletedSpy,
}));

vi.mock('../server/db/queries.js', () => ({
  listAllRunningAgents: listAllRunningAgentsSpy,
  getAgentWithJob: getAgentWithJobSpy,
  getJobById: getJobByIdSpy,
  updateAgent: updateAgentSpy,
  updateJobStatus: updateJobStatusSpy,
  releaseLocksForAgent: releaseLocksForAgentSpy,
  getPendingQuestion: getPendingQuestionSpy,
  updateQuestion: updateQuestionSpy,
  scheduleRepeatJob: scheduleRepeatJobSpy,
  getDb: vi.fn(),
}));

vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  reattachAgent: vi.fn(),
  getLogPath: vi.fn(() => '/tmp/fake.log'),
}));

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  attachPty: vi.fn(),
}));

vi.mock('../server/orchestrator/JobFinalizer.js', () => ({
  resolveStandalonePrintJobOutcome: vi.fn(() => null),
  reportStandaloneResolutionFailure: vi.fn(),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
}));

vi.mock('../server/mcp/McpServer.js', () => ({
  orphanedWaits: new Map(),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('recovery.ts: startup wiring for reconcileBlockedPRs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAllRunningAgentsSpy.mockReturnValue([]);
    getPendingQuestionSpy.mockReturnValue(null);
  });

  it('(f) runRecovery calls reconcileBlockedPRs as fire-and-forget', async () => {
    // Replace with a promise that never resolves to prove runRecovery doesn't await it
    let resolveBlocked!: () => void;
    reconcileBlockedPRsSpy.mockReturnValue(
      new Promise<void>(resolve => { resolveBlocked = resolve; }),
    );

    const { runRecovery } = await import('../server/orchestrator/recovery.js');

    // runRecovery() is synchronous — it should return without waiting for reconcileBlockedPRs
    runRecovery();

    // reconcileBlockedPRs was called
    expect(reconcileBlockedPRsSpy).toHaveBeenCalledOnce();
    // reconcileRunningWorkflows was also called (the other gap-detector call)
    expect(reconcileRunningWorkflowsSpy).toHaveBeenCalledOnce();

    // Clean up the dangling promise so the test doesn't leak
    resolveBlocked();
  });

  it('does not rewrite a job that already finished before startup recovery runs', async () => {
    const queries = await import('../server/db/queries.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listAllRunningAgentsSpy.mockReturnValue([
      { id: 'agent-1', job_id: 'job-1', status: 'running', pid: null },
    ] as any);
    getAgentWithJobSpy.mockReturnValue({
      id: 'agent-1',
      job_id: 'job-1',
      status: 'running',
      job: {
        id: 'job-1',
        status: 'done',
        is_interactive: false,
        model: 'claude-sonnet-4-6',
        repeat_interval_ms: null,
      },
    } as any);
    getJobByIdSpy.mockReturnValue({
      id: 'job-1',
      status: 'done',
      is_interactive: false,
      model: 'claude-sonnet-4-6',
      repeat_interval_ms: null,
    } as any);

    const { runRecovery } = await import('../server/orchestrator/recovery.js');
    runRecovery();

    expect(queries.updateJobStatus).not.toHaveBeenCalled();
    expect(queries.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ status: 'done' }),
    );
    expect(workflowOnJobCompletedSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("illegal job transition 'done' → 'failed'"),
    );
    warnSpy.mockRestore();
  });
});
