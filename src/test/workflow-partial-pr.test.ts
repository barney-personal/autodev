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
  resetManagerState,
  insertTestProject,
  insertTestJob,
} from './helpers.js';

// Track all execSync calls for assertion
const execSyncCalls: Array<{ cmd: string; opts?: any }> = [];
// Track raw execFileSync calls (file + discrete args) for argv-safety assertions
const execFileSyncCalls: Array<{ file: string; args: string[]; opts?: any }> = [];

vi.mock('child_process', () => {
  const mod = {
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
    // execFileSync records raw argv calls, then delegates to execSync for existing test overrides
    execFileSync: vi.fn((file: string, args?: string[], opts?: any) => {
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      const quotedArgs = (args ?? []).map(a =>
        /[\s"'`$()\\]/.test(a) ? JSON.stringify(a) : a
      );
      const cmd = [file, ...quotedArgs].join(' ');
      return mod.execSync(cmd, opts);
    }),
  };
  return mod;
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
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

// Mock Sentry instrument so we can assert captureException call counts
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

import type { Workflow } from '../shared/types.js';
import { execSync, execFileSync } from 'child_process';
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
    execFileSyncCalls.length = 0;
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

  // M3 regression: legacy pushAndCreatePr must verify the worktree is on the
  // workflow branch BEFORE counting commits. If the worktree drifted to a
  // clean different branch, counting on that wrong-branch HEAD yields 0 and
  // would incorrectly skip PR creation even though the workflow branch has
  // recoverable commits ahead of origin. This test fails on commit dd5e374
  // (branch verification ran AFTER countBranchCommits via pushBranch).
  it('verifies workflow branch before counting commits when worktree drifted (M3)', async () => {
    let onCorrectBranch = false;
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');

      // ensureWorktreeBranch: HEAD on a wrong (clean) branch initially.
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from(onCorrectBranch ? 'workflow/test-branch\n' : 'feature/drifted\n');
      }
      // ensureWorktreeBranch performs the checkout: now we're on the correct branch.
      if (cmd.includes('git checkout')) {
        onCorrectBranch = true;
        return Buffer.from('');
      }
      // countBranchCommits: zero commits on the drifted branch, three on the workflow branch.
      // Pre-fix code runs this BEFORE checkout → returns 0 → pushAndCreatePr returns null.
      // Post-fix code runs ensureWorktreeBranch first → returns 3 → PR is created.
      if (cmd.includes('rev-list --count')) {
        return Buffer.from(onCorrectBranch ? '3\n' : '0\n');
      }
      if (cmd.startsWith('git push')) return Buffer.from('');
      if (cmd.includes('gh pr create')) return Buffer.from('https://github.com/test/repo/pull/77\n');
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);

    expect(prUrl).toBe('https://github.com/test/repo/pull/77');

    const checkoutIdx = execSyncCalls.findIndex(
      c => typeof c.cmd === 'string' && c.cmd.includes('git checkout')
    );
    const revListIdx = execSyncCalls.findIndex(
      c => typeof c.cmd === 'string' && c.cmd.includes('rev-list --count')
    );
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(revListIdx).toBeGreaterThan(checkoutIdx);

    const checkoutCall = execSyncCalls[checkoutIdx]!;
    expect(typeof checkoutCall.cmd === 'string' && checkoutCall.cmd.includes('workflow/test-branch')).toBe(true);
  });
});

describe('finalizeWorkflow: worktree preservation on PR failure', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
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
    execFileSyncCalls.length = 0;
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
    execFileSyncCalls.length = 0;
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
    execFileSyncCalls.length = 0;
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
    execFileSyncCalls.length = 0;
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('returns null (unknown) when origin default-branch metadata and all fallback refs are missing', async () => {
    // After the M2 fix, missing remote metadata is reported as `unknown` (null)
    // rather than `0`, so the wrap-up path preserves/quarantines the worktree
    // instead of treating "we could not verify a base" as "branch is empty".
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      if (cmd.startsWith('git rev-parse --verify origin/')) {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBeNull();
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-parse --verify origin/master',
    ]);
  });

  it('returns null when origin/main, origin/HEAD, and origin/master are all unavailable', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd.startsWith('git rev-parse --verify origin/')) {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBeNull();
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-parse --verify origin/HEAD',
      'git rev-parse --verify origin/master',
    ]);
  });

  it('returns the branch-specific commit count when origin default branch is available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        return Buffer.from('abc1234\n');
      }
      if (cmd === 'git rev-list --count HEAD ^origin/main') {
        return Buffer.from('2\n');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBe(2);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-list --count HEAD ^origin/main',
    ]);
  });

  it('causes getPrCreationOutcome to treat missing remote metadata as failed_with_publishable_commits (uncertainty preserves)', async () => {
    // After M2: when no origin base ref can be verified, countBranchCommits
    // returns null (unknown) and getPrCreationOutcome reports
    // failed_with_publishable_commits so the worktree is preserved/quarantined.
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      if (cmd.startsWith('git rev-parse --verify origin/')) {
        throw new Error('fatal: Needed a single revision');
      }
      return Buffer.from('');
    });

    const { getPrCreationOutcome } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ worktree_path: '/tmp/wt', work_dir: '/tmp/test' });

    expect(getPrCreationOutcome(wf, null)).toBe('failed_with_publishable_commits');
  });

  it('re-throws transient rev-parse errors instead of treating them as missing ref (Fix-C20a)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      // rev-parse --verify throws a transient error (timeout, index.lock, permission)
      if (cmd === 'git rev-parse --verify origin/main') {
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
      if (cmd === 'git rev-parse --verify origin/main') {
        return Buffer.from('abc1234\n');
      }
      // but rev-list fails (e.g. corrupt pack object)
      if (cmd === 'git rev-list --count HEAD ^origin/main') {
        throw new Error('fatal: bad object abc1234');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(() => countBranchCommits('/tmp/wt')).toThrow('fatal: bad object abc1234');
  });

  it('returns null when all candidates throw "not a valid object name" (Fix-C21b)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd.startsWith('git rev-parse --verify origin/')) {
        throw new Error('fatal: not a valid object name');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBeNull();
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-parse --verify origin/HEAD',
      'git rev-parse --verify origin/master',
    ]);
  });

  it('returns null when all candidates throw "unknown revision" (Fix-C21b)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd.startsWith('git rev-parse --verify origin/')) {
        throw new Error('fatal: unknown revision or path not in working tree');
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    expect(countBranchCommits('/tmp/wt')).toBeNull();
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-parse --verify origin/HEAD',
      'git rev-parse --verify origin/master',
    ]);
  });

  it('returns 0 when raw string "not a valid object name" is thrown (Fix-C21a)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd !== 'string') return Buffer.from('');
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (cmd === 'git rev-parse --verify origin/main') {
        // Raw string throw (no .message property) — tests the ?? err fallback
        throw 'fatal: not a valid object name origin/main';
      }
      if (cmd === 'git rev-parse --verify origin/HEAD') {
        throw 'fatal: not a valid object name origin/HEAD';
      }
      return Buffer.from('');
    });

    const { countBranchCommits } = await import('../server/orchestrator/WorkflowManager.js');

    // Without the ?? err fallback, this would throw because the classifier sees ''
    expect(countBranchCommits('/tmp/wt')).toBe(0);
    expect(execSyncCalls.map(c => c.cmd)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify origin/main',
      'git rev-parse --verify origin/HEAD',
    ]);
  });
});

describe('Fix-C11a: transient rev-parse errors propagate to callers via countBranchCommits', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      if (cmd === 'git rev-parse --verify origin/main') {
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
    const originHeadCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd === 'git rev-parse --verify origin/HEAD');
    expect(originHeadCall).toBeUndefined();

    // Safe-default logging contract verified (Fix-C12b)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rev-list failed'),
      expect.objectContaining({ message: expect.stringContaining('Permission denied') }),
    );
  });

  it('getPrCreationOutcome returns failed_with_publishable_commits when rev-parse throws transient error', async () => {
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
    const originHeadCall = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd === 'git rev-parse --verify origin/HEAD');
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
    execFileSyncCalls.length = 0;
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
    execFileSyncCalls.length = 0;
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

  });
});

/**
 * Sentry gating — proves OPERATIONAL_BLOCK_PATTERNS suppresses captureException for
 * "PR creation failed — worktree preserved for retry" blocks while non-operational
 * blocks (e.g. missing worktree guard) still report to Sentry.
 *
 * Mirrors the pattern in workflow-worktree-guard.test.ts, applied to the finalize path.
 */
describe('finalizeWorkflow: Sentry gating on PR failure blocks', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('does NOT call Sentry.captureException when finalizeWorkflow blocks with "PR creation failed"', async () => {
    vi.useFakeTimers();
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any, opts?: any) => {
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.includes('HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (file === 'git' && args?.[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify') {
        return Buffer.from('abc123\n');
      }
      if (file === 'git' && args?.[0] === 'rev-list') {
        return Buffer.from('5\n');
      }
      if (file === 'git' && args?.[0] === 'push') {
        return Buffer.from('');
      }
      if (file === 'git' && args?.[0] === 'merge-base') {
        return Buffer.from('\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        throw new Error('gh: Could not create PR');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') {
        throw new Error('no PR found');
      }
      if (file === 'git' && args?.[0] === 'status') return Buffer.from('');
      if (file === 'git' && args?.[0] === 'worktree') return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
        if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('5\n');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-sentry-pr-fail', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, {
      worktree_path: '/tmp/wt',
      worktree_branch: 'workflow/test-branch',
    });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-sentry-pr-fail', status: 'complete' });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    // Workflow is blocked with the preserved-worktree reason
    const updated = getWorkflowById('wf-sentry-pr-fail');
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('PR creation failed');

    // This is an operational block — Sentry must NOT be called
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('DOES call Sentry.captureException for non-operational blocks (worktree guard pattern)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');
    const { Sentry } = await import('../server/instrument.js');

    // Unrecoverable worktree repair: metadata is missing and work_dir is unavailable.
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
      use_worktree: 1,
    });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${workflow.id}/contract`, '# contract', null);
    queries.updateWorkflow(workflow.id, { work_dir: null, worktree_path: null, worktree_branch: null });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'assess',
      status: 'done',
    });
    onJobCompleted(job);

    // Workflow must be blocked (repair path could not proceed)
    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('Worktree metadata repair failed before review');
    expect(updated!.blocked_reason).toContain('work_dir is unavailable');

    // Non-operational block → Sentry MUST fire
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe('argv-safety regression: raw execFileSync assertions (M4)', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
    vi.restoreAllMocks();
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('preserves shell metacharacters in title/body as discrete argv elements [M4-target]', async () => {
    const mockedExecFileSync = vi.mocked(execFileSync);
    const callLog: Array<{ file: string; args: string[] }> = [];
    mockedExecFileSync.mockImplementation((file: any, args?: any, opts?: any) => {
      callLog.push({ file, args: args ?? [] });
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.includes('HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (file === 'git' && args?.[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify') {
        return Buffer.from('abc123\n');
      }
      if (file === 'git' && args?.[0] === 'rev-list') {
        return Buffer.from('3\n');
      }
      if (file === 'git' && args?.[0] === 'push') {
        return Buffer.from('');
      }
      if (file === 'git' && args?.[0] === 'merge-base') {
        return Buffer.from('\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') {
        throw new Error('no PRs found');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        return Buffer.from('https://github.com/test/repo/pull/42\n');
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const shellTitle = 'Fix `broken` code with $(echo pwned) and $USER';
    const wf = makeWorkflow({ title: shellTitle });

    const prUrl = pushAndCreatePr(wf, false);
    expect(prUrl).toBe('https://github.com/test/repo/pull/42');

    const prCreateShell = execSyncCalls.find(c => c.cmd.includes('gh pr create'));
    expect(prCreateShell).toBeUndefined();

    const prCreateSafe = callLog.find(
      c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'
    );
    expect(prCreateSafe).toBeDefined();

    const titleIdx = prCreateSafe!.args.indexOf('--title');
    expect(titleIdx).toBeGreaterThan(-1);
    const actualTitle = prCreateSafe!.args[titleIdx + 1];
    expect(actualTitle).toContain('`broken`');
    expect(actualTitle).toContain('$(echo pwned)');
    expect(actualTitle).toContain('$USER');
  });

  it('uses execFileSync argument arrays for gh pr view fallback on "already exists" [M4-target]', async () => {
    const mockedExecFileSync = vi.mocked(execFileSync);
    const callLog: Array<{ file: string; args: string[] }> = [];
    mockedExecFileSync.mockImplementation((file: any, args?: any, opts?: any) => {
      callLog.push({ file, args: args ?? [] });
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.includes('HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (file === 'git' && args?.[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify') {
        return Buffer.from('abc123\n');
      }
      if (file === 'git' && args?.[0] === 'rev-list') {
        return Buffer.from('3\n');
      }
      if (file === 'git' && args?.[0] === 'push') {
        return Buffer.from('');
      }
      if (file === 'git' && args?.[0] === 'merge-base') {
        return Buffer.from('\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') {
        const prViewCount = callLog.filter(
          c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view'
        ).length;
        if (prViewCount <= 1) throw new Error('no PRs found');
        return Buffer.from('https://github.com/test/repo/pull/99\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        const err = new Error('already exists');
        (err as any).stderr = Buffer.from('already exists');
        throw err;
      }
      return Buffer.from('');
    });

    const { pushAndCreatePr } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow();

    const prUrl = pushAndCreatePr(wf, false);
    expect(prUrl).toBe('https://github.com/test/repo/pull/99');

    const prViewCalls = callLog.filter(
      c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view'
    );
    expect(prViewCalls.length).toBeGreaterThanOrEqual(2);

    const fallbackCall = prViewCalls[prViewCalls.length - 1];
    expect(fallbackCall.args).toContain('workflow/test-branch');
    expect(fallbackCall.args).toContain('--json');
    expect(fallbackCall.args).toContain('url');
  });

  it('uses execFileSync argument arrays for finalizeWorkflow retry git push [M4-target]', async () => {
    vi.useFakeTimers();
    const mockedExecFileSync = vi.mocked(execFileSync);
    const callLog: Array<{ file: string; args: string[] }> = [];
    mockedExecFileSync.mockImplementation((file: any, args?: any, opts?: any) => {
      callLog.push({ file, args: args ?? [] });
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.includes('HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (file === 'git' && args?.[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify') {
        return Buffer.from('abc123\n');
      }
      if (file === 'git' && args?.[0] === 'rev-list') {
        return Buffer.from('3\n');
      }
      if (file === 'git' && args?.[0] === 'push') {
        return Buffer.from('');
      }
      if (file === 'git' && args?.[0] === 'merge-base') {
        return Buffer.from('\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') {
        throw new Error('no PRs found');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        const createCount = callLog.filter(
          c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'
        ).length;
        if (createCount <= 1) {
          throw Object.assign(new Error('transient'), { stderr: Buffer.from('transient') });
        }
        return Buffer.from('https://github.com/test/repo/pull/60\n');
      }
      if (file === 'git' && args?.[0] === 'status') return Buffer.from('');
      if (file === 'git' && args?.[0] === 'worktree') return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
        if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
        if (cmd.includes('git worktree remove')) return Buffer.from('');
        if (cmd.includes('git status --porcelain')) return Buffer.from('');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-retry-push-m4', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, { worktree_path: '/tmp/wt', worktree_branch: 'workflow/test-branch' });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-retry-push-m4', status: 'complete' });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    const gitPushCalls = callLog.filter(
      c => c.file === 'git' && c.args[0] === 'push'
    );
    expect(gitPushCalls.length).toBeGreaterThanOrEqual(2);

    for (const push of gitPushCalls) {
      expect(push.args).toEqual(['push', '-u', 'origin', 'workflow/test-branch']);
    }

    const shellPush = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.startsWith('git push'));
    expect(shellPush).toBeUndefined();
  });

  it('uses execFileSync argument arrays for finalizeWorkflow post-retry gh pr view fallback [M4-target]', async () => {
    vi.useFakeTimers();
    const mockedExecFileSync = vi.mocked(execFileSync);
    const callLog: Array<{ file: string; args: string[] }> = [];
    mockedExecFileSync.mockImplementation((file: any, args?: any, opts?: any) => {
      callLog.push({ file, args: args ?? [] });
      execFileSyncCalls.push({ file, args: args ?? [], opts });
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.includes('HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      if (file === 'git' && args?.[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      if (file === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify') {
        return Buffer.from('abc123\n');
      }
      if (file === 'git' && args?.[0] === 'rev-list') {
        return Buffer.from('3\n');
      }
      if (file === 'git' && args?.[0] === 'push') {
        return Buffer.from('');
      }
      if (file === 'git' && args?.[0] === 'merge-base') {
        return Buffer.from('\n');
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
        throw Object.assign(new Error('fail'), { stderr: Buffer.from('fail') });
      }
      if (file === 'gh' && args?.[0] === 'pr' && args?.[1] === 'view') {
        const viewCount = callLog.filter(
          c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view'
        ).length;
        if (viewCount <= 3) throw new Error('no PR');
        return Buffer.from('https://github.com/test/repo/pull/77\n');
      }
      if (file === 'git' && args?.[0] === 'status') return Buffer.from('');
      if (file === 'git' && args?.[0] === 'worktree') return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (typeof cmd === 'string') {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('workflow/test-branch\n');
        if (cmd.includes('symbolic-ref')) return Buffer.from('refs/remotes/origin/main\n');
        if (cmd.includes('rev-parse --verify')) return Buffer.from('abc123\n');
        if (cmd.includes('rev-list --count')) return Buffer.from('3\n');
        if (cmd.includes('git worktree remove')) return Buffer.from('');
        if (cmd.includes('git status --porcelain')) return Buffer.from('');
      }
      return Buffer.from('');
    });

    const { updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');
    const dbWf = await insertTestWorkflow({ id: 'wf-fallback-m4', status: 'complete', use_worktree: 1 });
    updateWorkflow(dbWf.id, { worktree_path: '/tmp/wt', worktree_branch: 'workflow/test-branch' });

    const { finalizeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ id: 'wf-fallback-m4', status: 'complete' });

    const promise = finalizeWorkflow(wf);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    const updated = getWorkflowById('wf-fallback-m4');
    expect(updated!.pr_url).toBe('https://github.com/test/repo/pull/77');

    const prViewCalls = callLog.filter(
      c => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view'
    );
    expect(prViewCalls.length).toBeGreaterThanOrEqual(4);

    const fallbackCall = prViewCalls[prViewCalls.length - 1];
    expect(fallbackCall.file).toBe('gh');
    expect(fallbackCall.args).toEqual(['pr', 'view', 'workflow/test-branch', '--json', 'url', '-q', '.url']);

    const shellPrView = execSyncCalls.find(c => typeof c.cmd === 'string' && c.cmd.includes('gh pr view'));
    expect(shellPrView).toBeUndefined();
  });
});

// M4 — bounded retry inside pushBranch with auth fail-fast.
// pushBranch tries `git push -u origin <branch>` once, sleeps a bounded delay
// on transient failure, then retries once with `--force-with-lease`. Auth
// failures (Authentication failed, Permission denied, terminal prompts
// disabled, 403) skip the retry. The result carries { attempts, retried }
// metadata so tests and operators can see what happened.
describe('pushBranch: bounded retry with auth fail-fast (M4)', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
    vi.restoreAllMocks();
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('first attempt succeeds — no retry, attempts=1, retried=false', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 5000 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.error).toBeUndefined();

    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(1);
    // First (and only) attempt is vanilla push, not --force-with-lease.
    expect(pushCalls[0]!.args).toEqual(['push', '-u', 'origin', 'workflow/test-branch']);
    // Sleep never called when first attempt succeeded.
    expect(sleepCalls).toEqual([]);
  });

  it('first attempt transient failure, retry succeeds — attempts=2, retried=true, --force-with-lease used', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        const pushCount = callLog.filter(c => c.file === 'git' && c.args[0] === 'push').length;
        if (pushCount === 1) {
          // Transient error on first attempt — not auth.
          throw Object.assign(new Error('transient'), {
            stderr: Buffer.from('error: failed to push some refs (network timeout)'),
          });
        }
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 5000 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.error).toBeUndefined();

    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(2);
    // Attempt 1: vanilla push.
    expect(pushCalls[0]!.args).toEqual(['push', '-u', 'origin', 'workflow/test-branch']);
    // Attempt 2: must include --force-with-lease.
    expect(pushCalls[1]!.args).toEqual(['push', '--force-with-lease', '-u', 'origin', 'workflow/test-branch']);

    // Sleep called once with the configured delay between the two attempts.
    expect(sleepCalls).toEqual([5000]);
  });

  it('auth failure on first attempt fails fast — exactly one push, retried=false, authFailure=true', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        throw Object.assign(new Error('auth fail'), {
          stderr: Buffer.from('fatal: Authentication failed for https://github.com/test/repo'),
        });
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 5000 });

    expect(result.ok).toBe(false);
    expect(result.authFailure).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.error).toContain('Authentication failed');

    // Hard rule: exactly one git push attempt was made.
    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(1);
    // No sleep happened — auth failure short-circuits.
    expect(sleepCalls).toEqual([]);
  });

  it.each([
    'Authentication failed',
    'Permission denied (publickey)',
    'fatal: could not read Username for',
    'fatal: could not read Password for',
    'terminal prompts disabled',
    'The requested URL returned error: 403',
  ])('treats %s as non-retryable auth failure', async (stderrMessage) => {
    const sleepCalls: number[] = [];
    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        throw Object.assign(new Error('auth-like'), { stderr: Buffer.from(stderrMessage) });
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), {
      sleep: (ms: number) => { sleepCalls.push(ms); },
      retryDelayMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.authFailure).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it('both attempts fail transiently — returns second stderr, attempts=2, retried=true', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        const pushCount = callLog.filter(c => c.file === 'git' && c.args[0] === 'push').length;
        const message = pushCount === 1
          ? 'error: failed to push some refs (first transient)'
          : 'error: remote rejected (second transient — distinct details)';
        throw Object.assign(new Error('transient'), { stderr: Buffer.from(message) });
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 5000 });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.authFailure).toBe(false);
    // The error must come from the SECOND attempt, not the first.
    expect(result.error).toContain('second transient');
    expect(result.error).not.toContain('first transient');

    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(2);
    expect(pushCalls[0]!.args).toEqual(['push', '-u', 'origin', 'workflow/test-branch']);
    expect(pushCalls[1]!.args).toEqual(['push', '--force-with-lease', '-u', 'origin', 'workflow/test-branch']);
    // Sleep called once between attempts.
    expect(sleepCalls).toEqual([5000]);
  });

  it('retryDelayMs: 0 skips the sleep entirely', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        const pushCount = callLog.filter(c => c.file === 'git' && c.args[0] === 'push').length;
        if (pushCount === 1) {
          throw Object.assign(new Error('transient'), { stderr: Buffer.from('error: try again') });
        }
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 0 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    // sleep was never invoked because retryDelayMs <= 0.
    expect(sleepCalls).toEqual([]);
  });

  it('returns failure metadata without attempting push when worktree path is missing', async () => {
    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const wf = makeWorkflow({ worktree_path: null });
    const result = pushBranch(wf);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.retried).toBe(false);
    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(0);
  });

  it.each([
    ['Retry-After', 'The requested URL returned error: 403\nRetry-After: 60'],
    ['rate limit', 'remote: error: 403 API rate limit exceeded for token'],
  ])('403 with %s wording is treated as transient, not auth - retries once and succeeds', async (_label, stderrMessage) => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        const pushCount = callLog.filter(c => c.file === 'git' && c.args[0] === 'push').length;
        if (pushCount === 1) {
          throw Object.assign(new Error('rate limited'), {
            stderr: Buffer.from(stderrMessage),
          });
        }
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 100 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.authFailure).toBeUndefined();

    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(2);
    expect(sleepCalls).toEqual([100]);
  });

  it('403 with rate limit wording is transient - returns second stderr when both attempts fail', async () => {
    const sleepCalls: number[] = [];
    const sleep = (ms: number) => { sleepCalls.push(ms); };

    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        const pushCount = callLog.filter(c => c.file === 'git' && c.args[0] === 'push').length;
        if (pushCount === 1) {
          throw Object.assign(new Error('rate limited'), {
            stderr: Buffer.from('error: 403 secondary rate limit exceeded'),
          });
        }
        throw Object.assign(new Error('rate limited again'), {
          stderr: Buffer.from('error: 403 secondary rate limit exceeded (attempt 2)'),
        });
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), { sleep, retryDelayMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.authFailure).toBe(false);
    expect(result.error).toContain('attempt 2');

    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(2);
    expect(sleepCalls).toEqual([100]);
  });

  it.each([
    'The requested URL returned error: 403',
    'remote: Permission denied to repo\nfatal: The requested URL returned error: 403',
  ])('plain auth/permission 403 without rate-limit wording is still treated as auth - no retry: %s', async (stderrMessage) => {
    const sleepCalls: number[] = [];
    const callLog: Array<{ file: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation((file: any, args?: any) => {
      callLog.push({ file, args: args ?? [] });
      if (file === 'git' && args?.[0] === 'push') {
        throw Object.assign(new Error('forbidden'), {
          stderr: Buffer.from(stderrMessage),
        });
      }
      return Buffer.from('');
    });
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Buffer.from('workflow/test-branch\n');
      }
      return Buffer.from('');
    });

    const { pushBranch } = await import('../server/orchestrator/WorkflowManager.js');
    const result = pushBranch(makeWorkflow(), {
      sleep: (ms: number) => { sleepCalls.push(ms); },
      retryDelayMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.authFailure).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    const pushCalls = callLog.filter(c => c.file === 'git' && c.args[0] === 'push');
    expect(pushCalls.length).toBe(1);
    expect(sleepCalls).toEqual([]);
  });
});
