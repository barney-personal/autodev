import { z } from 'zod';
import * as queries from '../../db/queries.js';
import { validateTaskRequest } from '../../../shared/taskNormalization.js';
import type { CreateTaskRequest } from '../../../shared/types.js';
import { createTaskCore } from '../../api/tasks.js';

const stopModeEnum = z.enum(['turns', 'budget', 'time', 'completion']);
const retryPolicyEnum = z.enum(['none', 'same', 'analyze']);

export const createTaskSchema = z.object({
  // ── Core ──────────────────────────────────────────────────────────────────
  description: z.string().optional().describe('Task description (required unless templateId is provided for job-routed tasks)'),
  title: z.string().optional().describe('Short title (auto-generated if omitted)'),
  preset: z.enum(['quick', 'reviewed', 'autonomous']).optional().describe('Preset hint: quick (single-shot job), reviewed (job with review pass), autonomous (multi-cycle workflow). Defaults inferred from other fields.'),

  // ── Complexity dial ───────────────────────────────────────────────────────
  review: z.boolean().optional().describe('Enable a review pass. Auto-enabled for reviewed/autonomous presets.'),
  iterations: z.number().optional().describe('Number of assess/review/implement cycles. 1 = job, >1 = workflow. Range: 1-50.'),

  // ── Model ─────────────────────────────────────────────────────────────────
  model: z.string().optional().describe('Primary/implementer model override'),
  reviewerModel: z.string().optional().describe('Reviewer model (used when review is enabled)'),

  // ── Environment ───────────────────────────────────────────────────────────
  workDir: z.string().optional().describe("Working directory (inherited from calling agent's job if omitted)"),
  useWorktree: z.boolean().optional().describe('Create a git worktree for isolation. Auto-enabled for iterations > 1.'),
  templateId: z.string().optional().describe('Template ID to apply'),
  projectId: z.string().optional().describe('Project to associate with (job-routed only; workflows create their own project)'),

  // ── Stopping conditions (simple — job-routed) ─────────────────────────────
  stopMode: stopModeEnum.optional().describe('Stopping mode for job-routed tasks'),
  stopValue: z.number().optional().describe('Stopping value for job-routed tasks'),
  maxTurns: z.number().optional().describe('Max agent turns for job-routed tasks'),

  // ── Stopping conditions (per-phase — workflow-routed) ─────────────────────
  maxTurnsAssess: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  maxTurnsReview: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  maxTurnsImplement: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeAssess: stopModeEnum.optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueAssess: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeReview: stopModeEnum.optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueReview: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeImplement: stopModeEnum.optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueImplement: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  completionThreshold: z.number().optional().describe('Milestone completion threshold 0.1-1.0 (workflow only)'),

  // ── Verification (workflow-only) ─────────────────────────────────────────
  startCommand: z.string().optional().describe('Command to start the app for smoke testing before PR creation (workflow only). e.g. npm run dev, docker compose up.'),
  maxVerifyRetries: z.number().optional().describe('Max verify retries before blocking, default 2 (workflow only). Only used when startCommand is set.'),

  // ── Advanced job options ──────────────────────────────────────────────────
  context: z.record(z.string()).optional().describe('Extra key/value context passed to the job (job only)'),
  priority: z.number().optional().describe('Priority 0-10 (job only)'),
  dependsOn: z.array(z.string()).optional().describe('Job IDs that must complete first (job only)'),
  interactive: z.boolean().optional().describe('Run as interactive tmux session (job only)'),
  repeatIntervalMs: z.number().optional().describe('Repeat interval in ms for recurring jobs (job only)'),
  scheduledAt: z.number().optional().describe('Unix timestamp (ms) to schedule the job for (job only)'),
  retryPolicy: retryPolicyEnum.optional().describe('Retry policy: none, same, or analyze (job only)'),
  maxRetries: z.number().optional().describe('Max retry attempts (job only)'),
  completionChecks: z.array(z.string()).optional().describe('Completion check commands (job only)'),
  reviewConfig: z.object({
    models: z.array(z.string()),
    auto: z.boolean(),
  }).optional().describe('Review configuration with model list and auto flag (job only)'),

  // ── Debate (job-only) ─────────────────────────────────────────────────────
  debate: z.boolean().optional().describe('Run a pre-job debate before starting (job only)'),
  debateClaudeModel: z.string().optional().describe('Claude model for debate (job only)'),
  debateCodexModel: z.string().optional().describe('Codex model for debate (job only)'),
  debateMaxRounds: z.number().optional().describe('Max debate rounds 1-10 (job only)'),
});

export async function createTaskHandler(
  agentId: string,
  input: z.infer<typeof createTaskSchema>,
): Promise<string> {
  // Map MCP input directly to CreateTaskRequest — schema uses canonical camelCase names
  const taskReq: CreateTaskRequest = {
    description: input.description,
    title: input.title,
    preset: input.preset,
    review: input.review,
    iterations: input.iterations,
    model: input.model,
    reviewerModel: input.reviewerModel,
    workDir: input.workDir,
    useWorktree: input.useWorktree,
    templateId: input.templateId,
    projectId: input.projectId,
    stopMode: input.stopMode,
    stopValue: input.stopValue,
    maxTurns: input.maxTurns,
    maxTurnsAssess: input.maxTurnsAssess,
    maxTurnsReview: input.maxTurnsReview,
    maxTurnsImplement: input.maxTurnsImplement,
    stopModeAssess: input.stopModeAssess,
    stopValueAssess: input.stopValueAssess,
    stopModeReview: input.stopModeReview,
    stopValueReview: input.stopValueReview,
    stopModeImplement: input.stopModeImplement,
    stopValueImplement: input.stopValueImplement,
    completionThreshold: input.completionThreshold,
    startCommand: input.startCommand,
    maxVerifyRetries: input.maxVerifyRetries,
    context: input.context,
    priority: input.priority,
    dependsOn: input.dependsOn,
    interactive: input.interactive,
    repeatIntervalMs: input.repeatIntervalMs,
    scheduledAt: input.scheduledAt,
    retryPolicy: input.retryPolicy,
    maxRetries: input.maxRetries,
    completionChecks: input.completionChecks,
    reviewConfig: input.reviewConfig,
    debate: input.debate,
    debateClaudeModel: input.debateClaudeModel,
    debateCodexModel: input.debateCodexModel,
    debateMaxRounds: input.debateMaxRounds,
  };

  // Inherit work_dir, model, and projectId from calling agent's parent job if not specified
  let inheritedModel: string | null = null;
  let inheritedProjectId: string | null = null;
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      if (!taskReq.workDir) taskReq.workDir = parentJob.work_dir ?? undefined;
      if (!taskReq.model) inheritedModel = parentJob.model ?? null;
      if (!taskReq.projectId) inheritedProjectId = parentJob.project_id ?? null;
    }
  }

  // Validate using shared normalization layer
  const error = validateTaskRequest(taskReq);
  if (error) {
    return JSON.stringify({ error });
  }

  // Create task using shared core logic (same path as POST /api/tasks)
  try {
    const { response, asyncWork } = createTaskCore(taskReq, {
      createdByAgentId: agentId,
      inheritedModel,
      inheritedProjectId,
    });

    // Fire-and-forget async work (smart title generation)
    if (asyncWork) asyncWork().catch(() => {});

    // Return MCP-friendly response shape
    if (response.task_type === 'workflow') {
      return JSON.stringify({
        task_type: 'workflow',
        autonomous_agent_run_id: response.workflow!.id,
        title: response.workflow!.title,
        status: response.workflow!.status,
        project_id: response.project!.id,
        assess_job_id: response.jobs?.[0]?.id ?? null,
      });
    }

    return JSON.stringify({
      task_type: 'job',
      job_id: response.job!.id,
      title: response.job!.title,
      status: response.job!.status,
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message ?? 'Failed to create task' });
  }
}
