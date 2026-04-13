/**
 * Tests for slow-progress detection in StuckJobWatchdog (M5).
 *
 * Verifies:
 * 1. Milestone progress resets the snapshot timer
 * 2. 15 min no-progress triggers a warning
 * 3. 30 min no-progress triggers a workflow block
 * 4. Non-implement-phase jobs are ignored
 * 5. Snapshot cleanup on workflow completion
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock child_process (tmux calls in watchdog)
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'tmux' && args[0] === 'list-sessions') {
      return ''; // no tmux sessions
    }
    return '';
  }),
}));

// Mock PtyManager — return true for isTmuxSessionAlive so Check 1 doesn't kill our agents
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => true),
  startInteractiveAgent: vi.fn(),
  saveSnapshot: vi.fn(),
}));

// Mock AgentRunner
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  getLogPath: vi.fn(() => '/dev/null'),
  _resetCompletedJobsForTest: vi.fn(),
}));

// Mock FileLockRegistry
vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

// Mock McpServer
vi.mock('../server/mcp/McpServer.js', () => ({
  orphanedWaits: new Map(),
  disconnectedAgents: new Map(),
  hasActiveTransport: vi.fn(() => false),
}));

// Mock DebateManager
vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
}));

// Mock WorkflowManager — keep parseMilestones real, mock the rest
const _actualParseMilestones = vi.fn((text: string) => {
  let done = 0, unchecked = 0;
  for (const line of text.split('\n')) {
    if (/^[\t ]*[-*][\t ]+\[[xX]\]/.test(line)) done++;
    else if (/^[\t ]*[-*][\t ]+\[\s?\]/.test(line)) unchecked++;
  }
  return { total: done + unchecked, done };
});
const _writeBlockedDiagnostic = vi.fn();
vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  parseMilestones: _actualParseMilestones,
  writeBlockedDiagnostic: _writeBlockedDiagnostic,
  _resetForTest: vi.fn(),
}));

// Mock ResilienceLogger
const _logResilienceEvent = vi.fn();
vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: _logResilienceEvent,
}));

// Mock RetryManager
vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

// Mock ModelClassifier
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
  markModelRateLimited: vi.fn(),
  getFallbackModel: vi.fn((m: string) => m),
  getModelProvider: vi.fn(() => 'anthropic'),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

// Mock FailureClassifier
vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyFailureText: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

// Mock RecoveryLedger
vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(() => true),
}));

// Mock WorkQueueManager
vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

// Mock ProcessPriority
vi.mock('../server/orchestrator/ProcessPriority.js', () => ({
  _resetForTest: vi.fn(),
}));

// Mock Sentry instrument
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('StuckJobWatchdog: slow-progress detection', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    // Reset the milestone snapshots between tests
    const { _resetMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    _resetMilestoneSnapshotsForTest();
  });

  afterEach(async () => {
    const { stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    stopWatchdog();
    await cleanupTestDb();
  });

  /** Helper: insert a workflow + job + agent for testing slow progress */
  async function setupWorkflowWithAgent(opts: {
    workflowStatus?: string;
    phase?: string;
    milestonesPlan: string;
    agentUpdatedAt?: number;
  }) {
    const queries = await import('../server/db/queries.js');
    const db = (await import('../server/db/database.js')).getDb();

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: opts.workflowStatus ?? 'running',
      current_phase: opts.phase ?? 'implement',
      current_cycle: 1,
      max_cycles: 10,
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: opts.phase ?? 'implement',
      status: 'running',
      project_id: project.id,
    });

    // Update job status to running (insertTestJob may use queued)
    queries.updateJobStatus(job.id, 'running');

    const agentId = randomUUID();
    queries.insertAgent({
      id: agentId,
      job_id: job.id,
      status: 'running',
    });
    // Set the agent's updated_at to simulate active/inactive
    const agentUpdatedAt = opts.agentUpdatedAt ?? Date.now();
    db.prepare('UPDATE agents SET updated_at = ?, status = ? WHERE id = ?')
      .run(agentUpdatedAt, 'running', agentId);

    // Write the plan note
    queries.upsertNote(`workflow/${workflow.id}/plan`, opts.milestonesPlan, null);

    return { workflowId: workflow.id, jobId: job.id, agentId, projectId: project.id };
  }

  it('creates initial snapshot on first observation, no warning', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now() - 10 * 60 * 1000,
    });

    // Manually trigger just the check function by starting/stopping
    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Should have created a snapshot with 1 milestone done
    const snapshot = _getMilestoneSnapshotsForTest().get(workflowId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.milestonesDone).toBe(1);

    // No warnings or blocks
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('seeds implement workflow snapshots on watchdog startup for restart resilience (Fix-C4b)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    const beforeStart = Date.now();
    const { workflowId, agentId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [x] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(),
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    const snapshot = _getMilestoneSnapshotsForTest().get(workflowId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.milestonesDone).toBe(2);
    expect(snapshot!.checkedAt).toBeLessThanOrEqual(beforeStart - 15 * 60 * 1000 + 5000);
    expect(snapshot!.checkedAt).toBeGreaterThanOrEqual(beforeStart - 15 * 60 * 1000 - 5000);
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'slow_progress_warning',
      'workflow',
      workflowId,
      expect.objectContaining({
        agent_id: agentId,
        milestones_done: 2,
      }),
    );
  });

  it('resets snapshot timer when milestone progress is detected', async () => {
    const { _getMilestoneSnapshotsForTest, _resetMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
    });

    // Pre-seed a snapshot with stale time and 0 milestones done
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 0,
      checkedAt: Date.now() - 20 * 60 * 1000, // 20 min ago
    });

    // Now plan shows 1 done — progress!
    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Snapshot should be reset with new milestonesDone=1 and recent checkedAt
    const snapshot = _getMilestoneSnapshotsForTest().get(workflowId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.milestonesDone).toBe(1);
    expect(Date.now() - snapshot!.checkedAt).toBeLessThan(5000);

    // No warnings since progress was made
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('emits warning at 15 min no-progress threshold', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const socket = await import('../server/socket/SocketManager.js');

    const { workflowId, agentId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(), // agent is active
    });

    // Pre-seed snapshot: 1 milestone done, 16 minutes ago
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1, // same as current — no progress
      checkedAt: Date.now() - 16 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Should have logged a slow_progress_warning
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'slow_progress_warning',
      'workflow',
      workflowId,
      expect.objectContaining({
        agent_id: agentId,
        milestones_done: 1,
      }),
    );

    // Should have emitted a warning via socket
    expect(socket.emitWarningNew).toHaveBeenCalled();
  });

  it('blocks workflow at 30 min no-progress threshold', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    const { workflowId, agentId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(), // agent is active
    });

    // Pre-seed snapshot: 1 milestone done, 31 minutes ago
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1,
      checkedAt: Date.now() - 31 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Workflow should be blocked
    const updated = queries.getWorkflowById(workflowId);
    expect(updated!.status).toBe('blocked');
    expect(updated!.blocked_reason).toContain('Slow progress');
    expect(updated!.blocked_reason).toContain('1 milestones done');

    // Should have logged a slow_progress_block
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'slow_progress_block',
      'workflow',
      workflowId,
      expect.objectContaining({
        agent_id: agentId,
        milestones_done: 1,
      }),
    );

    // Snapshot should be cleaned up after block
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);

    // Socket update emitted
    expect(socket.emitWorkflowUpdate).toHaveBeenCalled();
  });

  it('ignores non-implement-phase jobs', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    await setupWorkflowWithAgent({
      phase: 'review',
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(),
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // No snapshot created for review-phase agent
    expect(_getMilestoneSnapshotsForTest().size).toBe(0);
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('cleans up snapshot when workflow completes', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    const { workflowId } = await setupWorkflowWithAgent({
      workflowStatus: 'complete',
      milestonesPlan: '- [x] M1\n- [x] M2\n- [x] M3',
    });

    // Pre-seed a snapshot
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 2,
      checkedAt: Date.now() - 40 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Snapshot should be cleaned up (workflow is complete, not running)
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('does not emit duplicate warning when one already exists (Fix-M5a)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    const { workflowId, agentId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(), // agent is active
    });

    // Pre-seed snapshot: no progress for 16 min (past warn threshold)
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1,
      checkedAt: Date.now() - 16 * 60 * 1000,
    });

    // Pre-insert an undismissed slow_progress warning for this agent
    queries.insertWarning({
      id: randomUUID(),
      agent_id: agentId,
      type: 'slow_progress',
      message: 'Already warned',
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Should NOT have logged another warning (dedup guard)
    expect(_logResilienceEvent).not.toHaveBeenCalled();
    // Socket should not emit a duplicate warning
    expect(socket.emitWarningNew).not.toHaveBeenCalled();
  });

  it('resets snapshot when milestone count decreases (Fix-C3a)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [x] M2\n- [x] M3\n- [ ] M4\n- [ ] M5',
      agentUpdatedAt: Date.now(), // agent is active
    });

    // Pre-seed snapshot: 5 milestones done, stalled for 20 min
    // (simulates reviewer unchecking items or plan consolidation)
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 5,
      checkedAt: Date.now() - 20 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Snapshot should reset to current count (3 done), NOT trigger warning/block
    const snapshot = _getMilestoneSnapshotsForTest().get(workflowId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.milestonesDone).toBe(3);
    expect(Date.now() - snapshot!.checkedAt).toBeLessThan(5000);

    // No warnings or blocks — milestone count change means plan is being actively modified
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('clears snapshot when plan note is missing to prevent false stall (Fix-C3b)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(), // agent is active
    });

    // Pre-seed a stale snapshot (20 min ago — past both warn and block thresholds)
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1,
      checkedAt: Date.now() - 20 * 60 * 1000,
    });

    // Remove the plan note to simulate temporary unavailability
    queries.deleteNote(`workflow/${workflowId}/plan`);

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Snapshot should be deleted — not left with stale checkedAt
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);

    // Resilience event should be logged for the stale snapshot being cleared (Fix-C5a)
    expect(_logResilienceEvent).toHaveBeenCalledOnce();
    expect(_logResilienceEvent).toHaveBeenCalledWith(
      'slow_progress_snapshot_cleared',
      'workflow',
      workflowId,
      expect.objectContaining({
        reason: 'plan_note_missing',
        stale_milestones_done: 1,
        stale_checked_at: expect.any(Number),
      }),
    );

    // Verify stale_checked_at is a valid recent timestamp (Fix-C6a)
    const eventData = _logResilienceEvent.mock.calls[0][3];
    expect(eventData.stale_checked_at).toBeLessThanOrEqual(Date.now());
    expect(eventData.stale_checked_at).toBeGreaterThan(Date.now() - 25 * 60 * 1000);

    // No warnings or blocks should be emitted
    expect(socket.emitWarningNew).not.toHaveBeenCalled();
    expect(socket.emitWorkflowUpdate).not.toHaveBeenCalled();
  });

  it('does not log event when plan note is missing but no snapshot exists (Fix-C5a)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(),
    });

    // Remove the plan note — no snapshot was ever created
    queries.deleteNote(`workflow/${workflowId}/plan`);
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // No snapshot existed, so no resilience event should be logged
    expect(_logResilienceEvent).not.toHaveBeenCalled();
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);
  });

  it('creates fresh baseline after plan note reappears (Fix-C5b)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4',
      agentUpdatedAt: Date.now() - 10 * 60 * 1000,
    });

    // Step 1: Seed a snapshot (simulates prior watchdog observation)
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 2,
      checkedAt: Date.now() - 20 * 60 * 1000, // 20 min stale
    });

    // Step 2: Delete the plan note → watchdog clears snapshot
    queries.deleteNote(`workflow/${workflowId}/plan`);

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Snapshot should be cleared (verified by Fix-C3b, but confirm here)
    expect(_getMilestoneSnapshotsForTest().has(workflowId)).toBe(false);
    expect(_logResilienceEvent).toHaveBeenCalledOnce(); // snapshot_cleared event

    // Step 3: Restore the plan note (with 3 milestones done now — simulates progress during repair)
    queries.upsertNote(`workflow/${workflowId}/plan`, '- [x] M1\n- [x] M2\n- [x] M3\n- [ ] M4', null);
    vi.clearAllMocks();

    // Step 4: Run watchdog again → should create fresh baseline
    startWatchdog();
    stopWatchdog();

    // New snapshot should exist with correct milestone count and fresh timestamp
    const snapshot = _getMilestoneSnapshotsForTest().get(workflowId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.milestonesDone).toBe(3);
    expect(Date.now() - snapshot!.checkedAt).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(Date.now() - snapshot!.checkedAt).toBeLessThan(15 * 60 * 1000 + 5000);

    // No warnings or blocks — fresh baseline, not a stall
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('does not warn if agent is inactive (updated_at > 5 min ago)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now() - 10 * 60 * 1000, // inactive for 10 min
    });

    // Pre-seed snapshot: no progress for 20 min
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1,
      checkedAt: Date.now() - 20 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Agent is inactive — idle detection handles this, not slow-progress
    expect(_logResilienceEvent).not.toHaveBeenCalled();
  });

  it('calls writeBlockedDiagnostic when slow-progress blocks a workflow (Fix-C10b)', async () => {
    const { _getMilestoneSnapshotsForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const queries = await import('../server/db/queries.js');

    const { workflowId } = await setupWorkflowWithAgent({
      milestonesPlan: '- [x] M1\n- [ ] M2\n- [ ] M3',
      agentUpdatedAt: Date.now(),
    });

    // Pre-seed snapshot: 1 milestone done, 31 minutes ago
    _getMilestoneSnapshotsForTest().set(workflowId, {
      milestonesDone: 1,
      checkedAt: Date.now() - 31 * 60 * 1000,
    });

    const { startWatchdog, stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    startWatchdog();
    stopWatchdog();

    // Workflow should be blocked
    const updated = queries.getWorkflowById(workflowId);
    expect(updated!.status).toBe('blocked');

    // writeBlockedDiagnostic should have been called with the blocked workflow
    expect(_writeBlockedDiagnostic).toHaveBeenCalledTimes(1);
    expect(_writeBlockedDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        id: workflowId,
        status: 'blocked',
      }),
    );
  });
});
