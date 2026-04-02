import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  startWorkflow: vi.fn((wf: any) => ({
    id: 'assess-job-id',
    title: 'Assess',
    status: 'queued',
    workflow_id: wf.id,
    workflow_phase: 'assess',
    workflow_cycle: 0,
  })),
}));

describe('createAutonomousAgentRunHandler', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('creates an autonomous agent run and emits a workflow event', async () => {
    const { createAutonomousAgentRunHandler } = await import('../server/mcp/tools/createAutonomousAgentRun.js');
    const socket = await import('../server/socket/SocketManager.js');
    const payload = JSON.parse(await createAutonomousAgentRunHandler('agent-1', {
      task: 'Audit and improve the repo',
      workDir: '/tmp/repo',
      useWorktree: true,
    }));

    expect(payload.autonomous_agent_run_id).toBeTruthy();
    expect(payload.assess_job_id).toBe('assess-job-id');
    expect(socket.emitWorkflowNew).toHaveBeenCalledTimes(1);
  });
});
