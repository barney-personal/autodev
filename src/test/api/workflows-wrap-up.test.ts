/**
 * Wrap-up regression tests for POST /api/workflows/:id/wrap-up.
 *
 * Exercises every branch of the wrap-up handler against REAL temp git
 * worktrees so cleanup-vs-preserve behavior is asserted on disk, not just on
 * mocked function calls. Only network-going commands (`git push`, `gh ...`)
 * are intercepted — every other git operation runs against the real fixture.
 *
 * Covers:
 *  1. Happy path — push + draft PR succeed → workflow `complete`, worktree removed.
 *  2. Push succeeds, `gh pr create` fails → workflow `blocked`, worktree preserved.
 *  3. Push fails transiently then succeeds on retry → workflow `complete`, worktree removed.
 *  4. Push fails with auth error → no retry, workflow `blocked`, worktree preserved.
 *  5. `gh pr create` exits 0 with empty stdout (the original bug regression) →
 *     workflow `blocked`, NOT `cancelled`, worktree preserved.
 *  6. Probe returns `clean` (no commits ahead of verified origin/main) →
 *     workflow `cancelled`, worktree removed.
 *  7. Worktree metadata missing but milestones_done > 0 (Fix-C6b) →
 *     workflow `blocked`, no cleanup attempted.
 *
 * Plus a focused unit-style test of probeRecoverableWorkflowWork's
 * missing-origin-ref → `unknown` behavior, using a real worktree whose origin
 * remote has no refs at all.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
} from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

// ---------------------------------------------------------------------------
// Test-controlled handlers for intercepted external commands.
//
// `gitPushQueue` is a queue so a single `pushBranch` invocation that retries
// internally can be driven through both attempts.
// ---------------------------------------------------------------------------

interface CmdOutcome {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

interface MockHandlers {
  gitPushQueue: Array<(args: readonly string[]) => CmdOutcome>;
  ghPrCreate?: (args: readonly string[]) => CmdOutcome;
  ghPrView?: (args: readonly string[]) => CmdOutcome;
  ghLabelCreate?: (args: readonly string[]) => CmdOutcome;
}

const mockHandlers: MockHandlers = { gitPushQueue: [] };

function resetMockHandlers() {
  mockHandlers.gitPushQueue.length = 0;
  mockHandlers.ghPrCreate = undefined;
  mockHandlers.ghPrView = undefined;
  mockHandlers.ghLabelCreate = undefined;
}

function makeExecError(stderr: string, status = 1): Error & { stderr: Buffer; status: number } {
  const err: any = new Error(stderr || `command failed (exit ${status})`);
  err.stderr = Buffer.from(stderr);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Mock child_process: intercept `git push` and `gh ...`, delegate everything
// else (init, add, commit, status, log, rev-parse, worktree add/remove/prune)
// to the real binaries so the on-disk fixture is real.
// ---------------------------------------------------------------------------

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const handleExecFileSync = (cmd: string, args?: readonly string[] | any, opts?: any): Buffer => {
    const argv: string[] = Array.isArray(args) ? args : [];

    if (cmd === 'git' && argv[0] === 'push') {
      const next = mockHandlers.gitPushQueue.shift();
      if (!next) throw makeExecError('test bug: no gitPush mock outcome queued');
      const r = next(argv);
      if (!r.ok) throw makeExecError(r.stderr ?? '');
      return Buffer.from(r.stdout ?? '');
    }

    if (cmd === 'gh') {
      if (argv[0] === 'pr' && argv[1] === 'create') {
        const handler = mockHandlers.ghPrCreate;
        if (!handler) throw makeExecError('test bug: no ghPrCreate handler set');
        const r = handler(argv);
        if (!r.ok) throw makeExecError(r.stderr ?? '');
        return Buffer.from(r.stdout ?? '');
      }
      if (argv[0] === 'pr' && argv[1] === 'view') {
        const handler = mockHandlers.ghPrView;
        // Default: simulate "no PR exists" so createWorkflowPr proceeds to create one.
        if (!handler) throw makeExecError('no pull requests found');
        const r = handler(argv);
        if (!r.ok) throw makeExecError(r.stderr ?? '');
        return Buffer.from(r.stdout ?? '');
      }
      if (argv[0] === 'label' && argv[1] === 'create') {
        const handler = mockHandlers.ghLabelCreate;
        if (!handler) return Buffer.from('');
        const r = handler(argv);
        if (!r.ok) throw makeExecError(r.stderr ?? '');
        return Buffer.from(r.stdout ?? '');
      }
      throw makeExecError(`unexpected gh command: gh ${argv.join(' ')}`);
    }

    return actual.execFileSync(cmd, args as any, opts) as Buffer;
  };

  const handleExecSync = (cmd: string, opts?: any): Buffer | string => {
    if (typeof cmd === 'string') {
      // Belt-and-braces: the wrap-up path goes through execFileSync, but
      // removeWorktree() shells out via execSync. Don't allow `git push` or
      // `gh ...` to slip through — those are network-going.
      if (/(^|\s)git push\b/.test(cmd) || cmd.startsWith('gh ')) {
        throw makeExecError(`test bug: unexpected execSync command: ${cmd}`);
      }
    }
    return actual.execSync(cmd, opts);
  };

  return {
    ...actual,
    execFileSync: vi.fn(handleExecFileSync),
    execSync: vi.fn(handleExecSync),
  };
});

// ---------------------------------------------------------------------------
// Module mocks for things wrap-up imports — same pattern as workflows.test.ts,
// but DO NOT mock WorkflowManager. We want the real probe / pushBranch /
// createWorkflowPr / cleanupWorktree against the real fixture.
// ---------------------------------------------------------------------------

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));
vi.mock('../../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => []),
  getSnapshot: vi.fn(() => null),
  attachPty: vi.fn(),
  startInteractiveAgent: vi.fn(),
}));
vi.mock('../../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified prompt'),
}));
vi.mock('../../server/orchestrator/ModelClassifier.js', () => ({
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false, reason: () => 'closed',
    recordModelLimited: () => {}, recordModelAvailable: () => {},
    recordInfraFailure: () => {}, recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getAvailableModel: vi.fn((m: string) => m),
  getFallbackModel: vi.fn(() => null),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));
vi.mock('../../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));
vi.mock('../../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixture helpers — use real (unmocked) child_process via vi.importActual so
// the setup itself is unaffected by our intercept.
// ---------------------------------------------------------------------------

let _realExecSync: typeof import('child_process').execSync;
let _realExecFileSync: typeof import('child_process').execFileSync;

beforeAll(async () => {
  const real = await vi.importActual<typeof import('child_process')>('child_process');
  _realExecSync = real.execSync;
  _realExecFileSync = real.execFileSync;
});

interface Fixture {
  rootDir: string;
  originDir: string;
  workDir: string;
  worktreePath: string | null;
  branch: string;
  cleanup: () => void;
}

interface FixtureOptions {
  /** Push initial main to origin so origin/main is a verified base ref. Default true. */
  withOriginBase?: boolean;
  /** Number of commits to add on the workflow branch. Default 0 (clean tree). */
  branchCommits?: number;
  /** If false, do not create a worktree at all. Default true. */
  createWorktree?: boolean;
  /** Override the branch name. */
  branchName?: string;
}

let activeFixtures: Fixture[] = [];

function createGitFixture(opts: FixtureOptions = {}): Fixture {
  const withOriginBase = opts.withOriginBase ?? true;
  const branchCommits = opts.branchCommits ?? 0;
  const createWorktree = opts.createWorktree ?? true;
  const branchName = opts.branchName ?? `workflow/wrap-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const rootDir = mkdtempSync(path.join(tmpdir(), 'wrap-up-'));
  const originDir = path.join(rootDir, 'origin.git');
  const workDir = path.join(rootDir, 'work');
  const worktreePath = path.join(rootDir, 'worktrees', branchName.replace(/\//g, '-'));

  const run = (cmd: string, cwd: string) => {
    _realExecSync(cmd, { cwd, stdio: 'pipe', timeout: 15000 });
  };

  // Bare origin
  _realExecSync(`git init --bare ${JSON.stringify(originDir)}`, { stdio: 'pipe', timeout: 10000 });

  // Working clone
  _realExecSync(`git init ${JSON.stringify(workDir)}`, { stdio: 'pipe', timeout: 10000 });
  run('git config user.email "wrap-up-test@example.com"', workDir);
  run('git config user.name "Wrap-up Test"', workDir);
  run('git config commit.gpgsign false', workDir);
  run(`git remote add origin ${JSON.stringify(originDir)}`, workDir);

  // Initial commit on main
  writeFileSync(path.join(workDir, 'README.md'), '# wrap-up test fixture\n');
  run('git checkout -b main', workDir);
  run('git add README.md', workDir);
  run('git commit -m "initial"', workDir);

  if (withOriginBase) {
    // Push initial main directly via the real git so origin/main exists locally.
    _realExecSync('git push -u origin main', { cwd: workDir, stdio: 'pipe', timeout: 15000 });
    // Set origin/HEAD so getRemoteDefaultBranch() succeeds.
    try {
      _realExecSync('git remote set-head origin main', { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    } catch { /* best effort */ }
  }

  let actualWorktreePath: string | null = null;
  if (createWorktree) {
    _realExecSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)}`,
      { cwd: workDir, stdio: 'pipe', timeout: 15000 },
    );
    run('git config user.email "wrap-up-test@example.com"', worktreePath);
    run('git config user.name "Wrap-up Test"', worktreePath);
    run('git config commit.gpgsign false', worktreePath);

    for (let i = 0; i < branchCommits; i++) {
      writeFileSync(path.join(worktreePath, `milestone-${i + 1}.txt`), `progress ${i + 1}\n`);
      run(`git add milestone-${i + 1}.txt`, worktreePath);
      run(`git commit -m "milestone ${i + 1}"`, worktreePath);
    }
    actualWorktreePath = worktreePath;
  }

  const fixture: Fixture = {
    rootDir,
    originDir,
    workDir,
    worktreePath: actualWorktreePath,
    branch: branchName,
    cleanup: () => {
      try { rmSync(rootDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    },
  };
  activeFixtures.push(fixture);
  return fixture;
}

// ---------------------------------------------------------------------------
// Mock GitHub PR view defaults: simulate "no existing PR" so createWorkflowPr
// proceeds to create one. Tests can override per-call.
// ---------------------------------------------------------------------------

function withDefaultGhPrView() {
  mockHandlers.ghPrView = () => ({ ok: false, stderr: 'no pull requests found' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let app: express.Express;

describe('POST /api/workflows/:id/wrap-up — disk-state regression', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    resetMockHandlers();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
    for (const f of activeFixtures) f.cleanup();
    activeFixtures = [];
  });

  // ── Case 1: happy path ──────────────────────────────────────────────────
  it('completes and removes the worktree on disk when push and PR creation both succeed', async () => {
    const fx = createGitFixture({ branchCommits: 2 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    mockHandlers.gitPushQueue.push(() => ({ ok: true }));
    withDefaultGhPrView();
    mockHandlers.ghPrCreate = () => ({ ok: true, stdout: 'https://github.com/test/repo/pull/100\n' });

    expect(existsSync(fx.worktreePath!)).toBe(true);

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('draft_pr_created');
    expect(res.body.pr_url).toBe('https://github.com/test/repo/pull/100');
    expect(res.body.workflow.status).toBe('complete');
    expect(res.body.workflow.pr_url).toBe('https://github.com/test/repo/pull/100');

    // Worktree directory should now be gone from disk.
    expect(existsSync(fx.worktreePath!)).toBe(false);
    // No queued mock outcomes leftover — pushBranch consumed exactly one.
    expect(mockHandlers.gitPushQueue.length).toBe(0);
  });

  // ── Case 2: push succeeds, gh pr create fails ──────────────────────────
  it('blocks (not cancels) and preserves the worktree when push succeeds but gh pr create fails', async () => {
    const fx = createGitFixture({ branchCommits: 3 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow, getWorkflowById } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    mockHandlers.gitPushQueue.push(() => ({ ok: true }));
    withDefaultGhPrView();
    mockHandlers.ghPrCreate = () => ({ ok: false, stderr: 'gh: server returned 502 bad gateway' });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('draft_pr_failed_preserved');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('blocked');
    expect(res.body.workflow.blocked_reason).toContain('gh pr create failed');
    expect(res.body.workflow.blocked_reason).toContain('502 bad gateway');
    expect(res.body.workflow.blocked_reason).toContain(fx.worktreePath!);

    expect(existsSync(fx.worktreePath!)).toBe(true);
    const dbAfter = getWorkflowById(wf.id);
    expect(dbAfter!.pr_url).toBeNull();
  });

  // ── Case 3: push fails transiently then succeeds on retry ──────────────
  it('completes when the first push fails transiently and the bounded retry succeeds', async () => {
    const fx = createGitFixture({ branchCommits: 1 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    // First attempt fails transiently (network blip), second attempt (the retry
    // with --force-with-lease) succeeds. The wrap-up handler is unaware of the
    // retry — pushBranch returns ok:true after consuming both queued outcomes.
    mockHandlers.gitPushQueue.push(() => ({ ok: false, stderr: 'fatal: unable to access: 502' }));
    mockHandlers.gitPushQueue.push((argv) => {
      // Confirm the retry uses --force-with-lease per pushBranch's contract.
      expect(argv).toContain('--force-with-lease');
      return { ok: true };
    });
    withDefaultGhPrView();
    mockHandlers.ghPrCreate = () => ({ ok: true, stdout: 'https://github.com/test/repo/pull/101\n' });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('draft_pr_created');
    expect(res.body.pr_url).toBe('https://github.com/test/repo/pull/101');
    expect(res.body.workflow.status).toBe('complete');
    expect(existsSync(fx.worktreePath!)).toBe(false);
    expect(mockHandlers.gitPushQueue.length).toBe(0);
  }, /* timeout */ 20000);

  // ── Case 4: push fails with auth error — no retry ───────────────────────
  it('blocks and preserves the worktree on a push auth failure without retrying', async () => {
    const fx = createGitFixture({ branchCommits: 2 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    // Auth failure on the first attempt — pushBranch must NOT retry.
    mockHandlers.gitPushQueue.push(() => ({
      ok: false,
      stderr: 'remote: Permission denied to user/repo.git\nfatal: Authentication failed',
    }));
    // Queue a second outcome that should NEVER be consumed; if it is, the
    // post-test assertion on queue length fails.
    mockHandlers.gitPushQueue.push(() => ({ ok: true }));

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('draft_pr_failed_preserved');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('blocked');
    expect(res.body.workflow.blocked_reason).toContain('branch push failed');
    expect(res.body.workflow.blocked_reason).toContain('Authentication failed');
    expect(res.body.workflow.blocked_reason).toContain(fx.worktreePath!);

    expect(existsSync(fx.worktreePath!)).toBe(true);
    // Auth fail-fast: only one push attempt consumed.
    expect(mockHandlers.gitPushQueue.length).toBe(1);
    expect(mockHandlers.ghPrCreate).toBeUndefined();
  });

  // ── Case 5: gh pr create exits 0 with empty stdout (THE BUG REGRESSION) ─
  it('blocks (not cancels) and preserves the worktree when gh pr create exits 0 with empty stdout', async () => {
    const fx = createGitFixture({ branchCommits: 4 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow, getWorkflowById } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    mockHandlers.gitPushQueue.push(() => ({ ok: true }));
    withDefaultGhPrView();
    // The pre-fix bug: gh exits 0 with no URL → wrap-up used to cancel the
    // workflow and delete the worktree. After the fix, it must block instead.
    mockHandlers.ghPrCreate = () => ({ ok: true, stdout: '' });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('draft_pr_failed_preserved');
    expect(res.body.pr_url).toBeNull();

    const dbAfter = getWorkflowById(wf.id);
    expect(dbAfter!.status).toBe('blocked');
    expect(dbAfter!.status).not.toBe('cancelled');
    expect(dbAfter!.blocked_reason).toContain('gh pr create failed');
    expect(dbAfter!.blocked_reason).toContain('empty stdout');
    expect(dbAfter!.blocked_reason).toContain(fx.worktreePath!);

    expect(existsSync(fx.worktreePath!)).toBe(true);
  });

  // ── Case 6: clean worktree, no commits ahead of origin ───────────────────
  it('cancels and removes the worktree when the probe proves no commits ahead of origin/main', async () => {
    const fx = createGitFixture({ branchCommits: 0 });
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      work_dir: fx.workDir,
    });
    const { updateWorkflow, getWorkflowById } = await import('../../server/db/queries.js');
    updateWorkflow(wf.id, { worktree_path: fx.worktreePath, worktree_branch: fx.branch });

    expect(existsSync(fx.worktreePath!)).toBe(true);

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('no_publishable_commits');
    expect(res.body.pr_url).toBeNull();

    const dbAfter = getWorkflowById(wf.id);
    expect(dbAfter!.status).toBe('cancelled');

    expect(existsSync(fx.worktreePath!)).toBe(false);
    // Probe should never have queued a push or PR call.
    expect(mockHandlers.gitPushQueue.length).toBe(0);
    expect(mockHandlers.ghPrCreate).toBeUndefined();
  });

  // ── Case 7: worktree_path missing but milestones_done > 0 (Fix-C6b) ──────
  it('blocks with descriptive reason when worktree_path is missing but milestones_done > 0', async () => {
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      use_worktree: 1,
      milestones_total: 5,
      milestones_done: 3,
      // Deliberately NO worktree_path (matches Fix-C6b lost-metadata case).
    });

    const res = await request(app).post(`/api/workflows/${wf.id}/wrap-up`);

    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('missing_worktree_with_progress');
    expect(res.body.pr_url).toBeNull();
    expect(res.body.workflow.status).toBe('blocked');
    expect(res.body.workflow.blocked_reason).toContain('worktree metadata missing');
    expect(res.body.workflow.blocked_reason).toContain('3/5 milestones');

    // Probe / push / PR should never be invoked when worktree metadata is missing.
    expect(mockHandlers.gitPushQueue.length).toBe(0);
    expect(mockHandlers.ghPrCreate).toBeUndefined();
  });
});

describe('probeRecoverableWorkflowWork — missing-origin-ref preservation', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    resetMockHandlers();
  });

  afterEach(async () => {
    await cleanupTestDb();
    for (const f of activeFixtures) f.cleanup();
    activeFixtures = [];
  });

  it('returns status=unknown when no origin base ref can be verified, even with no local commits', async () => {
    // Origin remote exists but we never pushed to it, so origin/main, origin/HEAD
    // and origin/master are all absent. countBranchCommits returns 0 in this
    // scenario (proven by other tests), but the safer probe must return
    // `unknown` so wrap-up preserves the worktree.
    const fx = createGitFixture({ withOriginBase: false, branchCommits: 0 });

    const { probeRecoverableWorkflowWork } = await import(
      '../../server/orchestrator/WorkflowManager.js'
    );

    const wf: any = {
      id: 'probe-test',
      worktree_path: fx.worktreePath,
      worktree_branch: fx.branch,
      work_dir: fx.workDir,
    };

    const result = probeRecoverableWorkflowWork(wf);

    expect(result.status).toBe('unknown');
    expect(result.detail).toMatch(/could not verify any origin base ref/);
    expect(result.baseRef).toBeNull();
  });

  it('returns status=unknown when the worktree directory is missing on disk', async () => {
    const fx = createGitFixture({ branchCommits: 1 });
    // Remove the worktree dir from disk while leaving DB metadata intact.
    rmSync(fx.worktreePath!, { recursive: true, force: true });

    const { probeRecoverableWorkflowWork } = await import(
      '../../server/orchestrator/WorkflowManager.js'
    );
    const wf: any = {
      id: 'probe-missing-dir',
      worktree_path: fx.worktreePath,
      worktree_branch: fx.branch,
      work_dir: fx.workDir,
    };

    const result = probeRecoverableWorkflowWork(wf);
    expect(result.status).toBe('unknown');
    expect(result.detail).toContain('worktree directory missing');
  });

  it('returns status=has_work when the worktree has uncommitted changes', async () => {
    const fx = createGitFixture({ branchCommits: 0 });
    writeFileSync(path.join(fx.worktreePath!, 'dirty.txt'), 'uncommitted\n');

    const { probeRecoverableWorkflowWork } = await import(
      '../../server/orchestrator/WorkflowManager.js'
    );
    const wf: any = {
      id: 'probe-dirty',
      worktree_path: fx.worktreePath,
      worktree_branch: fx.branch,
      work_dir: fx.workDir,
    };

    const result = probeRecoverableWorkflowWork(wf);
    expect(result.status).toBe('has_work');
    expect(result.detail).toContain('uncommitted');
  });

  it('returns status=clean when the verified origin base ref has no commits ahead', async () => {
    const fx = createGitFixture({ branchCommits: 0 });

    const { probeRecoverableWorkflowWork } = await import(
      '../../server/orchestrator/WorkflowManager.js'
    );
    const wf: any = {
      id: 'probe-clean',
      worktree_path: fx.worktreePath,
      worktree_branch: fx.branch,
      work_dir: fx.workDir,
    };

    const result = probeRecoverableWorkflowWork(wf);
    expect(result.status).toBe('clean');
    expect(result.baseRef).toBe('origin/main');
  });

  it('returns status=has_work with a commit count when commits are ahead of origin/main', async () => {
    const fx = createGitFixture({ branchCommits: 3 });

    const { probeRecoverableWorkflowWork } = await import(
      '../../server/orchestrator/WorkflowManager.js'
    );
    const wf: any = {
      id: 'probe-has-work',
      worktree_path: fx.worktreePath,
      worktree_branch: fx.branch,
      work_dir: fx.workDir,
    };

    const result = probeRecoverableWorkflowWork(wf);
    expect(result.status).toBe('has_work');
    expect(result.baseRef).toBe('origin/main');
    expect(result.detail).toContain('3 commit');
  });
});
