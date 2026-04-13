import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestJob,
} from './helpers.js';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'tmux' && args[0] === 'list-sessions') return '';
    return '';
  }),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  startInteractiveAgent: vi.fn(),
  saveSnapshot: vi.fn(),
}));

vi.mock('../server/orchestrator/JobFinalizer.js', () => ({
  resolveStandalonePrintJobOutcome: vi.fn(() => null),
  reportStandaloneResolutionFailure: vi.fn(),
}));

vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  getLogPath: vi.fn(() => '/dev/null'),
  _resetCompletedJobsForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

vi.mock('../server/mcp/McpServer.js', () => ({
  orphanedWaits: new Map(),
  disconnectedAgents: new Map(),
  hasActiveTransport: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  writeBlockedDiagnostic: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
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
  markModelRateLimited: vi.fn(),
  getFallbackModel: vi.fn((model: string) => model),
  getModelProvider: vi.fn(() => 'anthropic'),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyFailureText: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(() => true),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/ProcessPriority.js', () => ({
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('StuckJobWatchdog terminal guards', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    const { _resetWatchdogStateForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    _resetWatchdogStateForTest();
  });

  afterEach(async () => {
    const { stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    stopWatchdog();
    await cleanupTestDb();
  });

  it('idle-timeout does not rewrite a job that completed between the initial read and the terminal write', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { isTmuxSessionAlive } = await import('../server/orchestrator/PtyManager.js') as any;
    const { onJobCompleted: workflowOnJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { handleRetry } = await import('../server/orchestrator/RetryManager.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Job is running but will be "completed by finish_job" before watchdog writes
      const job = await insertTestJob({
        id: 'idle-already-done-job',
        status: 'running',
        model: 'claude-sonnet-4-6',
      });
      // Agent idle for 25 minutes (past 20-min threshold)
      const agent = queries.insertAgent({
        id: 'idle-already-done-agent',
        job_id: job.id,
        status: 'running',
        updated_at: Date.now() - 25 * 60 * 1000,
      });

      // Tmux session is alive so the idle-timeout branch fires
      (isTmuxSessionAlive as any).mockImplementation((id: string) => id === agent.id);

      // Simulate finish_job completing the job between the initial read and
      // the re-read that guards the terminal write. The first getJobById call
      // (isStuckCandidate check) sees 'running'; the second (guard re-read)
      // sees 'done' because we intercept it.
      let callCount = 0;
      const originalGetJobById = queries.getJobById.bind(queries);
      const spy = vi.spyOn(queries, 'getJobById').mockImplementation((id: string) => {
        if (id === job.id) {
          callCount++;
          if (callCount === 1) {
            // First read: job is still running (triggers idle-timeout)
            return originalGetJobById(id);
          }
          // Second read (guard): simulate that finish_job completed it
          queries.updateJobStatus(job.id, 'done');
          return originalGetJobById(id);
        }
        return originalGetJobById(id);
      });

      _invokeWatchdogCheckForTest();

      // Job must still be 'done', not overwritten to 'failed'
      spy.mockRestore();
      expect(queries.getJobById(job.id)?.status).toBe('done');
      // No workflow/retry side effects should fire
      expect(workflowOnJobCompleted).not.toHaveBeenCalled();
      expect(handleRetry).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("illegal job transition 'done' → 'failed'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('idle-timeout correctly fails a still-running job and fires side effects', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { isTmuxSessionAlive } = await import('../server/orchestrator/PtyManager.js') as any;
    const { onJobCompleted: workflowOnJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { handleRetry } = await import('../server/orchestrator/RetryManager.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const job = await insertTestJob({
        id: 'idle-still-running-job',
        status: 'running',
        model: 'claude-sonnet-4-6',
      });
      const agent = queries.insertAgent({
        id: 'idle-still-running-agent',
        job_id: job.id,
        status: 'running',
        updated_at: Date.now() - 25 * 60 * 1000,
      });

      (isTmuxSessionAlive as any).mockImplementation((id: string) => id === agent.id);

      _invokeWatchdogCheckForTest();

      expect(queries.getJobById(job.id)?.status).toBe('failed');
      expect(queries.getAgentById(agent.id)?.status).toBe('failed');
      expect(workflowOnJobCompleted).toHaveBeenCalled();
      expect(handleRetry).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('cleans up a stale running agent without rewriting a job that is already done', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { onJobCompleted: workflowOnJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { onJobCompleted: debateOnJobCompleted } = await import('../server/orchestrator/DebateManager.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const job = await insertTestJob({
        id: 'watchdog-terminal-job',
        status: 'done',
        model: 'claude-sonnet-4-6',
      });
      const agent = queries.insertAgent({
        id: 'watchdog-terminal-agent',
        job_id: job.id,
        status: 'running',
      });

      _invokeWatchdogCheckForTest();

      expect(queries.getJobById(job.id)?.status).toBe('done');
      expect(queries.getAgentById(agent.id)?.status).toBe('done');
      expect(workflowOnJobCompleted).not.toHaveBeenCalled();
      expect(debateOnJobCompleted).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("illegal job transition 'done' → 'failed'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports incomplete standalone terminal failures to Sentry', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resolveStandalonePrintJobOutcome, reportStandaloneResolutionFailure } = await import('../server/orchestrator/JobFinalizer.js') as any;

    const job = queries.insertJob({
      id: 'watchdog-incomplete-job',
      title: 'Standalone batch job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      work_dir: process.cwd(),
      model: 'claude-sonnet-4-6',
      is_interactive: 0,
    });
    const agent = queries.insertAgent({
      id: 'watchdog-incomplete-agent',
      job_id: job.id,
      status: 'running',
    });

    (resolveStandalonePrintJobOutcome as any).mockReturnValue({
      status: 'failed',
      source: 'incomplete_run',
      errorMessage: 'Agent session ended before emitting a final result event. session ended during pending tool call Edit.',
      detail: 'terminal evidence collected without final result (12 ndjson events)',
    });

    _invokeWatchdogCheckForTest();

    expect(reportStandaloneResolutionFailure).toHaveBeenCalledWith(
      agent.id,
      job.id,
      'StuckJobWatchdog',
      expect.objectContaining({
        source: 'incomplete_run',
        status: 'failed',
      }),
    );
  });

  it('extracts num_turns for incomplete standalone terminal failures', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resolveStandalonePrintJobOutcome } = await import('../server/orchestrator/JobFinalizer.js') as any;
    const { getLogPath } = await import('../server/orchestrator/AgentRunner.js') as any;

    const job = queries.insertJob({
      id: 'watchdog-turns-job',
      title: 'Standalone batch job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      work_dir: process.cwd(),
      model: 'claude-sonnet-4-6',
      is_interactive: 0,
    });
    const agent = queries.insertAgent({
      id: 'watchdog-turns-agent',
      job_id: job.id,
      status: 'running',
    });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${agent.id}.ndjson`),
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit' }] } }),
        '',
      ].join('\n'),
      'utf8',
    );
    (getLogPath as any).mockReturnValue(path.join(logDir, `${agent.id}.ndjson`));

    (resolveStandalonePrintJobOutcome as any).mockReturnValue({
      status: 'failed',
      source: 'incomplete_run',
      errorMessage: 'Agent session ended before emitting a final result event.',
      detail: 'terminal evidence collected without final result (3 ndjson events)',
    });

    _invokeWatchdogCheckForTest();

    expect(queries.getAgentById(agent.id)?.num_turns).toBe(2);
  });
});
