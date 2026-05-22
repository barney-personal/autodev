/**
 * ResumeOrchestrator — handle the moment after the Resolver proposes a
 * resume. Calls resumeWorkflow(), watches the workflow for re-block on the
 * same fingerprint, and trips the circuit breaker when the Resolver isn't
 * making things better.
 *
 * Decoupled from ResolverDispatcher to keep that file focused on
 * "should we run?" and this one on "did it actually help?".
 *
 * Re-block detection is event-driven, not polled: when WorkflowManager's
 * updateAndEmit sets status='blocked', it calls back via
 * recordPostResumeBlock(workflow_id, fingerprint). The window-since-resume is
 * tracked in resolver_runs.resume_outcome.
 */
import { resolverLogger } from '../lib/logger.js';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { resumeWorkflow } from './WorkflowManager.js';
import { fingerprint as fingerprintReason } from './ResolverFingerprint.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import type {
  Workflow,
  ResolverRun,
  ResolverResumeOutcome,
  WorkflowPhase,
} from '../../shared/types.js';

const log = resolverLogger();

// Track the (workflow_id, fingerprint) pairs we've recently resumed so we can
// trip the circuit breaker if the same fingerprint comes back.
// Map<workflowId, { fingerprint, resolver_id, resumed_at }>
const _recentResumes = new Map<string, { fingerprint: string; resolver_id: string; resumed_at: number }>();
const RECENT_RESUME_TTL_MS = 30 * 60 * 1000;          // 30 min — caller can fire re-block within this window

// ─── Resume entry point ─────────────────────────────────────────────────────

export interface ProposedResume {
  phase: WorkflowPhase;
  cycle: number;
  confidence: number;
  summary: string;
}

export interface HandleResolverOutcomeInput {
  workflow: Workflow;
  run: ResolverRun;
  proposed: ProposedResume;
}

export async function handleResolverOutcome(input: HandleResolverOutcomeInput): Promise<ResolverResumeOutcome> {
  const { run, proposed } = input;
  // Refresh: the Resolver may have updated work_dir/branch.
  const wf = queries.getWorkflowById(input.workflow.id);
  if (!wf) {
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    return 'not_resumed';
  }

  // Sanity check: the Resolver shouldn't have moved the workflow to a non-blocked
  // state. If it did (via update_workflow_field on status — which isn't allowed
  // but defence-in-depth), we don't resume.
  if (wf.status !== 'blocked') {
    log.warn({ workflow_id: wf.id, status: wf.status, resolver_id: run.id }, 'workflow no longer blocked at resume time — skipping resume');
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_resume_skipped', 'workflow', wf.id, {
      resolver_id: run.id, reason: 'status_not_blocked', current_status: wf.status,
    });
    return 'not_resumed';
  }

  // Bounds-check the LLM-proposed cycle. The tool input schema enforces
  // type:number, but a Resolver under adversarial influence could propose
  // cycle: 9999 to confuse downstream logic. Clamp explicit out-of-range
  // values to the workflow's known bounds and surface as a not_resumed.
  if (proposed.cycle < 0 || proposed.cycle > wf.max_cycles) {
    log.warn({ workflow_id: wf.id, resolver_id: run.id, proposed_cycle: proposed.cycle, max_cycles: wf.max_cycles }, 'resolver proposed out-of-range cycle — skipping resume');
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_resume_skipped', 'workflow', wf.id, {
      resolver_id: run.id, reason: 'cycle_out_of_range',
      proposed_cycle: proposed.cycle, max_cycles: wf.max_cycles,
    });
    return 'not_resumed';
  }

  try {
    const job = resumeWorkflow(wf, { phase: proposed.phase, cycle: proposed.cycle });
    log.info({ workflow_id: wf.id, resolver_id: run.id, job_id: job.id }, 'resolver-driven resume succeeded');

    _recentResumes.set(wf.id, {
      fingerprint: run.reason_fingerprint,
      resolver_id: run.id,
      resumed_at: Date.now(),
    });

    queries.updateResolverRun(run.id, { resume_outcome: 'resumed_running' });
    const fresh = queries.getResolverRunById(run.id);
    if (fresh) socket.emitResolverRunUpdate(fresh);

    logResilienceEvent('resolver_resumed', 'workflow', wf.id, {
      resolver_id: run.id,
      phase: proposed.phase,
      cycle: proposed.cycle,
      confidence: proposed.confidence,
      job_id: job.id,
    });

    return 'resumed_running';
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    log.error({ err, workflow_id: wf.id, resolver_id: run.id }, 'resolver-driven resume failed');
    captureWithContext(err, { workflow_id: wf.id, resolver_id: run.id, component: 'ResumeOrchestrator' });

    queries.updateResolverRun(run.id, {
      resume_outcome: 'not_resumed',
      error_message: msg.slice(0, 500),
    });
    const fresh = queries.getResolverRunById(run.id);
    if (fresh) socket.emitResolverRunUpdate(fresh);

    // The resume itself errored (worktree health check, missing fields, etc.)
    // We do NOT trip the circuit just for a resume failure — the resolver
    // didn't get a chance to be wrong yet. Surface for the dashboard.
    logResilienceEvent('resolver_resume_failed', 'workflow', wf.id, {
      resolver_id: run.id, error: msg.slice(0, 240),
    });

    // Mark workflow blocked again with an updated reason so the next
    // resolver attempt sees what went wrong.
    //
    // We deliberately use queries.updateWorkflow + manual emitWorkflowUpdate
    // here instead of WorkflowManager.updateAndEmit. updateAndEmit's
    // status='blocked' branch calls dispatchResolverForWorkflowAsync, which
    // would re-fire the Resolver in a tight loop on every resume failure.
    // Bypassing that path keeps the resume-failure recovery owned by the
    // dispatcher's normal flow (next blocked transition from somewhere
    // outside this code path).
    try {
      queries.updateWorkflow(wf.id, {
        status: 'blocked',
        blocked_reason: `Resolver-driven resume failed: ${msg.slice(0, 400)}`,
      });
      const updated = queries.getWorkflowById(wf.id);
      if (updated) socket.emitWorkflowUpdate(updated);
    } catch { /* defensive */ }

    return 'not_resumed';
  }
}

// ─── Re-block detection ─────────────────────────────────────────────────────

/**
 * Called by WorkflowManager.updateAndEmit when a workflow transitions to
 * 'blocked'. If we recently resumed this workflow off the same fingerprint,
 * the Resolver's fix didn't stick — trip the circuit breaker.
 *
 * Pure: same-fingerprint re-block trips immediately. Different-fingerprint
 * blocks are normal forward progress; allow them through.
 *
 * Returns true if the circuit was tripped (so the caller can suppress its
 * usual blocked diagnostic noise if it wants to).
 */
export function recordPostResumeBlock(workflowId: string, newBlockedReason: string | null): boolean {
  const recent = _recentResumes.get(workflowId);
  if (!recent) return false;

  if (Date.now() - recent.resumed_at > RECENT_RESUME_TTL_MS) {
    _recentResumes.delete(workflowId);
    return false;
  }

  const fp = fingerprintReason(newBlockedReason);
  if (fp !== recent.fingerprint) {
    // Different problem — allow it. The new block is its own thing.
    return false;
  }

  // SAME fingerprint — Resolver's fix didn't hold. Trip the breaker.
  _recentResumes.delete(workflowId);

  try {
    queries.updateResolverRun(recent.resolver_id, { resume_outcome: 'resumed_re_blocked' });
    const fresh = queries.getResolverRunById(recent.resolver_id);
    if (fresh) socket.emitResolverRunUpdate(fresh);

    queries.updateWorkflow(workflowId, { resolver_circuit_state: 'tripped' });
    const wf = queries.getWorkflowById(workflowId);
    if (wf) socket.emitWorkflowUpdate(wf);

    logResilienceEvent('resolver_circuit_tripped', 'workflow', workflowId, {
      resolver_id: recent.resolver_id,
      fingerprint: fp,
      reason: 'same_fingerprint_re_block',
    });
    log.warn({ workflow_id: workflowId, resolver_id: recent.resolver_id, fingerprint: fp }, 'resolver circuit tripped: same-fingerprint re-block');
    return true;
  } catch (err) {
    log.error({ err, workflow_id: workflowId }, 'failed to trip resolver circuit');
    return false;
  }
}

// ─── Circuit reset (operator action via API) ───────────────────────────────

export function resetResolverCircuit(workflowId: string): boolean {
  const wf = queries.getWorkflowById(workflowId);
  if (!wf) return false;
  queries.updateWorkflow(workflowId, {
    resolver_circuit_state: 'armed',
    resolver_attempt_count: 0,
  });
  const updated = queries.getWorkflowById(workflowId);
  if (updated) socket.emitWorkflowUpdate(updated);
  _recentResumes.delete(workflowId);
  logResilienceEvent('resolver_circuit_reset', 'workflow', workflowId, { previous_state: wf.resolver_circuit_state });
  return true;
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function _resetRecentResumesForTest(): void { _recentResumes.clear(); }
export function _peekRecentResumesForTest() { return new Map(_recentResumes); }
export function _seedRecentResumeForTest(workflowId: string, fingerprint: string, resolverId: string): void {
  _recentResumes.set(workflowId, { fingerprint, resolver_id: resolverId, resumed_at: Date.now() });
}
