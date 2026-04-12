/**
 * Tests for the verify phase lifecycle in WorkflowManager.
 *
 * Covers:
 * - No-verify regression: workflows without verifyCommand advance normally
 * - Threshold not met: verify is not triggered when completion threshold is not met
 * - Verify pass: workflow finalizes on pass when threshold is met
 * - Verify fail+retry: implement re-spawned with is_verify_retry context
 * - Verify fail exhausted: workflow blocked with verify_failed reason
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

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => true), statSync: vi.fn(() => ({ size: 100 })) };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('test-branch\n');
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess'),
  buildReviewPrompt: vi.fn(() => 'mock review'),
  buildImplementPrompt: vi.fn(() => 'mock implement'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified repair'),
  preReadWorkflowContext: vi.fn(() => ({})),
  renderInlineContext: vi.fn(() => ''),
  hasInlineContent: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn((model: string) => model),
  getFallbackModel: vi.fn((model: string) => model),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

// ── VerifyRunner mock — controlled via a module-level variable ─────────────────
let mockVerifyResult = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 100 };

vi.mock('../server/orchestrator/VerifyRunner.js', () => ({
  runVerification: vi.fn(async () => mockVerifyResult),
}));

// ── WorkflowPRCreator and sub-module stubs ──────────────────────────────────
vi.mock('../server/orchestrator/WorkflowPRCreator.js', () => ({
  pushAndCreatePr: vi.fn(() => null),
  finalizeWorkflow: vi.fn(async () => {}),
  reconcileBlockedPRs: vi.fn(async () => {}),
  countBranchCommits: vi.fn(() => 0),
  getPrCreationOutcome: vi.fn(() => 'no_publishable_commits'),
  _buildPrBody: vi.fn(() => ''),
}));

vi.mock('../server/orchestrator/WorkflowWorktreeManager.js', () => ({
  ensureWorktreeBranch: vi.fn(() => ({ ok: true })),
  verifyWorktreeHealth: vi.fn(() => ({ ok: true })),
  createWorkflowWorktree: vi.fn((wf: any) => wf),
  restoreWorkflowWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowBlockedDiagnostics.js', () => ({
  diagnoseWriteNoteInOutput: vi.fn(() => ({ status: 'not_called' })),
  formatWriteNoteDiagnostic: vi.fn(() => ''),
  writeBlockedDiagnostic: vi.fn(),
  BLOCKED_LOG_DIR: '/tmp',
}));

vi.mock('../server/orchestrator/WorkflowMilestoneParser.js', () => ({
  parseMilestones: vi.fn(() => ({ total: 3, done: 1 })),
  meetsCompletionThreshold: vi.fn(() => false),
  recoverPlanFromAgentOutput: vi.fn(() => false),
  extractPlanFromText: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeVerifyWorkflow(overrides: Record<string, any> = {}) {
  const project = await insertTestProject();
  const workflow = await insertTestWorkflow({
    project_id: project.id,
    status: 'running',
    current_phase: 'implement',
    current_cycle: 1,
    max_cycles: 10,
    milestones_total: 3,
    milestones_done: 1,
    ...overrides,
  });
  // insertTestWorkflow uses `as any` for extra fields — set via updateWorkflow
  const { updateWorkflow } = await import('../server/db/queries.js');
  updateWorkflow(workflow.id, overrides as any);
  return { project, workflow: (await import('../server/db/queries.js')).getWorkflowById(workflow.id)! };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('WorkflowManager verify phase lifecycle', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
    // Reset to a passing verify result
    mockVerifyResult = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 100 };
    // Ensure meetsCompletionThreshold returns false by default (tests that need true override it)
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');
    vi.mocked(meetsCompletionThreshold).mockReturnValue(false);
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  // ── No-verify regression ────────────────────────────────────────────────────

  it('advances normally when verify_command is NULL (no regression)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');

    const { workflow } = await makeVerifyWorkflow({
      current_cycle: 1,
    });
    // No verify_command — updateWorkflow with null
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2\n- [ ] M3', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/1`, '0', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/1`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // runVerification must NOT be called (verify_command is null)
    expect(runVerification).not.toHaveBeenCalled();
  });

  // ── Threshold not met — verify not triggered ────────────────────────────────

  it('does not run verify when completion threshold is not met', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { updateWorkflow, upsertNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { verify_command: 'echo hello' } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/1`, '0', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/1`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Verify must NOT run — completion threshold not met (mock returns false)
    expect(runVerification).not.toHaveBeenCalled();
  });

  // ── Verify pass → finalize ─────────────────────────────────────────────────

  it('runs verify and finalizes workflow on pass when threshold is met', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getVerifyRunsForCycle, getNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');
    const { finalizeWorkflow: mockFinalize } = await import('../server/orchestrator/WorkflowPRCreator.js');

    mockVerifyResult = { exitCode: 0, stdout: 'All checks passed', stderr: '', durationMs: 250 };
    // Make completion threshold return true so verify triggers
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 2 });
    updateWorkflow(workflow.id, { verify_command: 'npm test', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 50));

    expect(runVerification).toHaveBeenCalledWith('npm test', expect.any(String));

    // Verify run persisted
    const runs = getVerifyRunsForCycle(workflow.id, 2);
    expect(runs.length).toBe(1);
    expect(runs[0].exit_code).toBe(0);

    // Workflow should be marked complete
    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('complete');

    // finalizeWorkflow should have been called
    expect(mockFinalize).toHaveBeenCalled();

    // Worklog note written
    const wl = getNote(`workflow/${workflow.id}/worklog/cycle-2-verify`);
    expect(wl?.value).toContain('PASSED');

  });

  // ── Verify fail + retry ───────────────────────────────────────────────────

  it('spawns implement with verify_retry context on verify failure when retries remain', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    mockVerifyResult = { exitCode: 1, stdout: '', stderr: 'Server error 500', durationMs: 400 };
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { verify_command: 'exit 1', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 50));

    const freshWf = getWorkflowById(workflow.id)!;
    // Should NOT be blocked yet — retry available (attempt 1 <= max_verify_retries 2)
    expect(freshWf.status).not.toBe('blocked');
    // Phase should be implement (re-spawned for verify retry)
    expect(freshWf.current_phase).toBe('implement');

    // A new implement job should have been spawned with is_verify_retry context
    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.context && JSON.parse(j.context).is_verify_retry);
    expect(retryJob).toBeTruthy();
    expect(retryJob!.title).toContain('verify retry');

    // Failure note should be written so implement prompt can show it
    const failureNote = getNote(`workflow/${workflow.id}/verify-failure/1`);
    expect(failureNote).not.toBeNull();
    const failureData = JSON.parse(failureNote!.value);
    expect(failureData.exitCode).toBe(1);
    expect(failureData.stderr).toBe('Server error 500');

    // Worklog note written
    const wl = getNote(`workflow/${workflow.id}/worklog/cycle-1-verify`);
    expect(wl?.value).toContain('FAILED');

  });

  // ── Verify fail exhausted ─────────────────────────────────────────────────

  it('blocks workflow after max_verify_retries exhausted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, insertVerifyRun } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    mockVerifyResult = { exitCode: 2, stdout: '', stderr: 'Fatal error', durationMs: 200 };
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { verify_command: 'exit 2', max_verify_retries: 1 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Pre-insert 1 failed run (so attempt will be 2, which exceeds max_verify_retries=1)
    insertVerifyRun({
      id: 'existing-run-id',
      workflow_id: workflow.id,
      cycle: 1,
      attempt: 1,
      command: 'exit 2',
      exit_code: 2,
      stdout: null,
      stderr: 'Previous failure',
      duration_ms: 150,
      created_at: Date.now(),
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 100));

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('blocked');
    expect(freshWf.blocked_reason).toContain('verify_failed');
    expect(freshWf.current_phase).toBe('verify');

  });

  // ── Verify-retry implement bypasses zero-progress detection ───────────────

  it('verify-retry implement jobs bypass zero-progress detection and advance normally', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, upsertNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');

    // meetsCompletionThreshold returns false — threshold not met after retry implement
    const { workflow } = await makeVerifyWorkflow({ current_cycle: 2 });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2\n- [ ] M3', null);
    // Set up zero-progress state that would normally block
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/2`, '1', null);
    upsertNote(`workflow/${workflow.id}/zero-progress-count`, '1', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/2`, '1', null);

    // Simulate a verify-retry implement job completing (below threshold)
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
      context: JSON.stringify({ is_verify_retry: true }),
    });

    onJobCompleted(job);

    // Should NOT be blocked by zero-progress — verify-retry bypasses it
    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('running');
    // Should have advanced to next cycle
    expect(freshWf.current_cycle).toBe(3);
    expect(freshWf.current_phase).toBe('review');

    // Verify should NOT have been called (threshold not met)
    expect(runVerification).not.toHaveBeenCalled();
  });
});
