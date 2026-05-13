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
    DEFAULT_WATCHER_MODEL: 'claude-opus-4-7',
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

  it('requestTickNow returns false for unknown agent', async () => {
    const mod = await import('../server/orchestrator/JobWatcherManager.js');
    expect(mod.requestTickNow('unknown-agent')).toBe(false);
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
