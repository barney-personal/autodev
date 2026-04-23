import { Router } from 'express';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { spawnInitialRoundJobs } from '../orchestrator/DebateManager.js';
import { nudgeQueue } from '../orchestrator/WorkQueueManager.js';
import { createAutonomousAgentRun } from '../orchestrator/AutonomousAgentRunManager.js';
import {
  validateTaskRequest,
  resolveTaskConfig,
  taskToJobRequest,
  taskToWorkflowRequest,
} from '../../shared/taskNormalization.js';
import { DEFAULT_DEBATE_CLAUDE_MODEL, DEFAULT_DEBATE_CODEX_MODEL } from '../../shared/models.js';
import type { CreateTaskRequest, CreateTaskResponse, Debate } from '../../shared/types.js';

const anthropic = new Anthropic();

const TITLE_MAX = 45;

function autoTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1) + '…' : firstLine;
}

async function generateSmartTitle(description: string): Promise<string> {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Write a title for this task in ${TITLE_MAX} characters or fewer. Be semantic and descriptive — capture the essence, not just the first few words. Use title case. No quotes, no punctuation at the end, no explanation.\n\nTask:\n${description.slice(0, 1000)}`,
      }],
    });
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : null;
    if (text && text.length > 0) {
      return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
    }
  } catch (e) {
    console.warn('[tasks] smart title generation failed, using fallback:', e);
  }
  return autoTitle(description);
}

// ── Shared task creation logic ───────────────────────────────────────────────
// Used by both the REST endpoint and the MCP create_task tool.

export interface CreateTaskOptions {
  /** Agent ID for MCP-originated tasks (sets created_by_agent_id on jobs) */
  createdByAgentId?: string;
  /** Override model when not specified in request (inherited from parent job) */
  inheritedModel?: string | null;
  /** Override projectId when not specified in request (inherited from parent job) */
  inheritedProjectId?: string | null;
}

export interface CreateTaskResult {
  response: CreateTaskResponse;
  /** Fire-and-forget async follow-up work (e.g. smart title generation) */
  asyncWork?: () => Promise<void>;
}

/**
 * Core task creation — validates, resolves routing, creates job or workflow.
 * Throws on debate validation errors (caller should catch and return 400).
 */
export function createTaskCore(
  body: CreateTaskRequest,
  opts: CreateTaskOptions = {},
): CreateTaskResult {
  const config = resolveTaskConfig(body);

  if (config.routesTo === 'workflow') {
    const workflowReq = taskToWorkflowRequest(body, config);
    // Apply inherited model from calling agent when request omits model
    if (opts.inheritedModel && !workflowReq.implementerModel) {
      workflowReq.implementerModel = opts.inheritedModel;
    }
    const result = createAutonomousAgentRun(workflowReq);
    socket.emitWorkflowNew(result.workflow);

    return {
      response: {
        task_type: 'workflow',
        workflow: result.workflow,
        project: result.project,
        jobs: result.jobs,
      },
    };
  }

  // ── Job path — full behavior: title, debate, interactive, scheduling ─────
  const jobReq = taskToJobRequest(body, config);

  const explicitTitle = jobReq.title?.trim();
  let titleSource = jobReq.description;
  if (!titleSource && jobReq.templateId) {
    const tpl = queries.getTemplateById(jobReq.templateId);
    titleSource = tpl?.content ?? '';
  }
  const title = explicitTitle || (titleSource ? autoTitle(titleSource) : 'Untitled');
  const shouldGenerateSmartTitle = !explicitTitle && !!titleSource;

  let preDebateId: string | null = null;
  let projectId = jobReq.projectId ?? opts.inheritedProjectId ?? null;

  if (jobReq.debate) {
    let debateTask = jobReq.description?.trim() || '';
    if (!debateTask && jobReq.templateId) {
      const tpl = queries.getTemplateById(jobReq.templateId);
      debateTask = tpl?.content?.trim() ?? '';
    }
    if (!debateTask) {
      throw new Error('debate requires a description or template with content');
    }

    const claudeModel = jobReq.debateClaudeModel?.trim() || DEFAULT_DEBATE_CLAUDE_MODEL;
    const codexModel = jobReq.debateCodexModel?.trim() || DEFAULT_DEBATE_CODEX_MODEL;
    const maxRounds = Math.min(Math.max(jobReq.debateMaxRounds ?? 3, 1), 10);
    const now = Date.now();

    if (!projectId) {
      const project = queries.insertProject({
        id: randomUUID(),
        name: `Pre-debate: ${title}`,
        description: `Pre-job debate between ${claudeModel} and ${codexModel}`,
        created_at: now,
        updated_at: now,
      });
      projectId = project.id;
    }

    const debate: Debate = {
      id: randomUUID(),
      title: `Pre-debate: ${title}`,
      task: debateTask,
      claude_model: claudeModel,
      codex_model: codexModel,
      max_rounds: maxRounds,
      current_round: 0,
      status: 'running',
      consensus: null,
      project_id: projectId!,
      work_dir: jobReq.workDir?.trim() || null,
      max_turns: jobReq.maxTurns ?? 50,
      template_id: jobReq.templateId?.trim() || null,
      post_action_prompt: null,
      post_action_role: null,
      post_action_job_id: null,
      post_action_verification: 0,
      verification_review_job_id: null,
      verification_response_job_id: null,
      verification_round: 0,
      loop_count: 1,
      current_loop: 0,
      created_at: now,
      updated_at: now,
    };
    queries.insertDebate(debate);
    spawnInitialRoundJobs(debate);
    socket.emitDebateNew(debate);
    preDebateId = debate.id;
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title,
    description: jobReq.description ?? '',
    context: jobReq.context ? JSON.stringify(jobReq.context) : null,
    priority: jobReq.priority ?? 0,
    work_dir: jobReq.workDir ?? null,
    max_turns: jobReq.maxTurns ?? 50,
    stop_mode: jobReq.stopMode ?? 'turns',
    stop_value: jobReq.stopValue ?? (jobReq.maxTurns ?? 50),
    model: jobReq.model ?? opts.inheritedModel ?? null,
    template_id: jobReq.templateId ?? null,
    depends_on: jobReq.dependsOn?.length ? JSON.stringify(jobReq.dependsOn) : null,
    is_interactive: jobReq.interactive ? 1 : 0,
    use_worktree: jobReq.useWorktree ? 1 : 0,
    project_id: projectId,
    scheduled_at: jobReq.scheduledAt ?? null,
    repeat_interval_ms: jobReq.repeatIntervalMs ?? null,
    retry_policy: jobReq.retryPolicy ?? 'none',
    max_retries: jobReq.maxRetries ?? 0,
    retry_count: 0,
    original_job_id: null,
    completion_checks: jobReq.completionChecks?.length ? JSON.stringify(jobReq.completionChecks) : null,
    review_config: jobReq.reviewConfig ? JSON.stringify(jobReq.reviewConfig) : null,
    pre_debate_id: preDebateId,
    created_by_agent_id: opts.createdByAgentId ?? null,
  });

  socket.emitJobNew(job);
  nudgeQueue();

  const response: CreateTaskResponse = {
    task_type: 'job',
    job,
    jobs: [job],
  };

  const asyncWork = shouldGenerateSmartTitle
    ? async () => {
        const smartTitle = await generateSmartTitle(titleSource!);
        if (smartTitle && smartTitle !== title) {
          queries.updateJobTitle(job.id, smartTitle);
          const updated = queries.getJobById(job.id);
          if (updated) socket.emitJobUpdate(updated);
        }
      }
    : undefined;

  return { response, asyncWork };
}

// ── Express router ───────────────────────────────────────────────────────────

const router = Router();

router.post('/', (req, res) => {
  const body = req.body as CreateTaskRequest;

  // 1. Validate
  const error = validateTaskRequest(body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  // 2. Create task using shared logic
  try {
    const { response, asyncWork } = createTaskCore(body);
    res.status(201).json(response);
    if (asyncWork) asyncWork().catch(() => {});
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to create task' });
  }
});

export default router;
