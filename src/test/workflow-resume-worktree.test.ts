/**
 * WorkflowManager resumeWorkflow worktree restoration test.
 *
 * Proves that when use_worktree=1 but worktree_path is null (DB recovery scenario),
 * resumeWorkflow recreates the worktree and persists metadata BEFORE changing
 * the workflow status to 'running' or inserting a phase job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
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
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

const _logResilienceEvent = vi.fn();
vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: (...args: any[]) => _logResilienceEvent(...args),
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

describe('WorkflowManager: resumeWorkflow worktree restoration', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('restores worktree metadata when use_worktree=1 and worktree_path is null on resume', async () => {
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Confirm worktree_path is null before resume
    const before = queries.getWorkflowById(workflow.id);
    expect(before!.worktree_path).toBeNull();
    expect(before!.worktree_branch).toBeNull();

    // Resume — should recreate worktree and persist metadata
    const job = resumeWorkflow(workflow);

    // Worktree metadata should now be populated
    const after = queries.getWorkflowById(workflow.id);
    expect(after!.worktree_path).toBeTruthy();
    expect(after!.worktree_branch).toBeTruthy();
    expect(after!.worktree_branch).toMatch(/^workflow\//);
    expect(after!.status).toBe('running');

    // The spawned job should use the restored worktree_path, not work_dir
    expect(job.work_dir).toBe(after!.worktree_path);

    // git worktree add should have been called
    const worktreeAddCalls = execSyncMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('git worktree add'),
    );
    expect(worktreeAddCalls.length).toBe(1);
    const addCmd = worktreeAddCalls[0][0] as string;
    expect(addCmd).toContain(' -b ');

    // Resilience event should be logged for successful worktree restoration (Fix-C12c)
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'worktree_restore', 'workflow', workflow.id,
      expect.objectContaining({ action: 'restore', outcome: 'success', branch: after!.worktree_branch, worktree_path: after!.worktree_path }),
    );
  });

  it('throws and keeps workflow blocked when worktree restoration fails', async () => {
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 1,
    });

    // Make git worktree add fail
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git worktree add')) {
        throw new Error('fatal: branch already exists');
      }
      return Buffer.from('');
    });

    expect(() => resumeWorkflow(workflow)).toThrow('Worktree restoration failed during resume');

    // Workflow should still be blocked — status was never changed to running
    const after = queries.getWorkflowById(workflow.id);
    expect(after!.status).toBe('blocked');
    expect(after!.worktree_path).toBeNull();

    // No phase job should have been inserted
    const allJobs = queries.listJobs();
    expect(allJobs.filter(j => j.workflow_id === workflow.id)).toHaveLength(0);

    // Resilience event should be logged for failed worktree restoration (Fix-C12c)
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'worktree_restore', 'workflow', workflow.id,
      expect.objectContaining({ action: 'restore', outcome: 'failed', error: 'fatal: branch already exists' }),
    );
  });

  it('re-attaches existing branch without -b when branch survived DB recovery', async () => {
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // rev-parse --verify succeeds → branch exists; worktree add without -b should succeed
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --verify') && cmd.includes('refs/heads/')) {
        return Buffer.from('abc1234\n'); // branch exists
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('expected-branch\n');
      }
      return Buffer.from('');
    });

    const job = resumeWorkflow(workflow);

    const after = queries.getWorkflowById(workflow.id);
    expect(after!.worktree_path).toBeTruthy();
    expect(after!.worktree_branch).toBeTruthy();
    expect(after!.status).toBe('running');

    // Verify git worktree add was called WITHOUT -b
    const worktreeAddCalls = execSyncMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('git worktree add'),
    );
    expect(worktreeAddCalls.length).toBe(1);
    const addCmd = worktreeAddCalls[0][0] as string;
    expect(addCmd).not.toContain(' -b ');

    // Resilience event should be logged for successful worktree restoration (Fix-C13a)
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'worktree_restore', 'workflow', workflow.id,
      expect.objectContaining({ action: 'restore', outcome: 'success' }),
    );
  });

  it('does not attempt worktree restoration when use_worktree=0', async () => {
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 1,
      use_worktree: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    const job = resumeWorkflow(workflow);

    // No worktree restoration should have been attempted
    const worktreeAddCalls = execSyncMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('git worktree add'),
    );
    expect(worktreeAddCalls.length).toBe(0);

    // Job should use work_dir
    const after = queries.getWorkflowById(workflow.id);
    expect(after!.worktree_path).toBeNull();
    expect(job.work_dir).toBe(after!.work_dir);
    expect(after!.status).toBe('running');
  });
});
