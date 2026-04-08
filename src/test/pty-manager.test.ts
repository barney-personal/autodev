import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, createSocketMock, setupTestDb } from './helpers.js';

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
});
