/**
 * ResolverDispatcher — the entry point fired when a workflow transitions to
 * 'blocked'. Decides whether to spawn a Resolver session, runs it, and routes
 * the terminal result back into the orchestrator (resume, escalate, or leave
 * blocked).
 *
 * Safety budget (every guard is independent of the others):
 *   - RESOLVER_MODE = off | diagnose | assisted | auto (default 'assisted')
 *   - RESOLVER_LIFETIME_ATTEMPTS per workflow (default 3)
 *   - RESOLVER_MAX_COST_USD per run (enforced by ResolverSession)
 *   - RESOLVER_DAILY_COST_CAP_USD global circuit (default $50)
 *   - RESOLVER_GLOBAL_CONCURRENCY (default 2)
 *   - Idempotency: in-flight (workflow_id, fingerprint) is a no-op
 *   - Circuit breaker: resolver_circuit_state='tripped' blocks all attempts
 *
 * All decisions emit resilience events so the dashboard explains every skip.
 */
import { randomUUID } from 'crypto';
import { dispatcherLogger } from '../lib/logger.js';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { fingerprint as fingerprintReason, classifyHeuristic, autoResumeConfidenceThreshold, normalizeReason } from './ResolverFingerprint.js';
import { buildResolverContext } from './ResolverContext.js';
import { runResolverSession, defaultResolverModel } from './ResolverSession.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { handleResolverOutcome } from './ResumeOrchestrator.js';
import { stripControlChars } from './watcherTools.js';
import type {
  Workflow,
  ResolverRun,
  ResolverClassification,
  ResolverResumeOutcome,
} from '../../shared/types.js';

// ─── Env helpers (read on every call so tests can patch process.env) ───────

export type ResolverMode = 'off' | 'diagnose' | 'assisted' | 'auto';

export function envResolverMode(): ResolverMode {
  const raw = (process.env.RESOLVER_MODE ?? 'assisted').toLowerCase();
  if (raw === 'off' || raw === 'diagnose' || raw === 'assisted' || raw === 'auto') return raw;
  return 'assisted';
}

export function envLifetimeAttempts(): number {
  const raw = process.env.RESOLVER_LIFETIME_ATTEMPTS;
  if (raw === undefined || raw === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export function envDailyCostCap(): number {
  const raw = process.env.RESOLVER_DAILY_COST_CAP_USD;
  if (raw === undefined || raw === '') return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export function envGlobalConcurrency(): number {
  const raw = process.env.RESOLVER_GLOBAL_CONCURRENCY;
  if (raw === undefined || raw === '') return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/** Classifications that auto-execute in 'assisted' mode. Code bugs and unknown
 *  always require human approval until trust is built up. */
const ASSISTED_CLASSIFICATIONS: ReadonlySet<ResolverClassification> = new Set([
  'transient_infra',
  'config_drift',
]);

// ─── Dispatch decision ─────────────────────────────────────────────────────

export type DispatchSkipReason =
  | 'mode_off'
  | 'circuit_tripped'
  | 'lifetime_attempts_exhausted'
  | 'daily_cost_cap'
  | 'in_flight'
  | 'concurrency_cap'
  | 'no_blocked_reason'
  | 'not_blocked';

export interface DispatchDecision {
  shouldRun: boolean;
  reason?: DispatchSkipReason;
  fingerprint: string;
  classification: ResolverClassification;
  attempt: number;
  mode: ResolverMode;
}

/** Pure decision function — no side effects, easy to test. */
export function decideDispatch(workflow: Workflow): DispatchDecision {
  const mode = envResolverMode();
  const reason = workflow.blocked_reason ?? null;
  const fp = fingerprintReason(reason);
  const cls = classifyHeuristic(reason);
  const attempt = (workflow.resolver_attempt_count ?? 0) + 1;
  const base = { fingerprint: fp, classification: cls, attempt, mode };

  if (mode === 'off') {
    return { shouldRun: false, reason: 'mode_off', ...base };
  }
  if (workflow.status !== 'blocked') {
    return { shouldRun: false, reason: 'not_blocked', ...base };
  }
  if (!reason) {
    return { shouldRun: false, reason: 'no_blocked_reason', ...base };
  }
  if (workflow.resolver_circuit_state === 'tripped') {
    return { shouldRun: false, reason: 'circuit_tripped', ...base };
  }
  if ((workflow.resolver_attempt_count ?? 0) >= envLifetimeAttempts()) {
    return { shouldRun: false, reason: 'lifetime_attempts_exhausted', ...base };
  }
  return { shouldRun: true, ...base };
}

// ─── Dispatch entry point ──────────────────────────────────────────────────

const _inFlight = new Set<string>();   // composite key: `${workflow_id}/${fingerprint}`
const log = dispatcherLogger();

/**
 * Try to start a Resolver run for this workflow's current blocked state.
 *
 * Returns a promise that resolves once the Resolver session ends and the
 * outcome has been routed (resume, escalate, leave blocked). The caller can
 * either await it (tests) or fire-and-forget (production wiring from
 * updateAndEmit, which can't be async).
 *
 * Never throws — always logs and returns a structured outcome.
 */
export async function dispatchResolverForWorkflow(workflowId: string): Promise<DispatchResult> {
  let wf = queries.getWorkflowById(workflowId);
  if (!wf) return { dispatched: false, skip_reason: 'not_blocked' };

  const decision = decideDispatch(wf);
  if (!decision.shouldRun) {
    logResilienceEvent('resolver_dispatch_skipped', 'workflow', workflowId, {
      reason: decision.reason, fingerprint: decision.fingerprint, classification: decision.classification,
    });
    return { dispatched: false, skip_reason: decision.reason };
  }

  // In-flight guard for this fingerprint
  const key = `${workflowId}/${decision.fingerprint}`;
  if (_inFlight.has(key)) {
    logResilienceEvent('resolver_dispatch_skipped', 'workflow', workflowId, {
      reason: 'in_flight', fingerprint: decision.fingerprint,
    });
    return { dispatched: false, skip_reason: 'in_flight' };
  }

  // Existing active run on the same fingerprint
  const existing = queries.findActiveResolverRun(workflowId, decision.fingerprint);
  if (existing) {
    logResilienceEvent('resolver_dispatch_skipped', 'workflow', workflowId, {
      reason: 'in_flight', resolver_id: existing.id, fingerprint: decision.fingerprint,
    });
    return { dispatched: false, skip_reason: 'in_flight' };
  }

  // Daily cost cap (global)
  const dayMs = 24 * 60 * 60 * 1000;
  const dailySpend = queries.resolverCostUsdSince(Date.now() - dayMs);
  if (dailySpend >= envDailyCostCap()) {
    logResilienceEvent('resolver_dispatch_skipped', 'workflow', workflowId, {
      reason: 'daily_cost_cap', daily_spend: dailySpend, cap: envDailyCostCap(),
    });
    return { dispatched: false, skip_reason: 'daily_cost_cap' };
  }

  // Concurrency cap (global)
  const active = queries.countActiveResolverRuns();
  if (active >= envGlobalConcurrency()) {
    logResilienceEvent('resolver_dispatch_skipped', 'workflow', workflowId, {
      reason: 'concurrency_cap', active, cap: envGlobalConcurrency(),
    });
    return { dispatched: false, skip_reason: 'concurrency_cap' };
  }

  _inFlight.add(key);
  let runRow: ResolverRun | null = null;
  try {
    runRow = queries.insertResolverRun({
      id: randomUUID(),
      workflow_id: workflowId,
      trigger_reason: (wf.blocked_reason ?? '').slice(0, 4_000),
      reason_fingerprint: decision.fingerprint,
      attempt: decision.attempt,
      model: defaultResolverModel(),
    });
    socket.emitResolverRunNew(runRow);
    // null → 'armed' bootstrap. The schema defaults resolver_circuit_state to
    // NULL for never-dispatched workflows. The first dispatch transitions it
    // to 'armed' so subsequent re-block events can flip it to 'tripped'.
    // Existing 'armed' or 'tripped' values are preserved untouched.
    //
    // The attempt count is incremented up front so concurrent different-
    // fingerprint dispatches can't both observe the same pre-increment count
    // and collectively exceed the lifetime cap. The catch block below
    // rolls this back if the session never produced cost or turns (i.e.
    // crashed synchronously before any LLM work happened).
    queries.updateWorkflow(workflowId, {
      resolver_attempt_count: decision.attempt,
      resolver_circuit_state: wf.resolver_circuit_state ?? 'armed',
    });
    const refreshed = queries.getWorkflowById(workflowId);
    if (refreshed) {
      wf = refreshed;
      socket.emitWorkflowUpdate(refreshed);
    }

    logResilienceEvent('resolver_dispatched', 'workflow', workflowId, {
      resolver_id: runRow.id,
      attempt: decision.attempt,
      fingerprint: decision.fingerprint,
      heuristic_classification: decision.classification,
      blocked_reason_normalized: normalizeReason(wf.blocked_reason).slice(0, 280),
      mode: decision.mode,
    });

    const bundle = buildResolverContext({ workflow: wf, attemptNumber: decision.attempt });
    const outcome = await runResolverSession({ run: runRow, bundle });

    const resumeOutcome = await routeOutcome({
      workflow: wf,
      run: queries.getResolverRunById(runRow.id) ?? runRow,
      outcome,
      mode: decision.mode,
    });

    return {
      dispatched: true,
      resolver_id: runRow.id,
      outcome_status: outcome.status,
      resume_outcome: resumeOutcome,
    };
  } catch (err) {
    log.error({ err, workflow_id: workflowId, resolver_id: runRow?.id }, 'resolver dispatch crashed');
    captureWithContext(err, { workflow_id: workflowId, resolver_id: runRow?.id, component: 'ResolverDispatcher' });
    const msg = stripControlChars((err as Error).message ?? String(err)).slice(0, 500);
    if (runRow) {
      try {
        queries.updateResolverRun(runRow.id, {
          status: 'failed',
          finished_at: Date.now(),
          error_message: msg,
        });
        const fresh = queries.getResolverRunById(runRow.id);
        if (fresh) socket.emitResolverRunUpdate(fresh);

        // Roll back the attempt count if the session never produced cost
        // or turns — i.e. crashed in context assembly or before the first
        // API call. The lifetime cap shouldn't burn an attempt the operator
        // can't see any output from.
        if (fresh && (fresh.cost_usd ?? 0) === 0 && (fresh.turn_count ?? 0) === 0) {
          const rolledBack = Math.max(0, decision.attempt - 1);
          queries.updateWorkflow(workflowId, { resolver_attempt_count: rolledBack });
          const rb = queries.getWorkflowById(workflowId);
          if (rb) socket.emitWorkflowUpdate(rb);
          logResilienceEvent('resolver_attempt_rolled_back', 'workflow', workflowId, {
            resolver_id: runRow.id, reason: 'no cost or turns', new_count: rolledBack,
          });
        }
      } catch { /* swallow */ }
    }
    return { dispatched: false, skip_reason: undefined, error: msg };
  } finally {
    _inFlight.delete(key);
  }
}

// Fire-and-forget wrapper for callers in synchronous paths (updateAndEmit).
export function dispatchResolverForWorkflowAsync(workflowId: string): void {
  dispatchResolverForWorkflow(workflowId).catch(err => {
    log.error({ err, workflow_id: workflowId }, 'resolver async dispatch error');
  });
}

// ─── Outcome routing ────────────────────────────────────────────────────────

interface RouteInput {
  workflow: Workflow;
  run: ResolverRun;
  outcome: Awaited<ReturnType<typeof runResolverSession>>;
  mode: ResolverMode;
}

async function routeOutcome(input: RouteInput): Promise<ResolverResumeOutcome | null> {
  const { run, outcome, mode } = input;
  // Always refresh the workflow row — the Resolver may have mutated it.
  const wf = queries.getWorkflowById(input.workflow.id);
  if (!wf) return null;

  if (!outcome.terminal) {
    // Failed / aborted / no-terminal-tool. Surface in dashboard; workflow stays blocked.
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_no_action', 'workflow', wf.id, {
      resolver_id: run.id, status: outcome.status, error: outcome.error ?? null,
    });
    return 'not_resumed';
  }

  if (outcome.terminal.kind === 'escalated' || outcome.terminal.kind === 'unresolvable') {
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_escalated', 'workflow', wf.id, {
      resolver_id: run.id, kind: outcome.terminal.kind,
    });
    return 'not_resumed';
  }

  // propose_resume
  const payload = outcome.terminal.payload as { phase: 'assess' | 'review' | 'implement' | 'verify'; cycle: number; confidence: number; summary: string };
  const cls = run.classification ?? classifyHeuristic(wf.blocked_reason);
  const threshold = autoResumeConfidenceThreshold(cls);

  if (mode === 'diagnose') {
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_diagnose_only', 'workflow', wf.id, {
      resolver_id: run.id, classification: cls, confidence: payload.confidence,
    });
    return 'not_resumed';
  }

  // Mode is 'assisted' or 'auto'. In assisted mode, only safe classes resume automatically.
  const classAllowed = mode === 'auto' || ASSISTED_CLASSIFICATIONS.has(cls);
  const confidenceOk = payload.confidence >= threshold;

  if (!classAllowed || !confidenceOk) {
    queries.updateResolverRun(run.id, { resume_outcome: 'not_resumed' });
    logResilienceEvent('resolver_resume_gated', 'workflow', wf.id, {
      resolver_id: run.id,
      classification: cls,
      confidence: payload.confidence,
      threshold,
      class_allowed: classAllowed,
      mode,
    });
    return 'not_resumed';
  }

  // Hand off to ResumeOrchestrator — it does the worktree-health check,
  // calls resumeWorkflow, watches for re-block, trips the circuit if needed.
  const final = await handleResolverOutcome({
    workflow: wf,
    run,
    proposed: payload,
  });
  return final;
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function _resetInFlightForTest(): void { _inFlight.clear(); }
export function _peekInFlightForTest(): string[] { return [..._inFlight]; }

// ─── Result shape ──────────────────────────────────────────────────────────

export interface DispatchResult {
  dispatched: boolean;
  skip_reason?: DispatchSkipReason;
  resolver_id?: string;
  outcome_status?: string;
  resume_outcome?: ResolverResumeOutcome | null;
  error?: string;
}
