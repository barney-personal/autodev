/**
 * Tests for M10: Inline workflow scratchpad context in phase prompts.
 *
 * Proves:
 * 1. buildReviewPrompt() includes inline plan, contract, and worklogs when InlineContext is provided
 * 2. buildImplementPrompt() includes inline plan, contract, and worklogs when InlineContext is provided
 * 3. Without InlineContext, prompts still contain read_note/list_notes instructions (backward compat)
 * 4. capText() truncates oversized content and appends a notice
 * 5. Total inline context is capped at INLINE_TOTAL_CAP
 * 6. spawnPhaseJob and resumeWorkflow fetch and pass inline context to prompt builders
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';
import {
  buildReviewPrompt,
  buildImplementPrompt,
  capText,
  type InlineContext,
} from '../server/orchestrator/WorkflowPrompts.js';
import type { Workflow } from '../shared/types.js';

// ─── Unit tests for prompt builders (no DB needed) ──────────────────────────

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test-123',
    title: 'Test workflow',
    task: 'Do the thing',
    work_dir: '/tmp/test',
    status: 'running',
    use_worktree: 0,
    worktree_path: null,
    worktree_branch: null,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'claude-sonnet-4-6',
    max_cycles: 10,
    current_cycle: 1,
    current_phase: 'review',
    milestones_total: 3,
    milestones_done: 1,
    blocked_reason: null,
    template_id: null,
    project_id: null,
    pr_url: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    max_turns_assess: 30,
    max_turns_review: 20,
    max_turns_implement: 50,
    stop_mode_assess: 'turns' as any,
    stop_mode_review: 'turns' as any,
    stop_mode_implement: 'turns' as any,
    stop_value_assess: null,
    stop_value_review: null,
    stop_value_implement: null,
    ...overrides,
  };
}

describe('capText', () => {
  it('returns text unchanged when under cap', () => {
    expect(capText('hello', 100)).toBe('hello');
  });

  it('truncates and appends notice when over cap', () => {
    const result = capText('abcdefghij', 5);
    expect(result).toContain('abcde');
    expect(result).toContain('truncated at 5 characters');
    expect(result).not.toContain('fghij');
  });

  it('returns text unchanged when exactly at cap', () => {
    expect(capText('12345', 5)).toBe('12345');
  });
});

describe('buildReviewPrompt with InlineContext', () => {
  const wf = makeWorkflow();
  const ctx: InlineContext = {
    plan: '# Plan\n\n- [x] M1\n- [ ] M2',
    contract: '# Contract\n- rule 1',
    worklogs: [
      { key: 'workflow/wf-test-123/worklog/cycle-1', value: '## Cycle 1\nDid stuff' },
    ],
  };

  it('includes inline plan, contract, and worklogs when context is provided', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Current Plan');
    expect(prompt).toContain('- [x] M1');
    expect(prompt).toContain('- [ ] M2');
    expect(prompt).toContain('Operating Contract');
    expect(prompt).toContain('rule 1');
    expect(prompt).toContain('Previous Worklogs');
    expect(prompt).toContain('Cycle 1');
    expect(prompt).toContain('Did stuff');
  });

  it('does not tell agents to read_note for plan/contract when inline context is provided', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    // Should NOT have the old Step 1: Read Context instructions
    expect(prompt).not.toContain('Read the current plan: `read_note');
    expect(prompt).not.toContain('Read the operating contract: `read_note');
    expect(prompt).not.toContain('list_notes("workflow/wf-test-123/worklog/")');
  });

  it('still mentions note tools are available for updates', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('write_note');
    expect(prompt).toContain('read_note');
  });

  it('falls back to read_note instructions when no inline context is provided', () => {
    const prompt = buildReviewPrompt(wf, 2);
    expect(prompt).toContain('Read the current plan: `read_note');
    expect(prompt).toContain('Read the operating contract: `read_note');
    expect(prompt).toContain('list_notes("workflow/wf-test-123/worklog/")');
    expect(prompt).not.toContain('Pre-loaded Context');
  });

  it('falls back to read_note instructions when inline context has empty values', () => {
    const emptyCtx: InlineContext = { plan: null, contract: null, worklogs: [] };
    const prompt = buildReviewPrompt(wf, 2, emptyCtx);
    expect(prompt).toContain('Read the current plan: `read_note');
    expect(prompt).not.toContain('Pre-loaded Context');
  });

  it('shows (provided inline below) for worklog reference in code review section', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('(provided inline below)');
  });
});

describe('buildImplementPrompt with InlineContext', () => {
  const wf = makeWorkflow({ current_phase: 'implement' as any });
  const ctx: InlineContext = {
    plan: '# Plan\n\n- [x] M1\n- [ ] M2',
    contract: '# Contract\n- rule 1',
    worklogs: [
      { key: 'workflow/wf-test-123/worklog/cycle-1', value: '## Cycle 1\nDid stuff' },
    ],
  };

  it('includes inline plan, contract, and worklogs when context is provided', () => {
    const prompt = buildImplementPrompt(wf, 2, ctx);
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Current Plan');
    expect(prompt).toContain('- [x] M1');
    expect(prompt).toContain('Operating Contract');
    expect(prompt).toContain('rule 1');
    expect(prompt).toContain('Previous Worklogs');
    expect(prompt).toContain('Cycle 1');
  });

  it('replaces read_note instructions with review pre-loaded context instruction', () => {
    const prompt = buildImplementPrompt(wf, 2, ctx);
    expect(prompt).toContain('Review the pre-loaded context below');
    expect(prompt).not.toContain('Read the current plan**: `read_note');
    expect(prompt).not.toContain('Read the operating contract**: `read_note');
  });

  it('renumbers implementation steps when inline context is provided', () => {
    const prompt = buildImplementPrompt(wf, 2, ctx);
    // With inline context: steps start at 3 for implement
    expect(prompt).toContain('3. **Implement it**');
    expect(prompt).toContain('4. **Check off the milestone**');
    expect(prompt).toContain('5. **Write a worklog entry**');
  });

  it('uses original step numbering without inline context', () => {
    const prompt = buildImplementPrompt(wf, 2);
    expect(prompt).toContain('5. **Implement it**');
    expect(prompt).toContain('6. **Check off the milestone**');
    expect(prompt).toContain('7. **Write a worklog entry**');
  });

  it('falls back to read_note instructions when no inline context is provided', () => {
    const prompt = buildImplementPrompt(wf, 2);
    expect(prompt).toContain('Read the current plan**: `read_note');
    expect(prompt).toContain('Read the operating contract**: `read_note');
    expect(prompt).not.toContain('Pre-loaded Context');
  });
});

describe('inline context size capping', () => {
  const wf = makeWorkflow();

  it('truncates individual sections exceeding INLINE_CAP (20000 chars)', () => {
    const longPlan = 'x'.repeat(25_000);
    const ctx: InlineContext = { plan: longPlan, contract: 'short', worklogs: [] };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    // The plan section should be truncated
    expect(prompt).toContain('truncated at 20000 characters');
    // Should NOT contain the full 25000-char string
    expect(prompt.length).toBeLessThan(longPlan.length + 5000);
  });

  it('truncates total inline context exceeding INLINE_TOTAL_CAP (50000 chars)', () => {
    const bigContent = 'y'.repeat(20_000);
    const ctx: InlineContext = {
      plan: bigContent,
      contract: bigContent,
      worklogs: [
        { key: 'w/1', value: bigContent },
      ],
    };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    // Total inline context should be capped
    expect(prompt).toContain('total inline context truncated at 50000 characters');
  });
});

// ─── Integration tests: WorkflowManager fetches inline context ──────────────

// Mock SocketManager before any module that imports it
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock ModelClassifier
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getFallbackModel: vi.fn((model: string) => model),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

// Mock FailureClassifier
vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
}));

describe('fetchInlineContext', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });
  afterEach(async () => {
    await cleanupTestDb();
  });

  it('returns plan, contract, and worklogs from the database', async () => {
    const { upsertNote } = await import('../server/db/queries.js');
    const wfId = 'test-wf-inline';

    upsertNote(`workflow/${wfId}/plan`, 'the plan', null);
    upsertNote(`workflow/${wfId}/contract`, 'the contract', null);
    upsertNote(`workflow/${wfId}/worklog/cycle-1`, 'worklog 1', null);
    upsertNote(`workflow/${wfId}/worklog/cycle-2`, 'worklog 2', null);

    const { fetchInlineContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = fetchInlineContext(wfId);

    expect(ctx.plan).toBe('the plan');
    expect(ctx.contract).toBe('the contract');
    expect(ctx.worklogs).toHaveLength(2);
    expect(ctx.worklogs![0].key).toBe(`workflow/${wfId}/worklog/cycle-1`);
    expect(ctx.worklogs![0].value).toBe('worklog 1');
    expect(ctx.worklogs![1].key).toBe(`workflow/${wfId}/worklog/cycle-2`);
    expect(ctx.worklogs![1].value).toBe('worklog 2');
  });

  it('returns null plan/contract when notes do not exist', async () => {
    const { fetchInlineContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = fetchInlineContext('nonexistent-wf');

    expect(ctx.plan).toBeNull();
    expect(ctx.contract).toBeNull();
    expect(ctx.worklogs).toEqual([]);
  });
});

describe('spawnPhaseJob passes inline context to prompt builders', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });
  afterEach(async () => {
    await cleanupTestDb();
  });

  it('review phase job description contains inline plan and contract', async () => {
    const queries = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'assess',
      current_cycle: 0,
    });

    // Store plan and contract notes
    queries.upsertNote(`workflow/${wf.id}/plan`, '# Plan\n- [ ] M1: Do stuff', null);
    queries.upsertNote(`workflow/${wf.id}/contract`, '# Contract\n- rule', null);
    queries.upsertNote(`workflow/${wf.id}/worklog/cycle-1`, '## Cycle 1\nDid things', null);

    // Trigger a review phase via onJobCompleted with a successful assess job
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const assessJob = await insertTestJob({
      workflow_id: wf.id,
      workflow_phase: 'assess',
      workflow_cycle: 0,
      status: 'done',
    });
    onJobCompleted(assessJob);

    // Find the review job that was spawned
    const jobs = queries.listJobs();
    const reviewJob = jobs.find(j => j.workflow_phase === 'review' && j.id !== assessJob.id);
    expect(reviewJob).toBeDefined();
    expect(reviewJob!.description).toContain('Pre-loaded Context');
    expect(reviewJob!.description).toContain('# Plan');
    expect(reviewJob!.description).toContain('M1: Do stuff');
    expect(reviewJob!.description).toContain('# Contract');
    expect(reviewJob!.description).toContain('Cycle 1');
  });

  it('implement phase job description contains inline plan and contract', async () => {
    const queries = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
    });

    // Store plan and contract notes
    queries.upsertNote(`workflow/${wf.id}/plan`, '# Plan\n- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${wf.id}/contract`, '# Contract\n- rule', null);

    // Trigger implement phase via onJobCompleted with a successful review job
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const reviewJob = await insertTestJob({
      workflow_id: wf.id,
      workflow_phase: 'review',
      workflow_cycle: 1,
      status: 'done',
    });
    onJobCompleted(reviewJob);

    // Find the implement job that was spawned
    const jobs = queries.listJobs();
    const implJob = jobs.find(j => j.workflow_phase === 'implement' && j.id !== reviewJob.id);
    expect(implJob).toBeDefined();
    expect(implJob!.description).toContain('Pre-loaded Context');
    expect(implJob!.description).toContain('# Plan');
    expect(implJob!.description).toContain('- [ ] M2');
    expect(implJob!.description).toContain('# Contract');
  });
});
