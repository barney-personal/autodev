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
import type { RouteDecision, RouteDecisionMode } from '../shared/types.js';

const routingState = vi.hoisted(() => ({
  mode: 'live' as 'off' | 'shadow' | 'live',
  rowMode: null as RouteDecisionMode | null,
  counter: 0,
  decision: null as RouteDecision | null,
}));

const failureState = vi.hoisted(() => ({
  kind: 'unknown',
  fallbackEligible: false,
}));

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    implementerModel: 'claude-haiku-4-5-20251001',
    reviewerModel: 'codex',
    skipReview: false,
    confidence: 'high',
    rationale: 'Test decision.',
    guardrailOverrides: [],
    llmRawResponse: '{}',
    signalsSent: {},
    promptVersion: 'v1',
    decisionModel: 'claude-sonnet-4-6[1m]',
    costEstimateUsd: 0.001,
    decidedAt: Date.now(),
    ...overrides,
  };
}

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1 })),
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'assess prompt'),
  buildReviewPrompt: vi.fn(() => 'review prompt'),
  buildImplementPrompt: vi.fn(() => 'implement prompt'),
  buildVerifyPrompt: vi.fn(() => 'verify prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'repair prompt'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'simple repair prompt'),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'closed',
    recordModelLimited: () => {},
    recordModelAvailable: () => {},
    recordInfraFailure: () => {},
    recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
  getAvailableModel: vi.fn((model: string) => {
    if (failureState.fallbackEligible && model === 'claude-opus-4-7[1m]') return 'claude-sonnet-4-6[1m]';
    return model;
  }),
  getFallbackModel: vi.fn((model: string) => {
    if (failureState.fallbackEligible && model === 'claude-opus-4-7[1m]') return 'claude-sonnet-4-6[1m]';
    return model;
  }),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => failureState.kind),
  isFallbackEligibleFailure: vi.fn(() => failureState.fallbackEligible),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/RoutingBrain.js', () => ({
  getRoutingBrainMode: vi.fn(() => routingState.mode),
  decideRouteForCycle: vi.fn(async (workflow: { id: string }, phase: string, cycle: number) => {
    const decision = routingState.decision ?? makeDecision();
    const { insertRouteDecision } = await import('../server/db/queries.js');
    insertRouteDecision({
      id: `route-${++routingState.counter}`,
      workflow_id: workflow.id,
      cycle,
      phase,
      decision,
      mode: routingState.rowMode ?? routingState.mode,
      prompt_version: decision.promptVersion,
      decision_model: decision.decisionModel,
    });
    return decision;
  }),
}));

async function flushRouting(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function createReviewReadyWorkflow() {
  const project = await insertTestProject();
  const workflow = await insertTestWorkflow({
    project_id: project.id,
    status: 'running',
    current_phase: 'review',
    current_cycle: 2,
    implementer_model: 'claude-opus-4-7[1m]',
    reviewer_model: 'codex',
    milestones_total: 3,
    milestones_done: 1,
    use_worktree: 0,
  });
  const { upsertNote } = await import('../server/db/queries.js');
  upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2\n- [ ] M3', null);
  return workflow;
}

describe('routing brain implement-spawn integration: live mode and bypasses', () => {
  beforeEach(async () => {
    routingState.mode = 'live';
    routingState.rowMode = null;
    routingState.counter = 0;
    routingState.decision = makeDecision();
    failureState.kind = 'unknown';
    failureState.fallbackEligible = false;
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('live mode uses the routed implementer model for review-approved cycle starts', async () => {
    routingState.decision = makeDecision({ implementerModel: 'claude-haiku-4-5-20251001' });
    const workflow = await createReviewReadyWorkflow();
    const reviewJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'review',
      status: 'done',
    });
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const routingBrain = await import('../server/orchestrator/RoutingBrain.js');
    const { getJobsForWorkflow, getRouteDecisionsForWorkflow } = await import('../server/db/queries.js');

    onJobCompleted(reviewJob);
    await flushRouting();

    const decisions = getRouteDecisionsForWorkflow(workflow.id);
    const implementJob = getJobsForWorkflow(workflow.id).find(job => job.workflow_phase === 'implement');

    expect(routingBrain.decideRouteForCycle).toHaveBeenCalledTimes(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].mode).toBe('live');
    expect(implementJob?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('live mode falls back to the static implementer when the persisted decision row is fallback', async () => {
    routingState.rowMode = 'fallback';
    routingState.decision = makeDecision({ implementerModel: 'claude-haiku-4-5-20251001' });
    const workflow = await createReviewReadyWorkflow();
    const reviewJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'review',
      status: 'done',
    });
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getJobsForWorkflow, getRouteDecisionsForWorkflow } = await import('../server/db/queries.js');

    onJobCompleted(reviewJob);
    await flushRouting();

    const decisions = getRouteDecisionsForWorkflow(workflow.id);
    const implementJob = getJobsForWorkflow(workflow.id).find(job => job.workflow_phase === 'implement');

    expect(decisions).toHaveLength(1);
    expect(decisions[0].mode).toBe('fallback');
    expect(implementJob?.model).toBe('claude-opus-4-7[1m]');
  });

  it('verify-failure implement retry bypasses routing for v1', async () => {
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'verify',
      current_cycle: 2,
      implementer_model: 'claude-opus-4-7[1m]',
      reviewer_model: 'codex',
      milestones_total: 3,
      milestones_done: 2,
      use_worktree: 0,
    });
    const { upsertNote, getJobsForWorkflow, getRouteDecisionsForWorkflow } = await import('../server/db/queries.js');
    upsertNote(`workflow/${workflow.id}/verify-result/2`, '## Verify Result: FAIL\n\nNeeds repair.', null);
    const verifyJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'verify',
      status: 'done',
    });
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const routingBrain = await import('../server/orchestrator/RoutingBrain.js');

    onJobCompleted(verifyJob);
    await flushRouting();

    const implementJob = getJobsForWorkflow(workflow.id).find(job => job.workflow_phase === 'implement');
    expect(routingBrain.decideRouteForCycle).not.toHaveBeenCalled();
    expect(getRouteDecisionsForWorkflow(workflow.id)).toHaveLength(0);
    expect(implementJob?.model).toBe('claude-opus-4-7[1m]');
  });

  it('explicit model fallback retries bypass routing', async () => {
    failureState.kind = 'rate_limit';
    failureState.fallbackEligible = true;
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
      implementer_model: 'claude-opus-4-7[1m]',
      reviewer_model: 'codex',
      milestones_total: 3,
      milestones_done: 1,
      use_worktree: 0,
    });
    const failedJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-opus-4-7[1m]',
    });
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const routingBrain = await import('../server/orchestrator/RoutingBrain.js');
    const { getJobsForWorkflow, getRouteDecisionsForWorkflow } = await import('../server/db/queries.js');

    onJobCompleted(failedJob);
    await flushRouting();

    const retryJob = getJobsForWorkflow(workflow.id)
      .filter(job => job.workflow_phase === 'implement' && job.id !== failedJob.id)
      .at(-1);
    expect(routingBrain.decideRouteForCycle).not.toHaveBeenCalled();
    expect(getRouteDecisionsForWorkflow(workflow.id)).toHaveLength(0);
    expect(retryJob?.model).toBe('claude-sonnet-4-6[1m]');
  });

  it('resumeWorkflow implement phase remains synchronous and bypasses routing', async () => {
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 3,
      implementer_model: 'claude-opus-4-7[1m]',
      reviewer_model: 'codex',
      milestones_total: 4,
      milestones_done: 2,
      use_worktree: 0,
    });
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const routingBrain = await import('../server/orchestrator/RoutingBrain.js');
    const { getRouteDecisionsForWorkflow } = await import('../server/db/queries.js');

    const job = resumeWorkflow(workflow, { phase: 'implement', cycle: 3 });
    await flushRouting();

    expect(job.workflow_phase).toBe('implement');
    expect(job.workflow_cycle).toBe(3);
    expect(job.model).toBe('claude-opus-4-7[1m]');
    expect(routingBrain.decideRouteForCycle).not.toHaveBeenCalled();
    expect(getRouteDecisionsForWorkflow(workflow.id)).toHaveLength(0);
  });
});

// ─── Reviewer-skip hook tests ──────────────────────────────────────────────────

async function createImplementDoneWorkflow(opts: {
  milestonesDone?: number;
  milestonesTotal?: number;
  currentCycle?: number;
  maxCycles?: number;
} = {}) {
  const done = opts.milestonesDone ?? 2;
  const total = opts.milestonesTotal ?? 5;
  const cycle = opts.currentCycle ?? 2;
  const project = await insertTestProject();
  const workflow = await insertTestWorkflow({
    project_id: project.id,
    status: 'running',
    current_phase: 'implement',
    current_cycle: cycle,
    max_cycles: opts.maxCycles ?? 10,
    implementer_model: 'claude-opus-4-7[1m]',
    reviewer_model: 'codex',
    milestones_total: total,
    milestones_done: done,
    use_worktree: 0,
  });
  const { upsertNote } = await import('../server/db/queries.js');
  const checked = Array(done).fill('- [x] Mx').join('\n');
  const unchecked = Array(total - done).fill('- [ ] Mx').join('\n');
  upsertNote(`workflow/${workflow.id}/plan`, `${checked}\n${unchecked}`, null);
  return workflow;
}

describe('routing brain live-mode reviewer-skip hook', () => {
  beforeEach(async () => {
    routingState.mode = 'live';
    routingState.rowMode = null;
    routingState.counter = 0;
    routingState.decision = makeDecision({ skipReview: true, reviewerModel: null });
    failureState.kind = 'unknown';
    failureState.fallbackEligible = false;
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('live skip creates no review job, sets marker note, and advances to next implement', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, getJobsForWorkflow, getNote, getWorkflowById } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-skip-1',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: true, reviewerModel: null }),
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJobs = jobs.filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(0);

    const markerNote = getNote(`workflow/${workflow.id}/route/cycle-2/review_status`);
    expect(markerNote?.value).toBe('auto_skipped');

    const implementJobs = jobs.filter(j => j.workflow_phase === 'implement' && j.id !== implementJob.id);
    expect(implementJobs).toHaveLength(1);
    expect(implementJobs[0].workflow_cycle).toBe(3);

    const updatedWf = getWorkflowById(workflow.id)!;
    expect(updatedWf.current_cycle).toBe(3);
  });

  it('logs a routing_brain_review_skip resilience event on skip', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, listResilienceEvents } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-skip-ev',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: true, reviewerModel: null }),
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const events = listResilienceEvents({ type: 'routing_brain_review_skip' });
    expect(events).toHaveLength(1);
    expect(events[0].entity_id).toBe(workflow.id);
    const details = JSON.parse(events[0].details!);
    expect(details.cycle).toBe(2);
    expect(details.nextCycle).toBe(3);
  });

  it('does not skip review when decision has skipReview=false (guardrails forced)', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, getJobsForWorkflow, getNote } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-no-skip',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: false, reviewerModel: 'codex' }),
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJobs = jobs.filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0].workflow_cycle).toBe(3);

    const markerNote = getNote(`workflow/${workflow.id}/route/cycle-2/review_status`);
    expect(markerNote).toBeNull();
  });

  it('does not skip review when decision row mode is shadow', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, getJobsForWorkflow, getNote } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-shadow',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: true, reviewerModel: null }),
      mode: 'shadow',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJobs = jobs.filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);

    const markerNote = getNote(`workflow/${workflow.id}/route/cycle-2/review_status`);
    expect(markerNote).toBeNull();
  });

  it('does not skip review when decision row mode is fallback', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, getJobsForWorkflow } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-fallback',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: false }),
      mode: 'fallback',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const reviewJobs = getJobsForWorkflow(workflow.id).filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);
  });

  it('does not skip review when no route decision exists', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { getJobsForWorkflow, getNote } = await import('../server/db/queries.js');

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    const reviewJobs = getJobsForWorkflow(workflow.id).filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);

    const markerNote = getNote(`workflow/${workflow.id}/route/cycle-2/review_status`);
    expect(markerNote).toBeNull();
  });

  it('does not skip re-review for zero-progress replan path', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, upsertNote, getJobsForWorkflow, getNote } = await import('../server/db/queries.js');

    // Set preImplementMilestones so zero-progress detection triggers
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/2`, '2', null);

    insertRouteDecision({
      id: 'route-skip-replan',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: true, reviewerModel: null }),
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    // Zero-progress triggers re-review at current cycle, not skippable
    const reviewJobs = getJobsForWorkflow(workflow.id).filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0].workflow_cycle).toBe(2);

    const markerNote = getNote(`workflow/${workflow.id}/route/cycle-2/review_status`);
    expect(markerNote).toBeNull();
  });

  it('does not skip review for repair jobs', async () => {
    const workflow = await createImplementDoneWorkflow();
    const { insertRouteDecision, getJobsForWorkflow } = await import('../server/db/queries.js');

    insertRouteDecision({
      id: 'route-skip-repair',
      workflow_id: workflow.id,
      cycle: 2,
      phase: 'implement',
      decision: makeDecision({ skipReview: true, reviewerModel: null }),
      mode: 'live',
      prompt_version: 'v1',
      decision_model: 'claude-sonnet-4-6[1m]',
    });

    const implementJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
      context: JSON.stringify({ is_repair: true }),
    });

    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implementJob);
    await flushRouting();

    // Repair jobs go through the is_repair path which spawns review, not skippable
    const reviewJobs = getJobsForWorkflow(workflow.id).filter(j => j.workflow_phase === 'review');
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0].workflow_cycle).toBe(2);
  });
});
