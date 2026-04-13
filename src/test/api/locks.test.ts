import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestJob } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());

let app: express.Express;

/** Create an agent+job so we have a valid agent_id for the FK constraint on file_locks */
async function ensureAgent(agentId: string) {
  const { insertAgent: dbInsert } = await import('../../server/db/queries.js');
  const job = await insertTestJob();
  try {
    dbInsert({ id: agentId, job_id: job.id, status: 'running' });
  } catch { /* already exists */ }
}

async function insertLock(agentId: string, filePath: string) {
  const { insertFileLock } = await import('../../server/db/queries.js');
  const { randomUUID } = await import('crypto');
  await ensureAgent(agentId);
  const id = randomUUID();
  const now = Date.now();
  insertFileLock({
    id,
    agent_id: agentId,
    file_path: filePath,
    reason: 'test',
    acquired_at: now,
    expires_at: now + 600000,
    released_at: null,
  });
  return { id, agent_id: agentId, file_path: filePath };
}

describe('GET /api/locks', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns empty array initially', async () => {
    const res = await request(app).get('/api/locks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns active locks', async () => {
    await insertLock('agent-1', '/path/to/file.ts');
    const res = await request(app).get('/api/locks');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].file_path).toBe('/path/to/file.ts');
  });
});

describe('GET /api/locks/check', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns locked:true when agent holds lock', async () => {
    await insertLock('agent-1', '/file.ts');
    const res = await request(app)
      .get('/api/locks/check')
      .query({ agent_id: 'agent-1', file: '/file.ts' });
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(true);
  });

  it('returns locked:false when agent does not hold lock', async () => {
    await insertLock('agent-1', '/file.ts');
    const res = await request(app)
      .get('/api/locks/check')
      .query({ agent_id: 'agent-2', file: '/file.ts' });
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
  });

  it('returns locked:false for unlocked file', async () => {
    const res = await request(app)
      .get('/api/locks/check')
      .query({ agent_id: 'agent-1', file: '/other.ts' });
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
  });

  it('returns 400 when agent_id missing', async () => {
    const res = await request(app)
      .get('/api/locks/check')
      .query({ file: '/file.ts' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when file missing', async () => {
    const res = await request(app)
      .get('/api/locks/check')
      .query({ agent_id: 'agent-1' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/locks/check-checkout', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns locked:false when no checkout locks exist', async () => {
    const res = await request(app)
      .get('/api/locks/check-checkout')
      .query({ agent_id: 'agent-1', dir: '/repo' });
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
  });

  it('returns 400 when agent_id missing', async () => {
    const res = await request(app)
      .get('/api/locks/check-checkout')
      .query({ dir: '/repo' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when dir missing', async () => {
    const res = await request(app)
      .get('/api/locks/check-checkout')
      .query({ agent_id: 'agent-1' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/locks/:id', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); app = createTestApp(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('owner can release own lock', async () => {
    const lock = await insertLock('agent-1', '/file.ts');
    const res = await request(app)
      .delete(`/api/locks/${lock.id}`)
      .query({ agent_id: 'agent-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('non-owner gets 403', async () => {
    const lock = await insertLock('agent-1', '/file.ts');
    const res = await request(app)
      .delete(`/api/locks/${lock.id}`)
      .query({ agent_id: 'agent-2' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns 400 when agent_id missing', async () => {
    const lock = await insertLock('agent-1', '/file.ts');
    const res = await request(app).delete(`/api/locks/${lock.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('agent_id required');
  });

  it('returns 404 for unknown lock', async () => {
    const res = await request(app)
      .delete('/api/locks/nonexistent')
      .query({ agent_id: 'agent-1' });
    expect(res.status).toBe(404);
  });

  it('emits socket event on release', async () => {
    const socket = await import('../../server/socket/SocketManager.js');
    const lock = await insertLock('agent-1', '/file.ts');
    await request(app)
      .delete(`/api/locks/${lock.id}`)
      .query({ agent_id: 'agent-1' });
    expect(socket.emitLockReleased).toHaveBeenCalledWith(lock.id, '/file.ts');
  });
});
