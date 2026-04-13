/**
 * Tests for M16/4B — Escalating repair budget.
 *
 * Verifies:
 * 1. Repair escalates through 3 levels (quick, diagnostic, full re-assess)
 * 2. Each level gets progressively more turns
 * 3. After 3 attempts, repair returns false (caller blocks workflow)
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
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified assess repair prompt'),
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

describe('WorkflowManager: escalating repair budget (M16/4B)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('escalates through 3 repair levels with increasing turn budgets', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Simulate 3 failed assess phases (no plan written)
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    // First repair attempt: quick repair
    const job1 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job1);

    let jobs = getJobsForWorkflow(workflow.id);
    let repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].title).toContain('quick repair');
    const quickTurns = repairJobs[0].max_turns;

    // Second repair attempt: diagnostic repair
    const job2 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job2);

    jobs = getJobsForWorkflow(workflow.id);
    repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(2);
    expect(repairJobs[1].title).toContain('diagnostic repair');
    const diagnosticTurns = repairJobs[1].max_turns;
    expect(diagnosticTurns).toBeGreaterThan(quickTurns!);

    // Third repair attempt: full re-assess repair
    const job3 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job3);

    jobs = getJobsForWorkflow(workflow.id);
    repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(3);
    expect(repairJobs[2].title).toContain('full re-assess repair');
    const fullTurns = repairJobs[2].max_turns;
    expect(fullTurns).toBeGreaterThan(diagnosticTurns!);
  });

  it('blocks workflow after 3 repair attempts are exhausted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);
    // Pre-set repair attempts to 3 (all exhausted)
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
  });
});

describe('WorkflowManager: assess repair model escalation', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('first repair uses workflow implementer_model', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      implementer_model: 'claude-sonnet-4-6',
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].model).toBe('claude-sonnet-4-6');
  });

  it('second repair escalates to claude-opus-4-6', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      implementer_model: 'claude-sonnet-4-6',
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);
    // Pre-set 1 prior attempt so next is attempt 2
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].model).toBe('claude-opus-4-6');
  });

  it('third repair also uses claude-opus-4-6', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      implementer_model: 'claude-sonnet-4-6',
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);
    // Pre-set 2 prior attempts so next is attempt 3
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].model).toBe('claude-opus-4-6');
  });

  it('review repair does NOT escalate to claude-opus-4-6', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
      reviewer_model: 'claude-sonnet-4-6',
    });

    // Pre-set 1 prior review repair attempt so next would be attempt 2
    upsertNote(`workflow/${workflow.id}/repair/review/cycle-1`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'review',
      status: 'done',
    });
    onJobCompleted(job);

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs).toHaveLength(1);
    // Review repairs should NOT escalate to opus; they use the reviewer_model
    expect(repairJobs[0].model).toBe('claude-sonnet-4-6');
    expect(repairJobs[0].model).not.toBe('claude-opus-4-6');
  });
});

describe('WorkflowManager: assess repair prompt selection', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('third repair with plan-only missing uses simplified assess prompt', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');
    const { buildSimplifiedAssessRepairPrompt, buildWorkflowRepairPrompt } = await import('../server/orchestrator/WorkflowPrompts.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Contract exists so only plan is missing
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);
    // Pre-set 2 prior attempts so next is attempt 3 (existingAttempts >= 2)
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    expect(buildSimplifiedAssessRepairPrompt).toHaveBeenCalledOnce();
    expect(buildWorkflowRepairPrompt).not.toHaveBeenCalled();

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJobs = jobs.filter(j => j.title?.includes('repair'));
    expect(repairJobs[0].description).toBe('mock simplified assess repair prompt');
  });

  it('third repair with plan+contract missing uses standard repair prompt', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote } = await import('../server/db/queries.js');
    const { buildSimplifiedAssessRepairPrompt, buildWorkflowRepairPrompt } = await import('../server/orchestrator/WorkflowPrompts.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Neither plan nor contract written — both are missing
    // Pre-set 2 prior attempts so next is attempt 3
    upsertNote(`workflow/${workflow.id}/repair/assess/cycle-0`, '2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    // Simplified prompt must NOT be used when contract is also missing
    expect(buildSimplifiedAssessRepairPrompt).not.toHaveBeenCalled();
    expect(buildWorkflowRepairPrompt).toHaveBeenCalledOnce();
  });

  it('first and second repairs use standard repair prompt regardless', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote } = await import('../server/db/queries.js');
    const { buildSimplifiedAssessRepairPrompt, buildWorkflowRepairPrompt } = await import('../server/orchestrator/WorkflowPrompts.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    // First repair (attempt 0 → existingAttempts=0)
    const job1 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job1);

    expect(buildSimplifiedAssessRepairPrompt).not.toHaveBeenCalled();
    expect(buildWorkflowRepairPrompt).toHaveBeenCalledTimes(1);

    // Second repair (attempt 1 → existingAttempts=1)
    const job2 = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job2);

    expect(buildSimplifiedAssessRepairPrompt).not.toHaveBeenCalled();
    expect(buildWorkflowRepairPrompt).toHaveBeenCalledTimes(2);
  });
});
