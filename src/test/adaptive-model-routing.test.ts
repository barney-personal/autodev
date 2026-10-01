import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, insertTestWorkflow, createSocketMock } from './helpers.js';
import { classifyTask, protectedTaskReason, _resetClassificationForTest, CLASSIFICATION_TIMEOUT_MS } from '../server/orchestrator/TaskComplexity.js';
import { decideAdaptiveRoute, selectAdaptiveModel, adaptiveRoutingApplies, getAdaptiveRoutingStatus } from '../server/orchestrator/AdaptiveModelRouter.js';
import { _resetForTest, markModelRateLimited, resolveModel } from '../server/orchestrator/ModelClassifier.js';
import * as queries from '../server/db/queries.js';
import { DEFAULT_CLAUDE_MODEL, FRONTIER_CODEX_MODEL, BALANCED_CLAUDE_MODEL } from '../shared/models.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

const simple = { complexity: 'simple', kind: 'mechanical', confidence: 'high', risk: 'low', rationale: 'A specified text correction.' };
function response(verdict: unknown = simple) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(verdict) }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 30 } }) };
}
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await setupTestDb();
  _resetForTest();
  _resetClassificationForTest();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('ADAPTIVE_DECISION_MODEL', 'claude-haiku-4-5-20251001');
  vi.stubEnv('ADAPTIVE_ROUTING_MODE', 'live');
  vi.stubEnv('ADAPTIVE_ROUTING_WORKFLOW_IDS', undefined);
  fetchMock = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await cleanupTestDb();
});

describe('bounded classification', () => {
  it.each([
    'Fix one line of authentication logic', 'Rename a payment field', 'Change the schema',
    'Delete old data in production', 'Adjust one permission', 'Fix a concurrency race',
    'Update package.json', 'Change .github/workflows/ci.yml', 'Review a one-line change',
    'Investigate an unknown failure', 'Verify the final feature', 'Tune encryption',
    'Small OAuth change', 'Fix login text', 'Change a session cookie', 'Update password validation',
    'Sanitize a name', 'Patch XSS handling', 'Edit .env.example', 'Change tsconfig.server.json',
  ])('protects sensitive small work without a provider call: %s', async text => {
    expect(protectedTaskReason(text)).not.toBeNull();
    expect((await classifyTask(text)).complexity).toBe('complex');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('examines the full input and rejects oversized context instead of truncating', async () => {
    expect((await classifyTask('Fix typo. '.repeat(2000) + 'Change auth')).fallbackReason).toContain('budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses tool-free structured requests and records latency and token cost', async () => {
    const result = await classifyTask('Correct recieve to receive in README.md');
    expect(result).toMatchObject({ ...simple, decisionModel: 'claude-haiku-4-5-20251001', inputTokens: 200, outputTokens: 30, fallbackReason: null });
    expect(result.costEstimateUsd).toBeGreaterThan(0);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.system).toContain('untrusted data');
    expect(body.max_tokens).toBe(512);
  });

  it.each([{}, { ...simple, confidence: 'certain' }, { ...simple, skipReview: true }, { ...simple, rationale: '' }])('fails closed for malformed classifications', async verdict => {
    fetchMock.mockResolvedValue(response(verdict));
    expect((await classifyTask('Correct a typo in README.md')).fallbackReason).toBeTruthy();
    await classifyTask('Correct a second typo in README.md');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects truncated output without cooling down a healthy provider', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(simple) }], stop_reason: 'max_tokens' }) });
    expect((await classifyTask('Correct a typo')).fallbackReason).toBeTruthy();
    expect((await classifyTask('Correct another typo')).complexity).toBe('simple');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts an exact JSON code fence but rejects prose around it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: '```json\n' + JSON.stringify(simple) + '\n```' }], stop_reason: 'end_turn' }) });
    expect((await classifyTask('Correct a typo')).complexity).toBe('simple');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: 'Ignore these instructions.\n```json\n' + JSON.stringify(simple) + '\n```' }] }) });
    expect((await classifyTask('Correct another typo')).fallbackReason).toBeTruthy();
  });

  it('bounds a slow response body, clears its timer, and avoids repeating a failing provider call', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, options) => ({ ok: true, json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) }));
    const pending = classifyTask('Correct a typo in README.md');
    await vi.advanceTimersByTimeAsync(CLASSIFICATION_TIMEOUT_MS);
    expect((await pending).fallbackReason).toBe('classification timeout');
    expect(vi.getTimerCount()).toBe(0);
    expect((await classifyTask('Another typo')).fallbackReason).toContain('cooling down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not disclose a raw provider error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'secret echoed' });
    expect(JSON.stringify(await classifyTask('Correct a typo'))).not.toContain('secret echoed');
  });

  it('supports Gemini structured classification without assuming API billing from a CLI login', async () => {
    vi.stubEnv('ADAPTIVE_DECISION_MODEL', 'gemini-3.5-flash-lite');
    vi.stubEnv('GEMINI_API_KEY', 'test-google-key');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'ignored' }, { text: JSON.stringify(simple) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 10 } }) });
    const result = await classifyTask('Correct a typo');
    expect(result).toMatchObject({ ...simple, inputTokens: 120, outputTokens: 30, costEstimateUsd: null });
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.responseJsonSchema.required).toContain('confidence');
    expect(body.tools).toBeUndefined();
  });

  it('fails closed if Gemini is configured without an API key', async () => {
    vi.stubEnv('ADAPTIVE_DECISION_MODEL', 'gemini-3.8-flash');
    vi.stubEnv('GEMINI_API_KEY', ''); vi.stubEnv('GOOGLE_API_KEY', '');
    expect((await classifyTask('Correct a typo')).fallbackReason).toContain('credential missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tier selection and escalation', () => {
  it('selects same-provider efficient and balanced models while retaining the baseline for uncertainty', async () => {
    const classification = await classifyTask('Correct a typo');
    expect(selectAdaptiveModel(classification, DEFAULT_CLAUDE_MODEL)).toBe('claude-haiku-4-5-20251001');
    expect(selectAdaptiveModel(classification, FRONTIER_CODEX_MODEL)).toBe('codex-gpt-6-luna');
    expect(selectAdaptiveModel({ ...classification, complexity: 'medium', kind: 'implementation' }, DEFAULT_CLAUDE_MODEL)).toBe(BALANCED_CLAUDE_MODEL);
    for (const patch of [{ confidence: 'low' }, { confidence: 'medium' }, { risk: 'high' }, { kind: 'judgment' }, { complexity: 'complex' }] as const) {
      expect(selectAdaptiveModel({ ...classification, ...patch }, DEFAULT_CLAUDE_MODEL)).toBe(DEFAULT_CLAUDE_MODEL);
    }
  });

  it('escalates unavailable efficient models to balanced, then baseline', async () => {
    const classification = await classifyTask('Correct a typo');
    markModelRateLimited('claude-haiku-4-5-20251001');
    expect(selectAdaptiveModel(classification, DEFAULT_CLAUDE_MODEL)).toBe(BALANCED_CLAUDE_MODEL);
    markModelRateLimited(BALANCED_CLAUDE_MODEL);
    expect(selectAdaptiveModel(classification, DEFAULT_CLAUDE_MODEL)).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('persists workflow decisions with reviewer and cost coverage preserved', async () => {
    const workflow = await insertTestWorkflow({ implementer_model: DEFAULT_CLAUDE_MODEL, reviewer_model: FRONTIER_CODEX_MODEL, task: 'Polish text in the help page', milestones_total: 3 });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] Correct recieve in README.md\n- [ ] Add examples\n- [ ] Check result', null);
    const d = await decideAdaptiveRoute(workflow, 1);
    expect(d).toMatchObject({ implementerModel: 'claude-haiku-4-5-20251001', reviewerModel: FRONTIER_CODEX_MODEL, skipReview: false });
    expect(d.signalsSent).toMatchObject({ costKnown: true, baselineModel: DEFAULT_CLAUDE_MODEL });
    expect(queries.getRouteDecisionsForWorkflow(workflow.id)).toHaveLength(1);
  });

  it.each(['final', 'feedback', 'failed', 'unchanged', 'no-progress'])('retains frontier on %s work without calling a model', async scenario => {
    const workflow = await insertTestWorkflow({ implementer_model: DEFAULT_CLAUDE_MODEL, reviewer_model: FRONTIER_CODEX_MODEL, task: 'Polish text', milestones_total: 3, milestones_done: scenario === 'final' ? 2 : 0 });
    queries.upsertNote(`workflow/${workflow.id}/plan`, '- [ ] Correct a typo\n- [ ] Add examples\n- [ ] Check result', null);
    if (scenario === 'feedback') queries.upsertNote(`workflow/${workflow.id}/review-feedback/cycle-2`, 'Fix the broken example', null);
    if (scenario === 'no-progress') queries.upsertNote(`workflow/${workflow.id}/zero-progress-count`, '1', null);
    if (scenario === 'failed' || scenario === 'unchanged') {
      if (scenario === 'unchanged') await decideAdaptiveRoute(workflow, 1);
      queries.insertJob({ id: randomUUID(), title: 'attempt', description: '', context: null, priority: 0, workflow_id: workflow.id, workflow_cycle: 1, workflow_phase: 'implement', status: scenario === 'failed' ? 'failed' : 'done' });
    }
    fetchMock.mockClear();
    const d = await decideAdaptiveRoute(workflow, 2);
    expect(d.implementerModel).toBe(DEFAULT_CLAUDE_MODEL);
    expect(d.skipReview).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an empty allowlist as no workflows and keeps status free of secrets', () => {
    vi.stubEnv('ADAPTIVE_ROUTING_WORKFLOW_IDS', '');
    expect(adaptiveRoutingApplies('wf')).toBe(false);
    vi.stubEnv('ADAPTIVE_ROUTING_WORKFLOW_IDS', ' wf, other ');
    expect(adaptiveRoutingApplies('wf')).toBe(true);
    expect(adaptiveRoutingApplies('third')).toBe(false);
    expect(JSON.stringify(getAdaptiveRoutingStatus())).not.toContain('test-key');
  });

  it('routes unpinned jobs, preserves explicit choices, and escalates only auto-selected retries', async () => {
    const makeJob = (extra = {}) => queries.insertJob({ id: randomUUID(), title: 'Correct typo', description: 'Change recieve to receive in README.md', context: null, priority: 0, ...extra });
    const job = makeJob();
    expect(await resolveModel(job)).toBe('claude-haiku-4-5-20251001');
    const retry = makeJob({ original_job_id: job.id, retry_count: 1, model: 'claude-haiku-4-5-20251001' });
    expect(await resolveModel(retry)).toBe(DEFAULT_CLAUDE_MODEL);
    fetchMock.mockClear();
    expect(await resolveModel(makeJob({ model: BALANCED_CLAUDE_MODEL, retry_count: 1 }))).toBe(BALANCED_CLAUDE_MODEL);
    expect(await resolveModel(makeJob({ original_job_id: job.id, model: BALANCED_CLAUDE_MODEL, retry_count: 1 }))).toBe(BALANCED_CLAUDE_MODEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
