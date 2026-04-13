/**
 * Tests for writeBlockedDiagnostic (Fix-C10a).
 *
 * Verifies:
 * (a) Diagnostic file is written with correct content (title, blocked reason, job history)
 * (b) Most recent agent (agents[0] from DESC ordering) is used for failed job details
 * (c) Handles workflow with no failed jobs gracefully
 * (d) Handles job with no agents gracefully
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock'),
  buildReviewPrompt: vi.fn(() => 'mock'),
  buildImplementPrompt: vi.fn(() => 'mock'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock'),
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
  getFallbackModel: vi.fn(() => null),
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

let queries: typeof import('../server/db/queries.js');
let fs: typeof import('fs');

describe('writeBlockedDiagnostic', () => {
  let project: any;

  beforeEach(async () => {
    await setupTestDb();
    queries = await import('../server/db/queries.js');
    fs = await import('fs');
    project = await insertTestProject();
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.mkdirSync).mockClear();
    // Unset VITEST so writeBlockedDiagnostic doesn't early-return
    delete process.env.VITEST;
  });

  afterEach(async () => {
    process.env.VITEST = 'true';
    await cleanupTestDb();
  });

  it('(a) writes diagnostic file with workflow title, blocked reason, and job history', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'My Test Workflow',
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 3,
    });

    queries.updateWorkflow(workflow.id, { blocked_reason: 'zero_progress_exceeded' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      workflow_cycle: 2,
      status: 'done',
      title: 'Implement cycle 2',
    });

    const failedJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      workflow_cycle: 3,
      status: 'failed',
      title: 'Implement cycle 3',
    });

    queries.insertAgent({
      id: 'agent-newest-111',
      job_id: failedJob.id,
      pid: 12345,
      tmux_session: null,
      status: 'failed',
      error_message: 'Rate limit exceeded',
      exit_code: 1,
      started_at: Date.now(),
      finished_at: Date.now(),
      num_turns: 15,
      cost_usd: 1.5,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    writeBlockedDiagnostic(updated);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('blocked-diagnostics'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

    const [filePath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(filePath)).toContain('blocked-diagnostics/');
    expect(String(filePath)).toContain(workflow.id.slice(0, 8));
    expect(String(filePath)).toMatch(/\.md$/);

    const md = String(content);
    expect(md).toContain('My Test Workflow');
    expect(md).toContain('zero_progress_exceeded');
    expect(md).toContain('implement');
    expect(md).toContain('Implement cycle 3');
    expect(md).toContain('Rate limit exceeded');
    expect(md).toContain('agent-ne'); // agent ID sliced to 8 chars
  });

  it('(b) uses most recent agent (agents[0] from DESC ordering) for failed job details', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'Agent Ordering Test',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'test_block' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    const failedJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      status: 'failed',
      title: 'Failed job',
    });

    // Insert TWO agents — older first, newer second
    // getAgentsWithJobByJobId orders by started_at DESC, so agents[0] = newest
    queries.insertAgent({
      id: 'agent-old-xxxxxxx',
      job_id: failedJob.id,
      pid: 1000,
      tmux_session: null,
      status: 'failed',
      error_message: 'OLD agent error - should not appear',
      exit_code: 1,
      started_at: Date.now() - 60000,
      finished_at: Date.now() - 50000,
      num_turns: 5,
      cost_usd: 0.5,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    queries.insertAgent({
      id: 'agent-new-xxxxxxx',
      job_id: failedJob.id,
      pid: 2000,
      tmux_session: null,
      status: 'failed',
      error_message: 'NEW agent error - should appear',
      exit_code: 2,
      started_at: Date.now(),
      finished_at: Date.now(),
      num_turns: 10,
      cost_usd: 1.0,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    writeBlockedDiagnostic(updated);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const content = String(vi.mocked(fs.writeFileSync).mock.calls[0][1]);

    // Should contain the NEW agent's error (most recent = agents[0] due to DESC ordering)
    expect(content).toContain('NEW agent error - should appear');
    expect(content).toContain('agent-ne'); // agent-new-xxxxxxx sliced to 8 chars
    // Should NOT contain the OLD agent's error
    expect(content).not.toContain('OLD agent error - should not appear');
  });

  it('(c) handles workflow with no failed jobs', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'No Failed Jobs Workflow',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'manual_block' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'assess',
      status: 'done',
      title: 'Assess phase',
    });

    writeBlockedDiagnostic(updated);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const content = String(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(content).toContain('No Failed Jobs Workflow');
    expect(content).toContain('No failed jobs.');
  });

  it('(d) handles failed job with no agents', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'No Agent Workflow',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'stuck' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      status: 'failed',
      title: 'Orphan failed job',
    });

    writeBlockedDiagnostic(updated);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const content = String(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(content).toContain('No Agent Workflow');
    expect(content).toContain('Orphan failed job');
    expect(content).toContain('n/a'); // agent_id fallback
    expect(content).toContain('no agent error recorded'); // error fallback
  });
});
