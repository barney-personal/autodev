/**
 * Tests for the verify agent phase lifecycle in WorkflowManager.
 *
 * Covers:
 * - No-verify regression: workflows without start_command advance normally
 * - Threshold not met: verify not triggered when completion threshold is not met
 * - Verify pass: workflow finalizes when verify agent writes PASS note
 * - Verify fail+retry: implement re-spawned when verify agent writes FAIL note
 * - Verify fail exhausted: workflow blocked after max retries
 * - Verify-retry bypass: implement jobs after failed verify skip zero-progress detection
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
  buildVerifyPrompt: vi.fn(() => 'mock verify'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified repair'),
  preReadWorkflowContext: vi.fn(() => ({})),
  renderInlineContext: vi.fn(() => ''),
  hasInlineContent: vi.fn(() => false),
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
  const { updateWorkflow } = await import('../server/db/queries.js');
  updateWorkflow(workflow.id, overrides as any);
  return { project, workflow: (await import('../server/db/queries.js')).getWorkflowById(workflow.id)! };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('WorkflowManager verify agent lifecycle', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');
    vi.mocked(meetsCompletionThreshold).mockReturnValue(false);
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  // ── No-verify regression ────────────────────────────────────────────────────

  it('advances normally when start_command is NULL (no regression)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
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

    const jobs = getJobsForWorkflow(workflow.id);
    const verifyJobs = jobs.filter(j => j.workflow_phase === 'verify');
    expect(verifyJobs).toHaveLength(0);
  });

  // ── Threshold not met ─────────────────────────────────────────────────────

  it('does not spawn verify when completion threshold is not met', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { updateWorkflow, upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev' } as any);
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

    const jobs = getJobsForWorkflow(workflow.id);
    const verifyJobs = jobs.filter(j => j.workflow_phase === 'verify');
    expect(verifyJobs).toHaveLength(0);
  });

  // ── Verify pass → finalize ─────────────────────────────────────────────────

  it('spawns verify agent and finalizes on PASS result note', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getJobsForWorkflow, getVerifyRunsForCycle } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');
    const { finalizeWorkflow: mockFinalize } = await import('../server/orchestrator/WorkflowPRCreator.js');

    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 2 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Step 1: Implement completes → should spawn verify job
    const implJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });
    onJobCompleted(implJob);

    const jobs = getJobsForWorkflow(workflow.id);
    const verifyJob = jobs.find(j => j.workflow_phase === 'verify');
    expect(verifyJob).toBeTruthy();
    expect(verifyJob!.model).toBe('claude-opus-4-7');

    // Step 2: Verify agent writes PASS note and job completes
    upsertNote(`workflow/${workflow.id}/verify-result/2`, '## Verify Result: PASS\n\n**Tests run:** 3\n**Passed:** 3\n**Failed:** 0\n\n### Summary\nAll smoke tests passed.', null);

    const doneVerifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'verify',
      status: 'done',
    });
    onJobCompleted(doneVerifyJob);

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('complete');
    expect(mockFinalize).toHaveBeenCalled();

    const runs = getVerifyRunsForCycle(workflow.id, 2);
    expect(runs.length).toBe(1);
    expect(runs[0].exit_code).toBe(0);
    expect(runs[0].command).toBe('verify-agent');
  });

  // ── Verify fail + retry ───────────────────────────────────────────────────

  it('spawns implement on verify FAIL when retries remain', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getJobsForWorkflow, getNote } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Implement completes → verify spawned
    const implJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });
    onJobCompleted(implJob);

    // Verify agent writes FAIL note
    upsertNote(`workflow/${workflow.id}/verify-result/1`, '## Verify Result: FAIL\n\n**Tests run:** 2\n**Passed:** 1\n**Failed:** 1\n\n### Tests\n- [FAIL] Health endpoint returns 500\n\n### Summary\nHealth check failed.', null);

    const verifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'verify',
      status: 'done',
    });
    onJobCompleted(verifyJob);

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).not.toBe('blocked');

    const jobs = getJobsForWorkflow(workflow.id);
    const implJobs = jobs.filter(j => j.workflow_phase === 'implement');
    expect(implJobs.length).toBeGreaterThan(1);

    const failureNote = getNote(`workflow/${workflow.id}/verify-failure/1`);
    expect(failureNote).not.toBeNull();
    expect(failureNote!.value).toContain('FAIL');
  });

  // ── No result note = FAIL ──────────────────────────────────────────────────

  it('treats missing result note as FAIL', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Implement completes → verify spawned
    const implJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });
    onJobCompleted(implJob);

    // Verify agent completes but writes NO result note
    const verifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'verify',
      status: 'done',
    });
    onJobCompleted(verifyJob);

    // Should NOT be complete — missing note means FAIL
    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).not.toBe('complete');

    // Should have spawned a retry implement job
    const jobs = getJobsForWorkflow(workflow.id);
    const implJobs = jobs.filter(j => j.workflow_phase === 'implement');
    expect(implJobs.length).toBeGreaterThan(1);
  });

  // ── Template text not a false positive ────────────────────────────────────

  it('does not false-positive on PASS | FAIL template text', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Implement → verify
    const implJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });
    onJobCompleted(implJob);

    // Agent echoes the template without filling it in
    upsertNote(`workflow/${workflow.id}/verify-result/1`, '## Verify Result: PASS | FAIL\n\nI could not run the tests.', null);

    const verifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'verify',
      status: 'done',
    });
    onJobCompleted(verifyJob);

    // Should NOT be treated as PASS
    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).not.toBe('complete');
  });

  // ── Verify fail exhausted ─────────────────────────────────────────────────

  it('blocks workflow after max_verify_retries exhausted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, insertVerifyRun } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { start_command: 'npm run dev', max_verify_retries: 1 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Pre-insert 1 failed verify run
    insertVerifyRun({
      id: 'existing-run-id',
      workflow_id: workflow.id,
      cycle: 1,
      attempt: 1,
      command: 'verify-agent',
      exit_code: 1,
      stdout: '## Verify Result: FAIL',
      stderr: null,
      duration_ms: null,
      created_at: Date.now(),
    });

    upsertNote(`workflow/${workflow.id}/verify-result/1`, '## Verify Result: FAIL\n\n### Summary\nStill broken.', null);

    const verifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'verify',
      status: 'done',
    });
    onJobCompleted(verifyJob);

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('blocked');
    expect(freshWf.blocked_reason).toContain('verify_failed');
    expect(freshWf.current_phase).toBe('verify');
  });

  // ── Verify-retry bypass ───────────────────────────────────────────────────

  it('implement jobs after failed verify bypass zero-progress detection', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, upsertNote, insertVerifyRun } = await import('../server/db/queries.js');

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 2 });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2\n- [ ] M3', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/2`, '1', null);
    upsertNote(`workflow/${workflow.id}/zero-progress-count`, '1', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/2`, '1', null);

    insertVerifyRun({
      id: 'failed-verify',
      workflow_id: workflow.id,
      cycle: 2,
      attempt: 1,
      command: 'verify-agent',
      exit_code: 1,
      stdout: null,
      stderr: null,
      duration_ms: null,
      created_at: Date.now(),
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('running');
    expect(freshWf.current_cycle).toBe(3);
    expect(freshWf.current_phase).toBe('review');
  });
});
