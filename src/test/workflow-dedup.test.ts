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
    kind === 'rate_limit'
      || kind === 'provider_overload'
      || kind === 'provider_capability'
      || kind === 'provider_billing'
  ),
  shouldMarkProviderUnavailable: vi.fn((kind: string) =>
    kind === 'rate_limit'
      || kind === 'provider_overload'
      || kind === 'provider_billing'
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
