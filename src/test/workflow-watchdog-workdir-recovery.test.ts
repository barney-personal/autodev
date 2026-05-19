/**
 * Tests for M2: Watchdog null-work_dir auto-fix.
 *
 * Covers:
 *   - normalizeToKebab, extractTitleLeadingSegment (pure helpers)
 *   - inferWorkspaceRepoFromTitle (unit, via opts injection)
 *   - StuckJobWatchdog recoverNullWorkDirWorkflows (integration)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
} from './helpers.js';
import {
  inferWorkspaceRepoFromTitle,
  normalizeToKebab,
  extractTitleLeadingSegment,
} from '../server/orchestrator/WorkspaceRepoInference.js';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));
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
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  startInteractiveAgent: vi.fn(),
  saveSnapshot: vi.fn(),
  disconnectAgent: vi.fn(),
  checkPtyResources: vi.fn(() => ({ ok: true })),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resumeWorkflow: vi.fn(),
    startWorkflow: vi.fn(() => null),
  };
});

// Mock WorkspaceRepoInference so watchdog integration tests can control it
vi.mock('../server/orchestrator/WorkspaceRepoInference.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // Wrap with spy — unit tests call through, integration tests override
    inferWorkspaceRepoFromTitle: vi.fn((...args: any[]) =>
      (actual['inferWorkspaceRepoFromTitle'] as Function)(...args)
    ),
  };
});

const execFileSyncMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: (...args: any[]) => execFileSyncMock(...args),
  };
});

// ── normalizeToKebab unit tests ───────────────────────────────────────────────

describe('normalizeToKebab', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(normalizeToKebab('Polymarket Agent')).toBe('polymarket-agent');
    expect(normalizeToKebab('polymarket-agent')).toBe('polymarket-agent');
    expect(normalizeToKebab('My_Repo Name')).toBe('my-repo-name');
    expect(normalizeToKebab('  leading  ')).toBe('leading');
    expect(normalizeToKebab('multi---hyphens')).toBe('multi-hyphens');
  });
});

// ── extractTitleLeadingSegment unit tests ─────────────────────────────────────

describe('extractTitleLeadingSegment', () => {
  it('splits on em dash with spaces', () => {
    expect(extractTitleLeadingSegment('polymarket-agent — 5 new strategies')).toBe('polymarket-agent');
  });
  it('splits on en dash with spaces', () => {
    expect(extractTitleLeadingSegment('my-repo – do something')).toBe('my-repo');
  });
  it('splits on space-hyphen-space', () => {
    expect(extractTitleLeadingSegment('my-repo - task description')).toBe('my-repo');
  });
  it('splits on colon', () => {
    expect(extractTitleLeadingSegment('my-repo: task description')).toBe('my-repo');
  });
  it('returns the full title when no separator', () => {
    expect(extractTitleLeadingSegment('myrepo')).toBe('myrepo');
    expect(extractTitleLeadingSegment('polymarket-agent')).toBe('polymarket-agent');
  });
  it('does NOT split on bare hyphens within a name (no surrounding spaces)', () => {
    expect(extractTitleLeadingSegment('polymarket-agent')).toBe('polymarket-agent');
    expect(extractTitleLeadingSegment('zoo-v3-sweep')).toBe('zoo-v3-sweep');
  });
});

// ── inferWorkspaceRepoFromTitle unit tests (DI opts) ─────────────────────────

describe('inferWorkspaceRepoFromTitle (via opts injection)', () => {
  const mockExistsSync = vi.fn();
  const mockReaddirSync = vi.fn();
  const mockStatSync = vi.fn();
  const mockExecFileSync = vi.fn();

  const baseOpts = {
    workspaceBaseDir: '/workspace',
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    execFileSync: mockExecFileSync,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }));
    mockExecFileSync.mockReturnValue(Buffer.from('true\n'));
  });

  it('returns no match when workspace dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    expect(result.match).toBeNull();
    expect(result.reason).toMatch(/does not exist/);
  });

  it('returns no match when no entries match the normalized title', () => {
    mockReaddirSync.mockReturnValue(['some-other-repo', 'another-repo']);
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    expect(result.match).toBeNull();
    expect(result.reason).toMatch(/none matched/);
    expect(result.candidates.length).toBe(2);
  });

  it('returns match when exactly one entry matches and is a git repo', () => {
    mockReaddirSync.mockReturnValue(['polymarket-agent', 'zoo-v3']);
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — 5 new strategies', baseOpts);
    expect(result.match).toBe('/workspace/polymarket-agent');
    expect(result.reason).toMatch(/polymarket-agent/);
  });

  it('returns no match when matching entry is not a git repo', () => {
    mockReaddirSync.mockReturnValue(['polymarket-agent']);
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    expect(result.match).toBeNull();
    expect(result.reason).toMatch(/none matched/);
  });

  it('returns no match when multiple entries match (ambiguous)', () => {
    mockReaddirSync.mockReturnValue(['polymarket-agent', 'polymarket_agent']);
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    expect(result.match).toBeNull();
    expect(result.candidates.length).toBe(2);
    expect(result.reason).toMatch(/ambiguous/);
  });

  it('does not match when entry is not a directory', () => {
    mockReaddirSync.mockReturnValue(['polymarket-agent']);
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }));
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    expect(result.match).toBeNull();
  });

  it('normalizes both title and directory names for matching', () => {
    mockReaddirSync.mockReturnValue(['Polymarket_Agent']);
    const result = inferWorkspaceRepoFromTitle('polymarket-agent — task', baseOpts);
    // 'Polymarket_Agent' normalizes to 'polymarket-agent' — should match
    expect(result.match).toBe('/workspace/Polymarket_Agent');
  });
});

// ── Watchdog integration tests ────────────────────────────────────────────────

describe('StuckJobWatchdog: null work_dir recovery', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();

    // Default execFileSync: fail tmux (no server), succeed for git
    execFileSyncMock.mockImplementation((file: string, args: string[]) => {
      if (file === 'tmux') throw new Error('no server running');
      return Buffer.from('');
    });
  });

  afterEach(async () => {
    const { _resetWatchdogStateForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    _resetWatchdogStateForTest();
    await cleanupTestDb();
  });

  it('positive match: writes work_dir, calls resumeWorkflow with correct args, is idempotent', async () => {
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { inferWorkspaceRepoFromTitle: inferMock } = await import('../server/orchestrator/WorkspaceRepoInference.js');
    const queries = await import('../server/db/queries.js');

    vi.mocked(resumeWorkflow).mockReturnValue({ id: 'job-resume-1', workflow_phase: 'implement' } as any);
    vi.mocked(inferMock).mockReturnValue({
      match: '/workspace/test-repo',
      candidates: ['/workspace/test-repo'],
      reason: 'inferred from title segment',
    });

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      use_worktree: 1,
      current_phase: 'idle',
      current_cycle: 1,
    });
    queries.updateWorkflow(workflow.id, {
      work_dir: null,
      blocked_reason: 'Worktree metadata repair failed before review: missing worktree_path and worktree_branch and work_dir is unavailable',
    });

    _invokeWatchdogCheckForTest();

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.work_dir).toBe('/workspace/test-repo');
    expect(vi.mocked(resumeWorkflow)).toHaveBeenCalledWith(
      expect.objectContaining({ id: workflow.id, work_dir: '/workspace/test-repo' }),
      { phase: 'implement', cycle: 1 },
    );

    // Second tick should NOT retry (idempotency via in-flight set)
    vi.mocked(resumeWorkflow).mockClear();
    _invokeWatchdogCheckForTest();
    expect(vi.mocked(resumeWorkflow)).not.toHaveBeenCalled();
  });

  it('no match: appends inference diagnostic to blocked_reason, does not call resume, is idempotent', async () => {
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { inferWorkspaceRepoFromTitle: inferMock } = await import('../server/orchestrator/WorkspaceRepoInference.js');
    const queries = await import('../server/db/queries.js');

    vi.mocked(resumeWorkflow).mockReturnValue({ id: 'job-resume-2' } as any);
    vi.mocked(inferMock).mockReturnValue({
      match: null,
      candidates: ['/workspace/other-repo', '/workspace/another-repo'],
      reason: "Considered 2 workspace entries; none matched normalized title segment 'test-workflow'.",
    });

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      use_worktree: 1,
      current_phase: 'idle',
      current_cycle: 2,
    });
    queries.updateWorkflow(workflow.id, {
      work_dir: null,
      blocked_reason: 'Worktree metadata repair failed before review: work_dir is unavailable',
    });

    _invokeWatchdogCheckForTest();

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.work_dir).toBeNull();
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('Inference attempted');
    expect(updated!.blocked_reason).toContain('/workspace/other-repo');
    expect(vi.mocked(resumeWorkflow)).not.toHaveBeenCalled();

    // Second tick should NOT append another diagnostic
    const beforeSecondTick = updated!.blocked_reason;
    _invokeWatchdogCheckForTest();
    const afterSecondTick = queries.getWorkflowById(workflow.id)!.blocked_reason;
    expect(afterSecondTick).toBe(beforeSecondTick);
  });

  it('resumeWorkflow throws: rewrites blocked_reason and does not retry', async () => {
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { inferWorkspaceRepoFromTitle: inferMock } = await import('../server/orchestrator/WorkspaceRepoInference.js');
    const queries = await import('../server/db/queries.js');

    vi.mocked(resumeWorkflow).mockImplementation(() => { throw new Error('resume failed: branch missing'); });
    vi.mocked(inferMock).mockReturnValue({
      match: '/workspace/my-repo',
      candidates: ['/workspace/my-repo'],
      reason: 'matched',
    });

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      use_worktree: 1,
      current_phase: 'idle',
      current_cycle: 1,
    });
    queries.updateWorkflow(workflow.id, {
      work_dir: null,
      blocked_reason: 'Worktree metadata repair failed: work_dir is unavailable',
    });

    _invokeWatchdogCheckForTest();

    const updated = queries.getWorkflowById(workflow.id);
    // work_dir was written before resumeWorkflow threw
    expect(updated!.work_dir).toBe('/workspace/my-repo');
    // blocked_reason should be rewritten to the failure message
    expect(updated!.blocked_reason).toMatch(/Null work_dir watchdog recovery failed/);
    expect(updated!.blocked_reason).toContain('resume failed: branch missing');

    // Second tick: in-flight set blocks retry
    vi.mocked(resumeWorkflow).mockClear();
    _invokeWatchdogCheckForTest();
    expect(vi.mocked(resumeWorkflow)).not.toHaveBeenCalled();
  });

  it('does not touch workflows that already have work_dir set', async () => {
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    vi.mocked(resumeWorkflow).mockReturnValue({ id: 'job-resume-3' } as any);

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      use_worktree: 1,
    });
    queries.updateWorkflow(workflow.id, {
      work_dir: '/existing/work/dir',
      blocked_reason: 'some reason mentioning work_dir is unavailable text',
    });

    _invokeWatchdogCheckForTest();

    const updated = queries.getWorkflowById(workflow.id);
    expect(updated!.work_dir).toBe('/existing/work/dir');
    expect(vi.mocked(resumeWorkflow)).not.toHaveBeenCalled();
  });

  it('does not touch completed/cancelled workflows', async () => {
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const queries = await import('../server/db/queries.js');

    vi.mocked(resumeWorkflow).mockReturnValue({ id: 'job-resume-4' } as any);

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'blocked',
      use_worktree: 1,
    });
    // Mark as complete — should not be touched
    queries.updateWorkflow(workflow.id, {
      work_dir: null,
      blocked_reason: 'work_dir is unavailable',
      status: 'complete',
    });

    _invokeWatchdogCheckForTest();

    expect(vi.mocked(resumeWorkflow)).not.toHaveBeenCalled();
  });
});
