import { Router } from 'express';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { spawnInitialRoundJobs } from '../orchestrator/DebateManager.js';
import { nudgeQueue } from '../orchestrator/WorkQueueManager.js';
import { DEFAULT_DEBATE_CLAUDE_MODEL, DEFAULT_DEBATE_CODEX_MODEL } from '../../shared/models.js';
import type { CreateJobRequest, Debate, JobStatus } from '../../shared/types.js';
import { createJobSchema, updateJobTitleSchema, updateJobInteractiveSchema, validateBody } from './validation.js';

const router = Router();
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
    console.warn('[jobs] smart title generation failed, using fallback:', e);
  }
  return autoTitle(description);
}

router.post('/', (req, res) => {
  const parsed = validateBody(createJobSchema, req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const body = parsed.data as CreateJobRequest;

  const explicitTitle = body.title?.trim();
  let titleSource = body.description;
  if (!titleSource && body.templateId) {
    const tpl = queries.getTemplateById(body.templateId);
    titleSource = tpl?.content ?? '';
  }
  const title = explicitTitle || (titleSource ? autoTitle(titleSource) : 'Untitled');
  const shouldGenerateSmartTitle = !explicitTitle && !!titleSource;

  let preDebateId: string | null = null;
  let projectId = body.projectId ?? null;

  if (body.debate) {
    // Resolve effective task: description > template content > reject
    let debateTask = body.description?.trim() || '';
    if (!debateTask && body.templateId) {
      const tpl = queries.getTemplateById(body.templateId);
      debateTask = tpl?.content?.trim() ?? '';
    }
    if (!debateTask) {
      res.status(400).json({ error: 'debate requires a description or template with content' });
      return;
    }

    const claudeModel = body.debateClaudeModel?.trim() || DEFAULT_DEBATE_CLAUDE_MODEL;
    const codexModel = body.debateCodexModel?.trim() || DEFAULT_DEBATE_CODEX_MODEL;
    const maxRounds = Math.min(Math.max(body.debateMaxRounds ?? 3, 1), 10);
    const now = Date.now();

    // Only create a project if caller didn't provide one
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
      work_dir: body.workDir?.trim() || null,
      max_turns: body.maxTurns ?? 50,
      template_id: body.templateId?.trim() || null,
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
    description: body.description ?? '',
    context: body.context ? JSON.stringify(body.context) : null,
    priority: body.priority ?? 0,
    work_dir: body.workDir ?? null,
    max_turns: body.maxTurns ?? 50,
    stop_mode: body.stopMode ?? 'turns',
    stop_value: body.stopValue ?? (body.maxTurns ?? 50),
    model: body.model ?? null,
    template_id: body.templateId ?? null,
    depends_on: body.dependsOn?.length ? JSON.stringify(body.dependsOn) : null,
    is_interactive: body.interactive ? 1 : 0,
    use_worktree: body.useWorktree ? 1 : 0,
    project_id: projectId,
    scheduled_at: body.scheduledAt ?? null,
    repeat_interval_ms: body.repeatIntervalMs ?? null,
    retry_policy: body.retryPolicy ?? 'none',
    max_retries: body.maxRetries ?? 0,
    retry_count: 0,
    original_job_id: null,
    completion_checks: body.completionChecks?.length ? JSON.stringify(body.completionChecks) : null,
    pre_debate_id: preDebateId,
  });

  socket.emitJobNew(job);
  nudgeQueue();
  res.status(201).json(job);

  // Generate smart title async — don't block the response
  if (shouldGenerateSmartTitle) {
    generateSmartTitle(titleSource!).then(smartTitle => {
      if (smartTitle && smartTitle !== title) {
        queries.updateJobTitle(job.id, smartTitle);
        const updated = queries.getJobById(job.id);
        if (updated) {
          socket.emitJobUpdate(updated);
        }
      }
    }).catch(() => {}); // keep fallback on error
  }
});

router.get('/', (req, res) => {
  let data: any;
  if (req.query.archived === '1' || req.query.archived === 'true') {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const jobs = queries.listArchivedJobsSlim(limit, offset);
    const total = queries.countArchivedJobs();
    const agents = queries.getAgentsForJobIds(jobs.map(j => j.id));
    data = { jobs, total, agents };
  } else {
    const status = req.query.status as string | undefined;
    data = queries.listJobsSlim(status as JobStatus | undefined);
  }
  res.json(data);
});

router.get('/:id', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json(job);
});

router.post('/:id/flag', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  queries.updateJobFlagged(job.id, job.flagged ? 0 : 1);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  // Update all agents for this job so their embedded job reflects the new flag state
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.patch('/:id/title', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  const parsed = validateBody(updateJobTitleSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  const title = parsed.data.title.trim();
  queries.updateJobTitle(job.id, title);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.post('/:id/run-now', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (job.status !== 'queued') {
    res.status(400).json({ error: 'Can only run-now queued jobs' });
    return;
  }
  queries.updateJobScheduledAt(job.id, null);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  nudgeQueue();
  res.json(updated);
});

router.patch('/:id/interactive', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  const parsed = validateBody(updateJobInteractiveSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  const interactive = parsed.data.interactive ? 1 : 0;
  queries.updateJobInteractive(job.id, interactive);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  const agents = queries.getAgentsWithJobByJobId(job.id);
  for (const agent of agents) {
    socket.emitAgentUpdate(agent);
  }
  res.json(updated);
});

router.post('/:id/archive', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (!['done', 'failed', 'cancelled'].includes(job.status)) {
    res.status(400).json({ error: 'Can only archive finished jobs (done, failed, cancelled)' });
    return;
  }
  queries.archiveJob(job.id);
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const job = queries.getJobById(req.params.id);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  if (job.status !== 'queued') {
    res.status(400).json({ error: 'Can only cancel queued jobs' });
    return;
  }
  queries.updateJobStatus(job.id, 'cancelled');
  const updated = queries.getJobById(job.id)!;
  socket.emitJobUpdate(updated);
  res.json(updated);
});

export default router;
