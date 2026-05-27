import { describe, expect, it } from 'vitest';
import {
  getWorkflowWorktreeIdentity,
  slugForWorkflow,
} from '../server/orchestrator/WorkflowWorktreeIdentity.js';
import type { Workflow } from '../shared/types.js';

function mkWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: '1234567890abcdef',
    title: 'Improve worktree creation',
    task: 'Make worktree naming deterministic',
    work_dir: '/tmp/repos/autodev',
    implementer_model: 'claude-opus-4-7',
    reviewer_model: 'codex',
    max_cycles: 5,
    current_cycle: 0,
    current_phase: 'idle',
    status: 'running',
    milestones_total: 0,
    milestones_done: 0,
    project_id: null,
    max_turns_assess: 0,
    max_turns_review: 0,
    max_turns_implement: 0,
    stop_mode_assess: 'turns',
    stop_value_assess: null,
    stop_mode_review: 'turns',
    stop_value_review: null,
    stop_mode_implement: 'turns',
    stop_value_implement: null,
    template_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    blocked_reason: null,
    pr_url: null,
    completion_threshold: 0,
    start_command: null,
    max_verify_retries: 0,
    resolver_circuit_state: null,
    resolver_attempt_count: 0,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  };
}

describe('WorkflowWorktreeIdentity', () => {
  it('normalizes workflow titles into bounded branch slugs', () => {
    expect(slugForWorkflow('Raise Core Components To 10/10 (relaunch)')).toBe(
      'raise-core-components-to-10-10-relaunch',
    );
    expect(slugForWorkflow('x'.repeat(80))).toBe('x'.repeat(40));
  });

  it('falls back to task when the title has no slug-safe characters', () => {
    expect(slugForWorkflow('')).toBe('task');
    expect(slugForWorkflow('!!!')).toBe('task');
  });

  it('uses the fallback slug in worktree branch names', () => {
    const identity = getWorkflowWorktreeIdentity(mkWorkflow({ title: '!!!' }));

    expect(identity).toEqual({
      worktree_branch: 'workflow/task-12345678',
      worktree_path: '/tmp/repos/.orchestrator-worktrees/autodev/wf-12345678',
    });
  });

  it('does not create an identity without a work directory', () => {
    expect(getWorkflowWorktreeIdentity(mkWorkflow({ work_dir: null }))).toBeNull();
  });
});
