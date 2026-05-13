/**
 * Hydration-ordering tests for watcherQueries.
 *
 * Regression: listCommentaryForAgent and listActionsForAgent originally used
 * `ORDER BY created_at ASC LIMIT ?` which returns the OLDEST N rows. The
 * client store keeps the NEWEST 500 (via slice(-500)) and the live socket
 * stream only carries new entries. For any agent with > limit rows the two
 * feeds didn't overlap — the panel showed the oldest 500 then jumped to the
 * newest socket-delivered entries, leaving a hole in the middle.
 *
 * Fix: newest-N inner SELECT, then reverse to chronological order — same
 * pattern as getRecentCommentaryForAgent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('watcherQueries hydration ordering', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  async function seedAgent() {
    const queries = await import('../server/db/queries.js');
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
    return { agentId, watcher };
  }

  it('listCommentaryForAgent returns the newest N rows in chronological order', async () => {
    const queries = await import('../server/db/queries.js');
    const { agentId, watcher } = await seedAgent();

    // 600 commentary rows — more than DEFAULT_WATCHER_LIST_LIMIT (500).
    // Each headline encodes its insertion index so we can prove which slice
    // came back. We bump the system clock between groups so created_at is
    // strictly monotonic and reflects insertion order.
    const FAKE_START = Date.now();
    let now = FAKE_START;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let i = 0; i < 600; i++) {
        now = FAKE_START + i;  // distinct timestamp per row
        queries.insertCommentary({
          id: randomUUID(),
          watcher_id: watcher.id,
          agent_id: agentId,
          severity: 'info',
          headline: `entry-${i}`,
        });
      }
    } finally { spy.mockRestore(); }

    const hydrated = queries.listCommentaryForAgent(agentId);
    expect(hydrated.length).toBe(500);
    // The oldest entry in the hydrated payload should be entry-100 (since
    // we keep the last 500 of 600), and the newest should be entry-599.
    expect(hydrated[0].headline).toBe('entry-100');
    expect(hydrated[hydrated.length - 1].headline).toBe('entry-599');
    // And the slice must be chronological so the UI renders top-down.
    for (let i = 1; i < hydrated.length; i++) {
      expect(hydrated[i].created_at).toBeGreaterThanOrEqual(hydrated[i - 1].created_at);
    }
  });

  it('listActionsForAgent returns the newest N rows in chronological order', async () => {
    const queries = await import('../server/db/queries.js');
    const { agentId, watcher } = await seedAgent();

    const FAKE_START = Date.now();
    let now = FAKE_START;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let i = 0; i < 600; i++) {
        now = FAKE_START + i;
        queries.insertAction({
          id: randomUUID(),
          watcher_id: watcher.id,
          agent_id: agentId,
          type: 'nudge',
          reason: `reason-${i}`,
          outcome: 'applied',
        });
      }
    } finally { spy.mockRestore(); }

    const hydrated = queries.listActionsForAgent(agentId);
    expect(hydrated.length).toBe(500);
    expect(hydrated[0].reason).toBe('reason-100');
    expect(hydrated[hydrated.length - 1].reason).toBe('reason-599');
    for (let i = 1; i < hydrated.length; i++) {
      expect(hydrated[i].created_at).toBeGreaterThanOrEqual(hydrated[i - 1].created_at);
    }
  });

  it('honours an explicit limit smaller than the default', async () => {
    const queries = await import('../server/db/queries.js');
    const { agentId, watcher } = await seedAgent();
    const FAKE_START = Date.now();
    let now = FAKE_START;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let i = 0; i < 50; i++) {
        now = FAKE_START + i;
        queries.insertCommentary({
          id: randomUUID(), watcher_id: watcher.id, agent_id: agentId,
          severity: 'info', headline: `entry-${i}`,
        });
      }
    } finally { spy.mockRestore(); }

    // Ask for only the latest 10. Should return entries 40..49 in chronological order.
    const recent = queries.listCommentaryForAgent(agentId, 10);
    expect(recent.length).toBe(10);
    expect(recent[0].headline).toBe('entry-40');
    expect(recent[9].headline).toBe('entry-49');
  });
});
