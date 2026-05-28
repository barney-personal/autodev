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

// Track calls to execFileSync for assertion. The worktree manager uses
// argument-array execFileSync('git', [...]) so branch names with shell-sensitive
// characters cannot reach a shell.
const execFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFileSync: (...args: any[]) => execFileSyncMock(...args),
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
  KNOWN_MODELS: [
    'claude-opus-4-7',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6[1m]',
    'claude-haiku-4-5-20251001',
    'codex',
  ],
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

// Helper: argument-array matcher. The first execFileSync arg is always 'git';
// the second is an args array. This converts an args array to a "joined cmd"
// string so existing assertions like .includes('worktree add') still work.
function calledArgs(): string[] {
  return execFileSyncMock.mock.calls.map(c => {
    const args = (c[1] as string[]) ?? [];
    return `git ${args.join(' ')}`;
  });
}

describe('verifyWorktreeHealth', () => {
  let verifyWorktreeHealth: typeof import('../server/orchestrator/WorkflowManager.js').verifyWorktreeHealth;

  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    logResilienceEventMock.mockReset();
    const mod = await import('../server/orchestrator/WorkflowManager.js');
    verifyWorktreeHealth = mod.verifyWorktreeHealth;
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('passes when all checks succeed and branch matches', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return Buffer.from('true\n');
      if (cmd === 'rev-parse HEAD') return Buffer.from('abc123\n');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('my-branch\n');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).not.toHaveBeenCalled();
  });

  it('recreates worktree when directory is missing', () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p === '/tmp/wt') return false;
      return true;
    });
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch', '/repo');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'directory_missing', action: 'recreate' }),
    );
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ action: 'recreate', outcome: 'success' }),
    );
    // The branch name flows through as a literal argument, not a shell string.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add', '/tmp/wt', 'my-branch']),
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
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch', '/repo');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'git_missing', action: 'recreate' }),
    );
  });

  it('force-checkouts when git rev-parse --is-inside-work-tree fails', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) throw new Error('not a git repo');
      if (cmd.includes('checkout -f')) return Buffer.from('');
      if (cmd === 'rev-parse HEAD') return Buffer.from('abc123\n');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('my-branch\n');
      return Buffer.from('');
    });

    const result = verifyWorktreeHealth('/tmp/wt', 'my-branch');
    expect(result).toEqual({ ok: true });
    expect(logResilienceEventMock).toHaveBeenCalledWith(
      'worktree_repair', 'worktree', '/tmp/wt',
      expect.objectContaining({ check: 'not_inside_work_tree', action: 'force_checkout' }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['checkout', '-f', 'my-branch'],
      expect.objectContaining({ cwd: '/tmp/wt' }),
    );
  });

  it('force-checkouts when HEAD is invalid', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return Buffer.from('true\n');
      if (cmd === 'rev-parse HEAD') throw new Error('bad HEAD');
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
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
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
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
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

  it('passes branch names with shell-sensitive characters as argv (not shell)', () => {
    existsSyncMock.mockImplementation((p: string) => p !== '/tmp/wt');
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    const hostileBranch = "workflow/foo'; rm -rf /; echo ";
    const result = verifyWorktreeHealth('/tmp/wt', hostileBranch, '/repo');
    expect(result).toEqual({ ok: true });
    // Argument array must carry the hostile branch verbatim — no quoting/escaping.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '/tmp/wt', hostileBranch],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});

describe('removeWorktree (idempotent cleanup)', () => {
  let removeWorktree: typeof import('../server/orchestrator/WorkflowWorktreeManager.js').removeWorktree;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const baseWorkflow = {
    id: 'wf-test',
    worktree_path: '/tmp/wt',
    work_dir: '/repo',
    worktree_branch: 'workflow/test',
  } as unknown as import('../shared/types.js').Workflow;

  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../server/orchestrator/WorkflowWorktreeManager.js');
    removeWorktree = mod.removeWorktree;
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    await cleanupTestDb();
  });

  it('skips the remove call when the worktree directory is already gone and just prunes', () => {
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'status --porcelain') {
        const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return Buffer.from('');
    });

    removeWorktree(baseWorkflow);

    const commands = calledArgs();
    expect(commands.some(c => c.includes('worktree remove'))).toBe(false);
    expect(commands.some(c => c === 'git worktree prune')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('worktree already removed'));
  });

  it('treats "is not a working tree" as success without warning (HURLICANE-SF race)', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'status --porcelain') return Buffer.from('');
      if (cmd.includes('worktree remove')) {
        throw new Error("fatal: '/tmp/wt' is not a working tree");
      }
      return Buffer.from('');
    });

    removeWorktree(baseWorkflow);

    const commands = calledArgs();
    expect(commands.filter(c => c === 'git worktree prune').length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('worktree already removed'));
  });

  it('still warns on unrelated removal failures', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'status --porcelain') return Buffer.from('');
      if (cmd.includes('worktree remove')) {
        throw new Error('fatal: file lock held by another process');
      }
      return Buffer.from('');
    });

    removeWorktree(baseWorkflow);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('worktree removal failed'),
      expect.stringContaining('file lock'),
    );
  });

  it('logs success on the happy path', () => {
    existsSyncMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'status --porcelain') return Buffer.from('');
      return Buffer.from('');
    });

    removeWorktree(baseWorkflow);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/worktree removed$/));
  });
});
