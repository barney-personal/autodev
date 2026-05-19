import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Workflow, RouteDecisionRow } from '../shared/types.js';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => {
  const notes = new Map<string, string>();
  const insertedRows: Array<Record<string, unknown>> = [];
  return { notes, insertedRows };
});

vi.mock('../server/db/queries.js', () => ({
  getNote: vi.fn((key: string) => {
    const val = mockState.notes.get(key);
    return val != null ? { key, value: val } : null;
  }),
  upsertNote: vi.fn(),
  getJobsForWorkflow: vi.fn(() => []),
  listWorkflows: vi.fn(() => []),
}));

vi.mock('../server/db/agentQueries.js', () => ({
  getAgentsForJobIds: vi.fn(() => []),
}));

vi.mock('../server/db/routeDecisionQueries.js', () => ({
  insertRouteDecision: vi.fn((input: Record<string, unknown>) => {
    mockState.insertedRows.push(input);
    return { ...input, created_at: Date.now() };
  }),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  KNOWN_MODELS: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6[1m]',
    'claude-opus-4-7',
    'claude-opus-4-7[1m]',
    'codex-gpt-5.5',
  ],
  isModelRateLimited: vi.fn(() => false),
  getAvailableModel: vi.fn((model: string) => model),
}));

vi.mock('../server/orchestrator/CostEstimator.js', () => ({
  estimateCostUsd: vi.fn(() => 0.001),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mkWorkflow = (overrides?: Partial<Workflow>): Workflow => ({
  id: 'wf-test-001',
  title: 'Test Workflow',
  task: 'Do things',
  work_dir: '/app/autodev',
  implementer_model: 'claude-opus-4-7[1m]',
  reviewer_model: 'codex-gpt-5.5',
  max_cycles: 5,
  current_cycle: 2,
  current_phase: 'implement',
  status: 'running',
  milestones_total: 5,
  milestones_done: 1,
  project_id: null,
  max_turns_assess: 50,
  max_turns_review: 20,
  max_turns_implement: 30,
  stop_mode_assess: 'turns',
  stop_value_assess: null,
  stop_mode_review: 'turns',
  stop_value_review: null,
  stop_mode_implement: 'turns',
  stop_value_implement: null,
  template_id: null,
  use_worktree: 1,
  worktree_path: '/app/.orchestrator-worktrees/autodev/wf-test-001',
  worktree_branch: 'workflow/test-branch',
  blocked_reason: null,
  pr_url: null,
  completion_threshold: 0.8,
  start_command: null,
  max_verify_retries: 3,
  created_at: Date.now() - 60_000,
  updated_at: Date.now(),
  ...overrides,
});

const validLlmJson = JSON.stringify({
  implementerModel: 'claude-sonnet-4-6',
  reviewerModel: 'codex-gpt-5.5',
  skipReview: false,
  confidence: 'high',
  rationale: 'Sonnet is sufficient for this milestone.',
});

function makeFetchResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ content: [{ text: body }] }),
    text: async () => body,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RoutingBrain.decideRouteForCycle', () => {
  const originalEnv = { ...process.env };
  let decideRouteForCycle: typeof import('../server/orchestrator/RoutingBrain.js').decideRouteForCycle;

  beforeEach(async () => {
    mockState.notes.clear();
    mockState.insertedRows.length = 0;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    process.env.ROUTING_BRAIN_MODE = 'live';
    delete process.env.ROUTING_BRAIN_DECISION_MODEL;

    // Plan note so the context builder has something to parse
    mockState.notes.set('workflow/wf-test-001/plan', '# Plan\n## Milestones\n- [ ] **M5: Core brain** [L]\n  - Build the decision module');

    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    decideRouteForCycle = mod.decideRouteForCycle;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // ── Happy path: valid JSON ──────────────────────────────────────────────

  it('parses valid JSON and persists a decision row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);

    expect(d.implementerModel).toBe('claude-sonnet-4-6');
    expect(d.reviewerModel).toBe('codex-gpt-5.5');
    expect(d.skipReview).toBe(false);
    expect(d.confidence).toBe('high');
    expect(d.rationale).toBe('Sonnet is sufficient for this milestone.');
    expect(d.guardrailOverrides).toEqual([]);
    expect(d.promptVersion).toBe('v1');
    expect(d.decisionModel).toBe('claude-sonnet-4-6[1m]');
    expect(d.llmRawResponse).toBe(validLlmJson);

    expect(mockState.insertedRows).toHaveLength(1);
    const row = mockState.insertedRows[0];
    expect(row.mode).toBe('live');
    expect(row.workflow_id).toBe('wf-test-001');
    expect(row.cycle).toBe(2);
    expect(row.phase).toBe('implement');
  });

  // ── Fenced JSON ─────────────────────────────────────────────────────────

  it('parses fenced JSON (```json ... ```)', async () => {
    const fenced = '```json\n' + validLlmJson + '\n```';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(fenced)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.implementerModel).toBe('claude-sonnet-4-6');
    expect(d.confidence).toBe('high');
    expect(mockState.insertedRows).toHaveLength(1);
    expect(mockState.insertedRows[0].mode).toBe('live');
  });

  // ── Fenced JSON without language tag ────────────────────────────────────

  it('parses fenced JSON without language tag', async () => {
    const fenced = '```\n' + validLlmJson + '\n```';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(fenced)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.implementerModel).toBe('claude-sonnet-4-6');
    expect(mockState.insertedRows[0].mode).toBe('live');
  });

  // ── Malformed JSON → fallback ───────────────────────────────────────────

  it('falls back on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('not json at all')));
    const wf = mkWorkflow();

    const d = await decideRouteForCycle(wf, 'implement', 2);
    expect(d.implementerModel).toBe(wf.implementer_model);
    expect(d.reviewerModel).toBe(wf.reviewer_model);
    expect(d.skipReview).toBe(false);
    expect(d.confidence).toBe('low');
    expect(d.rationale).toMatch(/fallback:/);
    expect(mockState.insertedRows).toHaveLength(1);
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Partial JSON (missing required field) → fallback ────────────────────

  it('falls back when required field is missing', async () => {
    const partial = JSON.stringify({
      implementerModel: 'claude-sonnet-4-6',
      // missing skipReview, confidence, rationale
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(partial)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.confidence).toBe('low');
    expect(d.rationale).toContain('fallback:');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Missing implementerModel → fallback ─────────────────────────────────

  it('falls back when implementerModel is empty string', async () => {
    const bad = JSON.stringify({
      implementerModel: '',
      reviewerModel: null,
      skipReview: false,
      confidence: 'high',
      rationale: 'test',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(bad)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback:');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Invalid confidence value → fallback ─────────────────────────────────

  it('falls back when confidence is invalid', async () => {
    const bad = JSON.stringify({
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: false,
      confidence: 'super_high',
      rationale: 'test',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(bad)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback:');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Timeout → fallback ──────────────────────────────────────────────────

  it('falls back on fetch timeout (AbortError)', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback: timeout');
    expect(d.confidence).toBe('low');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── API error (e.g. 429) → fallback ────────────────────────────────────

  it('falls back on Anthropic API error (429)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('rate limited', false, 429)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback:');
    expect(d.rationale).toContain('429');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── API error (500) → fallback ─────────────────────────────────────────

  it('falls back on Anthropic API error (500)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('internal error', false, 500)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback:');
    expect(d.rationale).toContain('500');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Network error → fallback ───────────────────────────────────────────

  it('falls back on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback: fetch failed');
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── No API key → fallback ──────────────────────────────────────────────

  it('falls back when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');

    const d = await mod.decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale).toContain('fallback: ANTHROPIC_API_KEY not set');
    expect(mockState.insertedRows).toHaveLength(1);
    expect(mockState.insertedRows[0].mode).toBe('fallback');
  });

  // ── Every path persists exactly one row ─────────────────────────────────

  it('persists exactly one row on happy path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(mockState.insertedRows).toHaveLength(1);
  });

  it('persists exactly one row on fallback path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('garbage')));

    await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(mockState.insertedRows).toHaveLength(1);
  });

  // ── Shadow mode persists with mode='shadow' ─────────────────────────────

  it('persists mode=shadow when in shadow mode', async () => {
    process.env.ROUTING_BRAIN_MODE = 'shadow';
    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    await mod.decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(mockState.insertedRows[0].mode).toBe('shadow');
  });

  // ── skipReview=true with null reviewerModel ─────────────────────────────

  it('accepts skipReview=true with null reviewerModel', async () => {
    const resp = JSON.stringify({
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'medium',
      rationale: 'Trivial milestone, reviewer not needed.',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(resp)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.skipReview).toBe(true);
    expect(d.reviewerModel).toBeNull();
    expect(d.confidence).toBe('medium');
  });

  // ── Low confidence is respected (no auto-degrade) ───────────────────────

  it('respects low confidence without auto-degrading', async () => {
    const resp = JSON.stringify({
      implementerModel: 'claude-haiku-4-5-20251001',
      reviewerModel: 'claude-sonnet-4-6',
      skipReview: false,
      confidence: 'low',
      rationale: 'Uncertain about complexity, picking cheap model.',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(resp)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.implementerModel).toBe('claude-haiku-4-5-20251001');
    expect(d.confidence).toBe('low');
    expect(mockState.insertedRows[0].mode).toBe('live');
  });

  // ── Rationale is capped at 500 chars ────────────────────────────────────

  it('caps rationale to 500 characters', async () => {
    const longRationale = 'A'.repeat(1000);
    const resp = JSON.stringify({
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high',
      rationale: longRationale,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(resp)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.rationale.length).toBeLessThanOrEqual(500);
  });

  // ── signalsSent includes expected keys ──────────────────────────────────

  it('includes expected keys in signalsSent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.signalsSent).toHaveProperty('milestonesDone');
    expect(d.signalsSent).toHaveProperty('milestonesTotal');
    expect(d.signalsSent).toHaveProperty('cycle');
    expect(d.signalsSent).toHaveProperty('maxCycles');
    expect(d.signalsSent).toHaveProperty('priorCycleCount');
    expect(d.signalsSent).toHaveProperty('crossWorkflowSampleSize');
  });

  // ── costEstimateUsd is populated on happy path ──────────────────────────

  it('populates costEstimateUsd from CostEstimator on happy path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.costEstimateUsd).toBe(0.001);
  });

  // ── costEstimateUsd is 0 on fallback ────────────────────────────────────

  it('sets costEstimateUsd to 0 on fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('bad')));

    const d = await decideRouteForCycle(mkWorkflow(), 'implement', 2);
    expect(d.costEstimateUsd).toBe(0);
  });

  // ── Sends correct model ID to Anthropic API ────────────────────────────

  it('strips [1m] suffix when calling Anthropic API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson));
    vi.stubGlobal('fetch', fetchMock);

    await decideRouteForCycle(mkWorkflow(), 'implement', 2);

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe('claude-sonnet-4-6');
  });
});

// ─── Guardrails tests ────────────────────────────────────────────────────────

describe('RoutingBrain.applyGuardrails', () => {
  let applyGuardrails: typeof import('../server/orchestrator/RoutingBrain.js').applyGuardrails;
  let getAvailableModelMock: any;

  beforeEach(async () => {
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    applyGuardrails = mod.applyGuardrails;

    // Get the mocked getAvailableModel from ModelClassifier
    const { getAvailableModel: imported } = await import('../server/orchestrator/ModelClassifier.js');
    getAvailableModelMock = vi.mocked(imported);
    // Default: return the input unchanged (model is available)
    getAvailableModelMock.mockImplementation((model: string) => model);
  });

  const mkMilestone = (overrides?: Partial<ReturnType<typeof buildMilestone>>): ReturnType<typeof buildMilestone> => {
    return buildMilestone(overrides);
  };

  function buildMilestone(overrides?: Record<string, unknown>) {
    return {
      raw: '- [ ] **M5: Core brain** [L]\n  - Build the decision module',
      title: 'M5: Core brain',
      complexityTag: 'L',
      bodyBullets: ['Build the decision module'],
      mentionedPaths: [],
      mentionedTestFiles: [],
      ...overrides,
    };
  }

  it('swaps unknown implementer model to workflow default', () => {
    const decision = {
      implementerModel: 'unknown-model',
      reviewerModel: 'claude-sonnet-4-6',
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.implementerModel).toBe(wf.implementer_model);
    expect(result.guardrailOverrides.length).toBeGreaterThan(0);
    expect(result.guardrailOverrides[0]).toMatch(/implementerModel swapped.*unknown model/);
  });

  it('swaps unknown reviewer model to workflow default', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: 'unknown-reviewer',
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.reviewerModel).toBe(wf.reviewer_model);
    expect(result.guardrailOverrides.some((o) => o.match(/reviewerModel swapped.*unknown model/))).toBe(true);
  });

  it('swaps rate-limited implementer model to fallback', () => {
    // Mock getAvailableModel to return a fallback for the requested model
    getAvailableModelMock.mockImplementation((model: string) => {
      if (model === 'claude-opus-4-7[1m]') return 'claude-sonnet-4-6[1m]'; // Fallback
      return model;
    });

    const decision = {
      implementerModel: 'claude-opus-4-7[1m]',
      reviewerModel: 'claude-sonnet-4-6',
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.implementerModel).toBe('claude-sonnet-4-6[1m]');
    expect(result.guardrailOverrides.some((o) => o.match(/implementerModel swapped.*rate-limited/))).toBe(true);
  });

  it('swaps rate-limited reviewer model to fallback', () => {
    // Mock getAvailableModel to return a fallback for the requested model
    getAvailableModelMock.mockImplementation((model: string) => {
      if (model === 'codex-gpt-5.5') return 'claude-sonnet-4-6'; // Fallback
      return model;
    });

    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: 'codex-gpt-5.5',
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.reviewerModel).toBe('claude-sonnet-4-6');
    expect(result.guardrailOverrides.some((o) => o.match(/reviewerModel swapped.*rate-limited/))).toBe(true);
  });

  it('uses workflow reviewer model when decision has null reviewer and skipReview=false', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.reviewerModel).toBe(wf.reviewer_model);
    expect(result.guardrailOverrides.some((o) => o.match(/reviewerModel fallback/))).toBe(true);
  });

  it('forces skipReview=false on final milestone', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow({ milestones_done: 4, milestones_total: 5 }); // Final milestone

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.skipReview).toBe(false);
    expect(result.guardrailOverrides.some((o) => o.includes('final milestone'))).toBe(true);
  });

  it('forces skipReview=false when milestone touches config.yaml', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();
    const milestone = mkMilestone({
      mentionedPaths: ['src/config.yaml'],
      bodyBullets: ['Update config.yaml with new settings'],
    });

    const result = applyGuardrails(decision, wf, milestone);

    expect(result.skipReview).toBe(false);
    expect(result.guardrailOverrides.some((o) => o.includes('critical-path'))).toBe(true);
  });

  it('forces skipReview=false when milestone touches package.json', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();
    const milestone = mkMilestone({
      mentionedPaths: ['package.json'],
      bodyBullets: ['Add dependency to package.json'],
    });

    const result = applyGuardrails(decision, wf, milestone);

    expect(result.skipReview).toBe(false);
    expect(result.guardrailOverrides.some((o) => o.includes('critical-path'))).toBe(true);
  });

  it('forces skipReview=false when milestone touches DB migrations', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();
    const milestone = mkMilestone({
      raw: '- [ ] **M3: Add users table** [M]\n  - Modify src/server/db/migrations/001_init.sql',
    });

    const result = applyGuardrails(decision, wf, milestone);

    expect(result.skipReview).toBe(false);
    expect(result.guardrailOverrides.some((o) => o.includes('critical-path'))).toBe(true);
  });

  it('forces skipReview=false when milestone touches schema.ts', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: null,
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();
    const milestone = mkMilestone({
      mentionedPaths: ['src/server/db/schema.ts'],
    });

    const result = applyGuardrails(decision, wf, milestone);

    expect(result.skipReview).toBe(false);
  });

  it('nulls reviewerModel when skipReview=true after guardrails', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: 'claude-opus-4-7',
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.skipReview).toBe(true);
    expect(result.reviewerModel).toBeNull();
  });

  it('preserves low-confidence decisions without auto-degrading', () => {
    const decision = {
      implementerModel: 'claude-haiku-4-5-20251001',
      reviewerModel: 'claude-sonnet-4-6',
      skipReview: false,
      confidence: 'low' as const,
      rationale: 'Uncertain but picking cheap option',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.0005,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.implementerModel).toBe('claude-haiku-4-5-20251001');
    expect(result.confidence).toBe('low');
  });

  it('accumulates multiple guardrail overrides', () => {
    const decision = {
      implementerModel: 'unknown-impl',
      reviewerModel: 'unknown-review',
      skipReview: true,
      confidence: 'high' as const,
      rationale: 'Test',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow();
    const milestone = mkMilestone({
      mentionedPaths: ['config.yaml'],
    });

    const result = applyGuardrails(decision, wf, milestone);

    // Overrides: (1) critical-path skip, (2) unknown impl, (3) unknown review
    // skipReview gets forced to false by critical-path, so null reviewer doesn't apply
    expect(result.guardrailOverrides.length).toBeGreaterThanOrEqual(3);
    expect(result.skipReview).toBe(false); // Forced by critical-path override
    expect(result.reviewerModel).toBe(wf.reviewer_model); // Swapped due to unknown, not nulled
  });

  it('does not override guardrailOverrides if no changes are made', () => {
    const decision = {
      implementerModel: 'claude-sonnet-4-6',
      reviewerModel: 'codex-gpt-5.5',
      skipReview: false,
      confidence: 'high' as const,
      rationale: 'Good choice',
      guardrailOverrides: [],
      llmRawResponse: '',
      signalsSent: {},
      promptVersion: 'v1',
      decisionModel: 'claude-sonnet-4-6[1m]',
      costEstimateUsd: 0.001,
      decidedAt: Date.now(),
    };
    const wf = mkWorkflow({ milestones_done: 1, milestones_total: 5 }); // Not final

    const result = applyGuardrails(decision, wf, mkMilestone());

    expect(result.guardrailOverrides).toEqual([]);
  });
});
