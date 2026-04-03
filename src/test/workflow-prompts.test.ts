import { describe, expect, it } from 'vitest';
import type { Workflow } from '../shared/types.js';
import {
  capText,
  buildReviewPrompt,
  buildImplementPrompt,
  buildAssessPrompt,
  type InlineContext,
} from '../server/orchestrator/WorkflowPrompts.js';

/** Minimal workflow fixture for prompt builders. */
function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test-001',
    task: 'Test task',
    status: 'running',
    current_phase: 'implement',
    current_cycle: 2,
    max_cycles: 10,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'claude-sonnet-4-6',
    work_dir: '/tmp/test-project',
    worktree_branch: 'test-branch',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as Workflow;
}

// ─── capText ────────────────────────────────────────────────────────────────

describe('capText', () => {
  it('returns text unchanged when under cap', () => {
    const text = 'Hello, world!';
    expect(capText(text, 100)).toBe(text);
  });

  it('returns text unchanged when exactly at cap', () => {
    const text = 'abcde';
    expect(capText(text, 5)).toBe(text);
  });

  it('truncates with notice when over cap', () => {
    const text = 'abcdefghij'; // 10 chars
    const result = capText(text, 5);
    expect(result).toContain('abcde');
    expect(result).toContain('truncated at 5 characters');
    expect(result).not.toContain('fghij');
  });
});

// ─── buildReviewPrompt with inline context ──────────────────────────────────

describe('buildReviewPrompt with inline context', () => {
  it('includes Pre-loaded Context section and omits read instructions', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [ ] M1: Do something',
      contract: '# Contract\n- rule 1',
      worklogs: [{ key: 'workflow/wf-test-001/worklog/cycle-1', value: '## Cycle 1 worklog' }],
    };

    const prompt = buildReviewPrompt(wf, 2, ctx);

    // Should contain pre-loaded context
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Current Plan');
    expect(prompt).toContain('Operating Contract');
    expect(prompt).toContain('Previous Worklogs');
    expect(prompt).toContain('# Plan');
    expect(prompt).toContain('# Contract');
    expect(prompt).toContain('Cycle 1 worklog');

    // Should NOT contain step-by-step read instructions
    expect(prompt).not.toContain('Step 1: Read Context');
    expect(prompt).not.toContain('read_note("workflow/wf-test-001/plan")');
  });

  it('includes Step 1: Read Context when no inline context provided', () => {
    const wf = makeWorkflow();
    const prompt = buildReviewPrompt(wf, 2);

    expect(prompt).toContain('Step 1: Read Context');
    expect(prompt).toContain('read_note("workflow/wf-test-001/plan")');
    expect(prompt).not.toContain('Pre-loaded Context');
  });
});

// ─── buildReviewPrompt adversarial quality bar ─────────────────────────────

describe('buildReviewPrompt adversarial quality bar', () => {
  it('cycle 1 (plan review) requires at least 2 improvements', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [ ] M1: Do something',
    };

    const prompt = buildReviewPrompt(wf, 1, ctx);

    // Should have the quality bar section
    expect(prompt).toContain('Review Quality Bar');
    expect(prompt).toContain('at least 2 concrete improvements');
    expect(prompt).toContain('"Plan looks good" is never sufficient');

    // Should NOT have code review section (no code yet in cycle 1)
    expect(prompt).not.toContain('Code Review (MOST IMPORTANT)');
  });

  it('cycle 1 without inline context also includes quality bar', () => {
    const wf = makeWorkflow();
    const prompt = buildReviewPrompt(wf, 1);

    expect(prompt).toContain('Review Quality Bar');
    expect(prompt).toContain('at least 2 concrete improvements');
  });

  it('cycle 1 without inline context has no duplicate step numbers', () => {
    const wf = makeWorkflow();
    const prompt = buildReviewPrompt(wf, 1);

    // Extract all "## Step N:" headings
    const stepHeaders = [...prompt.matchAll(/## Step (\d+):/g)].map(m => Number(m[1]));
    // Should have at least 2 steps (Read Context + Review Quality Bar + Update Plan)
    expect(stepHeaders.length).toBeGreaterThanOrEqual(2);
    // No duplicates
    const unique = new Set(stepHeaders);
    expect(unique.size).toBe(stepHeaders.length);
    // Steps should be sequential starting from 1
    for (let i = 0; i < stepHeaders.length; i++) {
      expect(stepHeaders[i]).toBe(i + 1);
    }
  });

  it('cycle 1 with inline context has sequential step numbers', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [ ] M1: Do something',
    };
    const prompt = buildReviewPrompt(wf, 1, ctx);

    const stepHeaders = [...prompt.matchAll(/## Step (\d+):/g)].map(m => Number(m[1]));
    expect(stepHeaders.length).toBeGreaterThanOrEqual(2);
    const unique = new Set(stepHeaders);
    expect(unique.size).toBe(stepHeaders.length);
    for (let i = 0; i < stepHeaders.length; i++) {
      expect(stepHeaders[i]).toBe(i + 1);
    }
  });

  it('cycle 2+ with inline context has sequential step numbers', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [x] M1\n- [ ] M2: Next thing',
      worklogs: [{ key: 'workflow/wf-test-001/worklog/cycle-1', value: '## Cycle 1 worklog' }],
    };
    const prompt = buildReviewPrompt(wf, 2, ctx);

    const stepHeaders = [...prompt.matchAll(/## Step (\d+):/g)].map(m => Number(m[1]));
    expect(stepHeaders.length).toBeGreaterThanOrEqual(2);
    const unique = new Set(stepHeaders);
    expect(unique.size).toBe(stepHeaders.length);
    for (let i = 0; i < stepHeaders.length; i++) {
      expect(stepHeaders[i]).toBe(i + 1);
    }
  });

  it('cycle 2+ without inline context has sequential step numbers', () => {
    const wf = makeWorkflow();
    const prompt = buildReviewPrompt(wf, 2);

    const stepHeaders = [...prompt.matchAll(/## Step (\d+):/g)].map(m => Number(m[1]));
    expect(stepHeaders.length).toBeGreaterThanOrEqual(2);
    const unique = new Set(stepHeaders);
    expect(unique.size).toBe(stepHeaders.length);
    for (let i = 0; i < stepHeaders.length; i++) {
      expect(stepHeaders[i]).toBe(i + 1);
    }
  });

  it('cycle 2+ (code review) requires at least 2 concrete issues', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [x] M1\n- [ ] M2: Next thing',
      worklogs: [{ key: 'workflow/wf-test-001/worklog/cycle-1', value: '## Cycle 1 worklog' }],
    };

    const prompt = buildReviewPrompt(wf, 2, ctx);

    // Should have adversarial code review language
    expect(prompt).toContain('You must find at least 2 concrete issues');
    expect(prompt).toContain('"Looks good" is never sufficient');

    // Should NOT have plan review quality bar (that's cycle 1 only)
    expect(prompt).not.toContain('Review Quality Bar');
  });

  it('cycle 2+ without inline context also includes adversarial language', () => {
    const wf = makeWorkflow();
    const prompt = buildReviewPrompt(wf, 2);

    expect(prompt).toContain('You must find at least 2 concrete issues');
    expect(prompt).toContain('Code Review (MOST IMPORTANT)');
  });
});

// ─── buildImplementPrompt with inline context ───────────────────────────────

describe('buildImplementPrompt with inline context', () => {
  it('includes Pre-loaded Context section and omits note read instructions', () => {
    const wf = makeWorkflow();
    const ctx: InlineContext = {
      plan: '# Plan\n\n- [ ] M1: implement feature',
      contract: '# Contract\n- follow rules',
      worklogs: [{ key: 'workflow/wf-test-001/worklog/cycle-1', value: '## Cycle 1 done' }],
    };

    const prompt = buildImplementPrompt(wf, 2, ctx);

    // Should contain pre-loaded context
    expect(prompt).toContain('Pre-loaded Context');
    expect(prompt).toContain('Current Plan');
    expect(prompt).toContain('Operating Contract');
    expect(prompt).toContain('Previous Worklogs');
    expect(prompt).toContain('# Plan');
    expect(prompt).toContain('implement feature');

    // Step numbering should be adjusted for inline (step 3 = implement, not step 5)
    expect(prompt).toContain('3. **Implement it**');

    // Should NOT contain step-by-step note read instructions
    expect(prompt).not.toContain('Read the current plan**: `read_note(');
    expect(prompt).not.toContain('Read the operating contract**: `read_note(');
    expect(prompt).not.toContain('list_notes("workflow/wf-test-001/worklog/")');
  });

  it('includes note read instructions when no inline context provided', () => {
    const wf = makeWorkflow();
    const prompt = buildImplementPrompt(wf, 2);

    expect(prompt).toContain('Read the current plan');
    expect(prompt).toContain('read_note("workflow/wf-test-001/plan")');
    expect(prompt).toContain('list_notes("workflow/wf-test-001/worklog/")');
    expect(prompt).not.toContain('Pre-loaded Context');

    // Step numbering should be standard (step 5 = implement)
    expect(prompt).toContain('5. **Implement it**');
  });
});

// ─── buildImplementPrompt turn budget visibility (M3/1B) ──────────────────

describe('buildImplementPrompt turn budget visibility', () => {
  it('includes Budget heading and turn count with default turns mode', () => {
    const wf = makeWorkflow({ stop_mode_implement: 'turns', stop_value_implement: 75 });
    const prompt = buildImplementPrompt(wf, 2);

    expect(prompt).toContain('## Budget');
    expect(prompt).toContain('75 turns');
    expect(prompt).toContain('commit your current work');
  });

  it('uses safety cap when stop_mode is not turns', () => {
    const wf = makeWorkflow({ stop_mode_implement: 'budget', stop_value_implement: 5 });
    const prompt = buildImplementPrompt(wf, 2);

    expect(prompt).toContain('## Budget');
    expect(prompt).toContain('1000 turns');
  });

  it('Budget section appears between Working Directory and Instructions', () => {
    const wf = makeWorkflow({ stop_mode_implement: 'turns', stop_value_implement: 50 });
    const prompt = buildImplementPrompt(wf, 1);

    const dirIdx = prompt.indexOf('## Working Directory');
    const budgetIdx = prompt.indexOf('## Budget');
    const instrIdx = prompt.indexOf('## Instructions');

    expect(dirIdx).toBeLessThan(budgetIdx);
    expect(budgetIdx).toBeLessThan(instrIdx);
  });
});

// ─── buildAssessPrompt turn-aware milestone sizing (M6/1A) ────────────────

describe('buildAssessPrompt turn-aware milestone sizing', () => {
  it('includes turn budget number and 30-40 tool calls guidance', () => {
    const wf = makeWorkflow({ stop_mode_implement: 'turns', stop_value_implement: 80 });
    const prompt = buildAssessPrompt(wf);

    expect(prompt).toContain('80 turns');
    expect(prompt).toContain('30-40 tool calls');
    expect(prompt).toContain('Size milestones for the turn budget');
  });

  it('uses safety cap when stop_mode is not turns', () => {
    const wf = makeWorkflow({ stop_mode_implement: 'budget', stop_value_implement: null });
    const prompt = buildAssessPrompt(wf);

    expect(prompt).toContain('1000 turns');
    expect(prompt).toContain('30-40 tool calls');
  });
});
