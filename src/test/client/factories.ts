import type { Job, AgentWithJob, Workflow, FileLock, Question, AgentWarning } from '@shared/types';

let seq = 0;
function uid(): string {
  return `test-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? uid();
  return {
    id, title: 'Test Job', description: 'A test job description', context: null, status: 'queued',
    priority: 0, work_dir: null, max_turns: 10, stop_mode: 'turns', stop_value: 10,
    model: 'claude-sonnet-4-6', template_id: null, depends_on: null, flagged: 0, is_interactive: 0,
    use_worktree: 0, project_id: null, debate_id: null, debate_loop: null, debate_round: null,
    debate_role: null, scheduled_at: null, repeat_interval_ms: null, retry_policy: 'none',
    max_retries: 0, retry_count: 0, original_job_id: null, completion_checks: null,
    review_config: null, review_status: null, review_parent_job_id: null, created_by_agent_id: null,
    pre_debate_id: null, pre_debate_summary: null, workflow_id: null, workflow_cycle: null,
    workflow_phase: null, pr_url: null, watch: 1, archived_at: null,
    created_at: Date.now(), updated_at: Date.now(), ...overrides,
  };
}

export function makeAgent(overrides: Partial<AgentWithJob> = {}): AgentWithJob {
  const id = overrides.id ?? uid();
  const job = overrides.job ?? makeJob({ status: 'running' });
  return {
    id, job_id: job.id, status: 'running', pid: 12345, session_id: null, parent_agent_id: null,
    exit_code: null, error_message: null, status_message: null, output_read: 0, base_sha: null,
    diff: null, cost_usd: null, duration_ms: null, num_turns: null, estimated_input_tokens: null,
    estimated_output_tokens: null, pending_wait_ids: null, started_at: Date.now() - 60_000,
    updated_at: Date.now(), finished_at: null, job, template_name: null, pending_question: null,
    active_locks: [], child_agents: [], warnings: [], ...overrides,
  };
}

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? uid(), title: 'Test Workflow', task: 'Test task description', work_dir: null,
    implementer_model: 'claude-sonnet-4-6', reviewer_model: 'claude-opus-4-6', max_cycles: 3,
    current_cycle: 1, current_phase: 'implement', status: 'running', milestones_total: 5,
    milestones_done: 2, project_id: null, max_turns_assess: 10, max_turns_review: 10,
    max_turns_implement: 50, stop_mode_assess: 'turns', stop_value_assess: 10,
    stop_mode_review: 'turns', stop_value_review: 10, stop_mode_implement: 'turns',
    stop_value_implement: 50, template_id: null, use_worktree: 0, worktree_path: null,
    worktree_branch: null, blocked_reason: null, pr_url: null, completion_threshold: 0.9,
    created_at: Date.now() - 300_000, updated_at: Date.now(), ...overrides,
  };
}

export function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: overrides.id ?? uid(), agent_id: uid(), question: 'What should I do?',
    answer: null, status: 'pending', asked_at: Date.now(), answered_at: null,
    timeout_ms: 30000, ...overrides,
  };
}

export function makeLock(overrides: Partial<FileLock> = {}): FileLock {
  return {
    id: overrides.id ?? uid(), agent_id: uid(), file_path: '/src/index.ts',
    reason: 'editing', acquired_at: Date.now(), expires_at: Date.now() + 60_000,
    released_at: null, ...overrides,
  };
}

export function makeWarning(overrides: Partial<AgentWarning> = {}): AgentWarning {
  return {
    id: overrides.id ?? uid(), agent_id: uid(), type: 'stalled',
    message: 'Agent appears stalled', dismissed: 0, created_at: Date.now(), ...overrides,
  };
}
