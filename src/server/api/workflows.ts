import { Router } from 'express';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { resumeWorkflow, cleanupWorktree } from '../orchestrator/WorkflowManager.js';
import { createAutonomousAgentRun } from '../orchestrator/AutonomousAgentRunManager.js';
import type { CreateAutonomousAgentRunRequest } from '../../shared/types.js';

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
  const body = req.body as CreateAutonomousAgentRunRequest;
  try {
    const result = createAutonomousAgentRun(body);
    socket.emitWorkflowNew(result.workflow);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to create autonomous agent run' });
  }
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

// POST /api/workflows/:id/resume — resume a blocked or stuck workflow
// Accepts optional body: { phase?: 'assess' | 'review' | 'implement', cycle?: number, force?: boolean }
// force=true allows resuming a 'running' workflow that has no active jobs (orphaned state).
router.post('/:id/resume', (req, res) => {
  let workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }

  const force = req.body?.force === true;

  if (workflow.status === 'running' && force) {
    // Force-resume: mark as blocked first so resumeWorkflow accepts it, then emit update
    const blocked = queries.updateWorkflow(workflow.id, { status: 'blocked' });
    if (blocked) socket.emitWorkflowUpdate(blocked);
    workflow = blocked ?? workflow;
  } else if (workflow.status !== 'blocked') {
    res.status(400).json({ error: `Workflow is ${workflow.status}, can only resume blocked workflows (use force=true for stuck running workflows)` });
    return;
  }

  const targetPhase = req.body?.phase as string | undefined;
  const targetCycle = req.body?.cycle as number | undefined;

  if (targetPhase && !['assess', 'review', 'implement'].includes(targetPhase)) {
    res.status(400).json({ error: `Invalid phase: ${targetPhase}. Must be assess, review, or implement.` });
    return;
  }

  try {
    const job = resumeWorkflow(workflow, { phase: targetPhase as any, cycle: targetCycle });
    const updated = queries.getWorkflowById(workflow.id);
    res.json({ workflow: updated, jobs: [job] });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to resume workflow' });
  }
});

export default router;
