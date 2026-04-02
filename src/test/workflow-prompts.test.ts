import { describe, expect, it } from 'vitest';
import type { Workflow } from '../shared/types.js';
import {
  capText,
  buildReviewPrompt,
  buildImplementPrompt,
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
