import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { startWorkflow, resumeWorkflow, cleanupWorktree } from '../orchestrator/WorkflowManager.js';
import type { CreateWorkflowRequest, Workflow } from '../../shared/types.js';

const router = Router();

// GET /api/workflows — list all workflows
router.get('/', (_req, res) => {
  res.json(queries.listWorkflows());
});

// GET /api/workflows/:id — get single workflow with plan/worklog content
router.get('/:id', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }

  // Include plan and worklog notes in the response
  const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
  const contractNote = queries.getNote(`workflow/${workflow.id}/contract`);
  const worklogNotes = queries.listNotes(`workflow/${workflow.id}/worklog/`);
  const worklogs: Array<{ key: string; value: string; updated_at: number }> = [];
  for (const n of worklogNotes) {
    const full = queries.getNote(n.key);
    if (full) worklogs.push({ key: n.key, value: full.value, updated_at: full.updated_at });
  }

  res.json({
    ...workflow,
    plan: planNote?.value ?? null,
    contract: contractNote?.value ?? null,
    worklogs,
  });
});

// GET /api/workflows/:id/jobs — list all jobs for a workflow
router.get('/:id/jobs', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.getJobsForWorkflow(req.params.id));
});

// POST /api/workflows — create + start a new workflow
router.post('/', (req, res) => {
  const body = req.body as CreateWorkflowRequest;
  if (!body.task?.trim()) {
    res.status(400).json({ error: 'task is required' });
    return;
  }

  const workflowId = randomUUID();
  const now = Date.now();
  const title = body.title?.trim() || `Workflow: ${body.task.trim().slice(0, 50)}`;
  const maxCycles = Math.min(Math.max(body.maxCycles ?? 10, 1), 50);

  // Create a project for this workflow
  const project = queries.insertProject({
    id: randomUUID(),
    name: title,
    description: `Plan/review/implement workflow`,
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
    pr_url: null,
    created_at: now,
    updated_at: now,
  };
  queries.insertWorkflow(workflow);

  const assessJob = startWorkflow(workflow);

  socket.emitWorkflowNew(workflow);

  res.status(201).json({ workflow, project, jobs: [assessJob] });
});

// POST /api/workflows/:id/cancel — cancel a running workflow
router.post('/:id/cancel', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }
  if (workflow.status !== 'running' && workflow.status !== 'blocked') {
    res.status(400).json({ error: `Workflow is ${workflow.status}, cannot cancel` });
    return;
  }

  const updated = queries.updateWorkflow(workflow.id, { status: 'cancelled' });
  if (updated) socket.emitWorkflowUpdate(updated);

  // Cancel any queued/running workflow jobs
  const jobs = queries.getJobsForWorkflow(workflow.id);
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'assigned') {
      queries.updateJobStatus(job.id, 'cancelled');
      const updatedJob = queries.getJobById(job.id);
      if (updatedJob) socket.emitJobUpdate(updatedJob);
    }
  }

  // Clean up the worktree (no PR for cancellations)
  if (updated) cleanupWorktree(updated);

  res.json(updated);
});

// POST /api/workflows/:id/resume — resume a blocked workflow
router.post('/:id/resume', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }
  if (workflow.status !== 'blocked') {
    res.status(400).json({ error: `Workflow is ${workflow.status}, can only resume blocked workflows` });
    return;
  }

  const job = resumeWorkflow(workflow);
  const updated = queries.getWorkflowById(workflow.id);
  res.json({ workflow: updated, jobs: [job] });
});

export default router;
