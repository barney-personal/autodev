import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job, Workflow, WorkflowPhase } from '../../shared/types.js';
import { buildAssessPrompt, buildReviewPrompt, buildImplementPrompt } from './WorkflowPrompts.js';

// Track jobs we've already processed to prevent double-exit race from triggering
// duplicate spawns. Same pattern as DebateManager.
const _processedJobs = new Set<string>();

/**
 * Called from AgentRunner.handleJobCompletion after a job's status is finalized.
 * If the job belongs to a workflow, advances to the next phase or completes the workflow.
 */
export function onJobCompleted(job: Job): void {
  if (!job.workflow_id) return;
  if (_processedJobs.has(job.id)) return;
  _processedJobs.add(job.id);
  // Prevent unbounded growth
  if (_processedJobs.size > 500) {
    const iter = _processedJobs.values();
    for (let i = 0; i < 250; i++) iter.next();
    // Keep the newer half
    const keep = new Set<string>();
    for (const v of iter) keep.add(v);
    _processedJobs.clear();
    for (const v of keep) _processedJobs.add(v);
  }

  try {
    _onJobCompleted(job);
  } catch (err) {
    console.error(`[workflow] error handling job completion for job ${job.id}:`, err);
  }
}

function _onJobCompleted(job: Job): void {
  const workflow = queries.getWorkflowById(job.workflow_id!);
  if (!workflow || workflow.status !== 'running') return;

  // If the phase job failed or was cancelled, mark workflow as blocked
  if (job.status === 'failed' || job.status === 'cancelled') {
    console.log(`[workflow ${workflow.id}] phase '${job.workflow_phase}' job ${job.id} ${job.status} — marking workflow blocked`);
    updateAndEmit(workflow.id, {
      status: 'blocked',
      current_phase: job.workflow_phase ?? 'idle',
    });
    return;
  }

  // Parse milestones from the plan note
  const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
  const milestones = parseMilestones(planNote?.value ?? '');

  // Phase-specific transitions
  switch (job.workflow_phase) {
    case 'assess': {
      // After assess: validate plan was written, then move to review
      if (!planNote?.value) {
        console.log(`[workflow ${workflow.id}] assess phase completed but no plan note found — marking blocked`);
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'assess' as WorkflowPhase });
        return;
      }
      updateAndEmit(workflow.id, {
        milestones_total: milestones.total,
        milestones_done: milestones.done,
        current_cycle: 1,
      });
      spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', 1);
      break;
    }

    case 'review': {
      // After review: update milestones (reviewer may have added/removed), then implement
      updateAndEmit(workflow.id, {
        milestones_total: milestones.total,
        milestones_done: milestones.done,
      });
      const updated = queries.getWorkflowById(workflow.id)!;
      if (milestones.total > 0 && milestones.done >= milestones.total) {
        console.log(`[workflow ${workflow.id}] all milestones complete after review — marking complete`);
        updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
        finalizeWorkflow(queries.getWorkflowById(workflow.id)!);
      } else {
        spawnPhaseJob(updated, 'implement', updated.current_cycle);
      }
      break;
    }

    case 'implement': {
      // After implement: update milestones, check if done or advance to next cycle
      updateAndEmit(workflow.id, {
        milestones_total: milestones.total,
        milestones_done: milestones.done,
      });
      const updated = queries.getWorkflowById(workflow.id)!;

      if (milestones.total > 0 && milestones.done >= milestones.total) {
        console.log(`[workflow ${workflow.id}] all ${milestones.total} milestones complete — marking complete`);
        updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
        finalizeWorkflow(queries.getWorkflowById(workflow.id)!);
      } else if (updated.current_cycle >= updated.max_cycles) {
        console.log(`[workflow ${workflow.id}] reached max cycles (${updated.max_cycles}) — marking complete`);
        updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
        finalizeWorkflow(queries.getWorkflowById(workflow.id)!);
      } else {
        // Advance to next cycle's review phase
        const nextCycle = updated.current_cycle + 1;
        updateAndEmit(workflow.id, { current_cycle: nextCycle });
        spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
      }
      break;
    }

    default:
      console.warn(`[workflow ${workflow.id}] unknown phase '${job.workflow_phase}' on job ${job.id}`);
  }
}

// ─── Milestone Parsing ────────────────────────────────────────────────────────

const CHECKBOX_CHECKED = /^[\t ]*[-*][\t ]+\[[xX]\]/;
const CHECKBOX_UNCHECKED = /^[\t ]*[-*][\t ]+\[\s?\]/;

export function parseMilestones(planText: string): { total: number; done: number } {
  let done = 0;
  let unchecked = 0;
  for (const line of planText.split('\n')) {
    if (CHECKBOX_CHECKED.test(line)) done++;
    else if (CHECKBOX_UNCHECKED.test(line)) unchecked++;
  }
  return { total: done + unchecked, done };
}

// ─── Phase Job Spawning ─────────────────────────────────────────────────────

function spawnPhaseJob(workflow: Workflow, phase: WorkflowPhase, cycle: number): void {
  const phaseLabels: Record<string, string> = { assess: 'Assess', review: 'Review', implement: 'Implement' };
  const label = phaseLabels[phase] ?? phase;

  // Choose model and max_turns based on phase
  let model: string;
  let maxTurns: number;
  let prompt: string;

  switch (phase) {
    case 'assess':
      model = workflow.implementer_model;
      maxTurns = workflow.max_turns_assess;
      prompt = buildAssessPrompt(workflow);
      break;
    case 'review':
      model = workflow.reviewer_model;
      maxTurns = workflow.max_turns_review;
      prompt = buildReviewPrompt(workflow, cycle);
      break;
    case 'implement':
      model = workflow.implementer_model;
      maxTurns = workflow.max_turns_implement;
      prompt = buildImplementPrompt(workflow, cycle);
      break;
    default:
      throw new Error(`Invalid phase: ${phase}`);
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${label}`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: workflow.template_id,
    // All phases share the single workflow-level worktree (created at startWorkflow).
    // use_worktree=0 tells WorkQueueManager not to create another one.
    work_dir: workflow.worktree_path ?? workflow.work_dir,
    max_turns: maxTurns,
    project_id: workflow.project_id,
    use_worktree: 0,
    workflow_id: workflow.id,
    workflow_cycle: cycle,
    workflow_phase: phase,
  });

  socket.emitJobNew(job);

  // Update workflow state
  updateAndEmit(workflow.id, {
    current_phase: phase,
    current_cycle: cycle,
  });

  console.log(`[workflow ${workflow.id}] spawned ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle}, model: ${model})`);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start a workflow by spawning the assess phase job.
 * Called from the API route when a workflow is created.
 */
export function startWorkflow(workflow: Workflow): Job {
  // Create a single worktree for the entire workflow so all phases share one branch.
  // Changes accumulate linearly: assess → review → implement → review → ...
  let activeWorkflow = workflow;
  if (workflow.use_worktree && workflow.work_dir) {
    try {
      const shortId = workflow.id.slice(0, 8);
      const slug = workflow.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      const branchName = `workflow/${slug}-${shortId}`;
      const worktreePath = path.resolve(workflow.work_dir, '..', '.orchestrator-worktrees', `wf-${shortId}`);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      execSync(`git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)}`, {
        cwd: workflow.work_dir,
        timeout: 30000,
        stdio: 'pipe',
      });
      activeWorkflow = queries.updateWorkflow(workflow.id, {
        worktree_path: worktreePath,
        worktree_branch: branchName,
      }) ?? workflow;
      console.log(`[workflow ${workflow.id}] created worktree at ${worktreePath} (branch: ${branchName})`);
    } catch (err: any) {
      console.warn(`[workflow ${workflow.id}] worktree creation failed, using work_dir directly:`, err.message);
    }
  }

  const prompt = buildAssessPrompt(activeWorkflow);
  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C0] Assess`,
    description: prompt,
    context: null,
    priority: 0,
    model: activeWorkflow.implementer_model,
    template_id: activeWorkflow.template_id,
    work_dir: activeWorkflow.worktree_path ?? activeWorkflow.work_dir,
    max_turns: activeWorkflow.max_turns_assess,
    project_id: activeWorkflow.project_id,
    use_worktree: 0,
    workflow_id: activeWorkflow.id,
    workflow_cycle: 0,
    workflow_phase: 'assess',
  });

  socket.emitJobNew(job);
  updateAndEmit(activeWorkflow.id, { current_phase: 'assess' as WorkflowPhase, current_cycle: 0 });
  console.log(`[workflow ${activeWorkflow.id}] started — assess job ${job.id.slice(0, 8)}`);
  return job;
}

/**
 * Resume a blocked workflow by re-spawning the phase that failed.
 */
export function resumeWorkflow(workflow: Workflow): Job {
  if (workflow.status !== 'blocked') {
    throw new Error(`Cannot resume workflow in status '${workflow.status}'`);
  }

  updateAndEmit(workflow.id, { status: 'running' });
  const updated = queries.getWorkflowById(workflow.id)!;

  // Re-spawn the phase that was blocked
  const phase = updated.current_phase === 'idle' ? 'assess' : updated.current_phase;
  const cycle = updated.current_cycle;

  let model: string;
  let maxTurns: number;
  let prompt: string;

  switch (phase) {
    case 'assess':
      model = updated.implementer_model;
      maxTurns = updated.max_turns_assess;
      prompt = buildAssessPrompt(updated);
      break;
    case 'review':
      model = updated.reviewer_model;
      maxTurns = updated.max_turns_review;
      prompt = buildReviewPrompt(updated, cycle);
      break;
    case 'implement':
      model = updated.implementer_model;
      maxTurns = updated.max_turns_implement;
      prompt = buildImplementPrompt(updated, cycle);
      break;
    default:
      throw new Error(`Cannot resume from phase '${phase}'`);
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${phase.charAt(0).toUpperCase() + phase.slice(1)} (resumed)`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: updated.template_id,
    work_dir: updated.worktree_path ?? updated.work_dir,
    max_turns: maxTurns,
    project_id: updated.project_id,
    use_worktree: 0,
    workflow_id: updated.id,
    workflow_cycle: cycle,
    workflow_phase: phase as WorkflowPhase,
  });

  socket.emitJobNew(job);
  console.log(`[workflow ${workflow.id}] resumed — ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle})`);
  return job;
}

// ─── Finalization & Cleanup ──────────────────────────────────────────────────

/**
 * Called when a workflow completes successfully.
 * Pushes the worktree branch, opens a GitHub PR, then removes the local worktree.
 */
export function finalizeWorkflow(workflow: Workflow): void {
  const { worktree_path, worktree_branch, work_dir } = workflow;
  if (!worktree_path || !work_dir) return;

  try {
    // Count commits on the branch that aren't on the remote default branch
    let hasCommits = false;
    try {
      const n = execSync(
        'git rev-list --count HEAD ^origin/HEAD 2>/dev/null || git rev-list --count HEAD',
        { cwd: worktree_path, stdio: 'pipe', timeout: 10000, shell: true }
      ).toString().trim();
      hasCommits = parseInt(n, 10) > 0;
    } catch { /* not a git repo or no remote — skip PR */ }

    if (hasCommits && worktree_branch) {
      try {
        // Push branch to remote
        execSync(`git push -u origin ${JSON.stringify(worktree_branch)}`, {
          cwd: worktree_path, stdio: 'pipe', timeout: 30000,
        });

        // Build PR body from plan note milestones
        const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
        const body = _buildPrBody(workflow, planNote?.value ?? null);
        const title = `[Workflow] ${workflow.title}`;

        // Create PR via gh CLI
        const prUrl = execSync(
          `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --head ${JSON.stringify(worktree_branch)}`,
          { cwd: worktree_path, stdio: 'pipe', timeout: 30000 }
        ).toString().trim();

        updateAndEmit(workflow.id, { pr_url: prUrl });
        console.log(`[workflow ${workflow.id}] PR created: ${prUrl}`);
      } catch (err: any) {
        console.warn(`[workflow ${workflow.id}] push/PR failed (worktree branch preserved locally):`, err.message);
      }
    } else {
      console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR`);
    }
  } finally {
    _removeWorktree(workflow);
  }
}

/**
 * Called when a workflow is cancelled — skip the PR, just clean up the worktree.
 */
export function cleanupWorktree(workflow: Workflow): void {
  _removeWorktree(workflow);
}

function _removeWorktree(workflow: Workflow): void {
  const { worktree_path, work_dir } = workflow;
  if (!worktree_path || !work_dir) return;
  try {
    execSync(`git worktree remove --force ${JSON.stringify(worktree_path)}`, {
      cwd: work_dir, stdio: 'pipe', timeout: 15000,
    });
    execSync('git worktree prune', { cwd: work_dir, stdio: 'pipe', timeout: 10000 });
    console.log(`[workflow ${workflow.id}] worktree removed`);
  } catch (err: any) {
    console.warn(`[workflow ${workflow.id}] worktree removal failed:`, err.message);
  }
}

function _buildPrBody(workflow: Workflow, planText: string | null): string {
  const { total, done } = parseMilestones(planText ?? '');
  const checkboxLines = planText
    ? planText.split('\n').filter(l => /^\s*[-*]\s+\[/.test(l)).map(l => l.trim()).join('\n')
    : '';
  return [
    `## ${workflow.title}`,
    '',
    `**Task:** ${workflow.task}`,
    '',
    `**Cycles:** ${workflow.current_cycle}/${workflow.max_cycles} · **Milestones:** ${done}/${total} complete`,
    '',
    '## Milestones',
    checkboxLines || '_No plan available_',
    '',
    '---',
    `🤖 Generated by Hurlicane autonomous agent workflow`,
    `Implementer: \`${workflow.implementer_model}\` · Reviewer: \`${workflow.reviewer_model}\``,
  ].join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function updateAndEmit(id: string, fields: Parameters<typeof queries.updateWorkflow>[1]): void {
  const updated = queries.updateWorkflow(id, fields);
  if (updated) socket.emitWorkflowUpdate(updated);
}
