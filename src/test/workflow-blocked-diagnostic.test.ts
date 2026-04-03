/**
 * Tests for writeBlockedDiagnostic (Fix-C10a).
 *
 * Verifies:
 * (a) Diagnostic file is written with correct content (title, blocked reason, job history)
 * (b) Most recent agent (agents[0] from DESC ordering) is used for failed job details
 * (c) Handles workflow with no failed jobs gracefully
 * (d) Handles job with no agents gracefully
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture writeFileSync calls to verify diagnostic content
const writeFileSyncSpy = vi.fn();
const mkdirSyncSpy = vi.fn();

vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => true),
  };
});

// Need to mock child_process for execSync (git status/log in diagnostic)
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
}));

let queries: typeof import('../server/db/queries.js');

describe('writeBlockedDiagnostic', () => {
  let project: any;

  beforeEach(async () => {
    await setupTestDb();
    queries = await import('../server/db/queries.js');
    project = await insertTestProject();
    writeFileSyncSpy.mockClear();
    mkdirSyncSpy.mockClear();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('(a) writes diagnostic file with workflow title, blocked reason, and job history', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'My Test Workflow',
      status: 'blocked',
      current_phase: 'implement',
      current_cycle: 3,
    });

    // Update workflow with blocked_reason (insertTestWorkflow doesn't support it directly)
    queries.updateWorkflow(workflow.id, { blocked_reason: 'zero_progress_exceeded' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    // Insert a done job and a failed job
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      workflow_cycle: 2,
      status: 'done',
      title: 'Implement cycle 2',
    });

    const failedJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      workflow_cycle: 3,
      status: 'failed',
      title: 'Implement cycle 3',
    });

    // Insert an agent for the failed job
    queries.insertAgent({
      id: 'agent-newest-111',
      job_id: failedJob.id,
      pid: 12345,
      tmux_session: null,
      status: 'failed',
      error_message: 'Rate limit exceeded',
      exit_code: 1,
      started_at: Date.now(),
      finished_at: Date.now(),
      num_turns: 15,
      cost_usd: 1.5,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    writeBlockedDiagnostic(updated);

    expect(mkdirSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('blocked-diagnostics'),
      { recursive: true },
    );
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);

    const [filePath, content] = writeFileSyncSpy.mock.calls[0];
    expect(filePath).toContain('blocked-diagnostics/');
    expect(filePath).toContain(workflow.id.slice(0, 8));
    expect(filePath).toMatch(/\.md$/);

    // Verify content includes key fields
    expect(content).toContain('My Test Workflow');
    expect(content).toContain('zero_progress_exceeded');
    expect(content).toContain('implement');
    expect(content).toContain('Implement cycle 3');
    expect(content).toContain('Rate limit exceeded');
    expect(content).toContain('agent-ne'); // agent ID sliced to 8 chars
  });

  it('(b) uses most recent agent (agents[0] from DESC ordering) for failed job details', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'Agent Ordering Test',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'test_block' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    const failedJob = await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      status: 'failed',
      title: 'Failed job',
    });

    // Insert TWO agents for the same job — older first, newer second
    // getAgentsWithJobByJobId orders by started_at DESC, so agents[0] = newest
    queries.insertAgent({
      id: 'agent-old-xxxxxxx',
      job_id: failedJob.id,
      pid: 1000,
      tmux_session: null,
      status: 'failed',
      error_message: 'OLD agent error - should not appear',
      exit_code: 1,
      started_at: Date.now() - 60000,
      finished_at: Date.now() - 50000,
      num_turns: 5,
      cost_usd: 0.5,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    queries.insertAgent({
      id: 'agent-new-xxxxxxx',
      job_id: failedJob.id,
      pid: 2000,
      tmux_session: null,
      status: 'failed',
      error_message: 'NEW agent error - should appear',
      exit_code: 2,
      started_at: Date.now(),
      finished_at: Date.now(),
      num_turns: 10,
      cost_usd: 1.0,
      model: 'claude-sonnet-4-6',
      parent_agent_id: null,
    } as any);

    writeBlockedDiagnostic(updated);

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const content = writeFileSyncSpy.mock.calls[0][1] as string;

    // Should contain the NEW agent's error (most recent = agents[0] due to DESC ordering)
    expect(content).toContain('NEW agent error - should appear');
    expect(content).toContain('agent-ne'); // agent-new-xxxxxxx sliced to 8 chars
    // Should NOT contain the OLD agent's error
    expect(content).not.toContain('OLD agent error - should not appear');
  });

  it('(c) handles workflow with no failed jobs', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'No Failed Jobs Workflow',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'manual_block' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    // Only insert a done job — no failures
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'assess',
      status: 'done',
      title: 'Assess phase',
    });

    writeBlockedDiagnostic(updated);

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const content = writeFileSyncSpy.mock.calls[0][1] as string;
    expect(content).toContain('No Failed Jobs Workflow');
    expect(content).toContain('No failed jobs.');
  });

  it('(d) handles failed job with no agents', async () => {
    const { writeBlockedDiagnostic } = await import('../server/orchestrator/WorkflowManager.js');

    const workflow = await insertTestWorkflow({
      project_id: project.id,
      title: 'No Agent Workflow',
      status: 'blocked',
    });
    queries.updateWorkflow(workflow.id, { blocked_reason: 'stuck' } as any);
    const updated = queries.getWorkflowById(workflow.id)!;

    // Failed job but no agent inserted
    await insertTestJob({
      workflow_id: workflow.id,
      workflow_phase: 'implement',
      status: 'failed',
      title: 'Orphan failed job',
    });

    // Should not throw
    writeBlockedDiagnostic(updated);

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const content = writeFileSyncSpy.mock.calls[0][1] as string;
    expect(content).toContain('No Agent Workflow');
    expect(content).toContain('Orphan failed job');
    expect(content).toContain('n/a'); // agent_id fallback
    expect(content).toContain('no agent error recorded'); // error fallback
  });
});
