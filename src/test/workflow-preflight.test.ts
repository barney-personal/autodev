/**
 * Tests for M4: Pre-flight validation before assess phase.
 *
 * Proves:
 * 1. When work_dir does not exist, workflow is blocked with diagnostic reason
 * 2. When git is not functional in work_dir, workflow is blocked with diagnostic reason
 * 3. When work_dir is valid and git works, workflow proceeds normally
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestWorkflow,
} from './helpers.js';

// Track execSync/execFileSync calls
const execSyncCalls: Array<{ cmd: string; opts?: any }> = [];
const execFileSyncCalls: Array<{ file: string; args: string[]; opts?: any }> = [];
let gitShouldFail = false;
let worktreeAddShouldFail = false;
let missingPaths = new Set<string>();

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => !missingPaths.has(p)),
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string, opts?: any) => {
    execSyncCalls.push({ cmd, opts });
    return Buffer.from('');
  }),
  execFileSync: vi.fn((file: string, args: string[], opts?: any) => {
    execFileSyncCalls.push({ file, args, opts });
    if (file === 'git' && args[0] === 'rev-parse' && gitShouldFail) {
      throw new Error('fatal: not a git repository');
    }
    if (file === 'git' && args.includes('worktree') && args.includes('add') && worktreeAddShouldFail) {
      throw new Error('fatal: branch already exists');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

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
  getFallbackModel: vi.fn((m: string) => m),
  getAlternateProviderModel: vi.fn(() => null),
  getModelProvider: vi.fn(() => 'anthropic'),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

describe('startWorkflow: pre-flight validation', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    execFileSyncCalls.length = 0;
    gitShouldFail = false;
    worktreeAddShouldFail = false;
    missingPaths = new Set();
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
    vi.restoreAllMocks();
  });

  it('blocks workflow when work_dir does not exist', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById } = await import('../server/db/queries.js');

    missingPaths.add('/nonexistent/path');
    const wf = await insertTestWorkflow({ work_dir: '/nonexistent/path' });

    const result = startWorkflow(wf);

    expect(result).toBeNull();

    const updated = getWorkflowById(wf.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blocked_reason).toContain('work_dir does not exist');
    expect(updated?.blocked_reason).toContain('/nonexistent/path');
  });

  it('blocks workflow when git is not functional', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById } = await import('../server/db/queries.js');

    gitShouldFail = true;
    const wf = await insertTestWorkflow({ work_dir: '/tmp/valid-but-no-git' });

    const result = startWorkflow(wf);

    expect(result).toBeNull();

    const updated = getWorkflowById(wf.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blocked_reason).toContain('is not a git repository');
    expect(updated?.blocked_reason).toContain('/tmp/valid-but-no-git');
  });

  it('proceeds normally when work_dir exists and git works', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    const wf = await insertTestWorkflow({ work_dir: '/tmp/valid-repo', use_worktree: 0 });

    const result = startWorkflow(wf);

    expect(result).not.toBeNull();
    expect(result!.workflow_phase).toBe('assess');
    expect(result!.workflow_id).toBe(wf.id);

    // Verify git rev-parse was called as pre-flight via validateGitWorkDir
    const gitRevParseCall = execFileSyncCalls.find(
      c => c.file === 'git' && c.args[0] === 'rev-parse',
    );
    expect(gitRevParseCall).toBeDefined();
    expect(gitRevParseCall!.opts.cwd).toBe('/tmp/valid-repo');
  });

  it('blocks workflow and avoids creating an assess job when worktree creation fails', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, listJobs } = await import('../server/db/queries.js');

    worktreeAddShouldFail = true;
    const wf = await insertTestWorkflow({ work_dir: '/tmp/valid-repo', use_worktree: 1 });

    const result = startWorkflow(wf);

    expect(result).toBeNull();

    const updated = getWorkflowById(wf.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blocked_reason).toContain('Worktree creation failed');
    expect(updated?.blocked_reason).toContain('fatal: branch already exists');

    const jobs = listJobs().filter(job => job.workflow_id === wf.id);
    expect(jobs).toHaveLength(0);
  });
});
