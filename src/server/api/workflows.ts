import { Router } from 'express';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { resumeWorkflow, cleanupWorktree, pushAndCreatePr, getPrCreationOutcome } from '../orchestrator/WorkflowManager.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import { disconnectAgent, isTmuxSessionAlive, saveSnapshot } from '../orchestrator/PtyManager.js';
import { createAutonomousAgentRun } from '../orchestrator/AutonomousAgentRunManager.js';
import type { CreateAutonomousAgentRunRequest, WorkflowPhase, VerifyRun } from '../../shared/types.js';
import { createWorkflowSchema, resumeWorkflowSchema, validateBody } from './validation.js';

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

  const verifyRuns: VerifyRun[] = queries.getVerifyRunsForWorkflow(workflow.id);

  res.json({
    ...workflow,
    plan: planNote?.value ?? null,
    contract: contractNote?.value ?? null,
    worklogs,
    verify_runs: verifyRuns,
  });
});

// GET /api/workflows/:id/metrics — latency metrics for a workflow
router.get('/:id/metrics', (req, res) => {
  const metrics = queries.getWorkflowMetrics(req.params.id);
  if (!metrics) { res.status(404).json({ error: 'not found' }); return; }
  res.json(metrics);
});

// GET /api/workflows/:id/jobs — list all jobs for a workflow
router.get('/:id/jobs', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.getJobsForWorkflow(req.params.id));
});

// POST /api/workflows — create + start a new workflow
router.post('/', (req, res) => {
  const parsed = validateBody(createWorkflowSchema, req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const body = parsed.data as CreateAutonomousAgentRunRequest;
  // Pre-flight the work_dir before the workflow is created. The startWorkflow()
  // pre-flight inside WorkflowManager still runs as a backstop, but failing at
  // the API layer avoids creating a workflow + project row that immediately
  // transitions to blocked, which is what caused the WorkflowBlocked cascade
  // when the host was missing a cloned repo.
  const workDir = body.workDir?.trim();
  if (workDir && !existsSync(workDir)) {
    res.status(400).json({ error: `work_dir does not exist: ${workDir}` });
    return;
  }
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

// POST /api/workflows/:id/wrap-up — stop work and create a draft PR with whatever's done
router.post('/:id/wrap-up', (req, res) => {
  const workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }
  if (workflow.status !== 'running' && workflow.status !== 'blocked') {
    res.status(400).json({ error: `Workflow is ${workflow.status}, cannot wrap up` });
    return;
  }

  // Kill any running agents and cancel pending jobs — full cancellation semantics
  // matching the pattern in agents.ts POST /:id/cancel
  // Each iteration is error-isolated so one failure cannot skip remaining agents/jobs.
  const jobs = queries.getJobsForWorkflow(workflow.id);
  for (const job of jobs) {
    try {
      if (job.status === 'running' || job.status === 'assigned') {
        const agents = queries.getAgentsWithJobByJobId(job.id);
        for (const agent of agents) {
          if (agent.status === 'running' || agent.status === 'starting' || agent.status === 'waiting_user') {
            try {
              cancelledAgents.add(agent.id);

              // Save tmux snapshot before killing so we retain last terminal state
              if (isTmuxSessionAlive(agent.id)) {
                try { saveSnapshot(agent.id); } catch { /* non-fatal */ }
              }

              if (agent.pid) {
                try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already gone */ }
              }
              try { execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' }); } catch { /* ok */ }
              queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
              getFileLockRegistry().releaseAll(agent.id);
              disconnectAgent(agent.id);

              // Timeout any pending question so the MCP ask_user call doesn't hang
              const pendingQ = queries.getPendingQuestion(agent.id);
              if (pendingQ) {
                queries.updateQuestion(pendingQ.id, {
                  status: 'timeout',
                  answer: '[TIMEOUT] Workflow wrapped up; agent cancelled.',
                  answered_at: Date.now(),
                });
              }

              // Emit agent update so the UI reflects the change immediately
              const updatedAgent = queries.getAgentWithJob(agent.id);
              if (updatedAgent) socket.emitAgentUpdate(updatedAgent);
            } catch (agentErr) {
              console.warn(`[wrap-up] Failed to cancel agent ${agent.id} in job ${job.id}:`, agentErr);
              // Best-effort cleanup for the steps that were skipped by the throw.
              // Each step is isolated so one failure doesn't prevent the rest.
              try { getFileLockRegistry().releaseAll(agent.id); } catch { /* best effort */ }
              try { disconnectAgent(agent.id); } catch { /* best effort */ }
              try {
                const pendingQ = queries.getPendingQuestion(agent.id);
                if (pendingQ) {
                  queries.updateQuestion(pendingQ.id, {
                    status: 'timeout',
                    answer: '[TIMEOUT] Workflow wrapped up; agent cancelled.',
                    answered_at: Date.now(),
                  });
                }
              } catch { /* best effort */ }
              try {
                queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
                // Emit UI update — the retry succeeded so the agent is cancelled in DB
                try {
                  const ua = queries.getAgentWithJob(agent.id);
                  if (ua) socket.emitAgentUpdate(ua);
                } catch { /* best effort */ }
              } catch {
                // DB update still failing — remove from cancelledAgents so handleAgentExit
                // can do its own cleanup when the killed process exits
                cancelledAgents.delete(agent.id);
              }
            }
          }
        }
        queries.updateJobStatus(job.id, 'cancelled');
        const updatedJob = queries.getJobById(job.id);
        if (updatedJob) socket.emitJobUpdate(updatedJob);
      } else if (job.status === 'queued') {
        queries.updateJobStatus(job.id, 'cancelled');
        const updatedJob = queries.getJobById(job.id);
        if (updatedJob) socket.emitJobUpdate(updatedJob);
      }
    } catch (jobErr) {
      console.warn(`[wrap-up] Failed to cancel job ${job.id}:`, jobErr);
    }
  }

  // Create draft PR with partial work
  let prUrl: string | null = null;
  if (workflow.worktree_path && workflow.work_dir) {
    prUrl = pushAndCreatePr(workflow, true);
  }
  const prOutcome = getPrCreationOutcome(workflow, prUrl);

  if (prOutcome === 'created') {
    queries.updateWorkflow(workflow.id, {
      status: 'complete',
      current_phase: 'idle' as WorkflowPhase,
      pr_url: prUrl,
      blocked_reason: null,
    });
    const finalWorkflow = queries.getWorkflowById(workflow.id);
    if (finalWorkflow) socket.emitWorkflowUpdate(finalWorkflow);
    if (finalWorkflow) cleanupWorktree(finalWorkflow);
    res.json({ workflow: finalWorkflow, pr_url: prUrl, outcome: 'draft_pr_created' });
    return;
  }

  if (prOutcome === 'failed_with_publishable_commits') {
    queries.updateWorkflow(workflow.id, {
      status: 'blocked',
      current_phase: 'idle' as WorkflowPhase,
      blocked_reason: `Draft PR creation failed — worktree preserved for retry at ${workflow.worktree_path}`,
    });
    const finalWorkflow = queries.getWorkflowById(workflow.id);
    if (finalWorkflow) socket.emitWorkflowUpdate(finalWorkflow);
    res.status(409).json({ workflow: finalWorkflow, pr_url: null, outcome: 'draft_pr_failed_preserved' });
    return;
  }

  // Fix-C6b: If worktree metadata is missing but milestones were completed,
  // block instead of silently cancelling — the work may be recoverable.
  if (!workflow.worktree_path && workflow.milestones_done > 0) {
    queries.updateWorkflow(workflow.id, {
      status: 'blocked',
      current_phase: 'idle' as WorkflowPhase,
      blocked_reason: `Wrap-up failed — worktree metadata missing but ${workflow.milestones_done}/${workflow.milestones_total} milestones completed. Commits may be recoverable from the main checkout.`,
    });
    const finalWorkflow = queries.getWorkflowById(workflow.id);
    if (finalWorkflow) socket.emitWorkflowUpdate(finalWorkflow);
    res.status(409).json({ workflow: finalWorkflow, pr_url: null, outcome: 'missing_worktree_with_progress' });
    return;
  }

  queries.updateWorkflow(workflow.id, {
    status: 'cancelled',
    current_phase: 'idle' as WorkflowPhase,
    blocked_reason: null,
    pr_url: null,
  });
  const finalWorkflow = queries.getWorkflowById(workflow.id);
  if (finalWorkflow) socket.emitWorkflowUpdate(finalWorkflow);
  if (finalWorkflow) cleanupWorktree(finalWorkflow);
  res.json({ workflow: finalWorkflow, pr_url: null, outcome: 'no_publishable_commits' });
});

// POST /api/workflows/:id/resume — resume a blocked or stuck workflow
// Accepts optional body: { phase?: 'assess' | 'review' | 'implement', cycle?: number, force?: boolean }
// force=true allows resuming a 'running' workflow that has no active jobs (orphaned state).
router.post('/:id/resume', (req, res) => {
  let workflow = queries.getWorkflowById(req.params.id);
  if (!workflow) { res.status(404).json({ error: 'not found' }); return; }

  if (req.body && Object.keys(req.body).length > 0) {
    const parsed = validateBody(resumeWorkflowSchema, req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  }

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

  if (targetPhase && !['assess', 'review', 'implement', 'verify'].includes(targetPhase)) {
    res.status(400).json({ error: `Invalid phase: ${targetPhase}. Must be assess, review, implement, or verify.` });
    return;
  }

  try {
    const job = resumeWorkflow(workflow, { phase: targetPhase as WorkflowPhase, cycle: targetCycle });
    const updated = queries.getWorkflowById(workflow.id);
    res.json({ workflow: updated, jobs: [job] });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to resume workflow' });
  }
});

export default router;
