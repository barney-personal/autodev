/**
 * Regression tests for WatcherSession history management.
 *
 * Three reviewer-flagged bugs:
 *   1. trimHistory produced consecutive user messages once history grew past
 *      MAX_HISTORY_TURNS — Anthropic rejects with 422.
 *   2. The error-recovery path popped at most two history entries, but a
 *      mid-tool-loop failure can leave 3+ in-flight messages — leading to an
 *      assistant(tool_use) with no matching tool_result on retry.
 *   3. The nudge cooldown SQL counted 'gated' attempts as "last action",
 *      permanently locking out nudges after the first cooldown rejection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
}));

// Hoisted so vi.mock can reach it before module init — same fn across tests,
// each test calls mockReset + mockResolvedValueOnce on it.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
  }
  return { default: FakeAnthropic };
});

describe('trimHistory — alternation invariant', () => {
  it('keeps short histories untouched', async () => {
    const { trimHistory } = await import('../server/orchestrator/WatcherSession.js');
    const hist = [
      { role: 'user' as const, content: 'u0' },
      { role: 'assistant' as const, content: 'a0' },
    ];
    expect(trimHistory(hist)).toEqual(hist);
  });

  it('produces a strictly-alternating sequence when trimming long histories', async () => {
    const { trimHistory } = await import('../server/orchestrator/WatcherSession.js');
    // 14 messages — 7 plain ticks (u, a) × 7, longer than MAX_HISTORY_TURNS=12.
    const hist: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 7; i++) {
      hist.push({ role: 'user', content: `u${i}` });
      hist.push({ role: 'assistant', content: `a${i}` });
    }
    const trimmed = trimHistory(hist);
    expect(trimmed.length).toBeLessThanOrEqual(12);
    expect(trimmed.length).toBeGreaterThan(1);

    // The first message must always be user (the original briefing), and
    // every adjacent pair must alternate.
    expect(trimmed[0].role).toBe('user');
    for (let i = 1; i < trimmed.length; i++) {
      expect(trimmed[i].role).not.toBe(trimmed[i - 1].role);
    }
  });

  it('drops leading tool_result users from the tail to avoid orphans', async () => {
    const { trimHistory } = await import('../server/orchestrator/WatcherSession.js');
    // Mix in tool_use/tool_result rounds so tail might start mid-round.
    const hist: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (let i = 0; i < 4; i++) {
      hist.push({ role: 'user', content: `u_tick${i}` });
      hist.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'X', input: {} }] });
      hist.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] });
      hist.push({ role: 'assistant', content: `a_final${i}` });
    }
    // 16 messages
    const trimmed = trimHistory(hist as never);
    expect(trimmed[0].role).toBe('user');
    // No consecutive same-role messages anywhere.
    for (let i = 1; i < trimmed.length; i++) {
      expect(trimmed[i].role).not.toBe(trimmed[i - 1].role);
    }
    // First non-head message must be assistant (head is user).
    expect(trimmed[1].role).toBe('assistant');
  });
});

describe('WatcherSession — error rollback', () => {
  beforeEach(async () => {
    await setupTestDb();
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'sk-test';
    mockCreate.mockReset();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('rolls history back to the snapshot length on mid-tool-loop API failure', async () => {
    // First call: assistant emits a tool_use round.
    // Second call: throws (e.g. rate limit) AFTER we've already pushed
    // assistant + tool_result to history. The session should roll back to
    // exactly the length before the tick prompt was pushed.
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu1', name: 'post_commentary', input: { severity: 'info', headline: 'starting' } }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'tool_use',
      })
      .mockRejectedValueOnce(new Error('429 rate limited'));

    const { WatcherSession } = await import('../server/orchestrator/WatcherSession.js');
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });

    const session = new WatcherSession(watcher.id, agentId);
    // Access the private history via a deliberate cast for the test.
    const sessionWithInternals = session as unknown as { history: unknown[] };
    expect(sessionWithInternals.history).toHaveLength(0);

    await session.requestTick('initial');

    // History must be empty again — no half-finished turn left dangling.
    expect(sessionWithInternals.history).toHaveLength(0);
    // The watcher row is marked errored, ready to retry on next trigger.
    const w = queries.getWatcherById(watcher.id);
    expect(w?.status).toBe('error');
    expect(w?.error_message).toContain('429');

    // Second tick after a successful API call should leave a valid 2-message history.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu2', name: 'post_commentary', input: { severity: 'info', headline: 'recovered' } }],
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn',
    });
    await session.requestTick('warning');
    expect(sessionWithInternals.history).toHaveLength(2);
    expect((sessionWithInternals.history[0] as { role: string }).role).toBe('user');
    expect((sessionWithInternals.history[1] as { role: string }).role).toBe('assistant');
  });
});

describe('lastActionAtForAgent — applied-only filter', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('ignores gated and failed actions when computing the last nudge time', async () => {
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });

    // Older applied action
    queries.insertAction({
      id: randomUUID(), watcher_id: watcher.id, agent_id: agentId,
      type: 'nudge', outcome: 'applied',
    });
    const appliedAt = queries.lastActionAtForAgent(agentId, 'nudge')!;
    expect(appliedAt).toBeGreaterThan(0);

    // A later gated action (created at "now" > appliedAt) must NOT shift the
    // last-applied timestamp — otherwise the cooldown would extend itself.
    await new Promise(r => setTimeout(r, 5));
    queries.insertAction({
      id: randomUUID(), watcher_id: watcher.id, agent_id: agentId,
      type: 'nudge', outcome: 'gated',
    });
    const stillAppliedAt = queries.lastActionAtForAgent(agentId, 'nudge')!;
    expect(stillAppliedAt).toBe(appliedAt);

    // Same for 'failed' outcome
    queries.insertAction({
      id: randomUUID(), watcher_id: watcher.id, agent_id: agentId,
      type: 'nudge', outcome: 'failed',
    });
    expect(queries.lastActionAtForAgent(agentId, 'nudge')).toBe(appliedAt);
  });
});
