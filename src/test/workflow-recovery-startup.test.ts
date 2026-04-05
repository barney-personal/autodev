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

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  reconcileBlockedPRs: reconcileBlockedPRsSpy,
  reconcileRunningWorkflows: reconcileRunningWorkflowsSpy,
  onJobCompleted: workflowOnJobCompletedSpy,
}));

vi.mock('../server/db/queries.js', () => ({
  listAllRunningAgents: vi.fn(() => []),
  getAgentWithJob: vi.fn(),
  getJobById: vi.fn(),
  updateAgent: vi.fn(),
  updateJobStatus: vi.fn(),
  releaseLocksForAgent: vi.fn(),
  getPendingQuestion: vi.fn(() => null),
  updateQuestion: vi.fn(),
  scheduleRepeatJob: vi.fn(),
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
    reconcileBlockedPRsSpy.mockClear();
    reconcileRunningWorkflowsSpy.mockClear();
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
});
