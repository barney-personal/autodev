/**
 * WorkflowManager spawnPhaseJob worktree safety guard test.
 *
 * Proves that when use_worktree=1 but worktree_path is null, spawnPhaseJob
 * blocks the workflow instead of silently falling back to work_dir.
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

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
  }),
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

  it('blocks workflow when use_worktree=1 but worktree_path is null', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    // Set up a workflow with use_worktree=1 but no worktree_path (simulates DB recovery)
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

    // Complete the assess job — this triggers spawnPhaseJob for review
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    // Workflow should be blocked, not running
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('Worktree required (use_worktree=1) but worktree_path is null');
    expect(updated!.blocked_reason).toContain('review');

    // No review job should have been inserted
    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j =>
      j.workflow_id === workflow.id && j.workflow_phase === 'review'
    );
    expect(reviewJob).toBeUndefined();
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
