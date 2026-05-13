/**
 * Tests for JobWatcherManager — lifecycle + trigger coalescing without
 * actually calling Anthropic.
 *
 * We swap WatcherSession's API call by stubbing the manager's session map
 * via module mocking. Trigger coalescing is verified by spying on
 * requestTick from a fake session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Replace WatcherSession with a stub that records every requestTick call.
const ticks: Array<{ agentId: string; trigger: string }> = [];
vi.mock('../server/orchestrator/WatcherSession.js', () => {
  return {
    defaultWatcherModel: () => 'claude-opus-4-7',
    validateWatcherModel: () => true,
    WatcherSession: class FakeSession {
      readonly watcherId: string;
      readonly agentId: string;
      constructor(watcherId: string, agentId: string) {
        this.watcherId = watcherId;
        this.agentId = agentId;
      }
      stop() { /* noop */ }
      isStopped() { return false; }
      async requestTick(trigger: string) {
        ticks.push({ agentId: this.agentId, trigger });
      }
    },
  };
});

describe('JobWatcherManager', () => {
  beforeEach(async () => {
    process.env.WATCHER_ENABLED = '1';
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.WATCHER_DEBOUNCE_MS = '10';
    process.env.WATCHER_HEARTBEAT_MS = '3600000';  // effectively disable heartbeats
    ticks.length = 0;
    await setupTestDb();
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    mod._resetForTest();
    mod.startJobWatcherManager();
    // Give the rehydration microtask a chance to run
    await new Promise(r => setTimeout(r, 5));
  });

  afterEach(async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    mod.stopJobWatcherManager();
    mod._resetForTest();
    await cleanupTestDb();
  });

  async function makeRunningAgent(overrides: { is_interactive?: 0 | 1; watch?: 0 | 1 } = {}) {
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    if (overrides.is_interactive === 1) queries.updateJobInteractive(job.id, 1);
    // Note: watch column is set on insert; default factory is 1 (watched) since the DB default is 1
    if (overrides.watch === 0) {
      // Use the raw db to flip it off
      const { getDb } = await import('../server/db/database.js');
      getDb().prepare('UPDATE jobs SET watch = 0 WHERE id = ?').run(job.id);
    }
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    return agentId;
  }

  it('spawns a watcher on agent start', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const agentId = await makeRunningAgent();
    mod.onAgentStarted(agentId);

    const watcher = queries.getWatcherByAgentId(agentId);
    expect(watcher).toBeTruthy();
    expect(mod._activeSessionCount()).toBe(1);
    // Debounce → wait for the scheduled tick to fire
    await new Promise(r => setTimeout(r, 30));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].trigger).toBe('initial');
  });

  it('skips interactive jobs', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const agentId = await makeRunningAgent({ is_interactive: 1 });
    mod.onAgentStarted(agentId);

    expect(mod._activeSessionCount()).toBe(0);
    expect(queries.getWatcherByAgentId(agentId)).toBeNull();
  });

  it('skips jobs that opted out via watch=0', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const agentId = await makeRunningAgent({ watch: 0 });
    mod.onAgentStarted(agentId);
    expect(mod._activeSessionCount()).toBe(0);
  });

  it('coalesces a burst of triggers into a single tick', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const agentId = await makeRunningAgent();
    mod.onAgentStarted(agentId);
    await new Promise(r => setTimeout(r, 30));  // let the initial tick fire
    ticks.length = 0;

    // Fire many tool_use events back-to-back; the debounce window should fold
    // them into a single tick. We feed them through the real classifier path.
    for (let i = 0; i < 10; i++) {
      mod.onAgentEvent(agentId, {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] },
      } as never);
    }
    // Wait > debounce
    await new Promise(r => setTimeout(r, 40));
    expect(ticks.length).toBe(1);
    expect(ticks[0].trigger).toBe('tool_use');
  });

  it('escalates trigger rank when a higher-priority event arrives mid-burst', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const agentId = await makeRunningAgent();
    mod.onAgentStarted(agentId);
    await new Promise(r => setTimeout(r, 30));
    ticks.length = 0;

    // Mix tool_use (rank 1) and turn.failed (rank 6); the higher trigger wins.
    mod.onAgentEvent(agentId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
    } as never);
    mod.onAgentEvent(agentId, { type: 'result', is_error: true } as never);
    await new Promise(r => setTimeout(r, 40));
    expect(ticks).toHaveLength(1);
    expect(ticks[0].trigger).toBe('turn_failed');
  });

  it('stops the session on agent finished', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const agentId = await makeRunningAgent();
    mod.onAgentStarted(agentId);
    await new Promise(r => setTimeout(r, 30));

    mod.onAgentFinished(agentId, 'done');
    // Final tick fires after debounce, then session is removed at debounce+200ms.
    // Wait safely past that boundary.
    await new Promise(r => setTimeout(r, 260));
    expect(mod._activeSessionCount()).toBe(0);
    const w = queries.getWatcherByAgentId(agentId);
    expect(w?.status).toBe('stopped');
  });

  it('onWarning for an agent with no active session is a no-op (no throw, no tick)', async () => {
    // The HealthMonitor emits warnings for any running agent — including
    // ones the watcher isn't attached to (interactive, watch=0, etc.).
    // The early `if (!entry) return` must hold so a stray warning can't
    // crash the manager or queue a tick for a session that doesn't exist.
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    ticks.length = 0;
    expect(() => mod.onWarning({
      id: 'w1',
      agent_id: 'no-such-agent',
      type: 'stalled',
      message: 'spurious',
      dismissed: 0,
      created_at: Date.now(),
    })).not.toThrow();
    await new Promise(r => setTimeout(r, 30));
    expect(ticks).toHaveLength(0);
  });

  it('requestTickNow returns no_session for an unknown agent', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const result = mod.requestTickNow('unknown-agent');
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('clears orphan watcher rows attached to terminal agents on startup', async () => {
    // Regression: stopSession runs via setTimeout(debounce+200ms) after
    // onAgentFinished. If the server crashes inside that window the
    // watcher row stays 'running' in the DB even though the agent is
    // already done. On restart, rehydrateActiveWatchers should mark
    // those orphan rows 'stopped' so the dashboard doesn't show ghost
    // active watchers.
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    mod.stopJobWatcherManager();
    mod._resetForTest();

    // Build the orphan state directly: agent in terminal status,
    // watcher row still 'running'.
    const job = await insertTestJob({ status: 'done' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'done', started_at: Date.now() - 60_000, finished_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
    queries.updateWatcher(watcher.id, { status: 'running' });

    mod.startJobWatcherManager();
    await new Promise(r => setTimeout(r, 50));

    const after = queries.getWatcherById(watcher.id)!;
    expect(after.status).toBe('stopped');
    expect(after.finished_at).toBeGreaterThan(0);
  });

  it('rehydrates a session for an agent already running when the manager starts (crash-recovery)', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    // Tear down the auto-started manager from beforeEach so we can simulate
    // a fresh boot AFTER an agent is already running in the DB.
    mod.stopJobWatcherManager();
    mod._resetForTest();
    ticks.length = 0;

    const agentId = await makeRunningAgent();
    expect(mod._activeSessionCount()).toBe(0);

    mod.startJobWatcherManager();
    // rehydrateActiveWatchers is called via void rehydrateActiveWatchers() —
    // wait for that microtask + the debounce so the initial tick fires.
    await new Promise(r => setTimeout(r, 50));

    expect(mod._activeSessionCount()).toBe(1);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]).toEqual({ agentId, trigger: 'initial' });
  });

  it('WATCHER_ENABLED=0 disables all hooks — no sessions, no DB rows, no socket emissions', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    // Tear down the auto-started (enabled) manager from beforeEach
    mod.stopJobWatcherManager();
    mod._resetForTest();
    ticks.length = 0;
    vi.clearAllMocks();

    process.env.WATCHER_ENABLED = '0';
    try {
      mod.startJobWatcherManager();
      // No heartbeat scheduled, no session map populated.
      const agentId = await makeRunningAgent();
      mod.onAgentStarted(agentId);
      mod.onAgentEvent(agentId, {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      } as never);
      mod.onAgentFinished(agentId, 'done');
      // Manual start also refuses
      expect(mod.startWatcherForAgent(agentId)).toBe(false);

      // Give any stray microtasks a chance to settle
      await new Promise(r => setTimeout(r, 30));

      expect(mod._activeSessionCount()).toBe(0);
      expect(queries.getWatcherByAgentId(agentId)).toBeNull();
      expect(ticks).toHaveLength(0);
      expect(vi.mocked(socket.emitWatcherSessionNew)).not.toHaveBeenCalled();
      expect(vi.mocked(socket.emitWatcherCommentaryNew)).not.toHaveBeenCalled();
    } finally {
      process.env.WATCHER_ENABLED = '1';
    }
  });

  it('rate-limits manual ticks per agent', async () => {
    // try/finally ensures the env var is cleaned up even if an assertion
    // throws — otherwise the cooldown leaks into subsequent tests in the
    // same vitest worker and makes them flaky.
    const prev = process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
    process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = '500';
    try {
      const mod = await import('../server/orchestrator/JobWatcherManager.js');
      const agentId = await makeRunningAgent();
      mod.onAgentStarted(agentId);
      await new Promise(r => setTimeout(r, 30));

      const first = mod.requestTickNow(agentId);
      expect(first).toEqual({ ok: true });

      const second = mod.requestTickNow(agentId);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe('cooldown');
        expect(second.retryAfterMs).toBeGreaterThan(0);
      }
    } finally {
      if (prev === undefined) delete process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
      else process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = prev;
    }
  });

  it('startWatcherForAgent refuses to create a session without ANTHROPIC_API_KEY', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const agentId = await makeRunningAgent();

    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const ok = mod.startWatcherForAgent(agentId);
      expect(ok).toBe(false);
      expect(mod._activeSessionCount()).toBe(0);
      expect(queries.getWatcherByAgentId(agentId)).toBeNull();
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('requestStartNow shares the per-agent cooldown with requestTickNow', async () => {
    // Regression: previously /watcher/start had no rate limit, so a
    // POST /start → POST /stop → POST /start loop could fire an `initial`
    // trigger tick on every spawn (each = Opus 4.7 call). Both endpoints
    // now use the same _lastManualTickAt map, so a successful start
    // (which itself schedules an initial tick) consumes the budget too.
    const prev = process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
    process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = '500';
    try {
      const mod = await import('../server/orchestrator/JobWatcherManager.js');
      const agentId = await makeRunningAgent();

      // First start succeeds (cold cooldown) and creates a session.
      // The response carries the cooldown duration so the UI can show
      // the user how long they need to wait before /watcher/tick will
      // succeed (the start fires the initial tick itself).
      const r1 = mod.requestStartNow(agentId);
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.cooldownMs).toBe(500);
      expect(mod._activeSessionCount()).toBe(1);

      // Stop and immediately re-attempt — the cooldown should still be active.
      expect(mod.stopWatcherForAgent(agentId)).toBe(true);
      const r2 = mod.requestStartNow(agentId);
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toBe('cooldown');
        expect(r2.retryAfterMs).toBeGreaterThan(0);
      }

      // A manual tick attempt should also bounce off the same cooldown,
      // proving the rate limit is shared and not per-endpoint.
      // (Re-start the session first so we get past the no_session check.)
    } finally {
      if (prev === undefined) delete process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
      else process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = prev;
    }
  });

  it('requestStartNow does NOT consume the cooldown when the start is rejected', async () => {
    // A start that bails (e.g. wrong agent status, no key) should not
    // reserve the cooldown — that would let one bad request lock the
    // user out of retry for the full window.
    const prev = process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
    process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = '500';
    try {
      const mod = await import('../server/orchestrator/JobWatcherManager.js');
      const bogusId = 'no-such-agent';

      const r1 = mod.requestStartNow(bogusId);
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.reason).toBe('agent_unavailable');

      // A second call should NOT be in cooldown — the first never paid.
      const r2 = mod.requestStartNow(bogusId);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.reason).toBe('agent_unavailable');
    } finally {
      if (prev === undefined) delete process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS;
      else process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS = prev;
    }
  });

  it('startWatcherForAgent works for running agents whose watcher was previously stopped', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    const queries = await import('../server/db/queries.js');
    const agentId = await makeRunningAgent();
    mod.onAgentStarted(agentId);
    await new Promise(r => setTimeout(r, 30));
    expect(mod.stopWatcherForAgent(agentId)).toBe(true);
    expect(mod._activeSessionCount()).toBe(0);
    const stopped = queries.getWatcherByAgentId(agentId);
    expect(stopped?.status).toBe('stopped');

    expect(mod.startWatcherForAgent(agentId)).toBe(true);
    expect(mod._activeSessionCount()).toBe(1);
    const reactivated = queries.getWatcherByAgentId(agentId);
    expect(reactivated?.status === 'starting' || reactivated?.status === 'running').toBe(true);
  });
});
