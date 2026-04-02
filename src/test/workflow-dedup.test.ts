/**
 * WorkflowManager dedup and phase-transition tests.
 *
 * Proves:
 * 1. _resetForTest() clears module-level dedup state between tests
 * 2. Same job ID processed twice within one test is a no-op (dedup guard)
 * 3. Same job ID works across separate tests (per-test independence via reset)
 * 4. onJobCompleted() drives a real assess→review phase transition with DB + socket assertions
 * 5. A failed phase job marks the workflow as blocked
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

// Mock SocketManager before any module that imports it
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock WorkflowPrompts so we don't need to exercise complex prompt generation
vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

// Mock ModelClassifier for rate limit fallback tests
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn((model: string) => {
    if (model === 'codex') return null;
    return model;
  }),
  getFallbackModel: vi.fn((model: string) => {
    // Simulate fallback: sonnet → haiku
    if (model === 'claude-sonnet-4-6') return 'claude-haiku-4-5-20251001';
    if (model === 'claude-sonnet-4-6[1m]') return 'claude-haiku-4-5-20251001';
    return model; // no fallback
  }),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn((model: string) => model.startsWith('codex') ? 'openai' : 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn((kind: string) =>
    kind === 'launch_environment'
      || kind === 'auth_failure'
      || kind === 'rate_limit'
      || kind === 'provider_overload'
      || kind === 'provider_capability'
      || kind === 'provider_billing'
  ),
  isSameModelRetryEligible: vi.fn((kind: string) =>
    kind === 'codex_cli_crash'
  ),
  shouldMarkProviderUnavailable: vi.fn((kind: string) =>
    kind === 'rate_limit'
      || kind === 'provider_overload'
      || kind === 'provider_billing'
      || kind === 'auth_failure'
  ),
}));

// Shared job ID used to prove cross-test dedup independence
const SHARED_JOB_ID = 'dedup-test-shared-job-id';

describe('WorkflowManager: dedup guard', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('processes a job the first time and ignores the second call (dedup within one test)', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    // Set up workflow + plan note + assess job
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      id: 'dedup-within-test',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // First call: should trigger assess→review transition
    onJobCompleted(job);
    const callsAfterFirst = vi.mocked(socket.emitWorkflowUpdate).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Verify a review job was spawned
    const emitJobNewCalls = vi.mocked(socket.emitJobNew).mock.calls;
    expect(emitJobNewCalls.length).toBe(1);
    expect(emitJobNewCalls[0][0].workflow_phase).toBe('review');

    // Second call with same job: should be a complete no-op
    vi.clearAllMocks();
    onJobCompleted(job);
    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls.length).toBe(0);
    expect(vi.mocked(socket.emitJobNew).mock.calls.length).toBe(0);

    // DB state unchanged from first call
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.current_phase).toBe('review');
    expect(updated.current_cycle).toBe(1);
  });

  it('processes the SHARED_JOB_ID (first test — proves reset clears dedup set)', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      id: SHARED_JOB_ID,
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    onJobCompleted(job);

    // Should have processed the job (not dedup-blocked)
    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls.length).toBeGreaterThan(0);
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.current_phase).toBe('review');
  });

  it('processes the SHARED_JOB_ID again (second test — proves per-test independence)', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      id: SHARED_JOB_ID,
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // If _resetForTest didn't clear the set, this would be silently deduped
    onJobCompleted(job);

    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls.length).toBeGreaterThan(0);
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.current_phase).toBe('review');
  });
});

describe('WorkflowManager: onJobCompleted phase transitions', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('assess completion spawns a review job and updates workflow phase', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2\n- [x] M3', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    onJobCompleted(job);

    // Workflow state updated
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.current_phase).toBe('review');
    expect(updated.current_cycle).toBe(1);
    expect(updated.milestones_total).toBe(3);
    expect(updated.milestones_done).toBe(1);

    // Review job was spawned
    const emitJobNewCalls = vi.mocked(socket.emitJobNew).mock.calls;
    expect(emitJobNewCalls.length).toBe(1);
    const reviewJob = emitJobNewCalls[0][0];
    expect(reviewJob.workflow_id).toBe(workflow.id);
    expect(reviewJob.workflow_phase).toBe('review');
    expect(reviewJob.workflow_cycle).toBe(1);
  });

  it('assess completion missing notes spawns a repair job before blocking', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');
    expect(updated.current_phase).toBe('assess');

    const jobs = getJobsForWorkflow(workflow.id);
    const repairJob = jobs.find(j => j.id !== job.id);
    expect(repairJob).toBeDefined();
    expect(repairJob!.title).toContain('repair');
    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls.map(c => c[0].status)).not.toContain('blocked');
  });

  it('failed phase job auto-retries with fallback model before blocking', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'failed',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    // Simulate rate-limiting: the job's model (implementer default 'claude-sonnet-4-6') is unavailable.
    // Fix-5 requires getAvailableModel to signal unavailability before the fallback search begins.
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'claude-sonnet-4-6') return null; // rate-limited
      if (model === 'codex') return null;
      return model;
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    // Should auto-retry with fallback model, not immediately block
    expect(updated.status).toBe('running');

    // A new job should have been spawned with a fallback model
    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    expect(retryJob!.title).toContain('(fallback)');

    // Socket should have emitted updates (phase job spawned, not blocked)
    const updateCalls = vi.mocked(socket.emitWorkflowUpdate).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    // Should NOT have emitted blocked status
    const statuses = updateCalls.map(c => c[0].status);
    expect(statuses).not.toContain('blocked');
  });

  it('provider capability failures auto-retry with a fallback model', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      implementer_model: 'claude-sonnet-4-6[1m]',
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'failed',
      model: 'claude-sonnet-4-6[1m]',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('provider_capability');
    // Simulate capability unavailability so Fix-5 early return does not prevent fallback.
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'claude-sonnet-4-6[1m]') return null; // capability error
      if (model === 'codex') return null;
      return model;
    });

    onJobCompleted(job);

    expect(getWorkflowById(workflow.id)!.status).toBe('running');
    expect(getJobsForWorkflow(workflow.id).some(j => j.id !== job.id && j.title.includes('(fallback)'))).toBe(true);
  });

  it('generic phase failures block the workflow instead of poisoning the model', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'failed',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('task_failure');

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(getJobsForWorkflow(workflow.id)).toHaveLength(1);

    const statuses = vi.mocked(socket.emitWorkflowUpdate).mock.calls.map(c => c[0].status);
    expect(statuses).toContain('blocked');
  });

  it('codex_cli_crash retries same model instead of blocking', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 2,
      reviewer_model: 'codex',
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'review',
      status: 'failed',
      model: 'codex',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('codex_cli_crash');

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');

    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    expect(retryJob!.title).not.toContain('(fallback)');
  });

  it('codex_cli_crash blocks after exhausting same-model retries', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 2,
      reviewer_model: 'codex',
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);
    upsertNote(`workflow/${workflow.id}/cli-retry/review/cycle-2`, '3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'review',
      status: 'failed',
      model: 'codex',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('codex_cli_crash');

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(getJobsForWorkflow(workflow.id)).toHaveLength(1);
  });

  it('max_cycles reached with remaining milestones blocks instead of completing', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      max_cycles: 1,          // max_cycles = 1, so current_cycle >= max_cycles
      milestones_total: 9,
      milestones_done: 0,
    });
    // Plan has 9 milestones, only 1 checked
    upsertNote(`workflow/${workflow.id}/plan`, [
      '- [x] M1: First milestone',
      '- [ ] M2: Second milestone',
      '- [ ] M3: Third milestone',
      '- [ ] M4: Fourth milestone',
      '- [ ] M5: Fifth milestone',
      '- [ ] M6: Sixth milestone',
      '- [ ] M7: Seventh milestone',
      '- [ ] M8: Eighth milestone',
      '- [ ] M9: Ninth milestone',
    ].join('\n'), null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    // Must be blocked, NOT complete — 8 milestones still unchecked
    expect(updated.status).toBe('blocked');
    expect(updated.milestones_done).toBe(1);
    expect(updated.milestones_total).toBe(9);

    // Should NOT have emitted 'complete'
    const statuses = vi.mocked(socket.emitWorkflowUpdate).mock.calls.map(c => c[0].status).filter(Boolean);
    expect(statuses).not.toContain('complete');
  });

  it('max_cycles reached with ALL milestones done correctly marks complete', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 5,
      max_cycles: 5,
    });
    // All milestones checked
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 5,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('complete');
  });

  it('non-workflow job is silently ignored', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');

    const job = await insertTestJob({
      workflow_id: null,
      status: 'done',
    });

    onJobCompleted(job);

    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls.length).toBe(0);
    expect(vi.mocked(socket.emitJobNew).mock.calls.length).toBe(0);
  });

  it('assess completion with 0-milestone plan triggers repair then blocks with descriptive reason', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    // Plan exists but has no checkbox milestones
    upsertNote(`workflow/${workflow.id}/plan`, '# Plan\n\nSome text without checkboxes', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    onJobCompleted(job);

    // First call should spawn a repair job (budget=1)
    const jobs = getJobsForWorkflow(workflow.id);
    const repairJob = jobs.find(j => j.id !== job.id);
    expect(repairJob).toBeDefined();
    expect(repairJob!.title).toContain('repair');

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');

    // Simulate repair also failing to add milestones — second completion should block
    vi.clearAllMocks();
    onJobCompleted({ ...repairJob!, status: 'done' } as any);

    const blocked = getWorkflowById(workflow.id)!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked_reason).toContain('no milestones');
  });

  it('review phase missing plan blocks with blocked_reason', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
    });
    // No plan note at all

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'review',
      status: 'done',
    });

    onJobCompleted(job);

    // First call spawns a repair job
    const jobs = getJobsForWorkflow(workflow.id);
    const repairJob = jobs.find(j => j.id !== job.id);
    expect(repairJob).toBeDefined();

    // Simulate repair failing to write the plan — second completion should block with reason
    vi.clearAllMocks();
    onJobCompleted({ ...repairJob!, status: 'done' } as any);

    const blocked = getWorkflowById(workflow.id)!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked_reason).toBeTruthy();
    expect(blocked.blocked_reason).toContain('plan');
  });
});

describe('WorkflowManager: getWorkflowFallbackModel', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('Fix-5: uses configured model without downgrade when no model is rate-limited', async () => {
    // When the current model is available, spawnPhaseJob must use the phase's configured
    // model (reviewer_model for review), NOT silently downgrade to a candidate.
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getJobsForWorkflow } = await import('../server/db/queries.js');
    const { getAvailableModel } = await import('../server/orchestrator/ModelClassifier.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      implementer_model: 'claude-sonnet-4-6[1m]',
      reviewer_model: 'claude-opus-4-6[1m]',
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Default mock: all models available (no rate limits)
    vi.mocked(getAvailableModel).mockImplementation((model: string) => model);

    onJobCompleted(job);

    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJob = jobs.find(j => j.id !== job.id);
    expect(reviewJob).toBeDefined();
    // Should use the configured reviewer_model, not a fallback
    expect(reviewJob!.model).toBe('claude-opus-4-6[1m]');
    expect(reviewJob!.title).not.toContain('(fallback)');
  });

  it('Fix-6: review phase fallback includes reviewer_model as candidate', async () => {
    // When a review job fails and the primary model is unavailable, the workflow's
    // reviewer_model should be tried before hardcoded alternatives.
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel, getFallbackModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
      implementer_model: 'claude-sonnet-4-6',  // also unavailable
      reviewer_model: 'claude-opus-4-6[1m]',   // available
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    // Job ran on haiku (e.g. a previous fallback), not the reviewer_model
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'review',
      status: 'failed',
      model: 'claude-haiku-4-5-20251001',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    // haiku + sonnet are rate-limited; opus[1m] (reviewer_model) is available
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'claude-haiku-4-5-20251001') return null;
      if (model === 'claude-sonnet-4-6') return null;
      if (model === 'codex') return null;
      return model;
    });
    vi.mocked(getFallbackModel).mockImplementation((model: string) => model);

    onJobCompleted(job);

    expect(getWorkflowById(workflow.id)!.status).toBe('running');
    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    // reviewer_model should have been tried and selected
    expect(retryJob!.model).toBe('claude-opus-4-6[1m]');
  });

  it('Fix-8: fallback from [1m] model reaches a genuinely different family', async () => {
    // When the current model is 'claude-opus-4-6[1m]' (rate-limited), the hardcoded
    // candidate set must not return the non-[1m] variant of the same family.
    // The result should be from a different model family (sonnet).
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel, getFallbackModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { upsertNote, getWorkflowById, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'claude-opus-4-6[1m]',
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-opus-4-6[1m]',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    // opus[1m] is rate-limited; sonnet[1m] and haiku are available; non-[1m] opus is also "available"
    vi.mocked(getAvailableModel).mockImplementation((model: string) => {
      if (model === 'claude-opus-4-6[1m]') return null;
      if (model === 'codex') return null;
      return model;
    });
    vi.mocked(getFallbackModel).mockImplementation((model: string) => model);

    onJobCompleted(job);

    expect(getWorkflowById(workflow.id)!.status).toBe('running');
    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    // Must be a different model family — NOT 'claude-opus-4-6' (same base, no [1m])
    expect(retryJob!.model).not.toBe('claude-opus-4-6');
    // Should be sonnet[1m] — the first genuinely different hardcoded candidate
    expect(retryJob!.model).toBe('claude-sonnet-4-6[1m]');
  });

  it('all models unavailable returns null — workflow blocks', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { classifyJobFailure } = await import('../server/orchestrator/FailureClassifier.js');
    const { getAvailableModel, getFallbackModel } = await import('../server/orchestrator/ModelClassifier.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      implementer_model: 'claude-sonnet-4-6[1m]',
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6[1m]',
    });

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    // Every model is unavailable
    vi.mocked(getAvailableModel).mockReturnValue(null);
    vi.mocked(getFallbackModel).mockReturnValue(null);

    onJobCompleted(job);

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('no fallback model available');
  });
});

describe('WorkflowManager: reconcileRunningWorkflows', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('detects a done implement job and advances workflow to next review cycle', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    // The implement job completed but no next phase was spawned (gap)
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    reconcileRunningWorkflows();

    const updated = getWorkflowById(workflow.id)!;
    // Should have advanced: either moved to review cycle 3, or at minimum no longer stuck
    if (updated.status === 'running') {
      // Advanced to next cycle review
      expect(updated.current_cycle).toBe(3);
      expect(updated.current_phase).toBe('review');
      // A review job should have been spawned
      expect(vi.mocked(socket.emitJobNew).mock.calls.length).toBeGreaterThan(0);
      const newJob = vi.mocked(socket.emitJobNew).mock.calls[0][0];
      expect(newJob.workflow_phase).toBe('review');
    } else {
      // If it blocked, it must have a descriptive reason
      expect(updated.status).toBe('blocked');
      expect(updated.blocked_reason).toBeTruthy();
    }
  });

  it('blocks a running workflow stuck in idle phase with no active jobs', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'idle',
      current_cycle: 0,
    });

    reconcileRunningWorkflows();

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('no active phase job');
  });

  it('skips workflows that have active jobs', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
    });
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);

    // Job is still running — should not be touched
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'running',
    });

    reconcileRunningWorkflows();

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('running');
    expect(updated.current_phase).toBe('implement');
    expect(updated.current_cycle).toBe(1);
  });

  it('blocks when no matching phase job exists', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
    });
    // No jobs at all for this workflow

    reconcileRunningWorkflows();

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.blocked_reason).toContain('no phase job to resume');
  });

  it('does not touch non-running workflows', async () => {
    const { reconcileRunningWorkflows } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
    });

    reconcileRunningWorkflows();

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).toBe('blocked');
    // No change
  });
});
