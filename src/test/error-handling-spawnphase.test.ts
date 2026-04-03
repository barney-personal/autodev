/**
 * WorkflowManager spawnPhaseJob error isolation test (M7a, part 2).
 *
 * Proves that when socket.emitJobNew throws inside spawnPhaseJob, the workflow
 * state is still updated (phase advances, status stays 'running'), and the
 * review job is inserted into the DB.
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

describe('WorkflowManager: spawnPhaseJob error isolation', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('updates workflow state even when socket.emitJobNew throws', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    // Set up a workflow in assess phase with a plan
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Make emitJobNew throw to simulate a socket failure during spawnPhaseJob
    vi.mocked(socket.emitJobNew).mockImplementationOnce(() => {
      throw new Error('Socket connection lost');
    });

    const job = await insertTestJob({
      id: 'spawn-error-job',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    // Trigger assess→review transition — spawnPhaseJob will try to emit
    onJobCompleted(job);

    // Despite the socket error, workflow state should be updated
    const updatedWorkflow = queries.getWorkflowById(workflow.id);
    expect(updatedWorkflow).not.toBeNull();
    // Phase should have advanced to 'review' (the socket error was caught inside spawnPhaseJob)
    expect(updatedWorkflow!.current_phase).toBe('review');
    expect(updatedWorkflow!.current_cycle).toBe(1);

    // emitWorkflowUpdate should have been called by updateAndEmit
    expect(socket.emitWorkflowUpdate).toHaveBeenCalled();

    // A review job should have been inserted in the DB even though socket emit failed
    const allJobs = queries.listJobs();
    const reviewJob = allJobs.find(j =>
      j.workflow_id === workflow.id && j.workflow_phase === 'review'
    );
    expect(reviewJob).toBeDefined();
  });

  it('workflow is not blocked by socket failure in spawnPhaseJob', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);

    // Socket failure on emitJobNew
    vi.mocked(socket.emitJobNew).mockImplementationOnce(() => {
      throw new Error('ECONNRESET');
    });

    const job = await insertTestJob({
      id: 'spawn-error-job-2',
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });

    onJobCompleted(job);

    // Workflow should NOT be blocked — should be running with review phase
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('running');
    expect(updated!.current_phase).toBe('review');
  });
});
