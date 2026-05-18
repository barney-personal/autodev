/**
 * Tests for POST /api/webhooks/sync — the sync-failure auto-remediation entry point.
 *
 * Bug: sync-webhook-handler-missing
 * The endpoint didn't exist; sync worker failures (e.g. "Worker lease expired")
 * had no way to dispatch remediation jobs. These tests fail on main (404) and
 * pass after the implementation.
 *
 * Dispatch id: fdacbe7e-743a-4021-9dd2-fee37391f72f
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, createSocketMock } from '../helpers.js';
import { createTestApp } from '../api-helpers.js';
import type express from 'express';

vi.mock('../../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  startWorkQueue: vi.fn(),
  stopWorkQueue: vi.fn(),
}));
vi.mock('../../server/orchestrator/DebateManager.js', () => ({
  spawnInitialRoundJobs: vi.fn(() => []),
  resolvePreDebateTerminal: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fix Sync Issue' }] }) };
  },
}));

const SYNC_FAILURE_PAYLOAD = {
  syncLogId: 1118,
  source: 'github',
  status: 'error',
  startedAt: '2026-05-15T14:01:05.808Z',
  completedAt: '2026-05-15T14:18:58.218Z',
  errorMessage: 'Worker lease expired before the sync completed.',
  lastSuccessAt: '2026-05-06T06:11:58.147Z',
  consecutiveFailureCount: 1,
  failedPhases: [
    {
      name: 'github-fetch-commits',
      status: 'error',
      error: 'Phase interrupted — worker lease expired before completion',
    },
  ],
};

let app: express.Express;
const ORIGINAL_AUTH_TOKEN = process.env.AUTH_TOKEN;

describe('POST /api/webhooks/sync — sync-webhook-handler-missing', () => {
  beforeEach(async () => {
    delete process.env.AUTH_TOKEN;
    await setupTestDb();
    vi.clearAllMocks();
    app = createTestApp();
  });
  afterEach(async () => {
    await cleanupTestDb();
    if (ORIGINAL_AUTH_TOKEN === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  });

  it('returns 201 and creates a remediation job for a valid sync failure', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.dispatchId).toBeTruthy();
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('queued');
  });

  it('stores source and error message in the created job', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    expect(res.status).toBe(201);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job).not.toBeNull();
    expect(job!.description).toContain('github');
    expect(job!.description).toContain('Worker lease expired before the sync completed.');
  });

  it('includes the failed phase name in the job description', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job!.description).toContain('github-fetch-commits');
  });

  it('includes dispatch instructions in the job description', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job!.description).toContain('failing test');
  });

  it('tags the job context with sync trigger metadata', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    const context = JSON.parse(job!.context!);
    expect(context.trigger).toBe('sync');
    expect(context.syncSource).toBe('github');
    expect(context.syncLogId).toBe(1118);
    expect(context.dispatchId).toBe(res.body.dispatchId);
  });

  it('returns 400 when status is not "error"', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send({ ...SYNC_FAILURE_PAYLOAD, status: 'success' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/error/i);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send({ status: 'error' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when source is missing', async () => {
    const { source: _source, ...withoutSource } = SYNC_FAILURE_PAYLOAD;
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(withoutSource);

    expect(res.status).toBe(400);
  });

  it('requires the configured AUTH_TOKEN when present', async () => {
    process.env.AUTH_TOKEN = 'sync-webhook-secret';

    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(SYNC_FAILURE_PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authorization/i);
  });

  it('rejects an invalid AUTH_TOKEN bearer value', async () => {
    process.env.AUTH_TOKEN = 'sync-webhook-secret';

    const res = await request(app)
      .post('/api/webhooks/sync')
      .set('Authorization', 'Bearer wrong-token')
      .send(SYNC_FAILURE_PAYLOAD);

    expect(res.status).toBe(403);
  });

  it('accepts the configured AUTH_TOKEN bearer value', async () => {
    process.env.AUTH_TOKEN = 'sync-webhook-secret';

    const res = await request(app)
      .post('/api/webhooks/sync')
      .set('Authorization', 'Bearer sync-webhook-secret')
      .send(SYNC_FAILURE_PAYLOAD);

    expect(res.status).toBe(201);
  });

  it('returns 400 when failedPhases is not an array', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send({ ...SYNC_FAILURE_PAYLOAD, failedPhases: { length: 1 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 when failedPhases contains malformed phase entries', async () => {
    const res = await request(app)
      .post('/api/webhooks/sync')
      .send({
        ...SYNC_FAILURE_PAYLOAD,
        failedPhases: [{ name: 'github-fetch-commits', status: 'timeout' }],
      });

    expect(res.status).toBe(400);
  });
});

/**
 * Bug: sync-phase-detail-missing
 * SyncFailurePhase lacked a `detail` field, so diagnostic context like
 * "Walking block trees for recently edited pages" was silently dropped from
 * the remediation job description. This meant the downstream agent had no
 * information about what the sync was doing when the worker lease expired.
 *
 * Dispatch id: 3aff6e9d-0fbe-4583-af13-436da7422719 (Notion sync_blocks)
 */
describe('sync-phase-detail-missing — notion sync_blocks phase detail dropped from job description', () => {
  beforeEach(async () => {
    delete process.env.AUTH_TOKEN;
    await setupTestDb();
    vi.clearAllMocks();
    app = createTestApp();
  });
  afterEach(async () => {
    await cleanupTestDb();
    if (ORIGINAL_AUTH_TOKEN === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  });

  it('includes phase detail in job description when provided', async () => {
    const notionPayload = {
      syncLogId: 1235,
      source: 'notion',
      status: 'error',
      startedAt: '2026-05-18T11:25:28.389Z',
      completedAt: '2026-05-18T11:58:03.705Z',
      errorMessage: 'Worker lease expired before the sync completed.',
      lastSuccessAt: null,
      consecutiveFailureCount: 1,
      failedPhases: [
        {
          name: 'sync_blocks',
          status: 'error',
          error: 'Phase interrupted — worker lease expired before completion',
          detail: 'Walking block trees for recently edited pages',
        },
      ],
    };

    const res = await request(app)
      .post('/api/webhooks/sync')
      .send(notionPayload);

    expect(res.status).toBe(201);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job).not.toBeNull();
    expect(job!.description).toContain('Walking block trees for recently edited pages');
  });
});
