/**
 * Regression tests for the standalone-job PR path (PrCreator) when the
 * worktree's parent repo has no usable `origin` remote.
 *
 * Sentry HURLICANE issues 7501509813 / 7501509904 / 7501510031 / 7501511003:
 * jobs running in /tmp/.orchestrator-worktrees/<repo>/ pushed to a missing
 * origin, so git failed with "fatal: 'origin' does not appear to be a git
 * repository". PrCreator treated that permanent environment condition as
 * transient — warn, sleep 5s, identical doomed retry, then console.error AND
 * captureWithContext — turning one condition into three Sentry issues per job.
 * WorkflowPRCreator was hardened for this; the standalone path never was.
 *
 * The reporting for genuinely transient push failures must be unchanged, so
 * those assertions live here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import type { Job } from '../shared/types.js';

const NO_REMOTE_STDERR =
  "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/db/queries.js', () => ({
  listActiveWorktrees: vi.fn(() => [
    { job_id: 'job-1', path: '/tmp/.orchestrator-worktrees/autodev-bench/abc', branch: 'orchestrator/test-branch' },
  ]),
  getAgentsWithJobByJobId: vi.fn(() => []),
  getLatestAgentOutput: vi.fn(() => null),
}));

const job = { id: 'job-1', title: 'Test job' } as Job;

/**
 * Build an execFileSync mock that records argv and lets a test decide what each
 * git subcommand does. Anything unhandled returns empty stdout (the success
 * shape for the branch/status/rev-list probes).
 */
function mockGit(handlers: {
  remoteGetUrl?: () => Buffer;
  push?: (attempt: number) => Buffer;
}) {
  const calls: string[][] = [];
  let pushAttempts = 0;
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[] = []) => {
    calls.push([file, ...args]);
    if (file === 'git' && args[0] === 'remote') {
      if (handlers.remoteGetUrl) return handlers.remoteGetUrl();
      return Buffer.from('git@github.com:test/repo.git');
    }
    if (file === 'git' && args[0] === 'rev-parse') return Buffer.from('orchestrator/test-branch\n');
    if (file === 'git' && args[0] === 'rev-list') return Buffer.from('3');
    if (file === 'git' && args[0] === 'push') {
      pushAttempts += 1;
      if (handlers.push) return handlers.push(pushAttempts);
      return Buffer.from('');
    }
    return Buffer.from('');
  }) as any);
  return {
    calls,
    pushCalls: () => calls.filter(c => c[0] === 'git' && c[1] === 'push'),
  };
}

function execError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: git push -u origin orchestrator/test-branch`), {
    stderr: Buffer.from(stderr),
  });
}

describe('PrCreator: missing origin remote on the standalone-job path', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('createPrForJob skips the push entirely when origin is not configured', async () => {
    const git = mockGit({
      remoteGetUrl: () => { throw execError('error: No such remote \'origin\''); },
    });
    const { createPrForJob } = await import('../server/orchestrator/PrCreator.js');
    const { captureWithContext } = await import('../server/instrument.js');

    const result = await createPrForJob(job);

    expect(result).toBeNull();
    // No push at all — not even the first doomed attempt.
    expect(git.pushCalls()).toHaveLength(0);
    // Reported once, at info level, naming where the work is preserved.
    const skipLog = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('PR creation skipped:'));
    expect(skipLog).toContain('origin remote');
    expect(skipLog).toContain('/tmp/.orchestrator-worktrees/autodev-bench/abc');
    // No warn/error/exception trio for an environment condition.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureWithContext).not.toHaveBeenCalled();
  });

  it('createPrForJob does not retry a push that failed with a missing remote', async () => {
    // Pre-check passes (a remote URL is configured) but the push still hits the
    // permanent error — e.g. the URL points at a repo that is gone.
    const git = mockGit({
      push: () => { throw execError(NO_REMOTE_STDERR); },
    });
    const { createPrForJob } = await import('../server/orchestrator/PrCreator.js');
    const { captureWithContext } = await import('../server/instrument.js');

    const result = await createPrForJob(job);

    expect(result).toBeNull();
    expect(git.pushCalls()).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureWithContext).not.toHaveBeenCalled();
  });

  it('createPrForJob still retries and still reports a genuinely transient push failure', async () => {
    vi.useFakeTimers();
    const git = mockGit({
      push: () => { throw execError('error: failed to push some refs (network timeout)'); },
    });
    const { createPrForJob } = await import('../server/orchestrator/PrCreator.js');
    const { captureWithContext } = await import('../server/instrument.js');

    const pending = createPrForJob(job);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result).toBeNull();
    // Transient failures keep the bounded retry...
    expect(git.pushCalls()).toHaveLength(2);
    // ...and stay loud: warn on attempt 1, error + Sentry exception on attempt 2.
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(captureWithContext).toHaveBeenCalledTimes(1);
  });

  it('pushBranchForFailedJob commits the work locally, then skips the push when origin is missing', async () => {
    const git = mockGit({
      remoteGetUrl: () => { throw execError('error: No such remote \'origin\''); },
    });
    // Uncommitted changes present so the local-commit path runs.
    const base = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[] = []) => {
      if (file === 'git' && args[0] === 'status') {
        git.calls.push([file, ...args]);
        return Buffer.from(' M src/foo.ts');
      }
      return base(file as any, args as any);
    }) as any);

    const { pushBranchForFailedJob } = await import('../server/orchestrator/PrCreator.js');

    expect(pushBranchForFailedJob(job)).toBe(false);

    // The work is still committed locally — that is the whole point of this path.
    expect(git.calls.some(c => c[1] === 'commit')).toBe(true);
    expect(git.pushCalls()).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    const skipLog = logSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('branch push skipped'));
    expect(skipLog).toContain('origin remote');
    expect(skipLog).toContain('work committed locally');
  });
});
