/**
 * Tests for the watcher's server-side action handlers.
 *
 * Proves:
 * 1. post_commentary persists and emits via socket; severity bumps watcher row.
 * 2. nudge_job applies once then enters cooldown on rapid retries.
 * 3. restart_job is capped at MAX_RESTARTS_PER_AGENT and auto-escalates on cap.
 * 4. escalate_to_user opens a discussion thread.
 *
 * The handlers depend on file-lock and kill plumbing, so we mock the pieces
 * that would touch real OS state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupTestDb, cleanupTestDb, createSocketMock, insertTestJob,
} from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    // Avoid actually killing tmux sessions during tests; let execFile fall through.
    execFileSync: vi.fn(() => ''),
  };
});

const HARM_PID = -1; // never matches any real process

async function makeWatcher(agentStatus: string = 'running') {
  const queries = await import('../server/db/queries.js');
  const job = await insertTestJob({ status: 'running' });
  const agentId = randomUUID();
  queries.insertAgent({ id: agentId, job_id: job.id, status: agentStatus as never, started_at: Date.now(), pid: HARM_PID });
  const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
  return { agentId, jobId: job.id, watcher };
}

describe('watcherTools.execPostCommentary', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('persists commentary and emits the socket event', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const socket = await import('../server/socket/SocketManager.js');
    const queries = await import('../server/db/queries.js');

    const { watcher } = await makeWatcher();
    const r = execPostCommentary(watcher, { severity: 'concern', headline: 'Looking shaky', detail: 'long input' });

    expect(r.ok).toBe(true);
    expect(vi.mocked(socket.emitWatcherCommentaryNew)).toHaveBeenCalledTimes(1);
    expect(queries.listCommentaryForAgent(watcher.agent_id)).toHaveLength(1);
  });

  it('bumps next_severity on the watcher row', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    execPostCommentary(watcher, { severity: 'concern', headline: 'A' });
    const w2 = queries.getWatcherById(watcher.id)!;
    expect(w2.next_severity).toBe('concern');

    // 'info' must not lower it below 'concern' ...
    execPostCommentary(w2, { severity: 'info', headline: 'B' });
    const w3 = queries.getWatcherById(watcher.id)!;
    expect(w3.next_severity).toBe('concern');

    // ... but 'resolved' clears it.
    execPostCommentary(w3, { severity: 'resolved', headline: 'C' });
    const w4 = queries.getWatcherById(watcher.id)!;
    expect(w4.next_severity).toBe('resolved');
  });
});

describe('watcherTools.execNudgeJob', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('applies first nudge and gates rapid second nudge', async () => {
    const { execNudgeJob, NUDGE_COOLDOWN_MS } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const r1 = execNudgeJob(watcher, { message: 'try X instead' });
    expect(r1.ok).toBe(true);
    expect(r1.outcome).toBe('applied');

    const r2 = execNudgeJob(watcher, { message: 'also try Y' });
    expect(r2.ok).toBe(false);
    expect(r2.outcome).toBe('gated');

    // The nudge note should contain only the first message
    const note = queries.getNote(`watcher/nudges/${watcher.agent_id}`);
    expect(note?.value).toContain('try X instead');
    expect(note?.value).not.toContain('also try Y');

    // cooldown is what we expect
    expect(NUDGE_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe('watcherTools.execRestartJob', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('rejects when no reason is supplied', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const { watcher } = await makeWatcher();
    const r = execRestartJob(watcher, { reason: '' });
    expect(r.ok).toBe(false);
  });

  it('restarts the agent and requeues the job', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, jobId } = await makeWatcher();

    const r = execRestartJob(watcher, { reason: 'looping on same edit', diagnosis: 'agent re-reads foo.ts every turn' });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('applied');

    const agent = queries.getAgentById(watcher.agent_id)!;
    expect(agent.status).toBe('cancelled');
    const job = queries.getJobById(jobId)!;
    expect(job.status).toBe('queued');
    expect(job.description).toContain('Watcher restart notes');
    expect(job.description).toContain('looping on same edit');
  });

  it('gates after MAX_RESTARTS_PER_AGENT applied restarts', async () => {
    const { execRestartJob, MAX_RESTARTS_PER_AGENT } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    // Prepopulate applied restart actions to push the counter to the cap
    for (let i = 0; i < MAX_RESTARTS_PER_AGENT; i++) {
      queries.insertAction({
        id: randomUUID(), watcher_id: watcher.id, agent_id: watcher.agent_id,
        type: 'restart', reason: 'prev', outcome: 'applied',
      });
    }

    const r = execRestartJob(watcher, { reason: 'one more time' });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('gated');
    // Auto-escalation should have run too
    const discussions = queries.listDiscussions();
    expect(discussions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('watcherTools.execEscalateToUser', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('opens a discussion thread', async () => {
    const { execEscalateToUser } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const r = execEscalateToUser(watcher, { question: 'should we abandon the auth refactor?', context: 'tests still failing after 3 cycles' });
    expect(r.ok).toBe(true);
    expect(queries.listDiscussions()).toHaveLength(1);
    const msgs = queries.getDiscussionMessages(queries.listDiscussions()[0].id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('auth refactor');
  });
});
