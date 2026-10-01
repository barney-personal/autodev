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
  mode: 'off' as 'off' | 'shadow' | 'live',
  rowMode: null as RouteDecisionMode | null,
  counter: 0,
  decision: null as RouteDecision | null,
}));

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  const now = Date.now();
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
    decidedAt: now,
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
  KNOWN_MODELS: [
    'claude-opus-4-7',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6[1m]',
    'claude-haiku-4-5-20251001',
    'codex',
  ],
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'closed',
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

async function createReviewReadyWorkflow(mode: 'off' | 'shadow' | 'live' = 'shadow') {
  routingState.mode = mode;
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

describe('routing brain implement-spawn integration: off and shadow modes', () => {
  beforeEach(async () => {
    routingState.mode = 'off';
    routingState.rowMode = null;
    routingState.counter = 0;
    routingState.decision = makeDecision();
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('off mode creates no route decision rows and keeps the static implementer model', async () => {
    const workflow = await createReviewReadyWorkflow('off');
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

    const implementJob = getJobsForWorkflow(workflow.id).find(job => job.workflow_phase === 'implement');
    expect(implementJob?.model).toBe('claude-opus-4-7[1m]');
    expect(getRouteDecisionsForWorkflow(workflow.id)).toHaveLength(0);
    expect(routingBrain.decideRouteForCycle).not.toHaveBeenCalled();
  });

  it('shadow mode persists one decision but spawns with the static implementer model', async () => {
    routingState.decision = makeDecision({ implementerModel: 'claude-haiku-4-5-20251001' });
    const workflow = await createReviewReadyWorkflow('shadow');
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
    expect(decisions[0].mode).toBe('shadow');
    expect(decisions[0].decision.implementerModel).toBe('claude-haiku-4-5-20251001');
    expect(implementJob?.model).toBe('claude-opus-4-7[1m]');
  });
});

describe('adaptive routing dispatch and final independent review', () => {
  beforeEach(async () => {
    routingState.mode = 'off';
    await setupTestDb();
    await resetManagerState();
    vi.stubEnv('ADAPTIVE_ROUTING_MODE', 'live');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('ADAPTIVE_DECISION_MODEL', 'claude-haiku-4-5-20251001');
    const { _resetClassificationForTest } = await import('../server/orchestrator/TaskComplexity.js');
    _resetClassificationForTest();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ complexity: 'simple', kind: 'mechanical', confidence: 'high', risk: 'low', rationale: 'Specified text correction.' }) }], stop_reason: 'end_turn',
    }) }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await cleanupTestDb();
  });

  it.each(['live', 'shadow'] as const)('dispatches the correct model in %s mode', async mode => {
    vi.stubEnv('ADAPTIVE_ROUTING_MODE', mode);
    const workflow = await createReviewReadyWorkflow('off');
    const { spawnImplementWithRouting } = await import('../server/orchestrator/WorkflowManager.js');
    const q = await import('../server/db/queries.js');
    await spawnImplementWithRouting(workflow, 2);
    const job = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'implement');
    expect(job?.model).toBe(mode === 'live' ? 'claude-haiku-4-5-20251001' : workflow.implementer_model);
    expect(q.getRouteDecisionsForWorkflow(workflow.id)[0].decision.skipReview).toBe(false);
  });

  it('requires final review even if routing is switched off after implementation starts', async () => {
    const workflow = await createReviewReadyWorkflow('off');
    const { spawnImplementWithRouting, onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const q = await import('../server/db/queries.js');
    await spawnImplementWithRouting(workflow, 2);
    const job = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'implement')!;
    q.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);
    vi.stubEnv('ADAPTIVE_ROUTING_MODE', 'off');
    onJobCompleted({ ...job, status: 'done' });
    expect(q.getWorkflowById(workflow.id)?.status).toBe('running');
    const review = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'review');
    expect(review).toMatchObject({ workflow_cycle: 3, model: workflow.reviewer_model });
  });

  it('does not spawn an agent if the workflow is cancelled during classification', async () => {
    const workflow = await createReviewReadyWorkflow('off');
    const q = await import('../server/db/queries.js');
    const fetchImpl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      q.updateWorkflow(workflow.id, { status: 'cancelled' });
      return fetchImpl(...args);
    });
    const { spawnImplementWithRouting } = await import('../server/orchestrator/WorkflowManager.js');
    await spawnImplementWithRouting(workflow, 2);
    expect(q.getJobsForWorkflow(workflow.id)).toHaveLength(0);
  });

  it('runs configured verification only after the final review', async () => {
    const workflow = await createReviewReadyWorkflow('off');
    const q = await import('../server/db/queries.js');
    q.updateWorkflow(workflow.id, { start_command: 'npm test' });
    const { spawnImplementWithRouting, onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    await spawnImplementWithRouting(q.getWorkflowById(workflow.id)!, 2);
    const job = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'implement')!;
    q.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);
    onJobCompleted({ ...job, status: 'done' });
    expect(q.getJobsForWorkflow(workflow.id).some(j => j.workflow_phase === 'verify')).toBe(false);
    const review = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'review')!;
    onJobCompleted({ ...review, status: 'done' });
    expect(q.getJobsForWorkflow(workflow.id).some(j => j.workflow_phase === 'verify')).toBe(true);
  });

  it('blocks final review corrections when implementation budget is exhausted', async () => {
    const workflow = await createReviewReadyWorkflow('off');
    const q = await import('../server/db/queries.js');
    q.updateWorkflow(workflow.id, { max_cycles: 2 });
    const { spawnImplementWithRouting, onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    await spawnImplementWithRouting(q.getWorkflowById(workflow.id)!, 2);
    const job = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'implement')!;
    q.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);
    onJobCompleted({ ...job, status: 'done' });
    const review = q.getJobsForWorkflow(workflow.id).find(j => j.workflow_phase === 'review')!;
    q.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [ ] **Fix incorrect M3**', null);
    onJobCompleted({ ...review, status: 'done' });
    expect(q.getWorkflowById(workflow.id)).toMatchObject({ status: 'blocked', blocked_reason: expect.stringContaining('budget exhausted') });
    expect(q.getJobsForWorkflow(workflow.id).filter(j => j.workflow_phase === 'implement')).toHaveLength(1);
  });
});
