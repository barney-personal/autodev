/**
 * Tests for M10/M14: Inline workflow scratchpad context in phase prompts.
 *
 * Proves:
 * 1. buildReviewPrompt() includes inline plan, contract, and worklogs when InlineWorkflowContext is provided
 * 2. buildImplementPrompt() includes inline plan, contract, and worklogs when InlineWorkflowContext is provided
 * 3. Without InlineWorkflowContext, prompts still contain read_note/list_notes instructions (backward compat)
 * 4. renderInlineContext() truncates oversized content at INLINE_CONTEXT_MAX_CHARS
 * 5. Total inline context is capped at INLINE_CONTEXT_MAX_CHARS (60K)
 * 6. spawnPhaseJob and resumeWorkflow fetch and pass inline context to prompt builders
 * 7. (M14) buildReviewPrompt() includes a Recent Changes section from the last implement-phase diff
 * 8. (M14) renderRecentChanges() truncates oversized diffs at RECENT_DIFF_MAX_CHARS
 * 9. (M14) preReadWorkflowContext() fetches the last implement diff
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
  renderInlineContext,
  renderRecentChanges,
  hasInlineContent,
  sortWorklogsByNumericCycle,
  INLINE_CONTEXT_MAX_CHARS,
  RECENT_DIFF_MAX_CHARS,
  type InlineWorkflowContext,
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

describe('hasInlineContent', () => {
  it('returns false for undefined', () => {
    expect(hasInlineContent(undefined)).toBe(false);
  });

  it('returns false for object with all empty fields', () => {
    expect(hasInlineContent({ plan: undefined, contract: undefined, worklogs: [] })).toBe(false);
  });

  it('returns false for object with empty strings and empty worklogs', () => {
    expect(hasInlineContent({ plan: '', contract: '', worklogs: [] })).toBe(false);
  });

  it('returns true when plan has content', () => {
    expect(hasInlineContent({ plan: 'some plan' })).toBe(true);
  });

  it('returns true when contract has content', () => {
    expect(hasInlineContent({ contract: 'some contract' })).toBe(true);
  });

  it('returns true when worklogs has entries', () => {
    expect(hasInlineContent({ worklogs: [{ key: 'k', value: 'v' }] })).toBe(true);
  });
});

describe('sortWorklogsByNumericCycle', () => {
  it('sorts single-digit cycles numerically', () => {
    const input = [
      { key: 'workflow/wf/worklog/cycle-3', value: 'c3' },
      { key: 'workflow/wf/worklog/cycle-1', value: 'c1' },
      { key: 'workflow/wf/worklog/cycle-2', value: 'c2' },
    ];
    const sorted = sortWorklogsByNumericCycle(input);
    expect(sorted.map(w => w.key)).toEqual([
      'workflow/wf/worklog/cycle-1',
      'workflow/wf/worklog/cycle-2',
      'workflow/wf/worklog/cycle-3',
    ]);
  });

  it('sorts multi-digit cycles correctly (cycle-2 before cycle-10)', () => {
    const input = [
      { key: 'workflow/wf/worklog/cycle-10', value: 'c10' },
      { key: 'workflow/wf/worklog/cycle-2', value: 'c2' },
      { key: 'workflow/wf/worklog/cycle-1', value: 'c1' },
      { key: 'workflow/wf/worklog/cycle-21', value: 'c21' },
      { key: 'workflow/wf/worklog/cycle-3', value: 'c3' },
    ];
    const sorted = sortWorklogsByNumericCycle(input);
    expect(sorted.map(w => w.key)).toEqual([
      'workflow/wf/worklog/cycle-1',
      'workflow/wf/worklog/cycle-2',
      'workflow/wf/worklog/cycle-3',
      'workflow/wf/worklog/cycle-10',
      'workflow/wf/worklog/cycle-21',
    ]);
  });

  it('places non-cycle keys at the end', () => {
    const input = [
      { key: 'workflow/wf/worklog/summary', value: 'sum' },
      { key: 'workflow/wf/worklog/cycle-2', value: 'c2' },
      { key: 'workflow/wf/worklog/cycle-1', value: 'c1' },
      { key: 'workflow/wf/worklog/notes', value: 'notes' },
    ];
    const sorted = sortWorklogsByNumericCycle(input);
    expect(sorted.map(w => w.key)).toEqual([
      'workflow/wf/worklog/cycle-1',
      'workflow/wf/worklog/cycle-2',
      'workflow/wf/worklog/summary',
      'workflow/wf/worklog/notes',
    ]);
  });

  it('preserves relative order of non-cycle keys', () => {
    const input = [
      { key: 'workflow/wf/worklog/zebra', value: 'z' },
      { key: 'workflow/wf/worklog/alpha', value: 'a' },
    ];
    const sorted = sortWorklogsByNumericCycle(input);
    expect(sorted.map(w => w.key)).toEqual([
      'workflow/wf/worklog/zebra',
      'workflow/wf/worklog/alpha',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(sortWorklogsByNumericCycle([])).toEqual([]);
  });

  it('does not mutate the original array', () => {
    const input = [
      { key: 'workflow/wf/worklog/cycle-2', value: 'c2' },
      { key: 'workflow/wf/worklog/cycle-1', value: 'c1' },
    ];
    const original = [...input];
    sortWorklogsByNumericCycle(input);
    expect(input).toEqual(original);
  });
});

describe('renderInlineContext', () => {
  const planKey = 'workflow/wf-test-123/plan';
  const contractKey = 'workflow/wf-test-123/contract';
  const worklogPrefix = 'workflow/wf-test-123/worklog/';

  it('returns empty string when no context is provided', () => {
    expect(renderInlineContext(undefined, planKey, contractKey, worklogPrefix)).toBe('');
  });

  it('returns empty string when context has no meaningful content', () => {
    const ctx: InlineWorkflowContext = { plan: undefined, contract: undefined, worklogs: [] };
    expect(renderInlineContext(ctx, planKey, contractKey, worklogPrefix)).toBe('');
  });

  it('truncates total inline context exceeding INLINE_CONTEXT_MAX_CHARS', () => {
    const bigContent = 'y'.repeat(INLINE_CONTEXT_MAX_CHARS + 1000);
    const ctx: InlineWorkflowContext = { plan: bigContent, worklogs: [] };
    const result = renderInlineContext(ctx, planKey, contractKey, worklogPrefix);
    expect(result).toContain('truncated');
    expect(result).toContain('list_notes');
  });

  it('renders worklogs in numeric cycle order even when keys are lexicographically misordered', () => {
    const ctx: InlineWorkflowContext = {
      worklogs: [
        { key: 'workflow/wf/worklog/cycle-10', value: 'ten' },
        { key: 'workflow/wf/worklog/cycle-2', value: 'two' },
        { key: 'workflow/wf/worklog/cycle-1', value: 'one' },
      ],
    };
    const result = renderInlineContext(ctx, planKey, contractKey, worklogPrefix);
    const posOne = result.indexOf('#### workflow/wf/worklog/cycle-1');
    const posTwo = result.indexOf('#### workflow/wf/worklog/cycle-2');
    const posTen = result.indexOf('#### workflow/wf/worklog/cycle-10');
    expect(posOne).toBeLessThan(posTwo);
    expect(posTwo).toBeLessThan(posTen);
  });

  it('returns text unchanged when under cap', () => {
    const ctx: InlineWorkflowContext = { plan: 'hello', worklogs: [] };
    const result = renderInlineContext(ctx, planKey, contractKey, worklogPrefix);
    expect(result).toContain('hello');
    expect(result).not.toContain('truncated');
  });

  it('renders diffSummary as "Files Changed So Far" section', () => {
    const ctx: InlineWorkflowContext = {
      diffSummary: ' src/foo.ts | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)',
    };
    const result = renderInlineContext(ctx, planKey, contractKey, worklogPrefix);
    expect(result).toContain('### Files Changed So Far');
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('```');
  });

  it('omits diffSummary section when not present', () => {
    const ctx: InlineWorkflowContext = { plan: 'some plan', worklogs: [] };
    const result = renderInlineContext(ctx, planKey, contractKey, worklogPrefix);
    expect(result).not.toContain('Files Changed So Far');
  });
});

describe('buildReviewPrompt with InlineWorkflowContext', () => {
  const wf = makeWorkflow();
  const ctx: InlineWorkflowContext = {
    plan: '# Plan\n\n- [x] M1\n- [ ] M2',
    contract: '# Contract\n- rule 1',
    worklogs: [
      { key: 'workflow/wf-test-123/worklog/cycle-1', value: '## Cycle 1\nDid stuff' },
    ],
  };

  it('includes inline plan, contract, and worklogs when context is provided', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Plan (snapshot');
    expect(prompt).toContain('- [x] M1');
    expect(prompt).toContain('- [ ] M2');
    expect(prompt).toContain('Contract');
    expect(prompt).toContain('rule 1');
    expect(prompt).toContain('Worklogs (read-only snapshots)');
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
    const emptyCtx: InlineWorkflowContext = { plan: undefined, contract: undefined, worklogs: [] };
    const prompt = buildReviewPrompt(wf, 2, emptyCtx);
    // With empty context, hasInlineContent returns false so prompts use read_note fallback
    expect(prompt).toContain('Read the current plan: `read_note');
    expect(prompt).toContain('Read the operating contract: `read_note');
    expect(prompt).toContain('list_notes("workflow/wf-test-123/worklog/")');
    expect(prompt).not.toContain('pre-loaded below');
    expect(prompt).not.toContain('Pre-loaded Context');
  });

  it('shows worklog reference in code review section pointing to pre-loaded context', () => {
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('Review the worklog in the Pre-loaded Context section below.');
  });
});

describe('buildImplementPrompt with InlineWorkflowContext', () => {
  const wf = makeWorkflow({ current_phase: 'implement' as any });
  const ctx: InlineWorkflowContext = {
    plan: '# Plan\n\n- [x] M1\n- [ ] M2',
    contract: '# Contract\n- rule 1',
    worklogs: [
      { key: 'workflow/wf-test-123/worklog/cycle-1', value: '## Cycle 1\nDid stuff' },
    ],
  };

  it('includes inline plan, contract, and worklogs when context is provided', () => {
    const prompt = buildImplementPrompt(wf, 2, ctx);
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Plan (snapshot');
    expect(prompt).toContain('- [x] M1');
    expect(prompt).toContain('Contract');
    expect(prompt).toContain('rule 1');
    expect(prompt).toContain('Worklogs (read-only snapshots)');
    expect(prompt).toContain('Cycle 1');
  });

  it('replaces read_note instructions with review pre-loaded context instruction', () => {
    const prompt = buildImplementPrompt(wf, 2, ctx);
    expect(prompt).toContain('Review the pre-loaded context');
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

  it('falls back to read_note instructions when inline context has empty values', () => {
    const emptyCtx: InlineWorkflowContext = { plan: undefined, contract: undefined, worklogs: [] };
    const prompt = buildImplementPrompt(wf, 2, emptyCtx);
    expect(prompt).toContain('Read the current plan**: `read_note');
    expect(prompt).toContain('Read the operating contract**: `read_note');
    expect(prompt).not.toContain('pre-loaded context');
    expect(prompt).not.toContain('Pre-loaded Context');
    // Step numbering should use the non-inline values
    expect(prompt).toContain('5. **Implement it**');
  });
});

describe('inline context size capping', () => {
  const wf = makeWorkflow();

  it('truncates inline context exceeding INLINE_CONTEXT_MAX_CHARS (60000 chars)', () => {
    const longPlan = 'x'.repeat(INLINE_CONTEXT_MAX_CHARS + 5000);
    const ctx: InlineWorkflowContext = { plan: longPlan, contract: 'short', worklogs: [] };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    // The inline context section should be truncated at INLINE_CONTEXT_MAX_CHARS
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('list_notes');
    // Should NOT contain the full oversized string
    expect(prompt.length).toBeLessThan(longPlan.length + 5000);
  });

  it('does not truncate when total inline context is under INLINE_CONTEXT_MAX_CHARS', () => {
    const normalContent = 'y'.repeat(1000);
    const ctx: InlineWorkflowContext = {
      plan: normalContent,
      contract: normalContent,
      worklogs: [{ key: 'w/1', value: normalContent }],
    };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).not.toContain('truncated');
  });
});

// ─── M14: renderRecentChanges unit tests ────────────────────────────────────

describe('renderRecentChanges', () => {
  it('returns empty string when diff is undefined', () => {
    expect(renderRecentChanges(undefined)).toBe('');
  });

  it('returns empty string when diff is empty string', () => {
    expect(renderRecentChanges('')).toBe('');
  });

  it('returns empty string when diff is whitespace only', () => {
    expect(renderRecentChanges('   \n\n  ')).toBe('');
  });

  it('renders diff in a code block with Recent Changes heading', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new';
    const result = renderRecentChanges(diff);
    expect(result).toContain('## Recent Changes');
    expect(result).toContain('```diff');
    expect(result).toContain('diff --git a/foo.ts b/foo.ts');
    expect(result).toContain('-old');
    expect(result).toContain('+new');
    expect(result).not.toContain('diff truncated at');
  });

  it('truncates diffs exceeding RECENT_DIFF_MAX_CHARS', () => {
    const largeDiff = 'x'.repeat(RECENT_DIFF_MAX_CHARS + 5000);
    const result = renderRecentChanges(largeDiff);
    expect(result).toContain('## Recent Changes');
    expect(result).toContain('diff truncated at');
    expect(result).toContain('git log --patch');
    // The rendered output should be smaller than the input
    expect(result.length).toBeLessThan(largeDiff.length + 1000);
  });

  it('does not truncate diffs under the cap', () => {
    const smallDiff = 'diff line\n'.repeat(100);
    const result = renderRecentChanges(smallDiff);
    expect(result).toContain('## Recent Changes');
    expect(result).not.toContain('diff truncated at');
  });
});

describe('buildReviewPrompt with recent diff context', () => {
  const wf = makeWorkflow();

  it('includes Recent Changes section for cycle 2+ when recentDiff is provided', () => {
    const ctx: InlineWorkflowContext = {
      plan: '# Plan\n- [x] M1\n- [ ] M2',
      contract: '# Contract',
      worklogs: [],
      recentDiff: 'diff --git a/file.ts b/file.ts\n-old\n+new',
    };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).toContain('## Recent Changes');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('-old');
    expect(prompt).toContain('+new');
  });

  it('does not include Recent Changes for cycle 1 (first review, no code yet)', () => {
    const ctx: InlineWorkflowContext = {
      plan: '# Plan\n- [ ] M1',
      contract: '# Contract',
      worklogs: [],
      recentDiff: 'diff --git a/file.ts b/file.ts\n-old\n+new',
    };
    const prompt = buildReviewPrompt(wf, 1, ctx);
    expect(prompt).not.toContain('## Recent Changes');
    expect(prompt).not.toContain('```diff');
  });

  it('does not include Recent Changes when recentDiff is undefined', () => {
    const ctx: InlineWorkflowContext = {
      plan: '# Plan\n- [x] M1\n- [ ] M2',
      contract: '# Contract',
      worklogs: [],
    };
    const prompt = buildReviewPrompt(wf, 2, ctx);
    expect(prompt).not.toContain('## Recent Changes');
  });

  it('does not include Recent Changes when no inline context at all', () => {
    const prompt = buildReviewPrompt(wf, 2);
    expect(prompt).not.toContain('## Recent Changes');
  });

  it('truncates oversized diff in review prompt', () => {
    const ctx: InlineWorkflowContext = {
      plan: '# Plan',
      contract: '# Contract',
      worklogs: [],
      recentDiff: 'z'.repeat(RECENT_DIFF_MAX_CHARS + 5000),
    };
    const prompt = buildReviewPrompt(wf, 3, ctx);
    expect(prompt).toContain('## Recent Changes');
    expect(prompt).toContain('diff truncated at');
  });

  it('does not include Recent Changes in implement prompts (recentDiff is ignored)', () => {
    const implWf = makeWorkflow({ current_phase: 'implement' as any });
    const ctx: InlineWorkflowContext = {
      plan: '# Plan\n- [ ] M2',
      contract: '# Contract',
      worklogs: [],
      recentDiff: 'diff --git a/file.ts b/file.ts\n-old\n+new',
    };
    const prompt = buildImplementPrompt(implWf, 2, ctx);
    expect(prompt).not.toContain('## Recent Changes');
  });
});

// ─── Integration tests: WorkflowManager fetches inline context ──────────────

// Mock SocketManager before any module that imports it
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

// Mock ModelClassifier
vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getAvailableModel: vi.fn((model: string) => model),
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
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

describe('preReadWorkflowContext', () => {
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

    const { preReadWorkflowContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = preReadWorkflowContext(wfId);

    expect(ctx.plan).toBe('the plan');
    expect(ctx.contract).toBe('the contract');
    expect(ctx.worklogs).toHaveLength(2);
    expect(ctx.worklogs![0].key).toBe(`workflow/${wfId}/worklog/cycle-1`);
    expect(ctx.worklogs![0].value).toBe('worklog 1');
    expect(ctx.worklogs![1].key).toBe(`workflow/${wfId}/worklog/cycle-2`);
    expect(ctx.worklogs![1].value).toBe('worklog 2');
  });

  it('returns undefined plan/contract when notes do not exist', async () => {
    const { preReadWorkflowContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = preReadWorkflowContext('nonexistent-wf');

    expect(ctx.plan).toBeUndefined();
    expect(ctx.contract).toBeUndefined();
    expect(ctx.worklogs).toEqual([]);
  });

  it('returns recentDiff from the last completed implement-phase agent', async () => {
    const queries = await import('../server/db/queries.js');
    const { randomUUID } = await import('crypto');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 2,
    });

    // Create a completed implement-phase job with an agent that has a diff
    const implJob = await insertTestJob({
      workflow_id: wf.id,
      workflow_phase: 'implement',
      workflow_cycle: 1,
      status: 'done',
    });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: implJob.id });
    queries.updateAgent(agentId, { status: 'done', diff: 'diff --git a/foo.ts\n-old\n+new' });

    const { preReadWorkflowContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = preReadWorkflowContext(wf.id);

    expect(ctx.recentDiff).toBe('diff --git a/foo.ts\n-old\n+new');
  });

  it('returns undefined recentDiff when no implement-phase agents have diffs', async () => {
    const queries = await import('../server/db/queries.js');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'review',
      current_cycle: 1,
    });

    // Create an assess job (no implement phase yet)
    await insertTestJob({
      workflow_id: wf.id,
      workflow_phase: 'assess',
      workflow_cycle: 0,
      status: 'done',
    });

    const { preReadWorkflowContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = preReadWorkflowContext(wf.id);

    expect(ctx.recentDiff).toBeUndefined();
  });

  it('returns undefined diffSummary when workflow has no worktree', async () => {
    const { upsertNote } = await import('../server/db/queries.js');
    const wfId = 'test-wf-no-worktree';
    upsertNote(`workflow/${wfId}/plan`, 'a plan', null);

    const { preReadWorkflowContext } = await import('../server/orchestrator/WorkflowManager.js');
    const ctx = preReadWorkflowContext(wfId);

    expect(ctx.diffSummary).toBeUndefined();
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

  it('review phase job (cycle 2+) includes Recent Changes from implement diff', async () => {
    const queries = await import('../server/db/queries.js');
    const { randomUUID } = await import('crypto');
    const project = await insertTestProject();
    const wf = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 1,
    });

    // Store plan note
    queries.upsertNote(`workflow/${wf.id}/plan`, '# Plan\n- [x] M1\n- [ ] M2', null);
    queries.upsertNote(`workflow/${wf.id}/contract`, '# Contract\n- rule', null);

    // Create a completed implement-phase job with a diff-bearing agent
    const implJob = await insertTestJob({
      workflow_id: wf.id,
      workflow_phase: 'implement',
      workflow_cycle: 1,
      status: 'done',
    });
    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: implJob.id });
    queries.updateAgent(agentId, { status: 'done', diff: 'diff --git a/bar.ts\n-removed\n+added' });

    // Trigger a review phase via onJobCompleted from the implement job
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    onJobCompleted(implJob);

    // Find the review job that was spawned (cycle 2)
    const jobs = queries.listJobs();
    const reviewJob = jobs.find(j => j.workflow_phase === 'review' && j.workflow_cycle === 2);
    expect(reviewJob).toBeDefined();
    expect(reviewJob!.description).toContain('## Recent Changes');
    expect(reviewJob!.description).toContain('```diff');
    expect(reviewJob!.description).toContain('-removed');
    expect(reviewJob!.description).toContain('+added');
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
