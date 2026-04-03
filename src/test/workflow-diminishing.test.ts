/**
 * Tests for the diminishing returns detector (M5/2D).
 *
 * Verifies:
 * 1. Workflow blocks when rolling 3-cycle average < 0.3 milestones/cycle
 * 2. A single slow cycle does NOT trigger the detector
 * 3. Workflow with < 3 cycles of history does NOT trigger
 * 4. Existing zero-progress detection still works alongside this
 * 5. Cycle-progress notes are written even on zero-progress cycles
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

describe('WorkflowManager: diminishing returns detector', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('blocks workflow when rolling 3-cycle average < 0.3 milestones/cycle', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 5,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 3,
    });

    // Plan: 4/10 done, pre-implement also 4 → delta = 0 this cycle
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [ ] M5\n- [ ] M6\n- [ ] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/5`, '4', null);
    // Previous cycles had 0 progress each
    upsertNote(`workflow/${workflow.id}/cycle-progress/3`, '0', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/4`, '0', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 5,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('Diminishing returns');
    expect(updated.blocked_reason).toContain('0.00');
    expect(updated.blocked_reason).toContain('4/10');
  });

  it('does NOT trigger on a single slow cycle (< 3 cycles of history)', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
      max_cycles: 10,
    });

    // Plan: 1/5 done, pre-implement had 1 → no progress but only cycle 2
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/2`, '1', null);
    // Only 1 prior cycle of progress data
    upsertNote(`workflow/${workflow.id}/cycle-progress/1`, '0', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    // Should NOT be blocked by diminishing returns (only 2 cycles, need 3)
    // It may be blocked by zero-progress if counter is high enough, but not by diminishing returns
    expect(updated.blocked_reason ?? '').not.toContain('Diminishing returns');

    // Cycle-progress note should still be written
    const cpNote = getNote(`workflow/${workflow.id}/cycle-progress/2`);
    expect(cpNote?.value).toBe('0');
  });

  it('does NOT trigger when only 1 of 3 recent cycles is slow', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 4,
      max_cycles: 10,
    });

    // Plan: 3/5 done, pre-implement was 2 → delta = 1 this cycle
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/4`, '2', null);
    // Previous cycles: cycle 2 had 1, cycle 3 had 0
    upsertNote(`workflow/${workflow.id}/cycle-progress/2`, '1', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/3`, '0', null);
    // This cycle will record delta=1 → average = (1+0+1)/3 = 0.67

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 4,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    // Average 0.67 > 0.3, should NOT block
    expect(updated.status).not.toBe('blocked');
    expect(updated.current_cycle).toBe(5); // advanced to next cycle
  });

  it('writes cycle-progress note even when zero-progress triggers block', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 4,
      max_cycles: 10,
    });

    // Plan: 2/5 done, pre-implement was 2 → zero progress
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/4`, '2', null);
    // Already at 1 zero-progress — this will be the 2nd, triggering block
    upsertNote(`workflow/${workflow.id}/zero-progress-count`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 4,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Zero-progress should have blocked it
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('no milestone progress');

    // But cycle-progress note should still have been written (before break)
    const cpNote = getNote(`workflow/${workflow.id}/cycle-progress/4`);
    expect(cpNote?.value).toBe('0');
  });

  it('resumeWorkflow clears stale cycle-progress notes so diminishing returns does not re-trigger', async () => {
    const { resumeWorkflow, onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    // Workflow was blocked by diminishing returns at cycle 5
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 5,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 4,
    });

    // Stale cycle-progress notes that caused the block (all zero → avg 0.00)
    upsertNote(`workflow/${workflow.id}/cycle-progress/3`, '0', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/4`, '0', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/5`, '0', null);
    upsertNote(`workflow/${workflow.id}/zero-progress-count`, '2', null);
    // Plan and contract needed for prompt building
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [ ] M5\n- [ ] M6\n- [ ] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    // Resume the workflow
    resumeWorkflow(workflow);

    // Verify cycle-progress notes were deleted
    expect(getNote(`workflow/${workflow.id}/cycle-progress/3`)).toBeNull();
    expect(getNote(`workflow/${workflow.id}/cycle-progress/4`)).toBeNull();
    expect(getNote(`workflow/${workflow.id}/cycle-progress/5`)).toBeNull();

    // Now simulate a new implement cycle (cycle 5 re-run) with zero progress
    const resumed = getWorkflowById(workflow.id)!;
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/5`, '4', null);

    const job = await insertTestJob({
      workflow_id: resumed.id,
      workflow_cycle: 5,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const afterImpl = getWorkflowById(workflow.id)!;
    // Should NOT be blocked at all — only 1 cycle of history after resume
    expect(afterImpl.status).not.toBe('blocked');
    // Should have advanced to cycle 6 (implement handler completed successfully)
    expect(afterImpl.current_cycle).toBe(6);
    // Blocked reason should not contain diminishing returns
    expect(afterImpl.blocked_reason ?? '').not.toContain('Diminishing returns');
    // Zero-progress count should be 1 (not high enough to block yet either)
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');
  });

  it('clamps negative milestone delta to 0 when reviewer unchecks milestones', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 5,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 4,
    });

    // Pre-implement snapshot had 5 done, but reviewer restructured the plan:
    // unchecked one milestone for rework → now only 4 checked
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [ ] M5\n- [ ] M6\n- [ ] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/5`, '5', null);
    // Previous cycles had some progress
    upsertNote(`workflow/${workflow.id}/cycle-progress/3`, '1', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/4`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 5,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Delta should be clamped to 0 (not -1)
    const cpNote = getNote(`workflow/${workflow.id}/cycle-progress/5`);
    expect(cpNote?.value).toBe('0');

    // Rolling average = (0 + 1 + 1) / 3 = 0.67 → should NOT block
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
    expect(updated.current_cycle).toBe(6);
  });

  it('does NOT trigger when rolling 3-cycle average is exactly 0.33 (strict < 0.3)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 5,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 4,
    });

    // Plan: 5/10 done, pre-implement was 4 → delta = 1 this cycle
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [x] M5\n- [ ] M6\n- [ ] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/5`, '4', null);
    // Previous cycles: 0, 0 → rolling average = (1 + 0 + 0) / 3 = 0.333...
    upsertNote(`workflow/${workflow.id}/cycle-progress/3`, '0', null);
    upsertNote(`workflow/${workflow.id}/cycle-progress/4`, '0', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 5,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Average 0.333 > 0.3 → strict less-than check should NOT block
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
    expect(updated.current_cycle).toBe(6);
    expect(updated.blocked_reason ?? '').not.toContain('Diminishing returns');
  });
});
