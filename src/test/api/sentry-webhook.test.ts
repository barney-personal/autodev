/**
 * Tests for POST /api/webhooks/sentry — the auto-remediation entry point.
 *
 * Bug: sentry-webhook-handler-missing
 * The endpoint didn't exist; Sentry alerts had no way to dispatch remediation
 * jobs. These tests fail on main (404) and pass after the implementation.
 *
 * Dispatch id: b46628a7-162a-465d-abb1-9993ab1e6b3d
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
    messages = { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fix Sentry Issue' }] }) };
  },
}));

const SENTRY_ISSUE_PAYLOAD = {
  action: 'created',
  data: {
    issue: {
      id: 'smoke-test-issue-001',
      title: '[SMOKE-TEST] Synthetic auto-remediation pipeline verification',
      culprit: 'src/lib/auto-remediation/sentry-webhook.ts in smoke-test',
      web_url: 'https://cleo-bf.sentry.io/issues/smoke-test-1/',
      fingerprints: ['smoke-test-fingerprint-001'],
      tags: [{ key: 'browser', value: 'smoke' }],
    },
  },
};

let app: express.Express;

describe('POST /api/webhooks/sentry — sentry-webhook-handler-missing', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    app = createTestApp();
  });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns 201 and creates a remediation job for a valid Sentry issue', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send(SENTRY_ISSUE_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.dispatchId).toBeTruthy();
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('queued');
  });

  it('stores issue id and fingerprint in the created job', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send(SENTRY_ISSUE_PAYLOAD);

    expect(res.status).toBe(201);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job).not.toBeNull();
    expect(job!.description).toContain('smoke-test-issue-001');
    expect(job!.description).toContain('smoke-test-fingerprint-001');
  });

  it('includes the Sentry URL in the job description so the agent can link back', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send(SENTRY_ISSUE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job!.description).toContain('https://cleo-bf.sentry.io/issues/smoke-test-1/');
  });

  it('includes culprit and dispatch instructions in the job description', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send(SENTRY_ISSUE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    expect(job!.description).toContain('src/lib/auto-remediation/sentry-webhook.ts');
    expect(job!.description).toContain('failing test');
  });

  it('returns 400 when the issue data is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send({ action: 'created' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/issue/i);
  });

  it('returns 400 when action is not "created"', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send({ ...SENTRY_ISSUE_PAYLOAD, action: 'resolved' });

    expect(res.status).toBe(400);
  });

  it('tags the job context with sentry trigger metadata', async () => {
    const res = await request(app)
      .post('/api/webhooks/sentry')
      .send(SENTRY_ISSUE_PAYLOAD);

    const { getJobById } = await import('../../server/db/queries.js');
    const job = getJobById(res.body.jobId);
    const context = JSON.parse(job!.context!);
    expect(context.trigger).toBe('sentry');
    expect(context.sentryIssueId).toBe('smoke-test-issue-001');
    expect(context.dispatchId).toBe(res.body.dispatchId);
  });
});
