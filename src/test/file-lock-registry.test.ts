/**
 * Regression tests for FileLockRegistry conflict detection.
 *
 * Covers normalized path helpers, direct + checkout conflict interplay,
 * sibling-prefix non-overlap, expired locks, and release with non-canonical inputs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { setupTestDb, cleanupTestDb, createSocketMock } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/mcp/McpServer.js', () => ({
  hasActiveTransport: vi.fn(() => false),
}));

async function insertAgentForLock(agentId: string, updatedAt?: number) {
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
    updated_at: updatedAt ?? Date.now(),
  });
  return jobId;
}

async function insertLockRow(opts: {
  agentId: string;
  filePath: string;
  ttlMs?: number;
  expiresOverride?: number;
  acquiredAt?: number;
}) {
  const queries = await import('../server/db/queries.js');
  const id = randomUUID();
  const now = Date.now();
  queries.insertFileLock({
    id,
    agent_id: opts.agentId,
    file_path: opts.filePath,
    reason: 'test',
    acquired_at: opts.acquiredAt ?? now,
    expires_at: opts.expiresOverride ?? (now + (opts.ttlMs ?? 600_000)),
    released_at: null,
  });
  return id;
}

describe('FileLockRegistry - path helpers', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/FileLockRegistry.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('normalizeLockPath strips trailing slash and collapses . / .. segments', async () => {
    const { normalizeLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(normalizeLockPath('/repo/src/foo.ts')).toBe('/repo/src/foo.ts');
    expect(normalizeLockPath('/repo/src/foo.ts/')).toBe('/repo/src/foo.ts');
    expect(normalizeLockPath('/repo/src/./bar/../foo.ts')).toBe('/repo/src/foo.ts');
    expect(normalizeLockPath('/repo//src///foo.ts')).toBe('/repo/src/foo.ts');
  });

  it('normalizeLockPath delegates checkout-prefixed input to normalizeCheckoutLockPath', async () => {
    const { normalizeLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(normalizeLockPath('checkout::/repo/')).toBe('checkout::/repo');
    expect(normalizeLockPath('checkout::/repo/./a/../b/')).toBe('checkout::/repo/b');
  });

  it('normalizeLockPath resolves relative paths against cwd', async () => {
    const { normalizeLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(normalizeLockPath('foo.ts')).toBe(path.resolve('foo.ts'));
  });

  it('normalizeCheckoutLockPath accepts both prefixed and bare directory inputs', async () => {
    const { normalizeCheckoutLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(normalizeCheckoutLockPath('checkout::/repo/')).toBe('checkout::/repo');
    expect(normalizeCheckoutLockPath('/repo/')).toBe('checkout::/repo');
  });

  it('isPathWithin recognises equal and nested paths but rejects siblings', async () => {
    const { isPathWithin } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(isPathWithin('/repo/src', '/repo/src')).toBe(true);
    expect(isPathWithin('/repo/src', '/repo/src/foo.ts')).toBe(true);
    expect(isPathWithin('/repo/src', '/repo/src/a/b/c')).toBe(true);
    // Sibling prefix MUST NOT match — this is the primary correctness fix.
    expect(isPathWithin('/repo/src', '/repo/src2')).toBe(false);
    expect(isPathWithin('/repo/src', '/repo/src2/foo.ts')).toBe(false);
    expect(isPathWithin('/repo/src', '/repo')).toBe(false);
    expect(isPathWithin('/repo/src', '/other/src/foo.ts')).toBe(false);
  });

  it('isPathWithin tolerates trailing slashes and . segments', async () => {
    const { isPathWithin } = await import('../server/orchestrator/FileLockRegistry.js');
    expect(isPathWithin('/repo/src/', '/repo/src/foo.ts')).toBe(true);
    expect(isPathWithin('/repo/src', '/repo/src/./foo.ts')).toBe(true);
  });
});

describe('FileLockRegistry - conflict detection', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/FileLockRegistry.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('blocks a direct lock when another agent already holds it', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/foo.ts' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]?.held_by).toBe('agent-a');
  });

  it('checkout lock blocks file locks under its directory', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: 'checkout::/repo' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.blocked.some(b => b.held_by === 'agent-a')).toBe(true);
  });

  it('existing file lock blocks a new checkout lock covering it', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/foo.ts' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['checkout::/repo'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.blocked.some(b => b.held_by === 'agent-a' && b.file === '/repo/src/foo.ts')).toBe(true);
  });

  it('sibling-prefix paths do not collide (/repo/src2 must not block /repo/src)', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: 'checkout::/repo/src2' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(true);
    expect(r.acquired).toEqual(['/repo/src/foo.ts']);
  });

  it('non-canonical input path (./ and trailing slash) reaches the same lock row', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    const { getFileLockRegistry, normalizeLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    const r1 = await getFileLockRegistry().acquire('agent-a', ['/repo/src/./foo.ts'], null, 60_000, 50);
    expect(r1.success).toBe(true);
    expect(r1.acquired).toEqual([normalizeLockPath('/repo/src/foo.ts')]);

    // Another agent attempting the same logical path via a different spelling must be blocked.
    const r2 = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts/'], null, 60_000, 50);
    expect(r2.success).toBe(false);
    expect(r2.timed_out).toBe(true);
  });

  it('release accepts a normalized-equivalent path even if input is non-canonical', async () => {
    await insertAgentForLock('agent-a');
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const reg = getFileLockRegistry();
    const r1 = await reg.acquire('agent-a', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r1.success).toBe(true);

    const released = reg.release('agent-a', ['/repo/src/./foo.ts/']);
    expect(released).toEqual(['/repo/src/foo.ts']);
  });

  it('expired locks do not block but releaseAll still emits release events for them', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    const now = Date.now();
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/foo.ts', expiresOverride: now - 1_000, acquiredAt: now - 5_000 });

    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const socket = await import('../server/socket/SocketManager.js');
    const reg = getFileLockRegistry();

    // Expired lock must not block agent-b.
    const r = await reg.acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(true);

    // releaseAll on the original holder must still emit lock:released for the
    // stale row so the dashboard does not display expired locks forever.
    vi.mocked(socket.emitLockReleased).mockClear();
    reg.releaseAll('agent-a');
    expect(socket.emitLockReleased).toHaveBeenCalledWith(expect.any(String), '/repo/src/foo.ts');
  });

  it('same-agent does not block itself', async () => {
    await insertAgentForLock('agent-a');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/foo.ts' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    // Agent re-acquiring its own checkout lock should not be blocked by its own file lock.
    const r = await getFileLockRegistry().acquire('agent-a', ['checkout::/repo'], null, 60_000, 50);
    expect(r.success).toBe(true);
  });
});

describe('FileLockRegistry - legacy non-canonical row compatibility', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/FileLockRegistry.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('legacy non-canonical direct row blocks a normalized acquire', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    // Simulate a row inserted before normalization landed — raw, non-canonical path.
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/./foo.ts' });

    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.blocked[0]?.held_by).toBe('agent-a');
  });

  it('release() with normalized input releases a legacy non-canonical row', async () => {
    await insertAgentForLock('agent-a');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/foo.ts/' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const reg = getFileLockRegistry();
    const released = reg.release('agent-a', ['/repo/src/foo.ts']);
    expect(released).toEqual(['/repo/src/foo.ts']);
    // And the legacy row must now be releasable a second time as a no-op.
    expect(reg.release('agent-a', ['/repo/src/foo.ts'])).toEqual([]);
  });

  it('legacy non-canonical child row blocks a new checkout acquire', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/./src/foo.ts' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['checkout::/repo'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.blocked.some(b => b.held_by === 'agent-a')).toBe(true);
  });

  it('direct lock exactly at the checkout dir blocks the checkout acquire', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    // Acquiring a non-checkout lock on the directory itself is unusual but
    // legal — it must still conflict with a checkout of the same path.
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['checkout::/repo'], null, 60_000, 50);
    expect(r.success).toBe(false);
    expect(r.blocked.some(b => b.held_by === 'agent-a' && b.file === '/repo')).toBe(true);
  });

  it('sibling-prefix legacy row still does not collide', async () => {
    await insertAgentForLock('agent-a');
    await insertAgentForLock('agent-b');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src2/./foo.ts' });
    const { getFileLockRegistry } = await import('../server/orchestrator/FileLockRegistry.js');
    const r = await getFileLockRegistry().acquire('agent-b', ['/repo/src/foo.ts'], null, 60_000, 50);
    expect(r.success).toBe(true);
  });

  it('/api/locks/check returns locked:true for a legacy row owned by the agent', async () => {
    const queries = await import('../server/db/queries.js');
    const { normalizeLockPath } = await import('../server/orchestrator/FileLockRegistry.js');
    await insertAgentForLock('agent-a');
    await insertLockRow({ agentId: 'agent-a', filePath: '/repo/src/./foo.ts/' });

    // Simulate what /api/locks/check does after normalizing the file param.
    const normFile = normalizeLockPath('/repo/src/foo.ts');
    const directLocks = queries.getAllActiveDirectFileLocks();
    const locked = directLocks.some(
      l => l.agent_id === 'agent-a' && normalizeLockPath(l.file_path) === normFile,
    );
    expect(locked).toBe(true);
  });
});
