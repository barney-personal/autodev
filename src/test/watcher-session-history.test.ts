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

  it('falls back to head + last assistant when the tail window is entirely user-role', async () => {
    // Pathological case: the recent MAX_HISTORY_TURNS-1 window is all
    // user-role tool_results. Naive "return head only" would give the
    // watcher zero recent context. Improved fallback: scan the FULL
    // history for the most recent assistant turn and keep it alongside
    // head — the watcher loses intermediate turns but at least has its
    // last response to anchor on. Result stays API-valid (user, assistant).
    const { trimHistory } = await import('../server/orchestrator/WatcherSession.js');
    const hist: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: 'u0_brief' },  // head
    ];
    // Pad with assistant turns then enough user-only entries that the
    // last (MAX_HISTORY_TURNS-1) tail window is entirely user-role.
    for (let i = 0; i < 5; i++) hist.push({ role: 'assistant', content: `a${i}` });
    for (let i = 0; i < 14; i++) {
      hist.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }] });
    }
    const trimmed = trimHistory(hist as never);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0].role).toBe('user');
    expect(trimmed[0].content).toBe('u0_brief');
    // Most recent assistant in the input is a4 — that's what we should keep.
    expect(trimmed[1].role).toBe('assistant');
    expect(trimmed[1].content).toBe('a4');
  });

  it('returns head only when the history contains no assistant turn at all', async () => {
    // True degenerate case: only user messages exist anywhere in history.
    // No assistant to fall back to → return just [head]. Still a valid
    // single-user history; alternation is trivially satisfied.
    const { trimHistory } = await import('../server/orchestrator/WatcherSession.js');
    const hist: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (let i = 0; i < 15; i++) {
      hist.push({ role: 'user', content: `u${i}` });
    }
    const trimmed = trimHistory(hist as never);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].role).toBe('user');
    expect(trimmed[0].content).toBe('u0');
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

  it('leaves history ending in assistant when MAX_TOOL_ROUNDS is exhausted', async () => {
    // Regression: previously hitting MAX_TOOL_ROUNDS while the model still
    // wanted to call tools left history ending in user(tool_results). The
    // next tick would push user(tick_prompt) onto that, producing two
    // consecutive user-role messages — Anthropic rejects with 422.
    //
    // The fix synthesises a final assistant text turn after the loop so
    // alternation is preserved across ticks.
    //
    // We force the path by mocking every tool round to return tool_use
    // blocks (no end_turn), so the loop runs the full MAX_TOOL_ROUNDS
    // iterations and exits via the round cap rather than via end_turn.
    for (let i = 0; i < 6; i++) {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: `tu${i}`, name: 'post_commentary', input: { severity: 'info', headline: `round ${i}` } }],
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'tool_use',
      });
    }

    const { WatcherSession } = await import('../server/orchestrator/WatcherSession.js');
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });

    const session = new WatcherSession(watcher.id, agentId);
    const internals = session as unknown as { history: Array<{ role: 'user' | 'assistant'; content: unknown }> };
    await session.requestTick('initial');

    // History must end on an assistant turn so a subsequent user(tick_prompt)
    // is alternation-valid.
    expect(internals.history.length).toBeGreaterThan(0);
    const last = internals.history[internals.history.length - 1];
    expect(last.role).toBe('assistant');

    // The synthetic note about the round cap should be present in that final
    // assistant turn so the model knows why the loop stopped.
    const lastContent = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
    const text = lastContent
      .filter((b: Record<string, unknown>) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('');
    expect(text).toContain('Tool-round cap');

    // Strict alternation check across the whole history — no two adjacent
    // entries share a role.
    for (let i = 1; i < internals.history.length; i++) {
      expect(internals.history[i].role).not.toBe(internals.history[i - 1].role);
    }
  });

  it('advances last_seq even when the tick errors out, so retries do not replay events', async () => {
    // Regression: previously last_seq stayed at its old value on the error
    // path, causing every retry to re-summarise the events that errored out.
    // On a long-running agent with many events between ticks, the first
    // successful retry after a transient API failure would produce a burst
    // of duplicate commentary.
    mockCreate.mockRejectedValueOnce(new Error('500 Internal Server Error'));

    const { WatcherSession } = await import('../server/orchestrator/WatcherSession.js');
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });

    // Insert several stream events so high_water_seq > -1.
    for (let i = 0; i < 5; i++) {
      queries.insertAgentOutput({
        agent_id: agentId, seq: i, event_type: 'assistant',
        content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
        created_at: Date.now(),
      });
    }

    const session = new WatcherSession(watcher.id, agentId);
    await session.requestTick('initial');

    const w = queries.getWatcherById(watcher.id)!;
    expect(w.status).toBe('error');
    // last_seq should now reflect the latest DB seq (4), not the original -1.
    expect(w.last_seq).toBe(4);
  });

  it('halts the session and posts a final commentary when WATCHER_MAX_COST_USD is reached', async () => {
    // Operator safety: a per-session cost cap can stop a runaway watcher
    // session before it burns more than expected on Opus 4.7. When the
    // running cost_usd meets the cap, runTick must skip the API call,
    // mark the row stopped with a clear error_message, and post a
    // blocker-severity commentary so the dashboard surfaces why the
    // stream went quiet.
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
    // Seed cost_usd above the cap so the very first runTick trips the guard.
    queries.updateWatcher(watcher.id, { cost_usd: 5.0 } as never);

    const prevCap = process.env.WATCHER_MAX_COST_USD;
    process.env.WATCHER_MAX_COST_USD = '1.0';
    try {
      mockCreate.mockReset();  // no API call should reach the SDK
      const { WatcherSession } = await import('../server/orchestrator/WatcherSession.js');
      const session = new WatcherSession(watcher.id, agentId);
      await session.requestTick('initial');

      // The SDK was not invoked — the cap intercepted before any spend.
      expect(mockCreate).not.toHaveBeenCalled();

      // Watcher row is now stopped with a clear error_message.
      const updated = queries.getWatcherById(watcher.id)!;
      expect(updated.status).toBe('stopped');
      expect(updated.finished_at).toBeGreaterThan(0);
      expect(updated.error_message ?? '').toContain('Cost cap reached');

      // A blocker-severity commentary explains why the stream went quiet.
      const commentary = queries.listCommentaryForAgent(agentId);
      const halt = commentary.find(c => c.severity === 'blocker' && c.headline.includes('cost cap'));
      expect(halt).toBeTruthy();
    } finally {
      if (prevCap === undefined) delete process.env.WATCHER_MAX_COST_USD;
      else process.env.WATCHER_MAX_COST_USD = prevCap;
    }
  });

  it('envMaxCostUsd ignores unparseable / non-positive env values', async () => {
    const { envMaxCostUsd } = await import('../server/orchestrator/WatcherSession.js');
    const prev = process.env.WATCHER_MAX_COST_USD;
    try {
      process.env.WATCHER_MAX_COST_USD = '';
      expect(envMaxCostUsd()).toBeNull();
      process.env.WATCHER_MAX_COST_USD = 'banana';
      expect(envMaxCostUsd()).toBeNull();
      process.env.WATCHER_MAX_COST_USD = '0';
      expect(envMaxCostUsd()).toBeNull();
      process.env.WATCHER_MAX_COST_USD = '-1';
      expect(envMaxCostUsd()).toBeNull();
      process.env.WATCHER_MAX_COST_USD = '2.5';
      expect(envMaxCostUsd()).toBe(2.5);
      delete process.env.WATCHER_MAX_COST_USD;
      expect(envMaxCostUsd()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WATCHER_MAX_COST_USD;
      else process.env.WATCHER_MAX_COST_USD = prev;
    }
  });

  it('does not flip a stopped watcher back to running after a slow in-flight tick', async () => {
    // The race: onAgentFinished marks the row 'stopped' while this tick is
    // still awaiting messages.create. Without the guard, the success path
    // would write status='running' and resurrect the session in the DB/UI.
    const queries = await import('../server/db/queries.js');
    const { WatcherSession } = await import('../server/orchestrator/WatcherSession.js');

    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });

    // Simulate the race: while the API call is pending, flip the watcher to
    // 'stopped' in the DB (mirroring what stopSession does) and call
    // session.stop() to set the in-process flag.
    let resolveApi!: (resp: unknown) => void;
    mockCreate.mockImplementationOnce(() => new Promise(resolve => { resolveApi = resolve; }));

    const session = new WatcherSession(watcher.id, agentId);
    const tickPromise = session.requestTick('initial');

    // Wait for the manager-side stop to land before the API resolves.
    await new Promise(r => setTimeout(r, 10));
    queries.updateWatcher(watcher.id, { status: 'stopped', finished_at: Date.now() });
    session.stop();

    // Now let the in-flight API call resolve successfully.
    resolveApi({
      content: [{ type: 'text', text: 'final tick' }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn',
    });
    await tickPromise;

    const finalState = queries.getWatcherById(watcher.id)!;
    expect(finalState.status).toBe('stopped');
    // Usage still recorded — tokens were paid for.
    expect(finalState.input_tokens).toBeGreaterThanOrEqual(5);
  });
});

describe('validateWatcherModel', () => {
  it('accepts a known Claude model without warning', async () => {
    const { validateWatcherModel } = await import('../server/orchestrator/WatcherSession.js');
    const warn = vi.fn();
    const ok = validateWatcherModel('claude-opus-4-7', { warn });
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (but does not throw) on an unknown model name', async () => {
    const { validateWatcherModel } = await import('../server/orchestrator/WatcherSession.js');
    const warn = vi.fn();
    const ok = validateWatcherModel('claude-opus-4-77', { warn });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('pinCacheControlToLast — Anthropic 4-breakpoint cap', () => {
  it('strips cache_control from earlier user turns and keeps it on the latest', async () => {
    // Regression: a real production smoke test errored at tick 4 with
    // "A maximum of 4 blocks with cache_control may be provided. Found 5."
    // Each tick added a user turn with cache_control: ephemeral. By tick 4
    // we had system(1) + 4 user-turn marks = 5 breakpoints. Prefix-based
    // caching only needs the LATEST breakpoint, so older marks are dropped
    // before sending.
    const { pinCacheControlToLast } = await import('../server/orchestrator/WatcherSession.js');
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'first', cache_control: { type: 'ephemeral' as const } }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'reply 1' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'second', cache_control: { type: 'ephemeral' as const } }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'reply 2' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'third (latest)', cache_control: { type: 'ephemeral' as const } }] },
    ];
    const out = pinCacheControlToLast(messages);

    // Only the LAST user turn keeps cache_control.
    const userTurns = out.filter(m => m.role === 'user');
    expect(userTurns.length).toBe(3);
    const hasCacheCtrl = (m: typeof userTurns[number]) => Array.isArray(m.content) && m.content.some(b => (b as { cache_control?: unknown }).cache_control !== undefined);
    expect(hasCacheCtrl(userTurns[0])).toBe(false);
    expect(hasCacheCtrl(userTurns[1])).toBe(false);
    expect(hasCacheCtrl(userTurns[2])).toBe(true);
  });

  it('does not mutate the input array (history must keep cache_control for the next tick)', async () => {
    // The in-memory history is reused across ticks. If pinCacheControlToLast
    // mutated it, the helper would have to be re-applied differently on
    // each subsequent call. The shallow-clone contract makes the helper
    // pure-ish so callers don't have to think about it.
    const { pinCacheControlToLast } = await import('../server/orchestrator/WatcherSession.js');
    const msg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'a', cache_control: { type: 'ephemeral' as const } }] };
    const input = [msg, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'b' }] }, msg];
    const before = JSON.stringify(input);
    pinCacheControlToLast(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('handles an empty messages array', async () => {
    const { pinCacheControlToLast } = await import('../server/orchestrator/WatcherSession.js');
    expect(pinCacheControlToLast([])).toEqual([]);
  });

  it('preserves messages whose content is a plain string (no cache_control to strip)', async () => {
    const { pinCacheControlToLast } = await import('../server/orchestrator/WatcherSession.js');
    const messages = [
      { role: 'user' as const, content: 'plain old string' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'latest', cache_control: { type: 'ephemeral' as const } }] },
    ];
    const out = pinCacheControlToLast(messages);
    expect(out[0].content).toBe('plain old string');
    expect(out[1].content).toBe('reply');
    expect(Array.isArray(out[2].content)).toBe(true);
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
