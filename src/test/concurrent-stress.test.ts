/**
 * Concurrent workflow stress test (M12).
 *
 * Creates 10 mock workflows simultaneously and drives their state machine
 * directly via onJobCompleted, processing phase-job completions in shuffled
 * (random) order.
 *
 * Asserts:
 * 1. No duplicate phase jobs spawned for any workflow
 * 2. No workflow stuck in an invalid (non-terminal) state
 * 3. All 10 workflows reach a terminal state (complete or blocked)
 *
 * The test uses an in-memory SQLite database and mocked spawning (no real
 * subprocesses). Runtime target: <5s.
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

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => true), statSync: vi.fn(() => ({ size: 100 })) };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('test-branch\n');
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess'),
  buildReviewPrompt: vi.fn(() => 'mock review'),
  buildImplementPrompt: vi.fn(() => 'mock implement'),
  buildVerifyPrompt: vi.fn(() => 'mock verify'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified repair'),
  preReadWorkflowContext: vi.fn(() => ({})),
  renderInlineContext: vi.fn(() => ''),
  hasInlineContent: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
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

vi.mock('../server/orchestrator/WorkflowPRCreator.js', () => ({
  pushAndCreatePr: vi.fn(() => null),
  finalizeWorkflow: vi.fn(async () => {}),
  reconcileBlockedPRs: vi.fn(async () => {}),
  countBranchCommits: vi.fn(() => 0),
  getPrCreationOutcome: vi.fn(() => 'no_publishable_commits'),
  _buildPrBody: vi.fn(() => ''),
}));

vi.mock('../server/orchestrator/WorkflowWorktreeManager.js', () => ({
  ensureWorktreeBranch: vi.fn(() => ({ ok: true })),
  verifyWorktreeHealth: vi.fn(() => ({ ok: true })),
  createWorkflowWorktree: vi.fn((wf: any) => wf),
  restoreWorkflowWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowBlockedDiagnostics.js', () => ({
  diagnoseWriteNoteInOutput: vi.fn(() => ({ status: 'not_called' })),
  formatWriteNoteDiagnostic: vi.fn(() => ''),
  writeBlockedDiagnostic: vi.fn(),
  BLOCKED_LOG_DIR: '/tmp',
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle — returns a new array, does not mutate the original. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const WORKFLOW_COUNT = 10;
const TERMINAL_STATUSES = new Set(['complete', 'blocked']);

// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowManager: concurrent workflow stress test', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('10 concurrent workflows all reach terminal state with no duplicate phase jobs', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();

    // ── 1. Create 10 workflows + seed fully-completed plan/contract notes ────
    //
    // Plan: all milestones already checked off.
    // After assess → spawns review.
    // After review → meetsCompletionThreshold(2/2, 1.0) is true → marks complete.
    // This gives a deterministic 2-job workflow per workflow instance.
    const workflows = await Promise.all(
      Array.from({ length: WORKFLOW_COUNT }, (_, i) =>
        insertTestWorkflow({
          project_id: project.id,
          title: `Stress Workflow ${i}`,
          status: 'running',
          current_phase: 'assess',
          current_cycle: 0,
          max_cycles: 5,
          use_worktree: 0,
        }),
      ),
    );

    for (const wf of workflows) {
      queries.upsertNote(`workflow/${wf.id}/plan`, '- [x] M1\n- [x] M2', null);
      queries.upsertNote(`workflow/${wf.id}/contract`, '# contract', null);
    }

    // ── 2. Create one assess job (status=done) per workflow ──────────────────
    const assessJobs = await Promise.all(
      workflows.map(wf =>
        insertTestJob({
          workflow_id: wf.id,
          workflow_cycle: 0,
          workflow_phase: 'assess',
          status: 'done',
        }),
      ),
    );

    // ── 3. Process assess completions in random order ────────────────────────
    for (const job of shuffle(assessJobs)) {
      onJobCompleted(job);
    }

    // ── 4. Assert: exactly 1 review job per workflow (no duplicates) ─────────
    for (const wf of workflows) {
      const wfJobs = queries.getJobsForWorkflow(wf.id);
      const reviewJobs = wfJobs.filter(j => j.workflow_phase === 'review');
      expect(reviewJobs, `workflow ${wf.id.slice(0, 8)}: expected 1 review job`).toHaveLength(1);
    }

    // ── 5. Double-process each assess job — should be a complete no-op ───────
    //
    // The _processedJobs dedup guard in onJobCompleted must prevent any
    // additional state mutations or job spawns.
    for (const job of assessJobs) {
      onJobCompleted(job);
    }

    // Still exactly 1 review job per workflow after double-processing
    for (const wf of workflows) {
      const wfJobs = queries.getJobsForWorkflow(wf.id);
      const reviewJobs = wfJobs.filter(j => j.workflow_phase === 'review');
      expect(reviewJobs, `workflow ${wf.id.slice(0, 8)}: dedup should prevent extra review jobs`).toHaveLength(1);
    }

    // ── 6. Collect the spawned review jobs and process in random order ────────
    //
    // spawnPhaseJob inserts jobs with status='queued'. We override to 'done'
    // to simulate successful phase completion (matching the pattern used in
    // all other WorkflowManager tests).
    const reviewJobs = workflows.map(wf => {
      const wfJobs = queries.getJobsForWorkflow(wf.id);
      const rj = wfJobs.find(j => j.workflow_phase === 'review');
      expect(rj, `workflow ${wf.id.slice(0, 8)}: no review job found`).toBeDefined();
      return { ...rj!, status: 'done' as const };
    });

    for (const job of shuffle(reviewJobs)) {
      onJobCompleted(job);
    }

    // ── 7. All workflows must reach a terminal state ──────────────────────────
    for (const wf of workflows) {
      const updated = queries.getWorkflowById(wf.id)!;
      expect(
        TERMINAL_STATUSES.has(updated.status),
        `workflow ${wf.id.slice(0, 8)}: expected terminal status, got '${updated.status}'`,
      ).toBe(true);
    }

    // ── 8. No workflow stuck in 'running' ────────────────────────────────────
    const stuckCount = workflows.filter(
      wf => queries.getWorkflowById(wf.id)!.status === 'running',
    ).length;
    expect(stuckCount, 'No workflows should be stuck in running').toBe(0);

    // ── 9. All 10 workflows should be 'complete' ──────────────────────────────
    //
    // Since the plan has 2/2 milestones done and threshold=1.0, the review
    // handler marks complete immediately without spawning an implement job.
    const completeCount = workflows.filter(
      wf => queries.getWorkflowById(wf.id)!.status === 'complete',
    ).length;
    expect(completeCount, 'All workflows should be complete').toBe(WORKFLOW_COUNT);

    // ── 10. Each workflow has exactly 2 jobs total (assess + review) ──────────
    for (const wf of workflows) {
      const wfJobs = queries.getJobsForWorkflow(wf.id);
      expect(wfJobs, `workflow ${wf.id.slice(0, 8)}: expected exactly 2 jobs`).toHaveLength(2);
    }
  });

  it('interleaved assess and review completions across different workflows reach terminal state', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();

    // 5 workflows starting at assess, 5 already at review (cycle 1, fully done)
    const assessWorkflows = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        insertTestWorkflow({
          project_id: project.id,
          title: `Assess-Wave ${i}`,
          status: 'running',
          current_phase: 'assess',
          current_cycle: 0,
          use_worktree: 0,
        }),
      ),
    );

    const reviewWorkflows = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        insertTestWorkflow({
          project_id: project.id,
          title: `Review-Wave ${i}`,
          status: 'running',
          current_phase: 'review',
          current_cycle: 1,
          milestones_total: 2,
          milestones_done: 2,
          use_worktree: 0,
        }),
      ),
    );

    const allWorkflows = [...assessWorkflows, ...reviewWorkflows];

    for (const wf of allWorkflows) {
      queries.upsertNote(`workflow/${wf.id}/plan`, '- [x] M1\n- [x] M2', null);
      queries.upsertNote(`workflow/${wf.id}/contract`, '# contract', null);
    }

    // Create assess jobs for the assess-phase group
    const assessJobs = await Promise.all(
      assessWorkflows.map(wf =>
        insertTestJob({
          workflow_id: wf.id,
          workflow_cycle: 0,
          workflow_phase: 'assess',
          status: 'done',
        }),
      ),
    );

    // Create review jobs for the review-phase group
    const reviewJobs = await Promise.all(
      reviewWorkflows.map(wf =>
        insertTestJob({
          workflow_id: wf.id,
          workflow_cycle: 1,
          workflow_phase: 'review',
          status: 'done',
        }),
      ),
    );

    // Mix and shuffle both job types, then process in one pass
    const allFirstWaveJobs = shuffle([...assessJobs, ...reviewJobs]);
    for (const job of allFirstWaveJobs) {
      onJobCompleted(job);
    }

    // The 5 review-wave workflows should already be complete
    for (const wf of reviewWorkflows) {
      expect(
        queries.getWorkflowById(wf.id)!.status,
        `review-wave workflow ${wf.id.slice(0, 8)}`,
      ).toBe('complete');
    }

    // The 5 assess-wave workflows spawned review jobs — collect and process them
    const secondWaveReviewJobs = assessWorkflows.map(wf => {
      const wfJobs = queries.getJobsForWorkflow(wf.id);
      const rj = wfJobs.find(j => j.workflow_phase === 'review');
      expect(rj, `assess-wave workflow ${wf.id.slice(0, 8)}: review job missing`).toBeDefined();
      return { ...rj!, status: 'done' as const };
    });

    for (const job of shuffle(secondWaveReviewJobs)) {
      onJobCompleted(job);
    }

    // All 10 workflows must be terminal and not stuck in running
    for (const wf of allWorkflows) {
      const updated = queries.getWorkflowById(wf.id)!;
      expect(
        TERMINAL_STATUSES.has(updated.status),
        `workflow ${wf.id.slice(0, 8)}: expected terminal, got '${updated.status}'`,
      ).toBe(true);
      expect(updated.status).not.toBe('running');
    }

    expect(
      allWorkflows.filter(wf => queries.getWorkflowById(wf.id)!.status === 'complete').length,
    ).toBe(10);
  });
});
