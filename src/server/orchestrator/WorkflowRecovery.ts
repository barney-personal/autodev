/**
 * Idempotent recovery slot acquisition for workflow failure handling.
 *
 * Extracts the repeated idempotency pattern from handleFailedJob into a single
 * reusable helper, eliminating 3x duplication.
 */
import * as queries from '../db/queries.js';

export const RecoveryKeys = {
  // ── Recovery (failure handling) ────────────────────────────────────────────
  modelFallback: (wfId: string, phase: string, cycle: number) =>
    `workflow/${wfId}/recovery/${phase}/cycle-${cycle}/model-fallback`,
  cliRetry: (wfId: string, phase: string, cycle: number, attempt: number) =>
    `workflow/${wfId}/recovery/${phase}/cycle-${cycle}/cli-retry-${attempt}`,
  cliAttempts: (wfId: string, phase: string, cycle: number) =>
    `workflow/${wfId}/cli-retry/${phase}/cycle-${cycle}`,
  altProvider: (wfId: string, phase: string, cycle: number) =>
    `workflow/${wfId}/recovery/${phase}/cycle-${cycle}/alt-provider`,

  // ── Workflow artifacts ─────────────────────────────────────────────────────
  plan: (wfId: string) => `workflow/${wfId}/plan`,
  contract: (wfId: string) => `workflow/${wfId}/contract`,

  // ── Lifecycle tracking ─────────────────────────────────────────────────────
  zeroProgressCount: (wfId: string) => `workflow/${wfId}/zero-progress-count`,
  replanAttempted: (wfId: string, cycle: number) => `workflow/${wfId}/replan-attempted/${cycle}`,
  cycleProgress: (wfId: string, cycle: number) => `workflow/${wfId}/cycle-progress/${cycle}`,
  preImplementMilestones: (wfId: string, cycle: number) => `workflow/${wfId}/pre-implement-milestones/${cycle}`,

  // ── Verify ─────────────────────────────────────────────────────────────────
  verifyResult: (wfId: string, cycle: number) => `workflow/${wfId}/verify-result/${cycle}`,
  verifyFailure: (wfId: string, cycle: number) => `workflow/${wfId}/verify-failure/${cycle}`,

  // ── Worklogs & review feedback ─────────────────────────────────────────────
  worklog: (wfId: string, cycle: number) => `workflow/${wfId}/worklog/cycle-${cycle}`,
  worklogPrefix: (wfId: string) => `workflow/${wfId}/worklog/`,
  reviewFeedback: (wfId: string, cycle: number) => `workflow/${wfId}/review-feedback/cycle-${cycle}`,
  reviewFeedbackPrefix: (wfId: string) => `workflow/${wfId}/review-feedback/`,

  // ── Repair tracking ────────────────────────────────────────────────────────
  repairAttempts: (wfId: string, phase: string, cycle: number) => `workflow/${wfId}/repair/${phase}/cycle-${cycle}`,
} as const;

export type RecoveryOutcome = 'acquired' | 'active_duplicate' | 'stale_exhausted';

/**
 * Try to acquire an idempotent recovery slot for a workflow.
 *
 * - 'acquired': Note inserted successfully — caller should proceed with recovery.
 * - 'active_duplicate': Note already exists AND another job is still active — skip.
 * - 'stale_exhausted': Note already exists but no active job remains — recovery failed.
 */
export function tryAcquireRecoverySlot(
  workflowId: string,
  noteKey: string,
  noteValue: string,
): RecoveryOutcome {
  if (queries.insertNoteIfNotExists(noteKey, noteValue, null)) {
    return 'acquired';
  }
  const hasActive = queries.getJobsForWorkflow(workflowId).some(j =>
    j.status === 'queued' || j.status === 'assigned' || j.status === 'running');
  return hasActive ? 'active_duplicate' : 'stale_exhausted';
}
