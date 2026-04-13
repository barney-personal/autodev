/**
 * Tests for WorkflowRecovery helper — tryAcquireRecoverySlot and RecoveryKeys.
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: tryAcquireRecoverySlot
// ─────────────────────────────────────────────────────────────────────────────

describe('tryAcquireRecoverySlot', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('returns "acquired" when insertNoteIfNotExists returns true (note is new)', async () => {
    const { tryAcquireRecoverySlot } = await import('../server/orchestrator/WorkflowRecovery.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id, status: 'running' });

    const outcome = tryAcquireRecoverySlot(
      workflow.id,
      `workflow/${workflow.id}/recovery/implement/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6',
    );
    expect(outcome).toBe('acquired');
  });

  it('returns "active_duplicate" when note already exists AND an active job exists', async () => {
    const { tryAcquireRecoverySlot } = await import('../server/orchestrator/WorkflowRecovery.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id, status: 'running' });

    // Pre-plant the note
    queries.upsertNote(
      `workflow/${workflow.id}/recovery/implement/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6',
      null,
    );

    // Insert an active (running) job for this workflow
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'running',
    });

    const outcome = tryAcquireRecoverySlot(
      workflow.id,
      `workflow/${workflow.id}/recovery/implement/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6',
    );
    expect(outcome).toBe('active_duplicate');
  });

  it('returns "stale_exhausted" when note already exists but no active jobs remain', async () => {
    const { tryAcquireRecoverySlot } = await import('../server/orchestrator/WorkflowRecovery.js');
    const queries = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id, status: 'running' });

    // Pre-plant the note
    queries.upsertNote(
      `workflow/${workflow.id}/recovery/implement/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6',
      null,
    );

    // Insert a failed (non-active) job — no active jobs left
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'failed',
    });

    const outcome = tryAcquireRecoverySlot(
      workflow.id,
      `workflow/${workflow.id}/recovery/implement/cycle-1/model-fallback`,
      'fallback=codex,from=claude-sonnet-4-6',
    );
    expect(outcome).toBe('stale_exhausted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: RecoveryKeys builders
// ─────────────────────────────────────────────────────────────────────────────

describe('RecoveryKeys', () => {
  it('modelFallback builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.modelFallback('wf-123', 'implement', 2)).toBe(
      'workflow/wf-123/recovery/implement/cycle-2/model-fallback',
    );
  });

  it('cliRetry builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.cliRetry('wf-123', 'review', 1, 3)).toBe(
      'workflow/wf-123/recovery/review/cycle-1/cli-retry-3',
    );
  });

  it('cliAttempts builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.cliAttempts('wf-123', 'implement', 5)).toBe(
      'workflow/wf-123/cli-retry/implement/cycle-5',
    );
  });

  it('altProvider builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.altProvider('wf-123', 'assess', 0)).toBe(
      'workflow/wf-123/recovery/assess/cycle-0/alt-provider',
    );
  });

  it('plan builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.plan('wf-123')).toBe('workflow/wf-123/plan');
  });

  it('contract builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.contract('wf-123')).toBe('workflow/wf-123/contract');
  });

  it('zeroProgressCount builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.zeroProgressCount('wf-123')).toBe('workflow/wf-123/zero-progress-count');
  });

  it('replanAttempted builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.replanAttempted('wf-123', 3)).toBe('workflow/wf-123/replan-attempted/3');
  });

  it('cycleProgress builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.cycleProgress('wf-123', 2)).toBe('workflow/wf-123/cycle-progress/2');
  });

  it('preImplementMilestones builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.preImplementMilestones('wf-123', 4)).toBe('workflow/wf-123/pre-implement-milestones/4');
  });

  it('verifyResult builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.verifyResult('wf-123', 1)).toBe('workflow/wf-123/verify-result/1');
  });

  it('verifyFailure builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.verifyFailure('wf-123', 2)).toBe('workflow/wf-123/verify-failure/2');
  });

  it('worklog builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.worklog('wf-123', 5)).toBe('workflow/wf-123/worklog/cycle-5');
  });

  it('worklogPrefix builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.worklogPrefix('wf-123')).toBe('workflow/wf-123/worklog/');
  });

  it('reviewFeedback builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.reviewFeedback('wf-123', 3)).toBe('workflow/wf-123/review-feedback/cycle-3');
  });

  it('reviewFeedbackPrefix builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.reviewFeedbackPrefix('wf-123')).toBe('workflow/wf-123/review-feedback/');
  });

  it('repairAttempts builds correct key format', async () => {
    const { RecoveryKeys } = await import('../server/orchestrator/WorkflowRecovery.js');
    expect(RecoveryKeys.repairAttempts('wf-123', 'assess', 0)).toBe('workflow/wf-123/repair/assess/cycle-0');
  });
});
