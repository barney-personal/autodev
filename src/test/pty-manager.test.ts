import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { cleanupTestDb, createSocketMock, insertTestJob, setupTestDb } from './helpers.js';

const execFileSyncMock = vi.fn((cmd: string, args: string[]) => {
  if (cmd !== 'tmux') return Buffer.from('');

  if (args[0] === 'list-sessions') {
    return Buffer.from('');
  }

  if (args[0] === 'has-session') {
    return Buffer.from('');
  }

  return Buffer.from('');
});

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

const startTailingMock = vi.fn();
const stopTailingMock = vi.fn();
const handleJobCompletionMock = vi.fn(async () => {});

vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  SYSTEM_PROMPT: 'test system prompt',
  HOOK_SETTINGS: {},
  handleJobCompletion: handleJobCompletionMock,
  cancelledAgents: new Set<string>(),
  startTailing: startTailingMock,
  stopTailing: stopTailingMock,
  readClaudeMd: vi.fn(() => ''),
  buildMemorySection: vi.fn(() => ''),
}));

vi.mock('../server/orchestrator/ProcessPriority.js', () => ({
  wrapExecLineWithNice: vi.fn((line: string) => line),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('PtyManager bad work_dir fail-fast', () => {
  const BAD_PATH = '/nonexistent/path/xyz';

  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { _resetPtyManagerStateForTest } = await import('../server/orchestrator/PtyManager.js');
    _resetPtyManagerStateForTest();
    await cleanupTestDb();
  });

  it('fails immediately with no tmux/pty spawn when work_dir does not exist', async () => {
    const queries = await import('../server/db/queries.js');
    const socketMod = await import('../server/socket/SocketManager.js');
    const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

    // Insert a job with the bad work_dir, then an agent for it
    const job = queries.insertJob({
      id: 'bad-workdir-job',
      title: 'Bad workdir test',
      description: 'Test bad work_dir',
      context: null,
      priority: 0,
      status: 'running',
      work_dir: BAD_PATH,
    });
    queries.insertAgent({ id: 'bad-workdir-agent', job_id: job.id, status: 'starting' });

    // Clear mocks after DB setup so we only measure startInteractiveAgent calls
    execFileSyncMock.mockClear();

    startInteractiveAgent({ agentId: 'bad-workdir-agent', job });

    // (a) Agent status becomes 'failed' with error containing the bad path
    const agent = queries.getAgentById('bad-workdir-agent');
    expect(agent?.status).toBe('failed');
    expect(agent?.error_message).toContain(BAD_PATH);

    // (b) Job status becomes 'failed'
    const updatedJob = queries.getJobById('bad-workdir-job');
    expect(updatedJob?.status).toBe('failed');

    // (c) socket.emitAgentUpdate was called with the failed agent
    expect(socketMod.emitAgentUpdate).toHaveBeenCalledTimes(1);
    expect(socketMod.emitAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bad-workdir-agent' }),
    );

    // (d) No tmux or PTY spawn calls — the function exited before any spawn work
    const tmuxCalls = execFileSyncMock.mock.calls.filter(([cmd]: [string]) => cmd === 'tmux');
    expect(tmuxCalls).toHaveLength(0);
    const { spawn: ptySpawnMock } = await import('node-pty');
    expect(ptySpawnMock).not.toHaveBeenCalled();

    // (e) captureWithContext was called once with error containing the bad path
    const { captureWithContext } = await import('../server/instrument.js');
    expect(captureWithContext).toHaveBeenCalledTimes(1);
    expect(captureWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(BAD_PATH) }),
      expect.objectContaining({
        agent_id: 'bad-workdir-agent',
        job_id: 'bad-workdir-job',
        component: 'PtyManager',
      }),
    );

    // (f) logResilienceEvent was called once with pty_work_dir_rejected event including the bad path
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    expect(logResilienceEvent).toHaveBeenCalledTimes(1);
    expect(logResilienceEvent).toHaveBeenCalledWith(
      'pty_work_dir_rejected',
      'agent',
      'bad-workdir-agent',
      expect.objectContaining({
        job_id: 'bad-workdir-job',
        rejected_path: BAD_PATH,
        reason: 'work_dir_does_not_exist',
        work_dir: BAD_PATH,
      }),
    );
  });
});

describe('PtyManager spawning state', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { _resetPtyManagerStateForTest } = await import('../server/orchestrator/PtyManager.js');
    _resetPtyManagerStateForTest();
    await cleanupTestDb();
  });

  it('does not kill tmux sessions for agents that are still spawning', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'list-sessions') {
        return Buffer.from('orchestrator-spawning-agent\norchestrator-stale-agent\n');
      }
      return Buffer.from('');
    });

    const {
      _cleanupStaleTmuxSessionsForTest,
      _seedSpawningAgentForTest,
    } = await import('../server/orchestrator/PtyManager.js');

    _seedSpawningAgentForTest('spawning-agent');
    _cleanupStaleTmuxSessionsForTest();

    const killCalls = execFileSyncMock.mock.calls.filter(([cmd, args]) =>
      cmd === 'tmux' && Array.isArray(args) && args[0] === 'kill-session'
    );

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]?.[1]).toEqual(['kill-session', '-t', 'orchestrator-stale-agent']);
  });

  it('clears spawning state when a standalone print job switches to monitor mode', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'has-session') {
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    const {
      _isAgentSpawningForTest,
      _seedSpawningAgentForTest,
      attachPty,
    } = await import('../server/orchestrator/PtyManager.js');

    const agentId = 'standalone-agent';
    _seedSpawningAgentForTest(agentId);

    await attachPty(agentId, {
      id: 'job-1',
      title: 'Standalone print job',
      work_dir: process.cwd(),
      is_interactive: false,
      debate_role: null,
      workflow_phase: null,
    } as any);

    expect(_isAgentSpawningForTest(agentId)).toBe(false);
    expect(startTailingMock).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ id: 'job-1' }),
      expect.stringContaining(`${agentId}.ndjson`),
      0,
      null,
    );
    expect(handleJobCompletionMock).not.toHaveBeenCalled();
  });

  it('marks standalone print jobs as running once the tmux session is live', async () => {
    vi.useFakeTimers();
    try {
      const queries = await import('../server/db/queries.js');
      const { startInteractiveAgent } = await import('../server/orchestrator/PtyManager.js');

      const job = await insertTestJob({
        id: 'pty-running-job',
        title: 'Standalone print job',
        description: 'test',
        status: 'assigned',
        model: 'claude-sonnet-4-6',
        work_dir: process.cwd(),
        is_interactive: 0,
      } as any);
      queries.insertAgent({ id: 'pty-running-agent', job_id: job.id, status: 'starting' });

      startInteractiveAgent({ agentId: 'pty-running-agent', job });
      const script = fs.readFileSync(
        path.join(process.cwd(), 'data', 'agent-scripts', 'pty-running-agent.sh'),
        'utf8',
      );
      expect(script).toContain('pty-running-agent.stderr');
      expect(script).toContain('pty-running-agent.ndjson');
      expect(script).toContain('--output-format stream-json');
      await vi.advanceTimersByTimeAsync(4000);

      expect(queries.getJobById(job.id)?.status).toBe('running');
      expect(startTailingMock).toHaveBeenCalledWith(
        'pty-running-agent',
        expect.objectContaining({ id: job.id }),
        expect.stringContaining('pty-running-agent.ndjson'),
        0,
        null,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies standalone runs with partial terminal evidence as incomplete_run', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-incomplete-job',
      title: 'Incomplete standalone print job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-incomplete-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'pty-incomplete-agent.ndjson'),
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit' }] },
        }),
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(logDir, 'pty-incomplete-agent.stderr'),
      'Transport closed unexpectedly\n',
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-incomplete-agent', job as any);

    expect(resolution.status).toBe('failed');
    expect(resolution.source).toBe('incomplete_run');
    expect(resolution.errorMessage).toContain('pending tool call Edit');
    expect(resolution.errorMessage).toContain('stderr tail: Transport closed unexpectedly');
  });

  it('reports failed incomplete standalone resolutions to Sentry', async () => {
    const { reportStandaloneResolutionFailure } = await import('../server/orchestrator/PtyManager.js');
    const { captureWithContext } = await import('../server/instrument.js');

    reportStandaloneResolutionFailure('agent-1', 'job-1', 'PtyManager', {
      status: 'failed',
      source: 'incomplete_run',
      errorMessage: 'Agent session ended before emitting a final result event.',
      detail: 'terminal evidence collected without final result (3 ndjson events)',
    });

    expect(captureWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Standalone print job failed via incomplete_run'),
      }),
      expect.objectContaining({
        agent_id: 'agent-1',
        job_id: 'job-1',
        component: 'PtyManager',
        resolution_source: 'incomplete_run',
      }),
    );
  });

  it('classifies stderr-only standalone runs as incomplete_run', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-stderr-only-job',
      title: 'Stderr-only standalone print job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-stderr-only-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'pty-stderr-only-agent.stderr'),
      'Claude exited before stream-json started\n',
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-stderr-only-agent', job as any);

    expect(resolution.status).toBe('failed');
    expect(resolution.source).toBe('incomplete_run');
    expect(resolution.errorMessage).toContain('stderr tail: Claude exited before stream-json started');
    expect(resolution.errorMessage).not.toContain('parsed ');
  });

  it('does not report standalone rate-limit failures to Sentry', async () => {
    const { reportStandaloneResolutionFailure } = await import('../server/orchestrator/PtyManager.js');
    const { captureWithContext } = await import('../server/instrument.js');

    vi.mocked(captureWithContext).mockClear();

    reportStandaloneResolutionFailure('agent-1', 'job-1', 'PtyManager', {
      status: 'failed',
      source: 'rate_limit',
      errorMessage: 'Rate limited (seven_day), resets at soon',
      detail: 'resolved from ndjson rate_limit event',
    });

    expect(captureWithContext).not.toHaveBeenCalled();
  });

  it('classifies system api_retry with error_status 429 as rate_limit with a non-empty error message', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-api-retry-429-job',
      title: 'api_retry 429 test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-api-retry-429-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'pty-api-retry-429-agent.ndjson'),
      [
        JSON.stringify({ type: 'assistant', message: { content: [] } }),
        JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429, message: 'Too many requests' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-api-retry-429-agent', job as any);

    expect(resolution.status).toBe('failed');
    expect(resolution.source).toBe('rate_limit');
    expect(resolution.errorMessage).toBeTruthy();
    expect(resolution.errorMessage).toContain('429');
  });

  it('classifies system api_retry with error rate_limit (no status) as rate_limit with a non-empty error message', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-api-retry-rl-job',
      title: 'api_retry rate_limit test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-api-retry-rl-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'pty-api-retry-rl-agent.ndjson'),
      [
        JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-api-retry-rl-agent', job as any);

    expect(resolution.status).toBe('failed');
    expect(resolution.source).toBe('rate_limit');
    expect(resolution.errorMessage).toBeTruthy();
    expect(resolution.errorMessage).toContain('rate_limit');
  });

  it('a result event after system api_retry takes precedence', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-api-retry-result-job',
      title: 'api_retry with later result test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-api-retry-result-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    // api_retry appears first (earlier in file), result event is last (wins)
    fs.writeFileSync(
      path.join(logDir, 'pty-api-retry-result-agent.ndjson'),
      [
        JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429 }),
        JSON.stringify({ type: 'result', is_error: false, result: 'Task complete' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-api-retry-result-agent', job as any);

    expect(resolution.status).toBe('done');
    expect(resolution.source).toBe('result');
  });

  it('ambiguous system api_retry without explicit rate-limit markers remains incomplete_run', async () => {
    const queries = await import('../server/db/queries.js');
    const { _resolveStandalonePrintJobOutcomeForTest } = await import('../server/orchestrator/PtyManager.js');

    const job = queries.insertJob({
      id: 'pty-api-retry-ambig-job',
      title: 'api_retry ambiguous test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running',
      is_interactive: 0,
      work_dir: null,
    });
    queries.insertAgent({ id: 'pty-api-retry-ambig-agent', job_id: job.id, status: 'running' });

    const logDir = path.join(process.cwd(), 'data', 'agent-logs');
    fs.mkdirSync(logDir, { recursive: true });
    // api_retry but no error_status 429 or error: 'rate_limit'
    fs.writeFileSync(
      path.join(logDir, 'pty-api-retry-ambig-agent.ndjson'),
      [
        JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 500, error: 'server_error' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const resolution = _resolveStandalonePrintJobOutcomeForTest('pty-api-retry-ambig-agent', job as any);

    expect(resolution.source).toBe('incomplete_run');
  });

  it('does not report system api_retry rate_limit resolutions to Sentry', async () => {
    const { reportStandaloneResolutionFailure } = await import('../server/orchestrator/PtyManager.js');
    const { captureWithContext } = await import('../server/instrument.js');

    vi.mocked(captureWithContext).mockClear();

    reportStandaloneResolutionFailure('agent-2', 'job-2', 'PtyManager', {
      status: 'failed',
      source: 'rate_limit',
      errorMessage: 'API rate limited (HTTP 429) Too many requests',
      detail: 'resolved from system api_retry event',
    });

    expect(captureWithContext).not.toHaveBeenCalled();
  });
});
