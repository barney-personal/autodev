/**
 * Tests for M8/1C — Auto-split failed milestones via re-plan on zero progress.
 *
 * Verifies:
 * 1. First zero-progress cycle spawns a review job for plan restructuring
 * 2. Second zero-progress cycle (replan already attempted) increments counter as before
 * 3. Re-plan note prevents infinite re-plan loop
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

// Mock fs.existsSync so pre-flight checks pass
vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// Mock child_process.execSync for branch verification
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
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

describe('WorkflowManager: auto-split via re-plan on zero progress (M8/1C)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('spawns review job on first zero-progress cycle (no replan-attempted)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    // Plan with 2/5 done, pre-implement also 2 → delta = 0
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    // No replan-attempted note — this is the first zero-progress

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // replan-attempted note should be set
    const replanNote = getNote(`workflow/${workflow.id}/replan-attempted/3`);
    expect(replanNote?.value).toBe('1');

    // Zero-progress counter should NOT be incremented (re-plan intercepts)
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value ?? '0').toBe('0');

    // A review job should have been spawned for the same cycle
    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJob = jobs.find(j => j.workflow_phase === 'review' && j.workflow_cycle === 3);
    expect(reviewJob).toBeDefined();

    // Workflow should NOT be blocked
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('increments zero-progress counter on second zero-progress when replan already attempted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    // Replan already attempted this cycle
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Zero-progress counter SHOULD be incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');

    // No additional review job should be spawned (only the original implement job exists)
    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJobs = jobs.filter(j => j.workflow_phase === 'review' && j.workflow_cycle === 3);
    expect(reviewJobs).toHaveLength(0);
  });

  it('re-plan does not trigger on cycles with actual progress', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 3,
    });

    // Plan with 3/5 done, pre-implement was 2 → delta = 1 (progress!)
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // No replan-attempted note should be set (progress was made)
    const replanNote = getNote(`workflow/${workflow.id}/replan-attempted/3`);
    expect(replanNote).toBeNull();

    // Zero-progress counter should be reset
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');
  });
});
