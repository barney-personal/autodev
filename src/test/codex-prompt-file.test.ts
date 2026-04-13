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
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'circuit closed',
    recordModelLimited: () => {},
    recordModelAvailable: () => {},
    recordInfraFailure: () => {},
    recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
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
  _resetWarnedUnclassifiedForTest: vi.fn(),
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

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
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
        on: vi.fn(),
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
      status: 'assigned',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-1', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    expect(queries.getJobById(job.id)?.status).toBe('running');

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
      status: 'assigned',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'claude-agent-1', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    expect(queries.getJobById(job.id)?.status).toBe('running');

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

  it('writeFileSync failure closes logFd and errFd and does not spawn', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-write-fail-job',
      title: 'Write Fail Test',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-write-fail', job_id: job.id, status: 'starting' });

    // Make writeFileSync throw on the prompt file write (third call — after mkdirSync)
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('ENOSPC');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // logFd and errFd (the first two openSync calls) were closed
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    // openSync was called twice — once for logFd, once for errFd
    expect(openedFds.size).toBe(2);
    const [logFd, errFd] = [...openedFds.values()];
    expect(closeCalls).toContain(logFd);
    expect(closeCalls).toContain(errFd);
  });

  it('openSync failure on prompt file closes logFd and errFd and does not spawn', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-open-fail-job',
      title: 'Open Fail Test',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-open-fail', job_id: job.id, status: 'starting' });

    // openSync is called 3 times for Codex: logFd('w'), errFd('w'), promptFd('r').
    // Let the first two succeed, then throw on the third.
    let openCount = 0;
    vi.mocked(fs.openSync).mockImplementation((filePath: any, mode: any) => {
      openCount++;
      if (openCount === 3) {
        throw new Error('EMFILE: too many open files');
      }
      const fd = nextFd++;
      openedFds.set(filePath, fd);
      return fd;
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EMFILE');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // The prompt file was written (writeFileSync succeeded before openSync failed)
    expect(writtenFiles.size).toBe(1);

    // logFd and errFd were closed in the catch handler
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    const [logFd, errFd] = [...openedFds.values()];
    expect(closeCalls).toContain(logFd);
    expect(closeCalls).toContain(errFd);
  });

  it('logFd open failure leaks no fds (Codex)', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-log-open-fail',
      title: 'Log Open Fail Codex',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-log-fail', job_id: job.id, status: 'starting' });

    // First openSync call (logFd) throws immediately
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw new Error('EMFILE: too many open files');
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EMFILE');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // No fds were opened successfully, so closeSync should not be called
    // to close any agent fds (no logFd, errFd, or promptFd to clean up)
    expect(vi.mocked(fs.closeSync).mock.calls).toHaveLength(0);
  });

  it('errFd open failure closes logFd (Codex)', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-err-open-fail',
      title: 'Err Open Fail Codex',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-err-fail', job_id: job.id, status: 'starting' });

    // First openSync (logFd) succeeds, second (errFd) throws
    let openCount = 0;
    vi.mocked(fs.openSync).mockImplementation((filePath: any, mode: any) => {
      openCount++;
      if (openCount === 2) {
        throw new Error('EMFILE: too many open files');
      }
      const fd = nextFd++;
      openedFds.set(filePath, fd);
      return fd;
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EMFILE');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // Only logFd was opened — it should be closed in the catch handler
    expect(openedFds.size).toBe(1);
    const [logFd] = [...openedFds.values()];
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    expect(closeCalls).toContain(logFd);
    // Only one fd should have been closed (the logFd)
    expect(closeCalls).toHaveLength(1);
  });

  it('logFd open failure leaks no fds (Claude)', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'claude-log-open-fail',
      title: 'Log Open Fail Claude',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'claude-agent-log-fail', job_id: job.id, status: 'starting' });

    // First openSync call (logFd) throws immediately
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw new Error('EMFILE: too many open files');
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EMFILE');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // No fds were opened, so nothing to close
    expect(vi.mocked(fs.closeSync).mock.calls).toHaveLength(0);
  });

  it('errFd open failure closes logFd (Claude)', async () => {
    const fs = await import('fs');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'claude-err-open-fail',
      title: 'Err Open Fail Claude',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'claude-agent-err-fail', job_id: job.id, status: 'starting' });

    // First openSync (logFd) succeeds, second (errFd) throws
    let openCount = 0;
    vi.mocked(fs.openSync).mockImplementation((filePath: any, mode: any) => {
      openCount++;
      if (openCount === 2) {
        throw new Error('EMFILE: too many open files');
      }
      const fd = nextFd++;
      openedFds.set(filePath, fd);
      return fd;
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EMFILE');

    // spawn was NOT called
    expect(spawnCalls).toHaveLength(0);

    // Only logFd was opened — it should be closed in the catch handler
    expect(openedFds.size).toBe(1);
    const [logFd] = [...openedFds.values()];
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    expect(closeCalls).toContain(logFd);
    expect(closeCalls).toHaveLength(1);
  });

  it('spawn failure closes all fds including promptFd', async () => {
    const fs = await import('fs');
    const { spawn } = await import('child_process');
    const { runAgent, getPromptPath } = await import('../server/orchestrator/AgentRunner.js');

    const job = await insertTestJob({
      id: 'codex-spawn-fail-job',
      title: 'Spawn Fail Test',
      description: 'test',
      model: 'codex',
      status: 'queued',
    });

    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'codex-agent-spawn-fail', job_id: job.id, status: 'starting' });

    // Make spawn throw
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('spawn ENOENT');

    // All three fds (logFd, errFd, promptFd) were closed in the catch handler
    const closeCalls = vi.mocked(fs.closeSync).mock.calls.map(c => c[0]);
    const promptPath = getPromptPath(agent.id);
    const promptFd = openedFds.get(promptPath)!;
    expect(promptFd).toBeDefined();
    expect(closeCalls).toContain(promptFd);

    // logFd and errFd also closed
    const allFds = [...openedFds.values()];
    expect(allFds.length).toBe(3);
    for (const fd of allFds) {
      expect(closeCalls).toContain(fd);
    }
  });
});

describe('AgentRunner: Claude stdin EPIPE handling', () => {
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

  it('benign EPIPE on stdin.write() is swallowed and does not call captureWithContext', async () => {
    const { spawn } = await import('child_process');
    const { captureWithContext } = await import('../server/instrument.js');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    vi.mocked(spawn).mockImplementationOnce((_cmd: any, args: any, options: any) => {
      spawnCalls.push({ binary: _cmd, args, options });
      return {
        pid: 12345,
        stdin: {
          write: vi.fn(() => {
            const err = new Error('write EPIPE') as NodeJS.ErrnoException;
            err.code = 'EPIPE';
            throw err;
          }),
          end: vi.fn(),
          on: vi.fn(),
        },
        on: vi.fn(),
        unref: vi.fn(),
      } as any;
    });

    const job = await insertTestJob({
      id: 'claude-epipe-sync-benign',
      title: 'EPIPE sync benign',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'assigned',
    });
    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'agent-epipe-sync-benign', job_id: job.id, status: 'running' });

    // Should not throw — EPIPE is caught internally
    runAgent({ agentId: agent.id, job });

    // Benign error must NOT reach Sentry
    expect(vi.mocked(captureWithContext)).not.toHaveBeenCalled();
  });

  it('unexpected error on stdin.write() calls captureWithContext with AgentRunner context', async () => {
    const { spawn } = await import('child_process');
    const { captureWithContext } = await import('../server/instrument.js');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    vi.mocked(spawn).mockImplementationOnce((_cmd: any, args: any, options: any) => {
      spawnCalls.push({ binary: _cmd, args, options });
      return {
        pid: 12345,
        stdin: {
          write: vi.fn(() => {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }),
          end: vi.fn(),
          on: vi.fn(),
        },
        on: vi.fn(),
        unref: vi.fn(),
      } as any;
    });

    const job = await insertTestJob({
      id: 'claude-stdin-unexpected-sync',
      title: 'Unexpected sync error',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'assigned',
    });
    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'agent-stdin-unexpected-sync', job_id: job.id, status: 'running' });

    expect(() => runAgent({ agentId: agent.id, job })).toThrow('EACCES');

    // Unexpected error MUST be reported to Sentry exactly once
    expect(vi.mocked(captureWithContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureWithContext)).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EACCES' }),
      expect.objectContaining({
        agent_id: agent.id,
        job_id: job.id,
        component: 'AgentRunner',
      }),
    );
  });

  it('benign EPIPE emitted asynchronously on stdin stream does not call captureWithContext', async () => {
    const { spawn } = await import('child_process');
    const { captureWithContext } = await import('../server/instrument.js');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    let stdinErrorHandler: ((err: Error) => void) | null = null;
    vi.mocked(spawn).mockImplementationOnce((_cmd: any, args: any, options: any) => {
      spawnCalls.push({ binary: _cmd, args, options });
      return {
        pid: 12345,
        stdin: {
          write: vi.fn((data: string) => { stdinWrites.push(data); }),
          end: vi.fn(() => { stdinEnded = true; }),
          on: vi.fn((event: string, handler: any) => {
            if (event === 'error') stdinErrorHandler = handler;
          }),
        },
        on: vi.fn(),
        unref: vi.fn(),
      } as any;
    });

    const job = await insertTestJob({
      id: 'claude-epipe-async-benign',
      title: 'EPIPE async benign',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'assigned',
    });
    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'agent-epipe-async-benign', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    // Simulate async EPIPE emitted after child exits
    expect(stdinErrorHandler).not.toBeNull();
    const epipeErr = new Error('write EPIPE') as NodeJS.ErrnoException;
    epipeErr.code = 'EPIPE';
    stdinErrorHandler!(epipeErr);

    // Benign async error must NOT reach Sentry
    expect(vi.mocked(captureWithContext)).not.toHaveBeenCalled();
  });

  it('unexpected error emitted asynchronously on stdin stream calls captureWithContext', async () => {
    const { spawn } = await import('child_process');
    const { captureWithContext } = await import('../server/instrument.js');
    const { runAgent } = await import('../server/orchestrator/AgentRunner.js');

    let stdinErrorHandler: ((err: Error) => void) | null = null;
    vi.mocked(spawn).mockImplementationOnce((_cmd: any, args: any, options: any) => {
      spawnCalls.push({ binary: _cmd, args, options });
      return {
        pid: 12345,
        stdin: {
          write: vi.fn((data: string) => { stdinWrites.push(data); }),
          end: vi.fn(() => { stdinEnded = true; }),
          on: vi.fn((event: string, handler: any) => {
            if (event === 'error') stdinErrorHandler = handler;
          }),
        },
        on: vi.fn(),
        unref: vi.fn(),
      } as any;
    });

    const job = await insertTestJob({
      id: 'claude-stdin-unexpected-async',
      title: 'Unexpected async error',
      description: 'test',
      model: 'claude-sonnet-4-6',
      status: 'assigned',
    });
    const queries = await import('../server/db/queries.js');
    const agent = queries.insertAgent({ id: 'agent-stdin-unexpected-async', job_id: job.id, status: 'running' });

    runAgent({ agentId: agent.id, job });

    // Simulate unexpected async error
    expect(stdinErrorHandler).not.toBeNull();
    const unexpectedErr = new Error('EIO: i/o error') as NodeJS.ErrnoException;
    unexpectedErr.code = 'EIO';
    stdinErrorHandler!(unexpectedErr);

    // Unexpected async error MUST be reported to Sentry exactly once
    expect(vi.mocked(captureWithContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureWithContext)).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EIO' }),
      expect.objectContaining({
        agent_id: agent.id,
        job_id: job.id,
        component: 'AgentRunner',
      }),
    );
  });
});
