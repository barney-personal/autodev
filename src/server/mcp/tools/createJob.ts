import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';
import { isEyeJob } from '../../orchestrator/EyeConfig.js';
import { nudgeQueue } from '../../orchestrator/WorkQueueManager.js';

export const createJobSchema = z.object({
  description: z.string().describe('Full task description for the new job'),
  title: z.string().optional().describe('Short title (auto-generated from first line if omitted)'),
  priority: z.number().optional().describe('Priority 0–10; higher runs sooner (default: 0)'),
  work_dir: z.string().optional().describe("Working directory (defaults to this agent's working directory)"),
  max_turns: z.number().optional().describe('Max agent turns (default: 50). Ignored when stop_mode is not "turns".'),
  stop_mode: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('How to stop the agent: "turns" (default), "budget" (dollar limit), "time" (minute limit), or "completion" (run to natural finish)'),
  stop_value: z.number().optional().describe('Limit value for the stop mode: turn count, dollar amount, or minutes. Not used for "completion".'),
  model: z.string().optional().describe('Model override, e.g. "claude-opus-4-6" (default: auto-classify)'),
  depends_on: z.array(z.string()).optional().describe('Job IDs that must complete before this job runs'),
  use_worktree: z.boolean().optional().describe('Create a git worktree so the agent works in an isolated checkout'),
  repeat_interval_ms: z.number().optional().describe('Re-queue the job automatically after it completes; value is the delay in ms before the next run'),
});

export async function createJobHandler(agentId: string, input: z.infer<typeof createJobSchema>): Promise<string> {
  const { description, title, priority, work_dir, max_turns, stop_mode, stop_value, model, depends_on, use_worktree, repeat_interval_ms } = input;

  // Inherit work_dir, project_id, and model from calling agent's job if not specified
  let resolvedWorkDir = work_dir ?? null;
  let inheritedProjectId: string | null = null;
  let inheritedModel: string | null = null;
  const agent = queries.getAgentById(agentId);
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob) {
      if (!resolvedWorkDir) resolvedWorkDir = parentJob.work_dir ?? null;
      inheritedProjectId = parentJob.project_id ?? null;
      inheritedModel = parentJob.model ?? null;
    }
  }

  // If the calling agent's job was spawned by the retry system (has original_job_id),
  // inherit retry settings so the new job continues the retry chain
  let retryPolicy: 'none' | 'same' | 'analyze' = 'none';
  let maxRetries = 0;
  let retryCount = 0;
  let originalJobId: string | null = null;
  let completionChecks: string | null = null;
  if (agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob?.original_job_id) {
      // This agent is an analysis agent — look up the original job to get retry settings
      const origJob = queries.getJobById(parentJob.original_job_id);
      if (origJob) {
        retryPolicy = origJob.retry_policy ?? 'none';
        maxRetries = origJob.max_retries ?? 0;
        retryCount = parentJob.retry_count + 1; // increment from analysis job's count
        originalJobId = origJob.original_job_id ?? origJob.id;
        completionChecks = origJob.completion_checks ?? null;
      }
    }
  }

  // Eye always isolates worker jobs in worktrees unless the caller explicitly opts out.
  // This prevents multiple proposals' changes from landing in the same branch/PR.
  let resolvedUseWorktree = use_worktree ?? false;
  if (use_worktree === undefined && agent) {
    const parentJob = queries.getJobById(agent.job_id);
    if (parentJob && isEyeJob(parentJob.context)) {
      resolvedUseWorktree = true;
    }
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: title?.trim() || description.split('\n')[0].slice(0, 60),
    description,
    context: null,
    priority: priority ?? 0,
    work_dir: resolvedWorkDir,
    max_turns: max_turns ?? 50,
    stop_mode: stop_mode ?? 'turns',
    stop_value: stop_value ?? (max_turns ?? 50),
    model: model ?? inheritedModel,
    template_id: null,
    depends_on: depends_on?.length ? JSON.stringify(depends_on) : null,
    use_worktree: resolvedUseWorktree ? 1 : 0,
    project_id: inheritedProjectId,
    repeat_interval_ms: repeat_interval_ms ?? null,
    retry_policy: retryPolicy,
    max_retries: maxRetries,
    retry_count: retryCount,
    original_job_id: originalJobId,
    completion_checks: completionChecks,
    created_by_agent_id: agentId,
  });

  socket.emitJobNew(job);
  nudgeQueue();

  return JSON.stringify({
    job_id: job.id,
    title: job.title,
    status: job.status,
  });
}
