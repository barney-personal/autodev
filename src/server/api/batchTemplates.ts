import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { spawnInitialRoundJobs } from '../orchestrator/DebateManager.js';
import { nudgeQueue } from '../orchestrator/WorkQueueManager.js';
import type { CreateBatchTemplateRequest, UpdateBatchTemplateRequest, RunBatchTemplateRequest, Debate, Job } from '../../shared/types.js';

const router = Router();

// List all batch templates
router.get('/', (_req, res) => {
  res.json(queries.listBatchTemplates());
});

// Get one batch template
router.get('/:id', (req, res) => {
  const bt = queries.getBatchTemplateById(req.params.id);
  if (!bt) { res.status(404).json({ error: 'not found' }); return; }
  res.json(bt);
});

// Create a batch template
router.post('/', (req, res) => {
  const body = req.body as CreateBatchTemplateRequest;
  if (!body.name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!Array.isArray(body.items) || body.items.filter(i => i.trim()).length === 0) {
    res.status(400).json({ error: 'at least one non-empty item is required' });
    return;
  }
  const now = Date.now();
  const bt = queries.insertBatchTemplate({
    id: randomUUID(),
    name: body.name.trim(),
    items: body.items.map(i => i.trim()).filter(Boolean),
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(bt);
});

// Update a batch template
router.put('/:id', (req, res) => {
  const existing = queries.getBatchTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  const body = req.body as UpdateBatchTemplateRequest;
  const fields: Parameters<typeof queries.updateBatchTemplate>[1] = {};
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.items !== undefined) {
    const cleaned = body.items.map(i => i.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      res.status(400).json({ error: 'at least one non-empty item is required' });
      return;
    }
    fields.items = cleaned;
  }
  const updated = queries.updateBatchTemplate(req.params.id, fields);
  res.json(updated);
});

// Delete a batch template
router.delete('/:id', (req, res) => {
  const existing = queries.getBatchTemplateById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'not found' }); return; }
  queries.deleteBatchTemplate(req.params.id);
  res.json({ ok: true });
});

// Run a batch template — creates project + N jobs (or N debates in debate mode)
router.post('/:id/run', (req, res) => {
  const bt = queries.getBatchTemplateById(req.params.id);
  if (!bt) { res.status(404).json({ error: 'batch template not found' }); return; }

  const body = req.body as RunBatchTemplateRequest;
  const now = Date.now();

  // Create the project
  const project = queries.insertProject({
    id: randomUUID(),
    name: body.projectName?.trim() || bt.name,
    description: body.debate
      ? `Batch debate of "${bt.name}" (${bt.items.length} items, ${body.claudeModel} vs ${body.codexModel})`
      : `Batch run of "${bt.name}" (${bt.items.length} items)`,
    created_at: now,
    updated_at: now,
  });

  if (body.debate) {
    // Debate mode: create one debate per item
    if (!body.claudeModel?.trim() || !body.codexModel?.trim()) {
      res.status(400).json({ error: 'claudeModel and codexModel are required for debate mode' });
      return;
    }
    const maxRounds = Math.min(Math.max(body.debateMaxRounds ?? 3, 1), 10);
    const allDebates: Debate[] = [];
    const allJobs: Job[] = [];

    for (const item of bt.items) {
      const debateId = randomUUID();
      const debate: Debate = {
        id: debateId,
        title: item.length > 40 ? item.slice(0, 39) + '\u2026' : item,
        task: item,
        claude_model: body.claudeModel.trim(),
        codex_model: body.codexModel.trim(),
        max_rounds: maxRounds,
        current_round: 0,
        status: 'running',
        consensus: null,
        project_id: project.id,
        work_dir: body.workDir?.trim() || null,
        max_turns: body.maxTurns ?? 50,
        template_id: body.templateId?.trim() || null,
        post_action_prompt: body.postActionPrompt?.trim() || null,
        post_action_role: body.postActionRole ?? null,
        post_action_job_id: null,
        post_action_verification: (body.postActionVerification && !!body.postActionPrompt?.trim()) ? 1 : 0,
        verification_review_job_id: null,
        verification_response_job_id: null,
        verification_round: 0,
        loop_count: 1,
        current_loop: 0,
        created_at: now,
        updated_at: now,
      };
      queries.insertDebate(debate);
      socket.emitDebateNew(debate);
      allDebates.push(debate);

      const [claudeJob, codexJob] = spawnInitialRoundJobs(debate);
      allJobs.push(claudeJob, codexJob);
    }

    res.status(201).json({ project, jobs: allJobs, debates: allDebates });
  } else {
    // Normal mode: create one job per item
    const jobs = bt.items.map(item => {
      const job = queries.insertJob({
        id: randomUUID(),
        title: item.length > 28 ? item.slice(0, 27) + '\u2026' : item,
        description: item,
        context: null,
        priority: 0,
        model: body.model ?? null,
        template_id: body.templateId ?? null,
        is_interactive: body.interactive ? 1 : 0,
        use_worktree: body.useWorktree ? 1 : 0,
        work_dir: body.workDir ?? null,
        max_turns: body.maxTurns ?? 50,
        project_id: project.id,
      });
      socket.emitJobNew(job);
      return job;
    });
    nudgeQueue();

    res.status(201).json({ project, jobs });
  }
});

export default router;
