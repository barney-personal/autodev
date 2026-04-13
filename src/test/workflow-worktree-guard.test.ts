/**
 * WorkflowManager spawnPhaseJob worktree safety guard test.
 *
 * Proves that phase handoff repairs recoverable worktree metadata gaps before
 * spawning the next job, while still blocking unrecoverable cases.
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

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn((m: string) => m),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn((kind: string) =>
    kind === 'rate_limit' || kind === 'provider_overload'
  ),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

// Mock Sentry instrument
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

const execSyncMock = vi.fn((cmd: string) => {
  if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
    return Buffer.from('expected-branch\n');
  }
  if (typeof cmd === 'string' && cmd.includes('rev-parse --verify') && cmd.includes('refs/heads/')) {
    throw new Error('fatal: Needed a single revision');
  }
  return Buffer.from('');
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: (...args: any[]) => execSyncMock(...args),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowManager: spawnPhaseJob worktree safety guard', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('rehydrates missing worktree metadata and spawns the next phase job', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Verify worktree_path is null
    const before = queries.getWorkflowById(workflow.id);
    expect(before!.worktree_path).toBeNull();
    expect(before!.worktree_branch).toBeNull();

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('running');
    expect(updated!.blocked_reason).toBeNull();
    expect(updated!.worktree_path).toBeTruthy();
    expect(updated!.worktree_branch).toBeTruthy();
    expect(updated!.worktree_branch).toMatch(/^workflow\//);

    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j =>
      j.workflow_id === workflow.id && j.workflow_phase === 'review'
    );
    expect(reviewJob).toBeDefined();
    expect(reviewJob!.work_dir).toBe(updated!.worktree_path);

    const worktreeAddCalls = execSyncMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('git worktree add'),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
  });

  it('blocks workflow when use_worktree=1 but repair cannot run without work_dir', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);
    queries.updateWorkflow(workflow.id, { work_dir: null, worktree_path: null, worktree_branch: null });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('Worktree metadata repair failed before review');
    expect(updated!.blocked_reason).toContain('worktree_path and worktree_branch');
    expect(updated!.blocked_reason).toContain('work_dir is unavailable');

    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j =>
      j.workflow_id === workflow.id && j.workflow_phase === 'review'
    );
    expect(reviewJob).toBeUndefined();
  });

  it('reports error-level blocks to Sentry (worktree guard)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);
    queries.updateWorkflow(workflow.id, { work_dir: null, worktree_path: null, worktree_branch: null });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    // Worktree guard block is an error — Sentry should fire
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('does NOT report operational blocks to Sentry (max cycles)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');

    const project = await insertTestProject();
    // Workflow at max_cycles=1, cycle 0, implement phase completing
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      max_cycles: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });
    onJobCompleted(job);

    // Max-cycles block is operational — Sentry should NOT fire
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('max cycles');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── M3: Sentry-gating regression for operational blocked reasons ────────

  it('does NOT call Sentry for "was cancelled" blocks', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'cancelled',
    });
    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('was cancelled');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT call Sentry for "no fallback model available" blocks', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const { classifyJobFailure, isFallbackEligibleFailure } = await import('../server/orchestrator/FailureClassifier.js');

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    vi.mocked(isFallbackEligibleFailure).mockReturnValue(true);
    // getFallbackModel already returns the same model (no fallback)

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // Insert an agent linked to this job so the "failed before start" check doesn't trigger
    queries.insertAgent({ id: 'agent-nofallback', job_id: job.id, status: 'finished', started_at: Date.now() });
    queries.updateAgent('agent-nofallback', { num_turns: 5, cost_usd: 0.01 });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('no fallback model available');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT call Sentry for model-fallback recovery exhausted blocks (operational)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const { classifyJobFailure, isFallbackEligibleFailure } = await import('../server/orchestrator/FailureClassifier.js');

    vi.mocked(classifyJobFailure).mockReturnValue('rate_limit');
    vi.mocked(isFallbackEligibleFailure).mockReturnValue(true);

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Pre-insert the model-fallback recovery note so the code hits the exhausted-recovery path
    queries.upsertNote(
      `workflow/${workflow.id}/recovery/review/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6,failure=rate_limit',
      null,
    );

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'review',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // Agent with real work so we don't hit the "failed before start" path
    queries.insertAgent({ id: 'agent-dupecomp', job_id: job.id, status: 'finished', started_at: Date.now() });
    queries.updateAgent('agent-dupecomp', { num_turns: 3, cost_usd: 0.005 });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    // Blocked reason now includes failure kind in phase-failure format for operational classification
    expect(updated!.blocked_reason).toContain('model-fallback recovery exhausted');
    expect(updated!.blocked_reason).toContain('rate_limit');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT call Sentry for "failed (timeout)" blocks (operational)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const { classifyJobFailure, isFallbackEligibleFailure, isSameModelRetryEligible } = await import('../server/orchestrator/FailureClassifier.js');

    vi.mocked(classifyJobFailure).mockReturnValue('timeout');
    vi.mocked(isFallbackEligibleFailure).mockImplementation((kind: string) => kind === 'rate_limit' || kind === 'provider_overload');
    vi.mocked(isSameModelRetryEligible).mockReturnValue(true);

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Exhaust CLI retries so the timeout failure reaches the blocking path
    const attemptsKey = `workflow/${workflow.id}/cli-retry/implement/cycle-1`;
    queries.upsertNote(attemptsKey, '3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // Agent with real work
    queries.insertAgent({ id: 'agent-timeout', job_id: job.id, status: 'finished', started_at: Date.now() });
    queries.updateAgent('agent-timeout', { num_turns: 10, cost_usd: 0.05 });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toMatch(/failed \(timeout\)/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('DOES call Sentry for "failed (task_failure)" blocks (non-operational)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const { classifyJobFailure, isFallbackEligibleFailure } = await import('../server/orchestrator/FailureClassifier.js');

    vi.mocked(classifyJobFailure).mockReturnValue('task_failure');
    vi.mocked(isFallbackEligibleFailure).mockImplementation((kind: string) => kind === 'rate_limit' || kind === 'provider_overload');
    const { isSameModelRetryEligible } = await import('../server/orchestrator/FailureClassifier.js');
    vi.mocked(isSameModelRetryEligible).mockReturnValue(false);

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
      model: 'claude-sonnet-4-6',
    });

    // Agent with real work
    queries.insertAgent({ id: 'agent-taskfail', job_id: job.id, status: 'finished', started_at: Date.now() });
    queries.updateAgent('agent-taskfail', { num_turns: 8, cost_usd: 0.03 });

    onJobCompleted(job);

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toMatch(/failed \(task_failure\)/);
    // task_failure is NOT operational — Sentry MUST fire
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('does NOT block when use_worktree=0 and worktree_path is null', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    // Set up a workflow with use_worktree=0 (default) — no worktree needed
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    // Workflow should proceed normally — not blocked
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('running');
    expect(updated!.current_phase).toBe('review');

    // A review job should have been inserted
    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j =>
      j.workflow_id === workflow.id && j.workflow_phase === 'review'
    );
    expect(reviewJob).toBeDefined();
  });
});
