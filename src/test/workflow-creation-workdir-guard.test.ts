/**
 * Tests for M1: Creation-time guard — work_dir validation for worktree-enabled workflows.
 *
 * Covers:
 *   - validateGitWorkDir helper (unit)
 *   - validateTaskRequest workDir guard (pure function)
 *   - createWorkflowSchema zod validation
 *   - createAutonomousAgentRun manager guard (throws before DB insert)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateGitWorkDir } from '../server/shared/workDirValidation.js';
import { validateTaskRequest } from '../shared/taskNormalization.js';
import { createSocketMock } from './helpers.js';

// ── Shared mock state ────────────────────────────────────────────────────────

let _missingPaths = new Set<string>();
let _nonGitPaths = new Set<string>();

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => !_missingPaths.has(p)),
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn((file: string, args: string[], _opts?: unknown) => {
    if (file === 'git' && args[0] === 'rev-parse') {
      const cwd = (_opts as any)?.cwd as string | undefined;
      if (cwd && _nonGitPaths.has(cwd)) {
        throw new Error('fatal: not a git repository');
      }
      return Buffer.from('true\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  startWorkflow: vi.fn(() => null),
}));

// ── validateGitWorkDir unit tests ────────────────────────────────────────────

describe('validateGitWorkDir', () => {
  beforeEach(() => {
    _missingPaths = new Set();
    _nonGitPaths = new Set();
    vi.clearAllMocks();
  });

  it('returns error when workDir is undefined', () => {
    const result = validateGitWorkDir(undefined);
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('returns error when workDir is null', () => {
    const result = validateGitWorkDir(null);
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('returns error when workDir is blank string', () => {
    const result = validateGitWorkDir('   ');
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('returns error when workDir does not exist', () => {
    _missingPaths.add('/nonexistent/repo');
    const result = validateGitWorkDir('/nonexistent/repo');
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/work_dir does not exist/);
    expect((result as any).error).toContain('/nonexistent/repo');
  });

  it('returns error when workDir is not a git repository', () => {
    _nonGitPaths.add('/tmp/not-a-git-dir');
    const result = validateGitWorkDir('/tmp/not-a-git-dir', { requireGit: true });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/is not a git repository/);
    expect((result as any).error).toContain('/tmp/not-a-git-dir');
  });

  it('returns ok when workDir exists and is a git repo', () => {
    const result = validateGitWorkDir('/app/valid-repo', { requireGit: true });
    expect(result.ok).toBe(true);
    expect((result as any).workDir).toBe('/app/valid-repo');
  });

  it('skips git check when requireGit is false', () => {
    _nonGitPaths.add('/tmp/existing-non-git');
    const result = validateGitWorkDir('/tmp/existing-non-git', { requireGit: false });
    expect(result.ok).toBe(true);
    expect((result as any).workDir).toBe('/tmp/existing-non-git');
  });

  it('trims leading/trailing whitespace from workDir', () => {
    const result = validateGitWorkDir('  /app/valid-repo  ', { requireGit: true });
    expect(result.ok).toBe(true);
    expect((result as any).workDir).toBe('/app/valid-repo');
  });
});

// ── validateTaskRequest workDir guard tests ──────────────────────────────────

describe('validateTaskRequest — workDir guard', () => {
  it('rejects autonomous task without workDir when useWorktree defaults to true', () => {
    const error = validateTaskRequest({ description: 'fix the bug', iterations: 5 });
    expect(error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('rejects autonomous task with blank workDir', () => {
    const error = validateTaskRequest({ description: 'fix the bug', iterations: 5, workDir: '   ' });
    expect(error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('rejects preset:autonomous without workDir', () => {
    const error = validateTaskRequest({ description: 'fix the bug', preset: 'autonomous' });
    expect(error).toMatch(/work_dir is required for worktree-enabled workflows/);
  });

  it('allows autonomous task without workDir when useWorktree=false', () => {
    const error = validateTaskRequest({
      description: 'fix the bug',
      iterations: 5,
      useWorktree: false,
    });
    expect(error).toBeNull();
  });

  it('allows autonomous task with non-empty workDir', () => {
    // validateTaskRequest is a pure function — it does NOT check existence/git
    // Those IO checks happen in the manager and API layer
    const error = validateTaskRequest({
      description: 'fix the bug',
      iterations: 5,
      workDir: '/some/path',
    });
    expect(error).toBeNull();
  });

  it('allows single-pass (job-routed) tasks without workDir regardless of useWorktree', () => {
    expect(validateTaskRequest({ description: 'job task', iterations: 1 })).toBeNull();
    expect(validateTaskRequest({ description: 'job task', preset: 'quick' })).toBeNull();
  });
});

// ── createWorkflowSchema zod validation ─────────────────────────────────────

describe('createWorkflowSchema — workDir guard', () => {
  beforeEach(() => {
    _missingPaths = new Set();
    _nonGitPaths = new Set();
    vi.clearAllMocks();
  });

  it('rejects workflow creation without workDir when useWorktree defaults to true', async () => {
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something' });
    expect(result.success).toBe(false);
    const issues = (result as any).error.issues;
    expect(issues.some((i: any) => i.message.includes('work_dir is required'))).toBe(true);
  });

  it('rejects blank workDir for worktree workflow', async () => {
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something', workDir: '  ' });
    expect(result.success).toBe(false);
    const issues = (result as any).error.issues;
    expect(issues.some((i: any) => i.message.includes('work_dir is required'))).toBe(true);
  });

  it('rejects non-existent workDir for worktree workflow', async () => {
    _missingPaths.add('/nonexistent/path');
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something', workDir: '/nonexistent/path' });
    expect(result.success).toBe(false);
  });

  it('rejects non-git workDir for worktree workflow', async () => {
    _nonGitPaths.add('/tmp/not-git');
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something', workDir: '/tmp/not-git' });
    expect(result.success).toBe(false);
    const issues = (result as any).error.issues;
    expect(issues.some((i: any) => i.message.includes('is not a git repository'))).toBe(true);
  });

  it('passes when useWorktree=false and no workDir', async () => {
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something', useWorktree: false });
    expect(result.success).toBe(true);
  });

  it('passes when valid git workDir provided', async () => {
    const { createWorkflowSchema } = await import('../server/api/validation.js');
    const result = createWorkflowSchema.safeParse({ task: 'do something', workDir: '/app/valid-repo' });
    expect(result.success).toBe(true);
  });
});

// ── createAutonomousAgentRun manager guard ───────────────────────────────────

describe('createAutonomousAgentRun — workDir guard (throws before DB insert)', () => {
  beforeEach(() => {
    _missingPaths = new Set();
    _nonGitPaths = new Set();
    vi.clearAllMocks();
  });

  it('throws with correct message when workDir missing and useWorktree=true', async () => {
    const { createAutonomousAgentRun } = await import('../server/orchestrator/AutonomousAgentRunManager.js');
    expect(() =>
      createAutonomousAgentRun({ task: 'do something' }),
    ).toThrow('work_dir is required for worktree-enabled workflows');
  });

  it('throws when workDir does not exist', async () => {
    _missingPaths.add('/nonexistent/path');
    const { createAutonomousAgentRun } = await import('../server/orchestrator/AutonomousAgentRunManager.js');
    expect(() =>
      createAutonomousAgentRun({ task: 'do something', workDir: '/nonexistent/path' }),
    ).toThrow(/work_dir does not exist/);
  });

  it('throws when workDir is not a git repository', async () => {
    _nonGitPaths.add('/tmp/not-git');
    const { createAutonomousAgentRun } = await import('../server/orchestrator/AutonomousAgentRunManager.js');
    expect(() =>
      createAutonomousAgentRun({ task: 'do something', workDir: '/tmp/not-git' }),
    ).toThrow(/is not a git repository/);
  });

  it('does NOT throw when useWorktree=false and no workDir provided', async () => {
    const { createAutonomousAgentRun } = await import('../server/orchestrator/AutonomousAgentRunManager.js');
    // This will succeed the workDir guard but may fail later (no DB) — that is fine.
    // We just need to confirm the guard does not block useWorktree=false.
    expect(() =>
      createAutonomousAgentRun({ task: 'do something', useWorktree: false }),
    ).not.toThrow(/work_dir is required/);
  });
});
