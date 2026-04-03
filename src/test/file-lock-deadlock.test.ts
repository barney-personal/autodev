/**
 * Tests for automatic deadlock recovery in FileLockRegistry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, createSocketMock } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock McpServer's hasActiveTransport — default: no active transport
const mockHasActiveTransport = vi.fn(() => false);
vi.mock('../server/mcp/McpServer.js', () => ({
  hasActiveTransport: (...args: any[]) => mockHasActiveTransport(...args),
}));

// Mock ResilienceLogger to capture calls
const mockLogResilienceEvent = vi.fn();
vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: (...args: any[]) => mockLogResilienceEvent(...args),
}));

describe('FileLockRegistry - automatic deadlock recovery', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/FileLockRegistry.js');
    _resetForTest();
    mockHasActiveTransport.mockReturnValue(false);
    mockLogResilienceEvent.mockClear();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  async function insertAgentWithLock(agentId: string, filePath: string, updatedAt?: number) {
    const queries = await import('../server/db/queries.js');
    const jobId = randomUUID();
    queries.insertJob({
      id: jobId,
      title: 'test',
      description: 'test',
      context: null,
      priority: 0,
      status: 'running' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null,
      project_id: null,
      work_dir: null,
      model: null,
    });
    queries.insertAgent({
      id: agentId,
      job_id: jobId,
      status: 'running' as any,
      updated_at: updatedAt ?? Date.now() - 10_000, // >5s ago by default
    });
    const lockId = randomUUID();
    const now = Date.now();
    queries.insertFileLock({
      id: lockId,
      agent_id: agentId,
      file_path: filePath,
      reason: 'test lock',
      acquired_at: now,
      expires_at: now + 600_000,
      released_at: null,
    });
    return { jobId, lockId };
  }

  it('auto-resolves deadlock when holder has no active transport', async () => {
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const socket = await import('../server/socket/SocketManager.js');
    const queries = await import('../server/db/queries.js');

    // Agent A holds /f1, Agent B holds /f2
    // Make A's lock older (lower acquired_at) so it's the one released
    const { lockId: lockA } = await insertAgentWithLock('agent-a', '/f1');
    // Small delay to ensure B's lock has a higher acquired_at
    await new Promise(r => setTimeout(r, 5));
    await insertAgentWithLock('agent-b', '/f2');

    const registry = getFileLockRegistry();

    // Both agents try to acquire the other's file concurrently.
    // Agent B will detect the deadlock (A registers in waitingFor first, then yields).
    const resultA = registry.acquire('agent-a', ['/f2'], null, 60_000, 1_000);
    const resultB = registry.acquire('agent-b', ['/f1'], null, 60_000, 1_000);

    const [a, b] = await Promise.all([resultA, resultB]);

    // Agent B should have auto-resolved the deadlock and acquired /f1
    expect(b.success).toBe(true);
    expect(b.acquired).toContain('/f1');

    // Agent A should time out (B still holds /f2 and A's lock on /f1 was released)
    expect(a.success).toBe(false);

    // Verify resilience event was logged
    expect(mockLogResilienceEvent).toHaveBeenCalledWith(
      'deadlock_resolved',
      'lock',
      expect.any(String),
      expect.objectContaining({
        cycle_agents: expect.arrayContaining(['agent-a', 'agent-b']),
        released_agent: 'agent-a',
        released_file: '/f1',
      }),
    );

    // Verify socket event was emitted
    expect(vi.mocked(socket.emitDeadlockResolved)).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_agents: expect.arrayContaining(['agent-a', 'agent-b']),
        released_agent: 'agent-a',
        released_file: '/f1',
      }),
    );

    // Verify the deadlock resolution counter
    expect(registry.getDeadlockResolutionCount()).toBe(1);
  });

  it('returns deadlock_detected when holder has active transport', async () => {
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');

    // Agent A holds /f1, Agent B holds /f2
    await insertAgentWithLock('agent-a', '/f1');
    await new Promise(r => setTimeout(r, 5));
    await insertAgentWithLock('agent-b', '/f2');

    // Both agents have active MCP transports
    mockHasActiveTransport.mockReturnValue(true);

    const registry = getFileLockRegistry();

    const resultA = registry.acquire('agent-a', ['/f2'], null, 60_000, 1_000);
    const resultB = registry.acquire('agent-b', ['/f1'], null, 60_000, 1_000);

    const [a, b] = await Promise.all([resultA, resultB]);

    // One of them should get deadlock_detected (B detects first, can't auto-resolve,
    // then A detects on its next cycle)
    const deadlocked = [a, b].filter(r => r.deadlock_detected);
    expect(deadlocked.length).toBeGreaterThanOrEqual(1);

    // No auto-resolution should have happened
    expect(mockLogResilienceEvent).not.toHaveBeenCalledWith(
      'deadlock_resolved',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    expect(registry.getDeadlockResolutionCount()).toBe(0);
  });

  it('does not auto-resolve when holder has recent activity', async () => {
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');

    // Agent A has very recent activity (updated_at < 5s ago)
    await insertAgentWithLock('agent-a', '/f1', Date.now() - 1_000);
    await new Promise(r => setTimeout(r, 5));
    await insertAgentWithLock('agent-b', '/f2');

    // No active transport, but recent activity
    mockHasActiveTransport.mockReturnValue(false);

    const registry = getFileLockRegistry();

    const resultA = registry.acquire('agent-a', ['/f2'], null, 60_000, 1_000);
    const resultB = registry.acquire('agent-b', ['/f1'], null, 60_000, 1_000);

    const [a, b] = await Promise.all([resultA, resultB]);

    // Should not auto-resolve since agent-a has recent activity
    const deadlocked = [a, b].filter(r => r.deadlock_detected);
    expect(deadlocked.length).toBeGreaterThanOrEqual(1);

    expect(registry.getDeadlockResolutionCount()).toBe(0);
  });
});
