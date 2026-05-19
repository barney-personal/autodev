import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestWorkflow } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

import * as queries from '../server/db/queries.js';
import {
  decideDispatch,
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
