/**
 * AgentRunner: Codex prompt delivery via file-backed stdin.
 *
 * Proves:
 * 1. Codex jobs write the prompt to a file and pass the file fd as stdin,
 *    instead of appending it as a positional CLI argument.
 * 2. Claude jobs still deliver the prompt via piped stdin.
 * 3. Very large prompts are handled without E2BIG risk because the prompt
 *    never appears in the argv array.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  startInteractiveAgent: vi.fn(),
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  ensureCodexTrusted: vi.fn(),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  getFallbackModel: vi.fn((m: string) => m),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess'),
  buildReviewPrompt: vi.fn(() => 'mock review'),
  buildImplementPrompt: vi.fn(() => 'mock implement'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair'),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/CompletionChecks.js', () => ({
  runCompletionChecks: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

vi.mock('../server/orchestrator/MemoryTriager.js', () => ({
  triageLearnings: vi.fn(async () => {}),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(),
  clearRecoveryState: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/PrCreator.js', () => ({
  createPrForJob: vi.fn(async () => null),
  pushBranchForFailedJob: vi.fn(),
}));

vi.mock('../server/orchestrator/EyeConfig.js', () => ({
  buildEyePrompt: vi.fn(() => 'mock eye prompt'),
  isEyeJob: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

// Track spawn calls and fs operations
const spawnCalls: Array<{ binary: string; args: string[]; options: any }> = [];
const writtenFiles: Map<string, string> = new Map();
const openedFds: Map<string, number> = new Map();
let nextFd = 100;

// Track stdin writes
const stdinWrites: string[] = [];
let stdinEnded = false;

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], options: any) => {
    spawnCalls.push({ binary: _cmd, args, options });
    return {
      pid: 12345,
      stdin: {
        write: vi.fn((data: string) => { stdinWrites.push(data); }),
        end: vi.fn(() => { stdinEnded = true; }),
      },
      on: vi.fn(),
      unref: vi.fn(),
    };
  }),
  execSync: vi.fn(() => Buffer.from('abc123\n')),
  exec: vi.fn((_cmd: string, _opts: any, cb: any) => {
    process.nextTick(() => cb(null, { stdout: '', stderr: '' }));
    return { on: vi.fn() };
  }),
}));

// Mock fs to track prompt file writes and fd opens
const realFs = await import('fs');
const originalWriteFileSync = realFs.writeFileSync;
const originalOpenSync = realFs.openSync;
const originalCloseSync = realFs.closeSync;
const originalMkdirSync = realFs.mkdirSync;
const originalExistsSync = realFs.existsSync;
const originalStatSync = realFs.statSync;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((filePath: string, content: string) => {
      writtenFiles.set(filePath, content);
    }),
    openSync: vi.fn((filePath: string, _mode: string) => {
      const fd = nextFd++;
      openedFds.set(filePath, fd);
      return fd;
    }),
    closeSync: vi.fn(),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ size: 0 })),
    readFileSync: vi.fn(() => ''),
    watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
  };
});

describe('AgentRunner: Codex prompt file delivery', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    spawnCalls.length = 0;
    writtenFiles.clear();
    openedFds.clear();
    nextFd = 100;
    stdinWrites.length = 0;
    stdinEnded = false;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('Codex jobs write prompt to file and pass file fd as stdin', async () => {
    const { runAgent, getPromptPath } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-prompt-job',
      title: 'Test Codex Job',
      description: 'Do something',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-1', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    // A prompt file was written
    const promptPath = getPromptPath(agent.id);
    expect(writtenFiles.has(promptPath)).toBe(true);
    const promptContent = writtenFiles.get(promptPath)!;
    expect(promptContent).toContain('Test Codex Job');
    expect(promptContent).toContain('Do something');

    // The prompt file was opened as a read fd
    expect(openedFds.has(promptPath)).toBe(true);
    const promptFd = openedFds.get(promptPath)!;

    // spawn was called with the prompt file fd as stdin, not 'pipe'
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.options.stdio[0]).toBe(promptFd);

    // The prompt does NOT appear as a positional arg in the spawn args
    const argsStr = call.args.join(' ');
    expect(argsStr).not.toContain('Do something');
    expect(argsStr).not.toContain('Test Codex Job');

    // No stdin pipe writes for Codex
    expect(stdinWrites).toHaveLength(0);
  });

  it('Claude jobs still deliver prompt via piped stdin', async () => {
    const { runAgent, getPromptPath } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'claude-prompt-job',
      title: 'Test Claude Job',
      description: 'Claude task',
      model: 'claude-sonnet-4-6',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'claude-agent-1', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    // No prompt file was written for Claude
    const promptPath = getPromptPath(agent.id);
    expect(writtenFiles.has(promptPath)).toBe(false);

    // spawn was called with 'pipe' as stdin
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.options.stdio[0]).toBe('pipe');

    // Prompt was written to stdin pipe
    expect(stdinWrites).toHaveLength(1);
    expect(stdinWrites[0]).toContain('Test Claude Job');
    expect(stdinWrites[0]).toContain('Claude task');
  });

  it('large Codex prompts do not appear in argv', async () => {
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    // Create a job with a very large description (simulating workflow context)
    const largeDescription = 'X'.repeat(200_000); // 200KB — would exceed macOS ARG_MAX
    const job = await insertTestJob({
      id: 'codex-large-prompt-job',
      title: 'Large Codex Job',
      description: largeDescription,
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-large', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    // spawn was called
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];

    // The large prompt is NOT in the argv array
    const totalArgvLength = call.args.reduce((sum: number, arg: string) => sum + arg.length, 0);
    expect(totalArgvLength).toBeLessThan(10_000); // args should just be flags, not the 200KB prompt

    // The large prompt WAS written to the file
    const promptContent = [...writtenFiles.values()][0];
    expect(promptContent).toContain(largeDescription);

    // stdin is a file fd, not a pipe
    expect(typeof call.options.stdio[0]).toBe('number');
  });

  it('prompt file fd is closed after spawning', async () => {
    const fs = await import('fs');
    const { runAgent, getPromptPath } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-fd-cleanup-job',
      title: 'FD Cleanup Test',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-fd', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    const promptPath = getPromptPath(agent.id);
    const promptFd = openedFds.get(promptPath)!;

    // closeSync was called with the prompt file fd
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    expect(closeCalls).toContain(promptFd);
  });
});
