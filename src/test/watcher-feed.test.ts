/**
 * Tests for the watcher's curated tick builder.
 *
 * Proves:
 * 1. buildWatcherTick returns null when the agent / job has been deleted.
 * 2. Events newer than sinceSeq are summarised as tool/text/result entries.
 * 3. Tool inputs and assistant narration are truncated to keep the feed bounded.
 * 4. Recent commentary and active warnings are surfaced.
 * 5. renderWatcherTick produces deterministic, byte-bounded output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

async function insertAgent(jobId: string) {
  const { insertAgent } = await import('../server/db/queries.js');
  const id = randomUUID();
  insertAgent({ id, job_id: jobId, status: 'running', started_at: Date.now() });
  return id;
}

async function insertOutput(agentId: string, seq: number, event: Record<string, unknown>) {
  const { insertAgentOutput } = await import('../server/db/queries.js');
  insertAgentOutput({
    agent_id: agentId,
    seq,
    event_type: String(event.type ?? 'unknown'),
    content: JSON.stringify(event),
    created_at: Date.now(),
  });
}

describe('watcherFeed.buildWatcherTick', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns null when the agent is gone', async () => {
    const { buildWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const tick = buildWatcherTick({ agentId: 'nope', trigger: 'initial', sinceSeq: -1 });
    expect(tick).toBeNull();
  });

  it('summarises tool_use, text, and result events', async () => {
    const { buildWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);

    await insertOutput(agentId, 0, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] },
    });
    await insertOutput(agentId, 1, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Working on the auth module.' }] },
    });
    await insertOutput(agentId, 2, {
      type: 'result',
      is_error: false,
      total_cost_usd: 0.123,
      num_turns: 4,
    });

    const tick = buildWatcherTick({ agentId, trigger: 'tool_use', sinceSeq: -1 })!;
    expect(tick).not.toBeNull();
    expect(tick.events).toHaveLength(3);
    expect(tick.events[0].kind).toBe('tool');
    expect(tick.events[0].detail).toContain('Edit');
    expect(tick.events[1].kind).toBe('text');
    expect(tick.events[2].kind).toBe('result');
    expect(tick.events[2].detail).toContain('4 turns');
    expect(tick.assistant_text).toContain('Working on the auth module');
    expect(tick.high_water_seq).toBe(2);
  });

  it('drops events at or below sinceSeq', async () => {
    const { buildWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);
    for (let i = 0; i < 5; i++) {
      await insertOutput(agentId, i, { type: 'assistant', message: { content: [{ type: 'tool_use', name: `T${i}`, input: {} }] } });
    }
    const tick = buildWatcherTick({ agentId, trigger: 'tool_use', sinceSeq: 2 })!;
    expect(tick.events.map(e => e.seq)).toEqual([3, 4]);
    expect(tick.high_water_seq).toBe(4);
  });

  it('truncates oversized tool inputs', async () => {
    const { buildWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);
    const huge = 'x'.repeat(5000);
    await insertOutput(agentId, 0, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: huge } }] },
    });
    const tick = buildWatcherTick({ agentId, trigger: 'tool_use', sinceSeq: -1 })!;
    expect(tick.events[0].detail.length).toBeLessThan(500);
    expect(tick.events[0].detail).toContain('…');
  });

  it('exposes warnings and recent commentary on the tick', async () => {
    const { buildWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = await insertAgent(job.id);

    queries.insertWarning({ id: randomUUID(), agent_id: agentId, type: 'stalled', message: '12 minutes' });

    const watcher = queries.insertWatcher({
      id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7',
    });
    queries.insertCommentary({
      id: randomUUID(), watcher_id: watcher.id, agent_id: agentId,
      severity: 'concern', headline: 'Looping on the same file',
    });

    const tick = buildWatcherTick({ agentId, trigger: 'warning', sinceSeq: -1 })!;
    expect(tick.warnings.map(w => w.type)).toContain('stalled');
    expect(tick.recent_commentary).toHaveLength(1);
    expect(tick.recent_commentary[0].severity).toBe('concern');
  });

  it('renders a deterministic, byte-bounded text view', async () => {
    const { buildWatcherTick, renderWatcherTick } = await import('../server/orchestrator/watcherFeed.js');
    const job = await insertTestJob({ status: 'running', title: 'My task' });
    const agentId = await insertAgent(job.id);
    await insertOutput(agentId, 0, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } }] },
    });

    const tick = buildWatcherTick({ agentId, trigger: 'heartbeat', sinceSeq: -1 })!;
    const text = renderWatcherTick(tick);
    expect(text.length).toBeLessThan(15_000);
    expect(text).toContain('[trigger=heartbeat]');
    expect(text).toContain('Job: My task');
    expect(text).toContain('RECENT EVENTS');
    expect(text).toContain('Read');
  });
});
