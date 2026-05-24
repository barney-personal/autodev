import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import { startWorkflow } from './WorkflowManager.js';
import { validateGitWorkDir } from '../shared/workDirValidation.js';
import type {
  CreateAutonomousAgentRunRequest,
  CreateAutonomousAgentRunResponse,
  Workflow,
} from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';
import {
  DEFAULT_WORKFLOW_IMPLEMENTER_MODEL,
  DEFAULT_WORKFLOW_REVIEWER_MODEL,
} from '../../shared/models.js';
import {
  firstWorkflowRunCapIssue,
  WORKFLOW_DEFAULT_STOP_MODE,
  WORKFLOW_DEFAULT_STOP_VALUE,
  WORKFLOW_UNBOUNDED_MAX_TURNS,
} from '../../shared/workflowRunPolicy.js';

export function createAutonomousAgentRun(
  body: CreateAutonomousAgentRunRequest,
): CreateAutonomousAgentRunResponse {
  if (!body.task?.trim()) {
    throw new Error('task is required');
  }

  const capIssue = firstWorkflowRunCapIssue(body);
  if (capIssue) {
    throw new Error(capIssue);
  }

  const useWorktree = body.useWorktree !== false;
  if (useWorktree) {
    const workDirCheck = validateGitWorkDir(body.workDir, { requireGit: true });
    if (!workDirCheck.ok) {
      throw new Error(workDirCheck.error);
    }
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
    implementer_model: body.implementerModel?.trim() || DEFAULT_WORKFLOW_IMPLEMENTER_MODEL,
    reviewer_model: body.reviewerModel?.trim() || DEFAULT_WORKFLOW_REVIEWER_MODEL,
    max_cycles: maxCycles,
    current_cycle: 0,
    current_phase: 'idle',
    status: 'running',
    milestones_total: 0,
    milestones_done: 0,
    project_id: project.id,
    max_turns_assess: WORKFLOW_UNBOUNDED_MAX_TURNS,
    max_turns_review: WORKFLOW_UNBOUNDED_MAX_TURNS,
    max_turns_implement: WORKFLOW_UNBOUNDED_MAX_TURNS,
    stop_mode_assess: body.stopModeAssess ?? WORKFLOW_DEFAULT_STOP_MODE,
    stop_value_assess: WORKFLOW_DEFAULT_STOP_VALUE,
    stop_mode_review: body.stopModeReview ?? WORKFLOW_DEFAULT_STOP_MODE,
    stop_value_review: WORKFLOW_DEFAULT_STOP_VALUE,
    stop_mode_implement: body.stopModeImplement ?? WORKFLOW_DEFAULT_STOP_MODE,
    stop_value_implement: WORKFLOW_DEFAULT_STOP_VALUE,
    template_id: body.templateId?.trim() || null,
    use_worktree: body.useWorktree === false ? 0 : 1,
    worktree_path: null,
    worktree_branch: null,
    blocked_reason: null,
    pr_url: null,
    completion_threshold: Math.min(Math.max(body.completionThreshold ?? 1.0, 0.1), 1.0),
    start_command: body.startCommand?.trim() || null,
    max_verify_retries: Math.min(Math.max(body.maxVerifyRetries ?? 2, 0), 10),
    resolver_circuit_state: null,
    resolver_attempt_count: 0,
    created_at: now,
    updated_at: now,
  };
  if (isCodexModel(workflow.implementer_model)) {
    console.warn(`[workflow] Codex model '${workflow.implementer_model}' selected as implementer — assess phase will auto-fallback to Claude for MCP compatibility`);
  }
  queries.insertWorkflow(workflow);

  const assessJob = startWorkflow(workflow);
  return { workflow, project, jobs: assessJob ? [assessJob] : [] };
}
