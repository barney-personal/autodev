/**
 * Tests for M7/4C — Assess output fallback for missing plan.
 *
 * Verifies:
 * 1. Plan is recovered from agent output when write_note was missed
 * 2. Malformed output (no plan header or no milestones) falls through to repair
 * 3. extractPlanFromText correctly parses plan sections
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

/** Build a mock assistant NDJSON event containing text */
function makeAssistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

describe('WorkflowManager: assess output fallback (M7/4C)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('recovers plan from agent output when write_note was missed', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Contract exists but plan was NOT written via write_note
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Create an agent that ran for this job, with plan in its output
    const agent = insertAgent({ id: `agent-${job.id}`, job_id: job.id, status: 'done' });
    const planText = '# Plan\n\n## Milestones\n- [x] M1: Done\n- [ ] M2: Todo\n- [ ] M3: Also todo';
    insertAgentOutput({
      agent_id: agent.id,
      seq: 1,
      event_type: 'assistant',
      content: makeAssistantEvent(planText),
      created_at: Date.now(),
    });

    onJobCompleted(job);

    // Plan should have been recovered and workflow should advance to review
    const planNote = getNote(`workflow/${workflow.id}/plan`);
    expect(planNote?.value).toContain('- [ ] M2');
    expect(planNote?.value).toContain('- [ ] M3');

    const updated = getWorkflowById(workflow.id)!;
    // Should not be blocked — plan was recovered
    expect(updated.status).not.toBe('blocked');
    expect(updated.current_cycle).toBe(1); // advanced to cycle 1 for review
  });

  it('falls through to repair when agent output has no valid plan', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Contract exists, no plan
    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Agent output with no plan header — just random text
    const agent = insertAgent({ id: `agent-${job.id}`, job_id: job.id, status: 'done' });
    insertAgentOutput({
      agent_id: agent.id,
      seq: 1,
      event_type: 'assistant',
      content: makeAssistantEvent('I analyzed the codebase and found several issues.'),
      created_at: Date.now(),
    });

    onJobCompleted(job);

    // Recovery from output should fail — repair job is spawned (first attempt)
    // so workflow stays running, not blocked yet
    const updated = getWorkflowById(workflow.id)!;
    // Plan note should still be absent
    const { getNote } = await import('../server/db/queries.js');
    expect(getNote(`workflow/${workflow.id}/plan`)).toBeNull();
    // A repair job should have been created for the missing plan
    const { getJobsForWorkflow } = await import('../server/db/queries.js');
    const jobs = getJobsForWorkflow(workflow.id);
    const repairJob = jobs.find(j => j.title?.includes('repair'));
    expect(repairJob).toBeDefined();
  });

  it('recovers the last (most refined) plan when multiple fragments exist', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    const agent = insertAgent({ id: `agent-${job.id}`, job_id: job.id, status: 'done' });

    // First message: early draft with 2 milestones
    const earlyPlan = '# Plan\n\n- [ ] M1: First thing\n- [ ] M2: Second thing';
    insertAgentOutput({
      agent_id: agent.id,
      seq: 1,
      event_type: 'assistant',
      content: makeAssistantEvent(earlyPlan),
      created_at: Date.now(),
    });

    // Second message: refined plan with 4 milestones (the final version)
    const refinedPlan = '# Plan\n\n- [ ] M1: First thing\n- [ ] M2: Second thing\n- [ ] M3: Third thing\n- [ ] M4: Fourth thing';
    insertAgentOutput({
      agent_id: agent.id,
      seq: 2,
      event_type: 'assistant',
      content: makeAssistantEvent(refinedPlan),
      created_at: Date.now(),
    });

    onJobCompleted(job);

    // Should recover the refined plan (4 milestones), not the early draft (2)
    const planNote = getNote(`workflow/${workflow.id}/plan`);
    expect(planNote?.value).toContain('- [ ] M3');
    expect(planNote?.value).toContain('- [ ] M4');

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
    expect(updated.current_cycle).toBe(1);
  });

  it('falls through when plan header exists but has no milestones', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    upsertNote(`workflow/${workflow.id}/contract`, 'test contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Agent output has # Plan header but no milestone checkboxes
    const agent = insertAgent({ id: `agent-${job.id}`, job_id: job.id, status: 'done' });
    insertAgentOutput({
      agent_id: agent.id,
      seq: 1,
      event_type: 'assistant',
      content: makeAssistantEvent('# Plan\n\nThis is a plan without any milestones.\nJust some text.'),
      created_at: Date.now(),
    });

    onJobCompleted(job);

    // Plan has no milestones so recovery fails — repair job spawned
    const { getNote } = await import('../server/db/queries.js');
    expect(getNote(`workflow/${workflow.id}/plan`)).toBeNull();
    const { getJobsForWorkflow } = await import('../server/db/queries.js');
    const jobs = getJobsForWorkflow(workflow.id);
    const repairJob = jobs.find(j => j.title?.includes('repair'));
    expect(repairJob).toBeDefined();
  });
});

describe('extractPlanFromText', () => {
  it('extracts plan section with milestones', async () => {
    const { extractPlanFromText } = await import('../server/orchestrator/WorkflowManager.js');

    const text = 'Some preamble text.\n\n# Plan\n\n- [x] M1: Done\n- [ ] M2: Todo\n\n# Other Section\n\nMore text.';
    const result = extractPlanFromText(text);
    expect(result).toContain('# Plan');
    expect(result).toContain('- [ ] M2');
    expect(result).not.toContain('# Other Section');
  });

  it('returns null when no plan header exists', async () => {
    const { extractPlanFromText } = await import('../server/orchestrator/WorkflowManager.js');

    const result = extractPlanFromText('Just some random text without a plan.');
    expect(result).toBeNull();
  });

  it('returns null when plan has no unchecked milestones', async () => {
    const { extractPlanFromText } = await import('../server/orchestrator/WorkflowManager.js');

    const result = extractPlanFromText('# Plan\n\n- [x] M1: Done\n- [x] M2: Also done');
    expect(result).toBeNull();
  });

  it('handles ## Plan header variant', async () => {
    const { extractPlanFromText } = await import('../server/orchestrator/WorkflowManager.js');

    const text = '## Plan\n\n- [ ] M1: Todo\n- [ ] M2: Also todo';
    const result = extractPlanFromText(text);
    expect(result).toContain('## Plan');
    expect(result).toContain('- [ ] M1');
  });
});
