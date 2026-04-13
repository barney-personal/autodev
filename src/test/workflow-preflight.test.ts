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

// Track execSync calls
const execSyncCalls: Array<{ cmd: string; opts?: any }> = [];
let gitStatusShouldFail = false;
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
    if (cmd === 'git status --porcelain' && gitStatusShouldFail) {
      throw new Error('fatal: not a git repository');
    }
    if (cmd.includes('git worktree add')) {
      if (worktreeAddShouldFail) {
        throw new Error('fatal: branch already exists');
      }
      return Buffer.from('');
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

describe('startWorkflow: pre-flight validation', () => {
  beforeEach(async () => {
    execSyncCalls.length = 0;
    gitStatusShouldFail = false;
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

    gitStatusShouldFail = true;
    const wf = await insertTestWorkflow({ work_dir: '/tmp/valid-but-no-git' });

    const result = startWorkflow(wf);

    expect(result).toBeNull();

    const updated = getWorkflowById(wf.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.blocked_reason).toContain('git is not functional');
    expect(updated?.blocked_reason).toContain('fatal: not a git repository');
  });

  it('proceeds normally when work_dir exists and git works', async () => {
    const { startWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    const wf = await insertTestWorkflow({ work_dir: '/tmp/valid-repo', use_worktree: 0 });

    const result = startWorkflow(wf);

    expect(result).not.toBeNull();
    expect(result!.workflow_phase).toBe('assess');
    expect(result!.workflow_id).toBe(wf.id);

    // Verify git status was called as pre-flight
    const gitStatusCall = execSyncCalls.find(c => c.cmd === 'git status --porcelain');
    expect(gitStatusCall).toBeDefined();
    expect(gitStatusCall!.opts.cwd).toBe('/tmp/valid-repo');
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
