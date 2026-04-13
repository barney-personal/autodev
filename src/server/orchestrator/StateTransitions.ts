import type { JobStatus, WorkflowStatus, DebateStatus } from '../../shared/types.js';

// ─── State Machine Transition Maps ──────────────────────────────────────────
//
// Each map defines the legal transitions for an entity's status field.
// The key is the current status; the value is the set of statuses it may move to.
// 'cancelled' is reachable from every non-terminal state (force-cancel).
//
// These are used for warn-only validation — illegal transitions log a warning
// but are NOT blocked, because edge cases (force-cancel, resume, recovery) may
// legitimately skip states.

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued:    ['assigned', 'failed', 'cancelled'],   // failed: cascade-fail (deps failed/cancelled)
  assigned:  ['running', 'failed', 'cancelled'],
  running:   ['done', 'failed', 'cancelled'],
  done:      [],
  failed:    ['queued'],          // retry re-queues the job
  cancelled: [],
};

const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  running:   ['complete', 'blocked', 'failed', 'cancelled'],
  complete:  ['blocked'],            // PR creation failure after completion
  blocked:   ['running', 'cancelled'],  // resume unblocks
  failed:    ['running'],               // manual restart
  cancelled: [],
};

const DEBATE_TRANSITIONS: Record<DebateStatus, readonly DebateStatus[]> = {
  running:      ['consensus', 'disagreement', 'failed', 'cancelled'],
  consensus:    [],
  disagreement: [],
  failed:       [],
  cancelled:    [],
};

/**
 * Validate a status transition for a given entity type.
 * Returns whether the transition is legal according to the transition map.
 * Throws an Error for illegal transitions — callers should catch and log.
 * Same-status no-ops return { valid: true } without throwing.
 */
export function validateTransition(
  entity: 'job' | 'workflow' | 'debate',
  from: string | undefined,
  to: string,
  entityId?: string,
): { valid: boolean; from: string | undefined; to: string } {
  // If we don't know the current status (e.g. entity not found), skip validation
  if (from === undefined) {
    return { valid: true, from, to };
  }

  // Same-status "transitions" are no-ops — always valid
  if (from === to) {
    return { valid: true, from, to };
  }

  const map =
    entity === 'job' ? JOB_TRANSITIONS :
    entity === 'workflow' ? WORKFLOW_TRANSITIONS :
    DEBATE_TRANSITIONS;

  const allowed = map[from as keyof typeof map];
  if (!allowed) {
    throw new Error(`[state-transition] unknown ${entity} status '${from}' → '${to}'${entityId ? ` (${entityId.slice(0, 8)})` : ''}`);
  }

  const valid = (allowed as readonly string[]).includes(to);
  if (!valid) {
    throw new Error(`[state-transition] illegal ${entity} transition '${from}' → '${to}'${entityId ? ` (${entityId.slice(0, 8)})` : ''}`);
  }

  return { valid, from, to };
}
