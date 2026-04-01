/**
 * Tests for PrCreator — auto-PR creation on job completion.
 *
 * These test the DB/query integration (pr_url column, updateJobPrUrl).
 * The actual git/gh operations are tested via manual verification since
 * they require a real git repo and GitHub auth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => ({
  emitJobNew: vi.fn(),
  emitJobUpdate: vi.fn(),
  emitAgentNew: vi.fn(),
  emitAgentUpdate: vi.fn(),
  emitAgentOutput: vi.fn(),
  emitLockChange: vi.fn(),
  emitWorkflowUpdate: vi.fn(),
  emitSnapshot: vi.fn(),
  emitWarningNew: vi.fn(),
  emitDebateNew: vi.fn(),
  emitDebateUpdate: vi.fn(),
  emitProposalUpdate: vi.fn(),
  emitDiscussionUpdate: vi.fn(),
  emitQuestionNew: vi.fn(),
  emitQuestionAnswered: vi.fn(),
  emitPtyData: vi.fn(),
  emitPtyClosed: vi.fn(),
}));

describe('PR Creator - DB integration', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('jobs table has pr_url column after migration', async () => {
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(jobs)").all().map((r: any) => r.name);
    expect(cols).toContain('pr_url');
  });

  it('pr_url defaults to null on new jobs', async () => {
    const queries = await import('../server/db/queries.js');
    const job = queries.insertJob({
      id: 'pr-test-1',
      title: 'Test PR Job',
      description: 'test',
      context: null,
      priority: 0,
      use_worktree: 1,
    });
    expect(job.pr_url).toBeNull();
  });

  it('updateJobPrUrl sets the pr_url on a job', async () => {
    const queries = await import('../server/db/queries.js');
    queries.insertJob({
      id: 'pr-test-2',
      title: 'Test PR Job',
      description: 'test',
      context: null,
      priority: 0,
      use_worktree: 1,
    });

    queries.updateJobPrUrl('pr-test-2', 'https://github.com/test/repo/pull/42');

    const updated = queries.getJobById('pr-test-2');
    expect(updated).toBeDefined();
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/42');
  });

  it('updateJobPrUrl updates updated_at timestamp', async () => {
    const queries = await import('../server/db/queries.js');
    const job = queries.insertJob({
      id: 'pr-test-3',
      title: 'Test PR Job',
      description: 'test',
      context: null,
      priority: 0,
    });
    const originalUpdatedAt = job.updated_at;

    // Small delay to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10));
    queries.updateJobPrUrl('pr-test-3', 'https://github.com/test/repo/pull/99');

    const updated = queries.getJobById('pr-test-3');
    expect(updated!.updated_at).toBeGreaterThan(originalUpdatedAt);
  });
});

describe('Worktree cleanup race prevention', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('done worktree job without pr_url has pr_url as null', async () => {
    const queries = await import('../server/db/queries.js');
    const job = queries.insertJob({
      id: 'wt-race-1',
      title: 'Worktree Race Test',
      description: 'test',
      context: null,
      priority: 0,
      use_worktree: 1,
    });
    queries.updateJobStatus('wt-race-1', 'done');

    const updated = queries.getJobById('wt-race-1');
    expect(updated!.status).toBe('done');
    expect(updated!.use_worktree).toBe(1);
    expect(updated!.pr_url).toBeNull();
  });

  it('done worktree job with pr_url can be cleaned up', async () => {
    const queries = await import('../server/db/queries.js');
    queries.insertJob({
      id: 'wt-race-2',
      title: 'Worktree Race Test',
      description: 'test',
      context: null,
      priority: 0,
      use_worktree: 1,
    });
    queries.updateJobStatus('wt-race-2', 'done');
    queries.updateJobPrUrl('wt-race-2', 'https://github.com/test/repo/pull/1');

    const updated = queries.getJobById('wt-race-2');
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/1');
    // pr_url is set, so worktree cleanup should proceed (not blocked)
  });
});
