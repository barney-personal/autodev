import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Workflow } from '../shared/types.js';

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
}));

vi.mock('../server/orchestrator/CostEstimator.js', () => ({
  estimateCostUsd: vi.fn(() => 0.001),
}));

// ─── Fixture ────────────────────────────────────────────────────────────────

const mkWorkflow = (overrides?: Partial<Workflow>): Workflow => ({
  id: 'wf-override-test',
  title: 'Override Test Workflow',
  task: 'test task',
  work_dir: '/app/autodev',
  implementer_model: 'claude-opus-4-7[1m]',
  reviewer_model: 'codex-gpt-5.5',
  max_cycles: 5,
  current_cycle: 1,
  current_phase: 'implement',
  status: 'running',
  milestones_total: 3,
  milestones_done: 0,
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
  worktree_path: '/app/.orchestrator-worktrees/autodev/wf-override-test',
  worktree_branch: 'workflow/override-test',
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
  reviewerModel: null,
  skipReview: true,
  confidence: 'high',
  rationale: 'Simple milestone.',
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

describe('RoutingBrain decision-model override', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    mockState.notes.clear();
    mockState.insertedRows.length = 0;
    process.env.ANTHROPIC_API_KEY = 'test-key-override';
    process.env.ROUTING_BRAIN_MODE = 'live';
    delete process.env.ROUTING_BRAIN_DECISION_MODEL;

    mockState.notes.set(
      'workflow/wf-override-test/plan',
      '# Plan\n## Milestones\n- [ ] **M1: Test** [S]\n  - a step',
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // ── Default model is claude-sonnet-4-6[1m] ─────────────────────────────

  it('uses claude-sonnet-4-6[1m] as the default decision model when no env or DB setting is set', async () => {
    vi.resetModules();
    const { getRoutingBrainDecisionModel } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainDecisionModel()).toBe('claude-sonnet-4-6[1m]');
  });

  it('sends claude-sonnet-4-6 (stripped) to Anthropic when using default model', async () => {
    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson));
    vi.stubGlobal('fetch', fetchMock);

    await mod.decideRouteForCycle(mkWorkflow(), 'implement', 1);

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe('claude-sonnet-4-6');
  });

  it('records claude-sonnet-4-6[1m] as decisionModel in the persisted row', async () => {
    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson)));

    const d = await mod.decideRouteForCycle(mkWorkflow(), 'implement', 1);

    expect(d.decisionModel).toBe('claude-sonnet-4-6[1m]');
    expect(mockState.insertedRows[0].decision_model).toBe('claude-sonnet-4-6[1m]');
  });

  // ── Env override ────────────────────────────────────────────────────────

  it('uses the env ROUTING_BRAIN_DECISION_MODEL when set', async () => {
    process.env.ROUTING_BRAIN_DECISION_MODEL = 'claude-opus-4-7[1m]';
    vi.resetModules();
    const { getRoutingBrainDecisionModel } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainDecisionModel()).toBe('claude-opus-4-7[1m]');
  });

  it('routes decision through the env-overridden model', async () => {
    process.env.ROUTING_BRAIN_DECISION_MODEL = 'claude-opus-4-7[1m]';
    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson));
    vi.stubGlobal('fetch', fetchMock);

    const d = await mod.decideRouteForCycle(mkWorkflow(), 'implement', 1);

    expect(d.decisionModel).toBe('claude-opus-4-7[1m]');
    // Anthropic API should receive the stripped model ID
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe('claude-opus-4-7');
  });

  // ── DB setting wins over env ────────────────────────────────────────────

  it('DB setting wins over env when both are set', async () => {
    process.env.ROUTING_BRAIN_DECISION_MODEL = 'claude-opus-4-7[1m]';
    mockState.notes.set('setting:routing_brain_decision_model', 'claude-haiku-4-5');

    vi.resetModules();
    const { getRoutingBrainDecisionModel } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainDecisionModel()).toBe('claude-haiku-4-5');
  });

  it('routes decision through DB-setting model even when env override is also present', async () => {
    process.env.ROUTING_BRAIN_DECISION_MODEL = 'claude-opus-4-7[1m]';
    mockState.notes.set('setting:routing_brain_decision_model', 'claude-haiku-4-5');

    vi.resetModules();
    const mod = await import('../server/orchestrator/RoutingBrain.js');
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse(validLlmJson));
    vi.stubGlobal('fetch', fetchMock);

    const d = await mod.decideRouteForCycle(mkWorkflow(), 'implement', 1);

    expect(d.decisionModel).toBe('claude-haiku-4-5');
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe('claude-haiku-4-5');
  });

  it('falls back to env when DB setting is empty string', async () => {
    process.env.ROUTING_BRAIN_DECISION_MODEL = 'claude-opus-4-7[1m]';
    mockState.notes.set('setting:routing_brain_decision_model', '');

    vi.resetModules();
    const { getRoutingBrainDecisionModel } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainDecisionModel()).toBe('claude-opus-4-7[1m]');
  });

  it('falls back to default when both env and DB setting are absent', async () => {
    delete process.env.ROUTING_BRAIN_DECISION_MODEL;
    vi.resetModules();
    const { getRoutingBrainDecisionModel } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainDecisionModel()).toBe('claude-sonnet-4-6[1m]');
  });

  // ── getRoutingBrainMode ─────────────────────────────────────────────────

  it('getRoutingBrainMode reads DB setting and wins over env', async () => {
    process.env.ROUTING_BRAIN_MODE = 'live';
    mockState.notes.set('setting:routing_brain_mode', 'shadow');

    vi.resetModules();
    const { getRoutingBrainMode } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainMode()).toBe('shadow');
  });

  it('getRoutingBrainMode returns off when neither env nor DB setting is set', async () => {
    delete process.env.ROUTING_BRAIN_MODE;
    vi.resetModules();
    const { getRoutingBrainMode } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainMode()).toBe('off');
  });

  it('getRoutingBrainMode rejects unknown values and returns off', async () => {
    process.env.ROUTING_BRAIN_MODE = 'invalid_mode';
    vi.resetModules();
    const { getRoutingBrainMode } = await import('../server/orchestrator/RoutingBrain.js');

    expect(getRoutingBrainMode()).toBe('off');
  });
});
