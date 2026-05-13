/**
 * Tests for the check_watcher_nudges MCP tool — the bridge that lets the
 * watched agent pick up guidance the watcher posted via execNudgeJob.
 *
 * Covers:
 *  - peek (consume=false) does NOT clear the note
 *  - default consume (true) clears the note
 *  - empty / absent note returns has_nudges=false
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('checkWatcherNudgesHandler', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  async function seedNudge(agentId: string, content: string): Promise<void> {
    const queries = await import('../server/db/queries.js');
    queries.upsertNote(`watcher/nudges/${agentId}`, content, null);
  }

  it('returns has_nudges=false when no note has been written', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    const { checkWatcherNudgesHandler } = await import('../server/mcp/tools/checkWatcherNudges.js');
    const queries = await import('../server/db/queries.js');
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });

    const raw = await checkWatcherNudgesHandler(agentId, {});
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ has_nudges: false, content: '' });
  });

  it('returns the nudge content and clears the note by default (consume=true implicit)', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    const queries = await import('../server/db/queries.js');
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    await seedNudge(agentId, 'try the smaller test suite first');

    const { checkWatcherNudgesHandler } = await import('../server/mcp/tools/checkWatcherNudges.js');
    const raw = await checkWatcherNudgesHandler(agentId, {});
    const parsed = JSON.parse(raw);
    expect(parsed.has_nudges).toBe(true);
    expect(parsed.content).toContain('try the smaller test suite first');

    // Note should be cleared so the next call has nothing to deliver.
    const second = JSON.parse(await checkWatcherNudgesHandler(agentId, {}));
    expect(second).toEqual({ has_nudges: false, content: '' });
  });

  it('peeks without consuming when consume=false', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    const queries = await import('../server/db/queries.js');
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    await seedNudge(agentId, 'focus on the failing assertion in foo.test.ts');

    const { checkWatcherNudgesHandler } = await import('../server/mcp/tools/checkWatcherNudges.js');
    const first = JSON.parse(await checkWatcherNudgesHandler(agentId, { consume: false }));
    expect(first.has_nudges).toBe(true);
    expect(first.content).toContain('foo.test.ts');

    // A second peek should see the same nudge — nothing was cleared.
    const second = JSON.parse(await checkWatcherNudgesHandler(agentId, { consume: false }));
    expect(second.has_nudges).toBe(true);
    expect(second.content).toBe(first.content);

    // A real consume after the peeks clears it as expected.
    JSON.parse(await checkWatcherNudgesHandler(agentId, {}));
    const after = JSON.parse(await checkWatcherNudgesHandler(agentId, {}));
    expect(after).toEqual({ has_nudges: false, content: '' });
  });

  it('treats an explicitly-empty note value as no nudges', async () => {
    const job = await insertTestJob({ status: 'running' });
    const agentId = randomUUID();
    const queries = await import('../server/db/queries.js');
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'running', started_at: Date.now() });
    // Simulate the post-consume state — note exists but is empty.
    queries.upsertNote(`watcher/nudges/${agentId}`, '', null);

    const { checkWatcherNudgesHandler } = await import('../server/mcp/tools/checkWatcherNudges.js');
    const parsed = JSON.parse(await checkWatcherNudgesHandler(agentId, {}));
    expect(parsed).toEqual({ has_nudges: false, content: '' });
  });
});
