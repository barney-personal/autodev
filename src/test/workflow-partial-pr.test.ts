/**
 * Tests for M1: Partial PR label on draft PRs.
 *
 * Proves:
 * 1. When isDraft=true, `gh label create partial` is attempted before PR creation
 * 2. When isDraft=true, `gh pr create` includes `--label partial`
 * 3. When isDraft=false, no label creation or `--label` flag is used
 * 4. Label creation failure (already exists) does not prevent PR creation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
} from './helpers.js';

// Track all execSync calls for assertion
const execSyncCalls: Array<{ cmd: string; opts?: any }> = [];

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string, opts?: any) => {
    execSyncCalls.push({ cmd, opts });
    // rev-parse for ensureWorktreeBranch
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('workflow/test-branch\n');
    }
    // rev-list for commit count check
    if (cmd.includes('rev-list --count')) {
      return Buffer.from('3\n');
    }
    // git push
    if (cmd.startsWith('git push')) {
      return Buffer.from('');
    }
    // gh label create — default success
    if (cmd.includes('gh label create')) {
      return Buffer.from('');
    }
    // gh pr create
    if (cmd.includes('gh pr create')) {
      return Buffer.from('https://github.com/test/repo/pull/42\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn((m: string) => m),
  getAlternateProviderModel: vi.fn(() => null),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

import type { Workflow } from '../shared/types.js';
import { execSync } from 'child_process';
import { insertTestWorkflow } from './helpers.js';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-partial-test',
    title: 'Partial Test',
    task: 'Test partial PR',
    work_dir: '/tmp/test',
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'codex',
    max_cycles: 5,
    current_cycle: 3,
    current_phase: 'implement',
    status: 'running',
    milestones_total: 4,
    milestones_done: 2,
    project_id: null,
    max_turns_assess: 20,
    max_turns_review: 15,
    max_turns_implement: 50,
    stop_mode_assess: 'turns',
    stop_value_assess: null,
    stop_mode_review: 'turns',
    stop_value_review: null,
    stop_mode_implement: 'turns',
    stop_value_implement: null,
    template_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/wt',
    worktree_branch: 'workflow/test-branch',
    pr_url: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('pushAndCreatePr: partial label', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('creates "partial" label and includes --label flag when isDraft=true', async () => {
    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, true);

    expect(prUrl).toBe('https://github.com/test/repo/pull/42');

    // Find the label creation call
    const labelCreateCall = execSyncCalls.find(c => c.cmd.includes('gh label create partial'));
    expect(labelCreateCall).toBeDefined();
    expect(labelCreateCall!.cmd).toContain('--description "Partial workflow completion"');
    expect(labelCreateCall!.cmd).toContain('--color FBCA04');

    // Find the PR creation call
    const prCreateCall = execSyncCalls.find(c => c.cmd.includes('gh pr create'));
    expect(prCreateCall).toBeDefined();
    expect(prCreateCall!.cmd).toContain('--draft');
    expect(prCreateCall!.cmd).toContain('--label partial');
  });

  it('does not create label or include --label flag when isDraft=false', async () => {
    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);

    expect(prUrl).toBe('https://github.com/test/repo/pull/42');

    // No label creation call
    const labelCreateCall = execSyncCalls.find(c => c.cmd.includes('gh label create'));
    expect(labelCreateCall).toBeUndefined();

    // PR creation without --label or --draft
    const prCreateCall = execSyncCalls.find(c => c.cmd.includes('gh pr create'));
    expect(prCreateCall).toBeDefined();
    expect(prCreateCall!.cmd).not.toContain('--draft');
    expect(prCreateCall!.cmd).not.toContain('--label');
  });

  it('includes conflict warning in PR body when merge conflicts detected (M14/6D)', async () => {
    const mockedExecSync = vi.mocked(execSync);
    let capturedPrBody = '';
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-list --count')) {
        return Buffer.from('3\n');
      }
      if (typeof cmd === 'string' && cmd.startsWith('git push')) {
        return Buffer.from('');
      }
      if (typeof cmd === 'string' && cmd.includes('merge-base')) {
        return Buffer.from('abc123\n');
      }
      if (typeof cmd === 'string' && cmd.includes('merge-tree')) {
        return Buffer.from("changed in both 'src/foo.ts'\n<<<<<<< .our\nours\n=======\ntheirs\n>>>>>>> .their\n");
      }
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        capturedPrBody = cmd;
        return Buffer.from('https://github.com/test/repo/pull/55\n');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);

    expect(prUrl).toBe('https://github.com/test/repo/pull/55');
    // PR body should contain conflict warning
    expect(capturedPrBody).toContain('merge conflicts detected');
    expect(capturedPrBody).toContain('src/foo.ts');
  });

  it('creates PR without conflict warning when no conflicts (M14/6D)', async () => {
    // Ensure default mock is restored (merge-base returns empty → no conflict check)
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-list --count')) {
        return Buffer.from('3\n');
      }
      if (typeof cmd === 'string' && cmd.startsWith('git push')) {
        return Buffer.from('');
      }
      if (typeof cmd === 'string' && cmd.includes('merge-base')) {
        return Buffer.from('\n'); // empty merge-base → skip conflict check
      }
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        return Buffer.from('https://github.com/test/repo/pull/42\n');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);

    expect(prUrl).toBe('https://github.com/test/repo/pull/42');
    const prCreateCall = execSyncCalls.find(c => c.cmd.includes('gh pr create'));
    expect(prCreateCall!.cmd).not.toContain('merge conflicts detected');
  });

  it('proceeds with PR creation even if label creation fails', async () => {
    // Override execSync to throw on label creation
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('gh label create')) {
        throw new Error('label already exists');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (typeof cmd === 'string' && cmd.includes('rev-list --count')) {
        return Buffer.from('3\n');
      }
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        return Buffer.from('https://github.com/test/repo/pull/99\n');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, true);

    expect(prUrl).toBe('https://github.com/test/repo/pull/99');

    // Label creation was attempted
    const labelCreateCall = execSyncCalls.find(c => c.cmd.includes('gh label create'));
    expect(labelCreateCall).toBeDefined();

    // PR creation still happened with --label flag
    const prCreateCall = execSyncCalls.find(c => c.cmd.includes('gh pr create'));
    expect(prCreateCall).toBeDefined();
    expect(prCreateCall!.cmd).toContain('--label partial');
  });
});

describe('finalizeWorkflow: worktree preservation on PR failure', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('does NOT remove worktree when pushAndCreatePr fails but commits exist', async () => {
    vi.useFakeTimers();
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        // ensureWorktreeBranch
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        // commit count check (has commits)
        if (cmd.includes('rev-list --count')) return Buffer.from('5\n');
        // git push succeeds
        if (cmd.startsWith('git push')) return Buffer.from('');
        // gh pr create FAILS (all 3 attempts)
        if (cmd.includes('gh pr create')) throw new Error('gh: Could not create PR');
        // gh pr view fallback also returns nothing
        if (cmd.includes('gh pr view')) throw new Error('no PRs found');
      }
      return Buffer.from('');
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;

    vi.useRealTimers();

    // Worktree removal should NOT have been called
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeUndefined();
  });

  it('removes worktree when pushAndCreatePr succeeds', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
        if (cmd.startsWith('git push')) return Buffer.from('');
        if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/42\n');
      }
      return Buffer.from('');
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    await finalizeWorkflow(wf);

    // Worktree removal SHOULD have been called
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeDefined();
  });

  it('removes worktree when no publishable commits exist', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        // No commits
        if (cmd.includes('rev-list --count')) return Buffer.from('0\n');
      }
      return Buffer.from('');
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    await finalizeWorkflow(wf);

    // Worktree removal SHOULD have been called (no commits to preserve)
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeDefined();
  });
});

describe('finalizeWorkflow: blocked status on PR failure', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('transitions workflow from complete to blocked when PR creation fails with publishable commits', async () => {
    vi.useFakeTimers();
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('5\n');
        if (cmd.startsWith('git push')) return Buffer.from('');
        // gh pr create FAILS all 3 attempts
        if (cmd.includes('gh pr create')) throw new Error('gh: Could not create PR');
        // gh pr view fallback also fails
        if (cmd.includes('gh pr view')) throw new Error('no PRs found');
      }
      return Buffer.from('');
    });

    // Insert workflow into DB in 'complete' status (mimics line 259 in onJobCompleted)
    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({
      id: 'wf-pr-fail-blocked',
      status: 'complete',
      use_worktree: 1,
      milestones_done: 10,
      milestones_total: 10,
    });
    updateWorkflow(dbWf.id, {
      worktree_path: '/tmp/wt',
      worktree_branch: 'workflow/test-branch',
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({
      id: 'wf-pr-fail-blocked',
      status: 'complete',
      milestones_done: 10,
      milestones_total: 10,
    });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;

    vi.useRealTimers();

    // Workflow should now be blocked with a descriptive reason
    const updated = getWorkflowById('wf-pr-fail-blocked');
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('PR creation failed');
    expect(updated!.blocked_reason).toContain('/tmp/wt');

    // Worktree should NOT have been removed (preserved for retry)
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeUndefined();
  });

  it('does NOT set blocked when PR succeeds', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
        if (cmd.startsWith('git push')) return Buffer.from('');
        if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/42\n');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({
      id: 'wf-pr-success',
      status: 'complete',
      use_worktree: 1,
      milestones_done: 5,
      milestones_total: 5,
    });
    updateWorkflow(dbWf.id, {
      worktree_path: '/tmp/wt',
      worktree_branch: 'workflow/test-branch',
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({
      id: 'wf-pr-success',
      status: 'complete',
      milestones_done: 5,
      milestones_total: 5,
    });

    await finalizeWorkflow(wf);

    // Workflow should stay complete (not blocked)
    const updated = getWorkflowById('wf-pr-success');
    expect(updated!.status).toBe('complete');
    expect(updated!.blocked_reason).toBeFalsy();
  });
});

describe('getPrCreationOutcome: git error handling (Fix-C7b)', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('returns failed_with_publishable_commits when execSync throws (preserves worktree)', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-list --count')) {
        throw new Error('fatal: .git/index.lock: File exists');
      }
      return Buffer.from('');
    });

    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ worktree_path: '/tmp/wt', work_dir: '/tmp/test' });

    const outcome = getPrCreationOutcome(wf, null);

    expect(outcome).toBe('failed_with_publishable_commits');
  });

  it('returns no_publishable_commits when rev-list returns 0', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-list --count')) {
        return Buffer.from('0\n');
      }
      return Buffer.from('');
    });

    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ worktree_path: '/tmp/wt', work_dir: '/tmp/test' });

    const outcome = getPrCreationOutcome(wf, null);

    expect(outcome).toBe('no_publishable_commits');
  });

  it('returns created when prUrl is provided', async () => {
    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const outcome = getPrCreationOutcome(wf, 'https://github.com/test/repo/pull/1');

    expect(outcome).toBe('created');
  });
});

describe('pushAndCreatePr: rev-list error handling (Fix-C8a)', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('still attempts push and PR creation when rev-list throws a transient error', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        // rev-list throws a transient git error
        if (cmd.includes('rev-list --count')) throw new Error('fatal: .git/index.lock: File exists');
        if (cmd.startsWith('git push')) return Buffer.from('');
        if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/77\n');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);

    // PR should be created despite rev-list failure (safe default: assume commits exist)
    expect(prUrl).toBe('https://github.com/test/repo/pull/77');

    // Push was attempted
    const pushCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.startsWith('git push'));
    expect(pushCall).toBeDefined();

    // PR creation was attempted
    const prCreateCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('gh pr create'));
    expect(prCreateCall).toBeDefined();
  });

  it('returns null when rev-list throws and worktree_branch is missing', async () => {
    const mockedExecSync = vi.mocked(execSync);
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-list --count')) throw new Error('fatal: timeout');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    // No worktree_branch — even with hasCommits=true, the !worktree_branch guard returns null
    const wf = makeWorkflow({ worktree_branch: null });

    const prUrl = pushAndCreatePr(wf, false);

    expect(prUrl).toBeNull();

    // Push should NOT have been attempted (returned early)
    const pushCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.startsWith('git push'));
    expect(pushCall).toBeUndefined();
  });
});

describe('countBranchCommits: safe fallback chain (Fix-C4b)', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('returns 0 when origin default-branch metadata and origin/HEAD are both missing', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      // rev-parse --verify for origin/HEAD fails (ref doesn't exist)
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/HEAD"',
    ]);
  });

  it('returns 0 when origin/main is missing and origin/HEAD is also unavailable', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      // rev-parse --verify for both candidates fails (refs don't exist)
      if (cmd === 'git rev-parse --verify "origin/main"') {
        throw new Error('fatal: Needed a single revision');
      }
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/main"',
      'git rev-parse --verify "origin/HEAD"',
    ]);
  });

  it('returns the branch-specific commit count when origin default branch is available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify "origin/main"') {
        return Buffer.from('abc1234\n');
      }
      if (cmd === 'git rev-list --count HEAD "^origin/main"') {
        return Buffer.from('2\n');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(2);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/main"',
      'git rev-list --count HEAD "^origin/main"',
    ]);
  });

  it('causes getPrCreationOutcome to treat missing remote metadata as no publishable commits', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ worktree_path: '/tmp/wt', work_dir: '/tmp/test' });

    expect(getPrCreationOutcome(wf, null)).toBe('no_publishable_commits');
  });

  it('re-throws transient rev-parse errors instead of treating them as missing ref (Fix-C20a)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      // rev-parse --verify throws a transient error (timeout, index.lock, permission)
      if (cmd === 'git rev-parse --verify "origin/main"') {
        throw new Error('Command timed out');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(() => countBranchCommits('/tmp/wt')).toThrow('Command timed out');
  });

  it('re-throws rev-list errors when rev-parse succeeds (Fix-C10a)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      // ref exists
      if (cmd === 'git rev-parse --verify "origin/main"') {
        return Buffer.from('abc1234\n');
      }
      // but rev-list fails (e.g. corrupt pack object)
      if (cmd === 'git rev-list --count HEAD "^origin/main"') {
        throw new Error('fatal: bad object abc1234');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(() => countBranchCommits('/tmp/wt')).toThrow('fatal: bad object abc1234');
  });

  it('returns 0 when both candidates throw "not a valid object name" (Fix-C21b)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify "origin/main"') {
        throw new Error('fatal: not a valid object name origin/main');
      }
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw new Error('fatal: not a valid object name origin/HEAD');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/main"',
      'git rev-parse --verify "origin/HEAD"',
    ]);
  });

  it('returns 0 when both candidates throw "unknown revision" (Fix-C21b)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify "origin/main"') {
        throw new Error('fatal: unknown revision or path not in working tree');
      }
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw new Error('fatal: unknown revision or path not in working tree');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/main"',
      'git rev-parse --verify "origin/HEAD"',
    ]);
  });

  it('returns 0 when raw string "not a valid object name" is thrown (Fix-C21a)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify "origin/main"') {
        // Raw string throw (no .message property) — tests the ?? err fallback
        throw 'fatal: not a valid object name origin/main';
      }
      if (cmd === 'git rev-parse --verify "origin/HEAD"') {
        throw 'fatal: not a valid object name origin/HEAD';
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    // Without the ?? err fallback, this would throw because the classifier sees ''
    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify "origin/main"',
      'git rev-parse --verify "origin/HEAD"',
    ]);
  });
});

describe('Fix-C11a: transient rev-parse errors propagate to callers via countBranchCommits', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  function mockTransientRevParseFailure() {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      // symbolic-ref succeeds — remote default branch is known
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      // rev-parse --verify throws a TRANSIENT error (not ref-missing).
      // This propagates immediately out of countCommitsAgainstBaseRef and
      // countBranchCommits — origin/HEAD is never attempted.
      if (cmd === 'git rev-parse --verify "origin/main"') {
        throw new Error('fatal: Unable to create /tmp/wt/.git/index.lock: Permission denied');
      }
      // branch check
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/99\n');
      return Buffer.from('');
    });
  }

  it('pushAndCreatePr still attempts PR when rev-parse throws transient error (safe default: hasCommits=true)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTransientRevParseFailure();

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    // work_dir differs from worktree_path so cwd assertions are meaningful
    const wf = makeWorkflow({ work_dir: '/tmp/other' });

    const prUrl = pushAndCreatePr(wf, false);

    // PR should be created — transient error triggers safe default (hasCommits = true)
    expect(prUrl).toBe('https://github.com/test/repo/pull/99');

    // symbolic-ref was called with worktree_path as cwd, not work_dir (Fix-C13a)
    const symRefCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('symbolic-ref'));
    expect(symRefCall).toBeDefined();
    expect(symRefCall!.opts?.cwd).toBe('/tmp/wt');

    // Push was attempted with worktree_path as cwd (Fix-C13a)
    const pushCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.startsWith('git push'));
    expect(pushCall).toBeDefined();
    expect(pushCall!.opts?.cwd).toBe('/tmp/wt');

    // PR creation was attempted
    const prCreateCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('gh pr create'));
    expect(prCreateCall).toBeDefined();

    // Transient error propagates immediately — origin/HEAD fallback was NOT attempted (Fix-C12a)
    const originHeadCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd === 'git rev-parse --verify "origin/HEAD"');
    expect(originHeadCall).toBeUndefined();

    // Safe-default logging contract verified (Fix-C12b)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rev-list failed'),
      expect.objectContaining({ message: expect.stringContaining('Permission denied') }),
    );
  });

  it('getPrCreationOutcome returns failed_with_publishable_commits when rev-parse throws transient error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTransientRevParseFailure();

    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    // work_dir differs from worktree_path so cwd assertions are meaningful
    const wf = makeWorkflow({ worktree_path: '/tmp/wt', work_dir: '/tmp/other' });

    const outcome = getPrCreationOutcome(wf, null);

    // Transient error propagates through countBranchCommits to getPrCreationOutcome's catch block,
    // which returns 'failed_with_publishable_commits' (preserves worktree)
    expect(outcome).toBe('failed_with_publishable_commits');

    // symbolic-ref was called with worktree_path as cwd, not work_dir (Fix-C13a)
    const symRefCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('symbolic-ref'));
    expect(symRefCall).toBeDefined();
    expect(symRefCall!.opts?.cwd).toBe('/tmp/wt');

    // Transient error propagates immediately — origin/HEAD fallback was NOT attempted (Fix-C12a)
    const originHeadCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd === 'git rev-parse --verify "origin/HEAD"');
    expect(originHeadCall).toBeUndefined();

    // Safe-default logging contract verified (Fix-C12b)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('getPrCreationOutcome'),
      expect.stringContaining('Permission denied'),
    );
  });
});

describe('finalizeWorkflow: retry and fallback behavior', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('(a) succeeds on the second retry attempt when the first fails', async () => {
    vi.useFakeTimers();
    let ghPrCreateCount = 0;
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
      if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('git status --porcelain')) return Buffer.from('');
      if (cmd.includes('git worktree remove')) return Buffer.from('');
      if (cmd.includes('gh pr view')) throw new Error('no PR');
      if (cmd.includes('gh pr create')) {
        ghPrCreateCount++;
        if (ghPrCreateCount === 1) {
          throw Object.assign(new Error('transient network error'), { stderr: Buffer.from('transient') });
        }
        return Buffer.from('https://github.com/test/repo/pull/55\n');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-retry-a', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, { worktree_path: '/tmp/wt', worktree_branch: 'workflow/test-branch' });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-retry-a', status: 'complete' });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    // PR creation was attempted twice
    expect(ghPrCreateCount).toBe(2);

    const updated = getWorkflowById('wf-retry-a');
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/55');
    expect(updated!.status).not.toBe('blocked');

    // Worktree was cleaned up after successful PR
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeDefined();
  });

  it('(b) uses gh pr view fallback when all 3 PR creation attempts fail', async () => {
    vi.useFakeTimers();
    let ghPrViewCount = 0;
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
      if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('git status --porcelain')) return Buffer.from('');
      if (cmd.includes('git worktree remove')) return Buffer.from('');
      if (cmd.includes('gh pr create')) {
        throw Object.assign(new Error('transient error'), { stderr: Buffer.from('transient') });
      }
      if (cmd.includes('gh pr view')) {
        ghPrViewCount++;
        // First 3 calls come from pushAndCreatePr's pre-create check — return empty
        if (ghPrViewCount <= 3) throw new Error('no PR');
        // 4th call is the finalizeWorkflow fallback — return the URL
        return Buffer.from('https://github.com/test/repo/pull/77\n');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-fallback-b', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, { worktree_path: '/tmp/wt', worktree_branch: 'workflow/test-branch' });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-fallback-b', status: 'complete' });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    const updated = getWorkflowById('wf-fallback-b');
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/77');
    // gh pr view fallback found a PR → outcome is 'created' → worktree removed
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeDefined();
  });

  it('(c) releases workflow claims synchronously before any retry delay', async () => {
    vi.useFakeTimers();
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
      if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('gh pr create')) {
        throw Object.assign(new Error('fail'), { stderr: Buffer.from('fail') });
      }
      if (cmd.includes('gh pr view')) throw new Error('no PR');
      return Buffer.from('');
    });

    const { claimFiles, getActiveClaimsForWorkflow, updateWorkflow } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-claims-c', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, { worktree_path: '/tmp/wt', worktree_branch: 'workflow/test-branch' });
    claimFiles('wf-claims-c', ['/tmp/project/src/main.ts']);

    // Verify the claim exists before we start
    expect(getActiveClaimsForWorkflow('wf-claims-c').length).toBe(1);

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-claims-c', status: 'complete' });

    // Start finalizeWorkflow without advancing timers — first attempt will fail and queue a 30s sleep
    const promise = finalizeWorkflow(wf);

    // Claims must be released synchronously BEFORE any timer fires
    expect(getActiveClaimsForWorkflow('wf-claims-c').length).toBe(0);

    // Now drain timers and let it complete
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
  });
});

describe('reconcileBlockedPRs: startup recovery', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('(d) recovers a blocked workflow when PR creation succeeds on retry', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
      if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-list --count')) return Buffer.from('2\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('git status --porcelain')) return Buffer.from('');
      if (cmd.includes('git worktree remove')) return Buffer.from('');
      if (cmd.includes('gh pr view')) return Buffer.from('');
      if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/88\n');
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-reconcile-d', status: 'blocked', use_worktree: 1 });
    updateWorkflow(dbWf.id, {
      worktree_path: '/tmp/wt',
      worktree_branch: 'workflow/test-branch',
      blocked_reason: 'PR creation failed — worktree preserved for retry at /tmp/wt',
    });

    const { reconcileBlockedPRs } = await import('../server/orchestrator/WorkflowManager.js');
    await reconcileBlockedPRs();

    const updated = getWorkflowById('wf-reconcile-d');
    expect(updated!.status).toBe('complete');
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/88');
    expect(updated!.blocked_reason).toBeNull();

    // Worktree was removed after recovery
    const removeCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('git worktree remove'));
    expect(removeCall).toBeDefined();
  });

  it('(e) skips malformed workflows (null worktree_path) without aborting reconciliation', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
      if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
      if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
      if (cmd.includes('rev-list --count')) return Buffer.from('2\n');
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('git status --porcelain')) return Buffer.from('');
      if (cmd.includes('git worktree remove')) return Buffer.from('');
      if (cmd.includes('gh pr view')) return Buffer.from('');
      if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/90\n');
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');

    // Malformed: worktree_path is null — reconcile should skip this with a warning
    await insertTestWorkflow({ id: 'wf-malformed-e', status: 'blocked', use_worktree: 1 });
    updateWorkflow('wf-malformed-e', {
      blocked_reason: 'PR creation failed — worktree preserved for retry at /tmp/wt',
      // worktree_path intentionally left null
    });

    // Valid: all required fields present
    const dbValid = await insertTestWorkflow({ id: 'wf-valid-e', status: 'blocked', use_worktree: 1 });
    updateWorkflow(dbValid.id, {
      worktree_path: '/tmp/wt',
      worktree_branch: 'workflow/test-branch',
      blocked_reason: 'PR creation failed — worktree preserved for retry at /tmp/wt',
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reconcileBlockedPRs } = await import('../server/orchestrator/WorkflowManager.js');

    // Should not throw despite the malformed row
    await reconcileBlockedPRs();

    // Malformed workflow stays blocked (was skipped)
    const malformed = getWorkflowById('wf-malformed-e');
    expect(malformed!.status).toBe('blocked');

    // Valid workflow is recovered
    const valid = getWorkflowById('wf-valid-e');
    expect(valid!.status).toBe('complete');
    expect(valid!.pr_url).toBe('https://github.com/test/repo/pull/90');

    // A warning was logged for the skipped malformed workflow (single-string form)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('wf-malformed-e'));
  });
});
