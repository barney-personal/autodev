import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestWorkflow } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

import * as queries from '../server/db/queries.js';
import {
  decideDispatch,
  decideDispatchWithCaps,
  dispatchResolverForWorkflow,
  _resetInFlightForTest,
} from '../server/orchestrator/ResolverDispatcher.js';
import {
  resetResolverCircuit,
  recordPostResumeBlock,
  _resetRecentResumesForTest,
} from '../server/orchestrator/ResumeOrchestrator.js';

beforeEach(async () => {
  await setupTestDb();
  _resetInFlightForTest();
  _resetRecentResumesForTest();
  delete process.env.RESOLVER_MODE;
  delete process.env.RESOLVER_LIFETIME_ATTEMPTS;
  delete process.env.RESOLVER_DAILY_COST_CAP_USD;
});

afterEach(async () => {
  await cleanupTestDb();
});

describe('decideDispatch', () => {
  it('skips when RESOLVER_MODE=off', async () => {
    process.env.RESOLVER_MODE = 'off';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    // Re-fetch through the queries layer so we get the full Workflow shape
    const stored = queries.getWorkflowById(wf.id)!;
    stored.blocked_reason = 'Phase failed';
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('mode_off');
  });

  it('skips when status is not blocked', async () => {
    const wf = await insertTestWorkflow({ status: 'running' });
    const stored = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('not_blocked');
  });

  it('skips when blocked_reason is empty', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    const stored = queries.getWorkflowById(wf.id)!;
    stored.blocked_reason = null;
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('no_blocked_reason');
  });

  it('skips when circuit is tripped', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, {
      blocked_reason: 'Phase failed',
      resolver_circuit_state: 'tripped',
    });
    const stored = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('circuit_tripped');
  });

  it('skips when lifetime attempts exhausted', async () => {
    process.env.RESOLVER_LIFETIME_ATTEMPTS = '3';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, {
      blocked_reason: 'Phase failed',
      resolver_attempt_count: 3,
    });
    const stored = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('lifetime_attempts_exhausted');
  });

  it('runs when blocked with a fresh reason', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });
    const stored = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatch(stored);
    expect(decision.shouldRun).toBe(true);
    expect(decision.attempt).toBe(1);
    expect(decision.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(decision.classification).not.toBe('unknown');
  });

  it('increments attempt count across dispatches', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, {
      blocked_reason: 'Phase failed',
      resolver_attempt_count: 2,
    });
    const stored = queries.getWorkflowById(wf.id)!;
    expect(decideDispatch(stored).attempt).toBe(3);
  });
});

describe('decideDispatchWithCaps', () => {
  it('reports daily_cost_cap when prior runs in the window exceed the cap', async () => {
    process.env.RESOLVER_DAILY_COST_CAP_USD = '5';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });
    const seeded = queries.insertResolverRun({
      id: 'wc-1', workflow_id: wf.id, trigger_reason: 'old', reason_fingerprint: 'oldfp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const db = (await import('../server/db/database.js')).getDb();
    db.prepare('UPDATE resolver_runs SET cost_usd = 10 WHERE id = ?').run(seeded.id);

    const fresh = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatchWithCaps(fresh);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('daily_cost_cap');
  });

  it('reports concurrency_cap when active runs meet the limit', async () => {
    process.env.RESOLVER_GLOBAL_CONCURRENCY = '1';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });
    queries.insertResolverRun({
      id: 'wc-active', workflow_id: wf.id, trigger_reason: 'active', reason_fingerprint: 'activefp',
      attempt: 1, model: 'claude-opus-4-7',
    });

    const fresh = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatchWithCaps(fresh);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('concurrency_cap');
  });

  it('reports in_flight when an active run on the same fingerprint exists', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    const reason = 'Phase failed (rate_limit)';
    queries.updateWorkflow(wf.id, { blocked_reason: reason });
    const fresh = queries.getWorkflowById(wf.id)!;
    const { fingerprint } = await import('../server/orchestrator/ResolverFingerprint.js');
    const fp = fingerprint(reason);
    queries.insertResolverRun({
      id: 'wc-inflight', workflow_id: wf.id, trigger_reason: reason, reason_fingerprint: fp,
      attempt: 1, model: 'claude-opus-4-7',
    });

    const decision = decideDispatchWithCaps(fresh);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('in_flight');
  });

  it('returns shouldRun=true when all caps clear', async () => {
    process.env.RESOLVER_DAILY_COST_CAP_USD = '50';
    process.env.RESOLVER_GLOBAL_CONCURRENCY = '2';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });
    const fresh = queries.getWorkflowById(wf.id)!;
    const decision = decideDispatchWithCaps(fresh);
    expect(decision.shouldRun).toBe(true);
  });
});

describe('dispatchResolverForWorkflow — daily cost cap', () => {
  it('skips dispatch when 24h spend ≥ RESOLVER_DAILY_COST_CAP_USD', async () => {
    process.env.RESOLVER_DAILY_COST_CAP_USD = '5';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });

    // Seed an existing run that already burned more than the cap within
    // the rolling 24h window.
    const seeded = queries.insertResolverRun({
      id: 'seed-cost', workflow_id: wf.id, trigger_reason: 'old', reason_fingerprint: 'oldfp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    // Bump cost manually since insertResolverRun doesn't accept cost_usd.
    const db = (await import('../server/db/database.js')).getDb();
    db.prepare('UPDATE resolver_runs SET cost_usd = 10 WHERE id = ?').run(seeded.id);

    const result = await dispatchResolverForWorkflow(wf.id);
    expect(result.dispatched).toBe(false);
    expect(result.skip_reason).toBe('daily_cost_cap');
  });

  it('allows dispatch when 24h spend is below the cap', async () => {
    process.env.RESOLVER_DAILY_COST_CAP_USD = '100';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'Phase failed (rate_limit)' });

    const seeded = queries.insertResolverRun({
      id: 'seed-cheap', workflow_id: wf.id, trigger_reason: 'old', reason_fingerprint: 'oldfp2',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const db = (await import('../server/db/database.js')).getDb();
    db.prepare('UPDATE resolver_runs SET cost_usd = 1, status = ? WHERE id = ?').run('escalated', seeded.id);

    // The session will fail with no Anthropic client wired in, but that's
    // after the dispatch fired — which is exactly what we want to check.
    const result = await dispatchResolverForWorkflow(wf.id);
    expect(result.skip_reason).not.toBe('daily_cost_cap');
  });
});

describe('runStartupMaintenance frees stale resolver concurrency slots', () => {
  it('aborts stale running rows via the maintenance hook so countActiveResolverRuns drops', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    const stale = queries.insertResolverRun({
      id: 'stale-startup', workflow_id: wf.id, trigger_reason: 'crashed', reason_fingerprint: 'sf',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const fresh = queries.insertResolverRun({
      id: 'fresh-startup', workflow_id: wf.id, trigger_reason: 'new', reason_fingerprint: 'nf',
      attempt: 2, model: 'claude-opus-4-7',
    });

    const db = (await import('../server/db/database.js')).getDb();
    db.prepare('UPDATE resolver_runs SET started_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000, stale.id);

    expect(queries.countActiveResolverRuns()).toBe(2);

    const { runStartupMaintenance } = await import('../server/orchestrator/StartupMaintenance.js');
    const stats = runStartupMaintenance();
    expect(stats.staleResolverRunsAborted).toBe(1);

    // Concurrency slot freed.
    expect(queries.countActiveResolverRuns()).toBe(1);
    expect(queries.getResolverRunById(stale.id)!.status).toBe('aborted');
    expect(queries.getResolverRunById(fresh.id)!.status).toBe('running');
  });
});

describe('abortStaleRunningResolverRuns', () => {
  it('marks rows with status=running and old started_at as aborted', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    const fresh = queries.getWorkflowById(wf.id)!;
    const stale = queries.insertResolverRun({
      id: 'stale-1', workflow_id: fresh.id, trigger_reason: 'old', reason_fingerprint: 'old',
      attempt: 1, model: 'claude-opus-4-7',
    });
    // Backdate the started_at to simulate a crashed run.
    const db = (await import('../server/db/database.js')).getDb();
    db.prepare('UPDATE resolver_runs SET started_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, stale.id);

    const recent = queries.insertResolverRun({
      id: 'recent-1', workflow_id: fresh.id, trigger_reason: 'new', reason_fingerprint: 'new',
      attempt: 2, model: 'claude-opus-4-7',
    });

    const aborted = queries.abortStaleRunningResolverRuns(30 * 60 * 1000);
    expect(aborted).toBe(1);

    const reloadedStale = queries.getResolverRunById(stale.id)!;
    expect(reloadedStale.status).toBe('aborted');
    expect(reloadedStale.finished_at).not.toBeNull();
    expect(reloadedStale.error_message).toMatch(/startup reconcile/);

    const reloadedRecent = queries.getResolverRunById(recent.id)!;
    expect(reloadedRecent.status).toBe('running');
  });
});

describe('ResumeOrchestrator — circuit-trip end-to-end', () => {
  it('trips the circuit when a Resolver-driven resume is followed by a same-fingerprint re-block', async () => {
    const { recordPostResumeBlock, _seedRecentResumeForTest, _resetRecentResumesForTest } =
      await import('../server/orchestrator/ResumeOrchestrator.js');
    const { fingerprint } = await import('../server/orchestrator/ResolverFingerprint.js');
    _resetRecentResumesForTest();

    const wf = await insertTestWorkflow({ status: 'blocked' });
    const blockedReason = 'Phase failed (rate_limit) on claude-sonnet-4-6';
    queries.updateWorkflow(wf.id, { blocked_reason: blockedReason });
    const fp = fingerprint(blockedReason);

    const run = queries.insertResolverRun({
      id: 'circuit-trip-1', workflow_id: wf.id, trigger_reason: blockedReason,
      reason_fingerprint: fp, attempt: 1, model: 'claude-opus-4-7',
    });
    queries.updateResolverRun(run.id, { resume_outcome: 'resumed_running' });

    // Simulate the state right after a successful Resolver-driven resume.
    _seedRecentResumeForTest(wf.id, fp, run.id);

    // Workflow re-blocks on the same root cause — fingerprint should match
    // and the circuit should trip.
    const tripped = recordPostResumeBlock(wf.id, blockedReason);
    expect(tripped).toBe(true);

    const wfAfter = queries.getWorkflowById(wf.id)!;
    expect(wfAfter.resolver_circuit_state).toBe('tripped');

    const runAfter = queries.getResolverRunById(run.id)!;
    expect(runAfter.resume_outcome).toBe('resumed_re_blocked');

    // A subsequent dispatch attempt must observe the tripped circuit.
    const decision = decideDispatch(wfAfter);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('circuit_tripped');
  });

  it('does NOT trip the circuit when the re-block has a different fingerprint', async () => {
    const { recordPostResumeBlock, _seedRecentResumeForTest, _resetRecentResumesForTest } =
      await import('../server/orchestrator/ResumeOrchestrator.js');
    const { fingerprint } = await import('../server/orchestrator/ResolverFingerprint.js');
    _resetRecentResumesForTest();

    const wf = await insertTestWorkflow({ status: 'blocked' });
    const originalReason = 'Phase failed (rate_limit) on claude-sonnet-4-6';
    queries.updateWorkflow(wf.id, { blocked_reason: originalReason });
    const fp = fingerprint(originalReason);

    const run = queries.insertResolverRun({
      id: 'circuit-trip-2', workflow_id: wf.id, trigger_reason: originalReason,
      reason_fingerprint: fp, attempt: 1, model: 'claude-opus-4-7',
    });
    _seedRecentResumeForTest(wf.id, fp, run.id);

    const newReason = 'Phase failed (test_failure) on claude-sonnet-4-6';
    const tripped = recordPostResumeBlock(wf.id, newReason);
    expect(tripped).toBe(false);

    const wfAfter = queries.getWorkflowById(wf.id)!;
    expect(wfAfter.resolver_circuit_state).toBeNull();
  });
});

describe('ResumeOrchestrator — circuit breaker', () => {
  it('resetResolverCircuit clears state and attempt count', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, {
      resolver_circuit_state: 'tripped',
      resolver_attempt_count: 5,
    });
    const ok = resetResolverCircuit(wf.id);
    expect(ok).toBe(true);
    const fresh = queries.getWorkflowById(wf.id)!;
    expect(fresh.resolver_circuit_state).toBe('armed');
    expect(fresh.resolver_attempt_count).toBe(0);
  });

  it('resetResolverCircuit on unknown workflow returns false', () => {
    const ok = resetResolverCircuit('does-not-exist');
    expect(ok).toBe(false);
  });

  it('recordPostResumeBlock is a no-op when no recent resume tracked', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    const tripped = recordPostResumeBlock(wf.id, 'fresh blocked reason');
    expect(tripped).toBe(false);
  });
});
