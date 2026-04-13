/**
 * Regression test: standalone job worktrees must use the namespaced path
 * `.orchestrator-worktrees/<repoName>/<shortId>`, not the old flat `<shortId>`.
 *
 * Asserts:
 *   1. `git worktree add` target is `.orchestrator-worktrees/<repoName>/<shortId>`
 *   2. `mkdirSync` is called with the parent namespace dir before `git worktree add`
 *   3. The persisted job `work_dir` in the DB is the namespaced worktree path
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { setupTestDb, cleanupTestDb, createSocketMock, resetManagerState } from './helpers.js';

// ── Fake repo root returned by `git rev-parse --show-toplevel` ────────────────
const FAKE_REPO_DIR = '/fake/myrepo';
const REPO_NAME = path.basename(FAKE_REPO_DIR); // 'myrepo'

// ── Capture execSync calls so we can inspect arguments ───────────────────────
const execFileSyncMock = vi.fn((cmd: string, args?: string[]) => {
  if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--show-toplevel') {
    return Buffer.from(`${FAKE_REPO_DIR}\n`);
  }
  // All other git commands succeed silently (worktree add, tag, rev-parse --git-dir)
  return Buffer.from('');
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});

// ── Mock fs so mkdirSync and existsSync don't touch the real filesystem ───────
const mkdirSyncMock = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mkdirSyncMock,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  cancelledAgents: new Set(),
  _resetCompletedJobsForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(),
  getPtyBuffer: vi.fn(() => ''),
  getSnapshot: vi.fn(() => ''),
  attachPty: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
}));
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'circuit closed',
    recordModelLimited: () => {},
    recordModelAvailable: () => {},
    recordInfraFailure: () => {},
    recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

describe('WorkQueueManager — namespaced standalone worktree paths', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
    // Re-apply the mock implementation after clearAllMocks resets it
    execFileSyncMock.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--show-toplevel') {
        return Buffer.from(`${FAKE_REPO_DIR}\n`);
      }
      return Buffer.from('');
    });
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('creates worktree at .orchestrator-worktrees/<repoName>/<shortId>', async () => {
    const queries = await import('../server/db/queries.js');
    const { _tickForTest } = await import('../server/orchestrator/WorkQueueManager.js');

    // Insert a standalone job with use_worktree=1
    const jobId = 'wt-test-1';
    queries.insertJob({
      id: jobId,
      title: 'Worktree Job',
      description: 'test',
      context: null,
      priority: 0,
      model: 'claude-sonnet-4-6',
      work_dir: FAKE_REPO_DIR,
      use_worktree: 1,
    });

    await _tickForTest();

    // 1. Find the `git worktree add` call
    const worktreeAddCall = execFileSyncMock.mock.calls.find(([cmd, args]) =>
      cmd === 'git' && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'add',
    );
    expect(worktreeAddCall, 'git worktree add should have been called').toBeTruthy();
    const worktreeArgs = worktreeAddCall![1] as string[];
    const worktreePath = worktreeArgs[2];

    // 2. Path must contain <repoName>/<shortId>, not flat <shortId>
    expect(worktreePath).toContain(`.orchestrator-worktrees/${REPO_NAME}/`);
    const pathParts = worktreePath.split(path.sep);
    const orchIdx = pathParts.indexOf('.orchestrator-worktrees');
    expect(orchIdx).toBeGreaterThan(-1);
    expect(pathParts[orchIdx + 1]).toBe(REPO_NAME);   // namespace dir
    const shortId = pathParts[orchIdx + 2];
    expect(shortId).toMatch(/^[0-9a-f]{8}$/);          // 8-char hex UUID prefix

    // 3. mkdirSync must have been called with the namespace parent dir
    const namespaceDirPath = path.resolve(
      FAKE_REPO_DIR, '..', '.orchestrator-worktrees', REPO_NAME,
    );
    const mkdirCalled = mkdirSyncMock.mock.calls.some(
      ([dirArg]) => dirArg === namespaceDirPath,
    );
    expect(mkdirCalled, `mkdirSync should be called with namespace dir ${namespaceDirPath}`).toBe(true);

    // 4. The job's work_dir in the DB must be updated to the namespaced path
    const updatedJob = queries.getJobById(jobId);
    expect(updatedJob!.work_dir).toBe(worktreePath);
  });

  it('fails assertion against old flat path (regression guard)', async () => {
    const queries = await import('../server/db/queries.js');
    const { _tickForTest } = await import('../server/orchestrator/WorkQueueManager.js');

    const jobId = 'wt-test-2';
    queries.insertJob({
      id: jobId,
      title: 'Worktree Regression Job',
      description: 'test',
      context: null,
      priority: 0,
      model: 'claude-sonnet-4-6',
      work_dir: FAKE_REPO_DIR,
      use_worktree: 1,
    });

    await _tickForTest();

    const worktreeAddCall = execFileSyncMock.mock.calls.find(([cmd, args]) =>
      cmd === 'git' && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'add',
    );
    const worktreeArgs = worktreeAddCall![1] as string[];
    const worktreePath = worktreeArgs[2];

    // The old flat path would be `.orchestrator-worktrees/<shortId>` with no repoName segment
    // This assertion verifies we are NOT on the old path.
    const pathParts = worktreePath.split(path.sep);
    const orchIdx = pathParts.indexOf('.orchestrator-worktrees');
    // Old path: pathParts[orchIdx + 1] was the shortId (8 hex chars), no repoName
    // New path: pathParts[orchIdx + 1] is repoName, pathParts[orchIdx + 2] is shortId
    const segmentAfterOrch = pathParts[orchIdx + 1];
    expect(segmentAfterOrch).not.toMatch(/^[0-9a-f]{8}$/); // must NOT be a bare shortId
    expect(segmentAfterOrch).toBe(REPO_NAME);
  });
});
