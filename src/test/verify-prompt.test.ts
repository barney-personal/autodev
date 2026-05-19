/**
 * Tests for verify-phase prompt rendering:
 * - renderVerifyFailure helper in WorkflowPrompts.ts
 * - buildVerifyPrompt generates correct verify agent instructions
 * - buildImplementPrompt includes verify failure section when context provides it
 */
import { describe, it, expect } from 'vitest';
import {
  renderVerifyFailure,
  buildVerifyPrompt,
  buildImplementPrompt,
  type InlineWorkflowContext,
} from '../server/orchestrator/WorkflowPrompts.js';
import type { Workflow } from '../shared/types.js';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-verify-prompt',
    title: 'Verify Prompt Test',
    task: 'Test verify prompts',
    status: 'running',
    current_phase: 'implement',
    current_cycle: 2,
    max_cycles: 10,
    milestones_total: 3,
    milestones_done: 1,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'codex',
    work_dir: '/tmp/test',
    worktree_path: null,
    worktree_branch: 'feature-branch',
    blocked_reason: null,
    pr_url: null,
    project_id: null,
    template_id: null,
    use_worktree: 1,
    max_turns_assess: 50,
    max_turns_review: 30,
    max_turns_implement: 100,
    stop_mode_assess: 'turns',
    stop_value_assess: 50,
    stop_mode_review: 'turns',
    stop_value_review: 30,
    stop_mode_implement: 'turns',
    stop_value_implement: 100,
    completion_threshold: 1.0,
    start_command: null,
    max_verify_retries: 2,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as Workflow;
}

// ─── renderVerifyFailure ─────────────────────────────────────────────────────

describe('renderVerifyFailure', () => {
  it('returns empty string when failure is null', () => {
    expect(renderVerifyFailure(null)).toBe('');
  });

  it('returns empty string when failure is undefined', () => {
    expect(renderVerifyFailure(undefined)).toBe('');
  });

  it('includes the agent failure note content', () => {
    const note = '## Verify Result: FAIL\n\n**Tests run:** 2\n**Failed:** 1\n\n### Tests\n- [FAIL] Health check returns 500';
    const out = renderVerifyFailure(note);
    expect(out).toContain('Verification Failed');
    expect(out).toContain('QA agent');
    expect(out).toContain('Health check returns 500');
  });

  it('truncates very long content at 5000 chars', () => {
    const longNote = 'x'.repeat(10_000);
    const out = renderVerifyFailure(longNote);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(longNote.length);
  });
});

// ─── buildVerifyPrompt ──────────────────────────────────────────────────────

describe('buildVerifyPrompt', () => {
  it('includes the start command', () => {
    const prompt = buildVerifyPrompt(makeWorkflow({ start_command: 'docker compose up' }), 3);
    expect(prompt).toContain('docker compose up');
  });

  it('falls back to npm run dev when start_command is null', () => {
    const prompt = buildVerifyPrompt(makeWorkflow({ start_command: null }), 2);
    expect(prompt).toContain('npm run dev');
  });

  it('includes the task description', () => {
    const prompt = buildVerifyPrompt(makeWorkflow({ task: 'Build a REST API' }), 1);
    expect(prompt).toContain('Build a REST API');
  });

  it('includes verify result note key', () => {
    const wf = makeWorkflow();
    const prompt = buildVerifyPrompt(wf, 2);
    expect(prompt).toContain(`workflow/${wf.id}/verify-result/2`);
  });

  it('includes branch warning when worktree is active', () => {
    const prompt = buildVerifyPrompt(makeWorkflow({ worktree_branch: 'my-feature' }), 1);
    expect(prompt).toContain('my-feature');
    expect(prompt).toContain('Do NOT switch branches');
  });

  it('mentions independent verifier role', () => {
    const prompt = buildVerifyPrompt(makeWorkflow(), 1);
    expect(prompt).toContain('INDEPENDENT');
    expect(prompt).toContain('skeptical');
  });
});

// ─── buildImplementPrompt with verify failure ─────────────────────────────────

describe('buildImplementPrompt with verifyFailure context', () => {
  it('does NOT include verification failed section when verifyFailure is absent', () => {
    const ctx: InlineWorkflowContext = { plan: '- [ ] M1', contract: 'Contract' };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).not.toContain('Verification Failed');
  });

  it('does NOT include verification failed section when verifyFailure is null', () => {
    const ctx: InlineWorkflowContext = { plan: '- [ ] M1', verifyFailure: null };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).not.toContain('Verification Failed');
  });

  it('includes verification failed section when verifyFailure is provided', () => {
    const ctx: InlineWorkflowContext = {
      plan: '- [ ] M1',
      verifyFailure: '## Verify Result: FAIL\n\n- [FAIL] API returns 500\n  - Suggested fix: Check DB connection',
    };
    const prompt = buildImplementPrompt(makeWorkflow(), 2, ctx);
    expect(prompt).toContain('Verification Failed');
    expect(prompt).toContain('API returns 500');
    expect(prompt).toContain('Check DB connection');
  });
});

// ─── task normalization: start command fields ───────────────────────────────

describe('taskNormalization: start command fields', () => {
  it('validateTaskRequest rejects startCommand on job-routed tasks', async () => {
    const { validateTaskRequest } = await import('../shared/taskNormalization.js');
    const err = validateTaskRequest({ description: 'task', iterations: 1, startCommand: 'npm run dev' });
    expect(err).toMatch(/startCommand.*workflow-only/i);
  });

  it('validateTaskRequest accepts startCommand on workflow-routed tasks', async () => {
    const { validateTaskRequest } = await import('../shared/taskNormalization.js');
    const err = validateTaskRequest({ description: 'task', iterations: 5, startCommand: 'npm run dev', workDir: '/tmp/test' });
    expect(err).toBeNull();
  });

  it('taskToWorkflowRequest passes startCommand through', async () => {
    const { taskToWorkflowRequest } = await import('../shared/taskNormalization.js');
    const req = taskToWorkflowRequest({
      description: 'build it',
      iterations: 5,
      startCommand: 'docker compose up',
      maxVerifyRetries: 3,
    });
    expect(req.startCommand).toBe('docker compose up');
    expect(req.maxVerifyRetries).toBe(3);
  });

  it('taskToWorkflowRequest leaves startCommand undefined when not set', async () => {
    const { taskToWorkflowRequest } = await import('../shared/taskNormalization.js');
    const req = taskToWorkflowRequest({ description: 'build it', iterations: 5 });
    expect(req.startCommand).toBeUndefined();
  });
});
