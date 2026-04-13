/**
 * Tests for M10/3C — Good-enough completion threshold.
 *
 * Verifies:
 * 1. Workflow completes early when done/total >= threshold (< 1.0)
 * 2. Default threshold 1.0 requires all milestones (existing behavior)
 * 3. Threshold is clamped to [0.1, 1.0]
 * 4. meetsCompletionThreshold helper works correctly
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

describe('meetsCompletionThreshold', () => {
  it('returns true when all milestones done (threshold 1.0)', async () => {
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowManager.js');
    expect(meetsCompletionThreshold({ total: 5, done: 5 }, 1.0)).toBe(true);
  });

  it('returns false when not all milestones done (threshold 1.0)', async () => {
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowManager.js');
    expect(meetsCompletionThreshold({ total: 5, done: 4 }, 1.0)).toBe(false);
  });

  it('returns true when 70% done and threshold is 0.7', async () => {
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowManager.js');
    expect(meetsCompletionThreshold({ total: 10, done: 7 }, 0.7)).toBe(true);
  });

  it('returns false when 60% done and threshold is 0.7', async () => {
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowManager.js');
    expect(meetsCompletionThreshold({ total: 10, done: 6 }, 0.7)).toBe(false);
  });

  it('returns false when total is 0', async () => {
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowManager.js');
    expect(meetsCompletionThreshold({ total: 0, done: 0 }, 0.5)).toBe(false);
  });
});

describe('WorkflowManager: completion threshold (M10/3C)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('completes workflow early when threshold < 1.0 is met after implement', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, updateWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 7,
    });

    // Set completion_threshold to 0.7
    updateWorkflow(workflow.id, { completion_threshold: 0.7 } as any);

    // Plan has 7/10 done (70% = threshold)
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [x] M5\n- [x] M6\n- [x] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('complete');
  });

  it('does NOT complete workflow when below threshold after implement', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, updateWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 10,
      milestones_done: 6,
    });

    // Set completion_threshold to 0.7
    updateWorkflow(workflow.id, { completion_threshold: 0.7 } as any);

    // Plan has 6/10 done (60% < 70% threshold)
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [x] M5\n- [x] M6\n- [ ] M7\n- [ ] M8\n- [ ] M9\n- [ ] M10', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '5', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    // Should NOT be complete — below threshold, should advance to next cycle
    expect(updated.status).not.toBe('complete');
  });

  it('default threshold 1.0 requires all milestones', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 4,
    });

    // Default threshold is 1.0 — 4/5 should NOT complete
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [x] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '3', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('complete');
  });

  it('completion_threshold is clamped in AutonomousAgentRunManager', async () => {
    const { createAutonomousAgentRun } = await import('../server/orchestrator/AutonomousAgentRunManager.js');

    // Below minimum: 0.05 should clamp to 0.1
    const result1 = createAutonomousAgentRun({
      task: 'test task',
      completionThreshold: 0.05,
    });
    expect(result1.workflow.completion_threshold).toBe(0.1);

    // Above maximum: 1.5 should clamp to 1.0
    const result2 = createAutonomousAgentRun({
      task: 'test task 2',
      completionThreshold: 1.5,
    });
    expect(result2.workflow.completion_threshold).toBe(1.0);

    // Normal value: 0.7 should pass through
    const result3 = createAutonomousAgentRun({
      task: 'test task 3',
      completionThreshold: 0.7,
    });
    expect(result3.workflow.completion_threshold).toBe(0.7);
  });
});
