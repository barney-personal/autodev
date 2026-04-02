import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import { startWorkflow } from './WorkflowManager.js';
import type {
  CreateAutonomousAgentRunRequest,
  CreateAutonomousAgentRunResponse,
  Workflow,
} from '../../shared/types.js';

export function createAutonomousAgentRun(
  body: CreateAutonomousAgentRunRequest,
): CreateAutonomousAgentRunResponse {
  if (!body.task?.trim()) {
    throw new Error('task is required');
  }

  const workflowId = randomUUID();
  const now = Date.now();
  const title = body.title?.trim() || `Autonomous Agent Run: ${body.task.trim().slice(0, 50)}`;
  const maxCycles = Math.min(Math.max(body.maxCycles ?? 10, 1), 50);

  const project = queries.insertProject({
    id: randomUUID(),
    name: title,
    description: 'Autonomous agent run',
    created_at: now,
    updated_at: now,
  });

  const workflow: Workflow = {
    id: workflowId,
    title,
    task: body.task.trim(),
    work_dir: body.workDir?.trim() || null,
    implementer_model: body.implementerModel?.trim() || 'claude-sonnet-4-6',
    reviewer_model: body.reviewerModel?.trim() || 'codex',
    max_cycles: maxCycles,
    current_cycle: 0,
    current_phase: 'idle',
    status: 'running',
    milestones_total: 0,
    milestones_done: 0,
    project_id: project.id,
    max_turns_assess: body.maxTurnsAssess ?? 50,
    max_turns_review: body.maxTurnsReview ?? 30,
    max_turns_implement: body.maxTurnsImplement ?? 100,
    stop_mode_assess: body.stopModeAssess ?? 'turns',
    stop_value_assess: body.stopValueAssess ?? (body.maxTurnsAssess ?? 50),
    stop_mode_review: body.stopModeReview ?? 'turns',
    stop_value_review: body.stopValueReview ?? (body.maxTurnsReview ?? 30),
    stop_mode_implement: body.stopModeImplement ?? 'turns',
    stop_value_implement: body.stopValueImplement ?? (body.maxTurnsImplement ?? 100),
    template_id: body.templateId?.trim() || null,
    use_worktree: body.useWorktree === false ? 0 : 1,
    worktree_path: null,
    worktree_branch: null,
    blocked_reason: null,
    pr_url: null,
    created_at: now,
    updated_at: now,
  };
  queries.insertWorkflow(workflow);

  const assessJob = startWorkflow(workflow);
  return { workflow, project, jobs: [assessJob] };
}
