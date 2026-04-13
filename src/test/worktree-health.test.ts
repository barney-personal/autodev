/**
 * Tests for verifyWorktreeHealth — deep worktree health checks with auto-repair.
 *
 * Covers:
 * 1. Healthy worktree passes all checks
 * 2. Missing directory triggers recreation
 * 3. Missing .git triggers recreation
 * 4. git rev-parse --is-inside-work-tree failure triggers force checkout
 * 5. Invalid HEAD triggers force checkout
 * 6. Branch drift delegates to ensureWorktreeBranch
 * 7. Missing directory with no mainRepoDir returns error (no recreation possible)
 * 8. Recreation failure returns error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Track calls to execSync for assertion
const execSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: (...args: any[]) => execSyncMock(...args),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => existsSyncMock(...args),
    mkdirSync: vi.fn(),
  };
});

// Mock SocketManager
vi.mock('../server/socket/SocketManager.js', () => ({
  initSocketManager: vi.fn(),
  getIo: vi.fn(() => ({ emit: vi.fn() })),
  emitSnapshot: vi.fn(),
  emitAgentNew: vi.fn(),
  emitAgentUpdate: vi.fn(),
  emitAgentOutput: vi.fn(),
  emitQuestionNew: vi.fn(),
  emitQuestionAnswered: vi.fn(),
  emitLockAcquired: vi.fn(),
  emitLockReleased: vi.fn(),
  emitDeadlockResolved: vi.fn(),
  emitProjectNew: vi.fn(),
  emitJobNew: vi.fn(),
  emitJobUpdate: vi.fn(),
  emitPtyData: vi.fn(),
  emitPtyClosed: vi.fn(),
  emitDebateNew: vi.fn(),
  emitDebateUpdate: vi.fn(),
  emitWorkflowNew: vi.fn(),
  emitWorkflowUpdate: vi.fn(),
  emitWarningNew: vi.fn(),
  emitDiscussionNew: vi.fn(),
  emitDiscussionMessage: vi.fn(),
  emitDiscussionUpdate: vi.fn(),
  emitProposalNew: vi.fn(),
  emitProposalUpdate: vi.fn(),
  emitProposalMessage: vi.fn(),
  emitPrNew: vi.fn(),
  emitPrReviewNew: vi.fn(),
  emitPrReviewUpdate: vi.fn(),
  emitPrReviewMessage: vi.fn(),
}));

// Mock WorkflowPrompts
vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

// Mock ModelClassifier
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
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn(() => null),
  getAlternateProviderModel: vi.fn(() => null),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

// Mock ResilienceLogger to capture events
const logResilienceEventMock = vi.fn();
vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: (...args: any[]) => logResilienceEventMock(...args),
}));

import { setupTestDb, cleanupTestDb, resetManagerState } from './helpers.js';

describe('verifyWorktreeHealth', () => {
  let verifyWorktreeHealth: typeof import('../server/orchestrator/WorkflowManager.js').verifyWorktreeHealth;

  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    execSyncMock.mockReset();
    existsSyncMock.mockReset();
    logResilienceEventMock.mockReset();
    const mod = await import('../server/orchestrator/WorkflowManager.js');
    verifyWorktreeHealth = mod.verifyWorktreeHealth;
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('passes when all checks succeed and branch matches', () => {
    // existsSync returns true for directory and .git
    existsSyncMock.mockReturnValue(true);
    // execSync succeeds for all git commands
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) return Buffer.from('true\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('my-branch\n');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: true });
    // No resilience events should be logged for a healthy worktree
    expect(logResilienceEventMock).not.toHaveBeenCalled();
  });

  it('recreates worktree when directory is missing', () => {
    // First call for directory check returns false; subsequent calls for .git after recreation succeed
    existsSyncMock.mockImplementation((p: string) => {
      if (p === '/tmp/wt') return false;
      return true;
    });
    // execSync succeeds for worktree add
    execSyncMock.mockReturnValue(Buffer.from(''));

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch', '/repo');
    expect(result).toEqual({ ok: true });
    // Should log recreation events
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'directory_missing', action: 'recreate' }),
    );
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ action: 'recreate', outcome: 'success' }),
    );
    // Verify worktree add was called
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('returns error when directory missing and no mainRepoDir', () => {
    existsSyncMock.mockReturnValue(false);

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: false, error: 'Worktree directory does not exist: /tmp/wt' });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'directory_missing', action: 'no_repair_possible' }),
    );
  });

  it('recreates worktree when .git is missing', () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p === '/tmp/wt') return true;
      if (p === '/tmp/wt/.git') return false;
      return true;
    });
    execSyncMock.mockReturnValue(Buffer.from(''));

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch', '/repo');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'git_missing', action: 'recreate' }),
    );
  });

  it('force-checkouts when git rev-parse --is-inside-work-tree fails', () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) throw new Error('not a git repo');
      // After force checkout, HEAD check and branch check succeed
      if (cmd.includes('checkout -f')) return Buffer.from('');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('my-branch\n');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'not_inside_work_tree', action: 'force_checkout' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('checkout -f'),
      expect.objectContaining({ cwd: '/tmp/wt' }),
    );
  });

  it('force-checkouts when HEAD is invalid', () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) return Buffer.from('true\n');
      if (cmd === 'git rev-parse HEAD' || (cmd.includes('rev-parse HEAD') && !cmd.includes('--abbrev-ref') && !cmd.includes('--is-inside'))) {
        throw new Error('bad HEAD');
      }
      if (cmd.includes('checkout -f')) return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('my-branch\n');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'invalid_head', action: 'force_checkout' }),
    );
  });

  it('returns error when recreation fails', () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('worktree add')) throw new Error('branch already exists');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch', '/repo');
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Worktree recreation failed');
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ action: 'recreate', outcome: 'failed' }),
    );
  });

  it('returns error when force checkout fails for broken git internals', () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) throw new Error('not a git repo');
      if (cmd.includes('checkout -f')) throw new Error('checkout failed');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('force checkout failed');
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'not_inside_work_tree', action: 'force_checkout', outcome: 'failed' }),
    );
  });
});
