/**
 * Operator API tests for /api/routing-brain endpoints.
 *
 * Covers:
 * - POST /mode validation + settings write
 * - POST /decision-model validation + settings write
 * - GET /shadow-report empty + populated, including reviewer-skip TP/FP rule
 *   (only counted when an actual review job ran with review_status set)
 * - GET /stats empty + populated, including LLM call-failure rate and
 *   decision-model breakdown
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestProject,
  insertTestWorkflow,
} from './helpers.js';
import { createTestApp } from './api-helpers.js';
import type express from 'express';
import type { RouteDecision, RouteDecisionMode } from '../shared/types.js';

interface TestResponse {
  status: number;
  body: any;
}

async function sendRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<TestResponse> {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function request(app: express.Express) {
  return {
    get: (path: string) => sendRequest(app, 'GET', path),
    post: (path: string) => ({
      send: (body: unknown) => sendRequest(app, 'POST', path, body),
    }),
  };
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: {
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}));
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));
vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  saveSnapshot: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(() => []),
  getPtyBuffer: vi.fn(() => []),
  getSnapshot: vi.fn(() => null),
  attachPty: vi.fn(),
  startInteractiveAgent: vi.fn(),
}));
vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));
vi.mock('../server/orchestrator/JobWatcherManager.js', () => ({
  requestTickNow: vi.fn(() => ({ ok: true })),
  requestStartNow: vi.fn(() => ({ ok: true })),
  stopWatcherForAgent: vi.fn(() => true),
}));
vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  cancelledAgents: new Set<string>(),
  _resetCompletedJobsForTest: vi.fn(),
}));

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    implementerModel: 'claude-haiku-4-5-20251001',
    reviewerModel: 'codex',
    skipReview: false,
    confidence: 'high',
    rationale: 'test',
    guardrailOverrides: [],
    llmRawResponse: '{}',
    signalsSent: {},
    promptVersion: 'v1',
    decisionModel: 'claude-sonnet-4-6[1m]',
    costEstimateUsd: 0.001,
    decidedAt: Date.now(),
    ...overrides,
  };
}

async function insertDecision(args: {
  workflow_id: string;
  cycle: number;
  phase?: string;
  mode: RouteDecisionMode;
  decision?: RouteDecision;
  decision_model?: string;
  created_at?: number;
}) {
  const { insertRouteDecision } = await import('../server/db/routeDecisionQueries.js');
  return insertRouteDecision({
    id: randomUUID(),
    workflow_id: args.workflow_id,
    cycle: args.cycle,
    phase: args.phase ?? 'implement',
    decision: args.decision ?? makeDecision(),
    mode: args.mode,
    prompt_version: 'v1',
    decision_model: args.decision_model ?? 'claude-sonnet-4-6[1m]',
    created_at: args.created_at,
  });
}

async function insertImplementJobWithAgent(args: {
  workflow_id: string;
  cycle: number;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
}) {
  const { insertJob, insertAgent, updateAgent } = await import('../server/db/queries.js');
  const jobId = randomUUID();
  insertJob({
    id: jobId,
    title: `[M1] implement cycle ${args.cycle}`,
    description: 'implement',
    context: null,
    priority: 0,
    status: 'done',
    workflow_id: args.workflow_id,
    workflow_cycle: args.cycle,
    workflow_phase: 'implement',
    model: args.model,
  });
  const agentId = randomUUID();
  insertAgent({ id: agentId, job_id: jobId, status: 'done' });
  updateAgent(agentId, {
    estimated_input_tokens: args.input_tokens ?? 1_000_000,
    estimated_output_tokens: args.output_tokens ?? 100_000,
  });
  return { jobId, agentId };
}

async function insertReviewJobWithAgent(args: {
  workflow_id: string;
  cycle: number;
  review_status: 'approved' | 'needs_revision' | 'pending_review' | null;
}) {
  const { insertJob, insertAgent } = await import('../server/db/queries.js');
  const jobId = randomUUID();
  insertJob({
    id: jobId,
    title: `[M1] review cycle ${args.cycle}`,
    description: 'review',
    context: null,
    priority: 0,
    status: 'done',
    workflow_id: args.workflow_id,
    workflow_cycle: args.cycle,
    workflow_phase: 'review',
    model: 'codex',
    review_status: args.review_status,
  });
  insertAgent({ id: randomUUID(), job_id: jobId, status: 'done' });
  return jobId;
}

describe('routing-brain operator API', () => {
  let app: express.Express;

  beforeEach(async () => {
    await setupTestDb();
    app = createTestApp();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  describe('POST /api/routing-brain/mode', () => {
    it('accepts valid mode and writes the setting note', async () => {
      const res = await request(app).post('/api/routing-brain/mode').send({ mode: 'shadow' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mode: 'shadow' });
      const { getNote } = await import('../server/db/queries.js');
      expect(getNote('setting:routing_brain_mode')?.value).toBe('shadow');
    });

    it('rejects invalid mode', async () => {
      const res = await request(app).post('/api/routing-brain/mode').send({ mode: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/off|shadow|live/);
    });

    it('rejects missing mode', async () => {
      const res = await request(app).post('/api/routing-brain/mode').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/routing-brain/decision-model', () => {
    it('accepts valid model id and writes the setting note', async () => {
      const res = await request(app)
        .post('/api/routing-brain/decision-model')
        .send({ model: 'claude-opus-4-7[1m]' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ model: 'claude-opus-4-7[1m]' });
      const { getNote } = await import('../server/db/queries.js');
      expect(getNote('setting:routing_brain_decision_model')?.value).toBe('claude-opus-4-7[1m]');
    });

    it('trims whitespace', async () => {
      const res = await request(app)
        .post('/api/routing-brain/decision-model')
        .send({ model: '  claude-sonnet-4-6  ' });
      expect(res.status).toBe(200);
      expect(res.body.model).toBe('claude-sonnet-4-6');
    });

    it('rejects empty string', async () => {
      const res = await request(app).post('/api/routing-brain/decision-model').send({ model: '   ' });
      expect(res.status).toBe(400);
    });

    it('rejects non-string', async () => {
      const res = await request(app).post('/api/routing-brain/decision-model').send({ model: 42 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/routing-brain/shadow-report', () => {
    it('returns empty aggregate when no decisions exist', async () => {
      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.window_days).toBe(30);
      expect(res.body.aggregate.decisions).toBe(0);
      expect(res.body.aggregate.skip_fp_rate).toBe(0);
      expect(res.body.workflows).toEqual([]);
    });

    it('rejects invalid days param', async () => {
      const res = await request(app).get('/api/routing-brain/shadow-report?days=0');
      expect(res.status).toBe(400);
    });

    it('rejects days > 365', async () => {
      const res = await request(app).get('/api/routing-brain/shadow-report?days=400');
      expect(res.status).toBe(400);
    });

    it('computes FP only when an actual review ran', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });

      // Cycle 1: skip=true, review actually ran with needs_revision -> FP
      await insertDecision({
        workflow_id: wf.id,
        cycle: 1,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 1, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 1, review_status: 'needs_revision' });

      // Cycle 2: skip=true, review ran with approved -> TP
      await insertDecision({
        workflow_id: wf.id,
        cycle: 2,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 2, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 2, review_status: 'approved' });

      // Cycle 3: skip=true, no review job ran (e.g. workflow ended) -> NOT counted
      await insertDecision({
        workflow_id: wf.id,
        cycle: 3,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 3, model: 'claude-opus-4-7[1m]' });

      // Cycle 4: skip=false, review needs_revision -> not a skip recommendation, not counted
      await insertDecision({ workflow_id: wf.id, cycle: 4, mode: 'shadow' });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 4, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 4, review_status: 'needs_revision' });

      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.aggregate.decisions).toBe(4);
      expect(res.body.aggregate.skip_recommended).toBe(3);
      expect(res.body.aggregate.skip_tp).toBe(1);
      expect(res.body.aggregate.skip_fp).toBe(1);
      expect(res.body.aggregate.skip_fp_rate).toBeCloseTo(0.5, 5);
      expect(res.body.workflows).toHaveLength(1);
      expect(res.body.workflows[0].cycles).toHaveLength(4);
    });

    it('scores skip TP/FP from review-feedback notes when review_status is null', async () => {
      const { upsertNote } = await import('../server/db/queries.js');
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });

      // Cycle 1: brain said skip, real workflow review ran (status=null) and
      // produced a review-feedback note (fix milestones added) -> FP.
      await insertDecision({
        workflow_id: wf.id,
        cycle: 1,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 1, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 1, review_status: null });
      upsertNote(`workflow/${wf.id}/review-feedback/cycle-1`, '- [ ] **Fix: missing case', null);

      // Cycle 2: brain said skip, real workflow review ran (status=null) and
      // produced no review-feedback note -> TP (no-op review).
      await insertDecision({
        workflow_id: wf.id,
        cycle: 2,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 2, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 2, review_status: null });

      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.aggregate.decisions).toBe(2);
      expect(res.body.aggregate.skip_recommended).toBe(2);
      expect(res.body.aggregate.skip_tp).toBe(1);
      expect(res.body.aggregate.skip_fp).toBe(1);
      expect(res.body.aggregate.skip_fp_rate).toBeCloseTo(0.5, 5);
    });

    it('does not infer TP when the review job has not completed yet', async () => {
      const { insertJob, insertAgent } = await import('../server/db/queries.js');
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });

      await insertDecision({
        workflow_id: wf.id,
        cycle: 1,
        mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 1, model: 'claude-opus-4-7[1m]' });
      const reviewJobId = randomUUID();
      insertJob({
        id: reviewJobId,
        title: '[M1] review cycle 1',
        description: 'review',
        context: null,
        priority: 0,
        status: 'queued',
        workflow_id: wf.id,
        workflow_cycle: 1,
        workflow_phase: 'review',
        model: 'codex',
        review_status: null,
      });
      insertAgent({ id: randomUUID(), job_id: reviewJobId, status: 'queued' });

      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.aggregate.skip_tp).toBe(0);
      expect(res.body.aggregate.skip_fp).toBe(0);
    });

    it('excludes non-shadow rows from the report', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      await insertDecision({ workflow_id: wf.id, cycle: 1, mode: 'live' });
      await insertDecision({ workflow_id: wf.id, cycle: 2, mode: 'fallback' });
      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.aggregate.decisions).toBe(0);
    });

    it('computes a non-zero counterfactual cost delta when recommended model is cheaper', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      // Brain recommended haiku, actual was opus[1m] -> haiku cheaper, positive delta.
      await insertDecision({
        workflow_id: wf.id,
        cycle: 1,
        mode: 'shadow',
        decision: makeDecision({ implementerModel: 'claude-haiku-4-5-20251001' }),
      });
      await insertImplementJobWithAgent({
        workflow_id: wf.id,
        cycle: 1,
        model: 'claude-opus-4-7[1m]',
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      });
      const res = await request(app).get('/api/routing-brain/shadow-report');
      expect(res.status).toBe(200);
      expect(res.body.aggregate.cost_delta_samples).toBe(1);
      expect(res.body.aggregate.mean_cost_delta_usd).toBeGreaterThan(0);
    });
  });

  describe('GET /api/routing-brain/stats', () => {
    it('returns zeros when no decisions exist', async () => {
      const res = await request(app).get('/api/routing-brain/stats');
      expect(res.status).toBe(200);
      expect(res.body.total_decisions).toBe(0);
      expect(res.body.by_mode).toEqual({ shadow: 0, live: 0, fallback: 0 });
      expect(res.body.llm_call_failure_rate).toBe(0);
      expect(res.body.shadow.decisions).toBe(0);
      expect(res.body.by_decision_model).toEqual([]);
    });

    it('rejects invalid days param', async () => {
      const res = await request(app).get('/api/routing-brain/stats?days=-1');
      expect(res.status).toBe(400);
    });

    it('aggregates mode counts, failure rate, and decision-model breakdown', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      await insertDecision({
        workflow_id: wf.id, cycle: 1, mode: 'shadow',
        decision: makeDecision({ guardrailOverrides: ['x'] }),
      });
      await insertDecision({ workflow_id: wf.id, cycle: 2, mode: 'shadow' });
      await insertDecision({ workflow_id: wf.id, cycle: 3, mode: 'live' });
      await insertDecision({ workflow_id: wf.id, cycle: 4, mode: 'fallback' });
      await insertDecision({
        workflow_id: wf.id, cycle: 5, mode: 'fallback',
        decision_model: 'claude-opus-4-7[1m]',
      });

      const res = await request(app).get('/api/routing-brain/stats');
      expect(res.status).toBe(200);
      expect(res.body.total_decisions).toBe(5);
      expect(res.body.by_mode).toEqual({ shadow: 2, live: 1, fallback: 2 });
      expect(res.body.llm_call_failure_rate).toBeCloseTo(2 / 5, 5);
      expect(res.body.guardrail_override_rate).toBeCloseTo(1 / 5, 5);

      const byModelMap = new Map(res.body.by_decision_model.map((e: { decision_model: string }) => [e.decision_model, e]));
      const sonnetRow = byModelMap.get('claude-sonnet-4-6[1m]') as { total: number; fallback: number; fallback_rate: number };
      expect(sonnetRow.total).toBe(4);
      expect(sonnetRow.fallback).toBe(1);
      const opusRow = byModelMap.get('claude-opus-4-7[1m]') as { total: number; fallback: number; fallback_rate: number };
      expect(opusRow.total).toBe(1);
      expect(opusRow.fallback_rate).toBe(1);
    });

    it('computes shadow-only reviewer-skip FP rate', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      await insertDecision({
        workflow_id: wf.id, cycle: 1, mode: 'shadow',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 1, model: 'claude-opus-4-7[1m]' });
      await insertReviewJobWithAgent({ workflow_id: wf.id, cycle: 1, review_status: 'needs_revision' });

      // live skip recommendation — review did not run, so unobservable.
      await insertDecision({
        workflow_id: wf.id, cycle: 2, mode: 'live',
        decision: makeDecision({ skipReview: true, reviewerModel: null }),
      });
      await insertImplementJobWithAgent({ workflow_id: wf.id, cycle: 2, model: 'claude-opus-4-7[1m]' });

      const res = await request(app).get('/api/routing-brain/stats');
      expect(res.body.shadow.decisions).toBe(1);
      expect(res.body.shadow.skip_recommended).toBe(1);
      expect(res.body.shadow.skip_fp).toBe(1);
      expect(res.body.shadow.skip_fp_rate).toBe(1);
    });

    it('excludes rows older than the window', async () => {
      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      const eightyDaysAgo = Date.now() - 80 * 86_400_000;
      await insertDecision({ workflow_id: wf.id, cycle: 1, mode: 'shadow', created_at: eightyDaysAgo });
      await insertDecision({ workflow_id: wf.id, cycle: 2, mode: 'shadow' });

      const res30 = await request(app).get('/api/routing-brain/stats?days=30');
      expect(res30.body.total_decisions).toBe(1);

      const res90 = await request(app).get('/api/routing-brain/stats?days=90');
      expect(res90.body.total_decisions).toBe(2);
    });
  });
});
