import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job, Workflow, WorkflowPhase, StopMode } from '../../shared/types.js';
import { effectiveMaxTurns } from '../../shared/types.js';
import { buildAssessPrompt, buildReviewPrompt, buildImplementPrompt, buildWorkflowRepairPrompt, type InlineWorkflowContext } from './WorkflowPrompts.js';
import { getAvailableModel, getFallbackModel, getAlternateProviderModel, getModelProvider, markModelRateLimited, markProviderRateLimited } from './ModelClassifier.js';
import { classifyJobFailure, isFallbackEligibleFailure, isSameModelRetryEligible, shouldMarkProviderUnavailable } from './FailureClassifier.js';
import { nudgeQueue } from './WorkQueueManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { validateTransition } from './StateTransitions.js';

// Track jobs we've already processed to prevent double-exit race from triggering
// duplicate spawns. Same pattern as DebateManager.
const _processedJobs = new Set<string>();

/**
 * Called from AgentRunner.handleJobCompletion after a job's status is finalized.
 * If the job belongs to a workflow, advances to the next phase or completes the workflow.
 */
export function onJobCompleted(job: Job, { force = false }: { force?: boolean } = {}): void {
  if (!job.workflow_id) return;
  if (!force && _processedJobs.has(job.id)) return;
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
    console.error(`[workflow] error handling job completion for job ${job.id} (workflow=${job.workflow_id}, phase=${job.workflow_phase}, cycle=${job.workflow_cycle}):`, err);
    captureWithContext(err, { job_id: job.id, workflow_id: job.workflow_id ?? undefined, component: 'WorkflowManager' });
  }
}

function _onJobCompleted(job: Job): void {
  const workflow = queries.getWorkflowById(job.workflow_id!);
  if (!workflow || workflow.status !== 'running') return;

  // If the phase job was cancelled, mark workflow as blocked (user action — don't auto-retry)
  if (job.status === 'cancelled') {
    const reason = `Phase '${job.workflow_phase}' job ${job.id.slice(0, 8)} was cancelled`;
    console.log(`[workflow ${workflow.id}] ${reason} — marking workflow blocked`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: reason });
    return;
  }

  // If the phase job failed, try to auto-retry with a fallback model before blocking.
  // Rate limits are transient — Codex can take over when Claude is down.
  if (job.status === 'failed') {
    const currentModel = job.model ?? workflow.implementer_model;
    const failureKind = classifyJobFailure(job.id);
    if (isFallbackEligibleFailure(failureKind)) {
      // Mark the failing model, and provider when the error indicates account-wide/provider-wide trouble.
      markModelRateLimited(currentModel, 5 * 60 * 1000);
      if (shouldMarkProviderUnavailable(failureKind)) {
        markProviderRateLimited(getModelProvider(currentModel), 5 * 60 * 1000);
      }
      const fallbackModel = getWorkflowFallbackModel(workflow, job.workflow_phase as WorkflowPhase, currentModel);
      if (fallbackModel && fallbackModel !== currentModel) {
        const phase = job.workflow_phase as WorkflowPhase;
        const cycle = job.workflow_cycle ?? workflow.current_cycle;
        const recoveryKey = `workflow/${workflow.id}/recovery/${phase}/cycle-${cycle}/model-fallback`;
        if (queries.getNote(recoveryKey)) {
          console.log(`[workflow ${workflow.id}] phase '${phase}' model-fallback already spawned (idempotency key exists) — skipping duplicate`);
          return; // Recovery already in flight — let it complete
        } else {
          queries.upsertNote(recoveryKey, `fallback=${fallbackModel},from=${currentModel},failure=${failureKind}`, null);
          console.log(`[workflow ${workflow.id}] phase '${job.workflow_phase}' failed on ${currentModel} (${failureKind}) → retrying with ${fallbackModel}`);
          spawnPhaseJob(workflow, phase, cycle, fallbackModel);
          return;
        }
      }
      const noFallbackReason = queries.getNote(`workflow/${workflow.id}/recovery/${job.workflow_phase as string}/cycle-${job.workflow_cycle ?? workflow.current_cycle}/model-fallback`)
        ? `Phase '${job.workflow_phase}' model-fallback recovery already spawned — duplicate completion skipped`
        : `Phase '${job.workflow_phase}' failed on ${currentModel} (${failureKind}) — no fallback model available`;
      console.log(`[workflow ${workflow.id}] ${noFallbackReason}`);
      updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: noFallbackReason });
      return;
    }
    // Transient CLI crashes (e.g. Codex stdin hang) — retry same model, not a provider issue.
    if (isSameModelRetryEligible(failureKind)) {
      const phase = job.workflow_phase as WorkflowPhase;
      const cycle = job.workflow_cycle ?? workflow.current_cycle;
      const attemptsKey = `workflow/${workflow.id}/cli-retry/${phase}/cycle-${cycle}`;
      const attempts = parseInt(queries.getNote(attemptsKey)?.value ?? '0', 10);
      const MAX_CLI_RETRIES = 3;
      if (attempts < MAX_CLI_RETRIES) {
        const cliRetryKey = `workflow/${workflow.id}/recovery/${phase}/cycle-${cycle}/cli-retry-${attempts + 1}`;
        if (queries.getNote(cliRetryKey)) {
          console.log(`[workflow ${workflow.id}] phase '${phase}' cli-retry-${attempts + 1} already spawned (idempotency key exists) — skipping`);
          return; // Recovery already in flight — let it complete
        } else {
          queries.upsertNote(attemptsKey, String(attempts + 1), null);
          queries.upsertNote(cliRetryKey, `model=${currentModel},failure=${failureKind},attempt=${attempts + 1}`, null);
          console.log(`[workflow ${workflow.id}] phase '${phase}' hit ${failureKind} on ${currentModel} — same-model retry ${attempts + 1}/${MAX_CLI_RETRIES}`);
          spawnPhaseJob(workflow, phase, cycle);
          return;
        }
      }
      // Same-model retries exhausted — try a different provider before blocking.
      // e.g. Codex keeps crashing → fall back to Claude for the review phase.
      const altModel = getAlternateProviderModel(currentModel);
      if (altModel) {
        const altProviderKey = `workflow/${workflow.id}/recovery/${phase}/cycle-${cycle}/alt-provider`;
        if (queries.getNote(altProviderKey)) {
          console.log(`[workflow ${workflow.id}] phase '${phase}' alt-provider already spawned (idempotency key exists) — skipping`);
          return; // Recovery already in flight — let it complete
        } else {
          queries.upsertNote(altProviderKey, `alt=${altModel},from=${currentModel},failure=${failureKind}`, null);
          console.log(`[workflow ${workflow.id}] phase '${phase}' exhausted ${MAX_CLI_RETRIES} retries on ${currentModel} (${failureKind}) → switching provider to ${altModel}`);
          spawnPhaseJob(workflow, phase, cycle, altModel);
          return;
        }
      }
      console.log(`[workflow ${workflow.id}] phase '${phase}' hit ${failureKind} on ${currentModel} — exhausted ${MAX_CLI_RETRIES} retries, no alternate provider available`);
    }

    const failReason = `Phase '${job.workflow_phase}' job ${job.id.slice(0, 8)} failed (${failureKind})`;
    console.log(`[workflow ${workflow.id}] ${failReason} — marking workflow blocked`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: failReason });
    return;
  }

  // Parse milestones from the plan note
  const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
  const milestones = parseMilestones(planNote?.value ?? '');

  // Phase-specific transitions
  switch (job.workflow_phase) {
    case 'assess': {
      try {
        // After assess: validate plan was written, then move to review
        const contractNote = queries.getNote(`workflow/${workflow.id}/contract`);
        const missingArtifacts = [
          !planNote?.value ? 'plan' : null,
          !contractNote?.value ? 'contract' : null,
        ].filter(Boolean) as string[];
        if (missingArtifacts.length > 0) {
          if (spawnRepairJob(workflow, 'assess', job.workflow_cycle ?? 0, missingArtifacts)) return;
          const assessReason = `Assess phase completed but missing ${missingArtifacts.join(', ')}`;
          console.log(`[workflow ${workflow.id}] ${assessReason} — marking blocked`);
          updateAndEmit(workflow.id, {
            status: 'blocked',
            current_phase: 'assess' as WorkflowPhase,
            blocked_reason: assessReason,
          });
          return;
        }
        // Plan and contract exist, but check that the plan has actual milestones.
        // A 0-milestone plan causes wasted review→implement cycles until max_cycles.
        if (milestones.total === 0) {
          if (spawnRepairJob(workflow, 'assess', job.workflow_cycle ?? 0, ['plan'])) return;
          const zeroReason = 'Assess phase produced a plan with no milestones';
          console.log(`[workflow ${workflow.id}] ${zeroReason} — marking blocked`);
          updateAndEmit(workflow.id, {
            status: 'blocked',
            current_phase: 'assess' as WorkflowPhase,
            blocked_reason: zeroReason,
          });
          return;
        }
        updateAndEmit(workflow.id, {
          milestones_total: milestones.total,
          milestones_done: milestones.done,
          current_cycle: 1,
        });
        spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', 1);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow ${workflow.id}] error in assess handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'assess' as WorkflowPhase, blocked_reason: `Internal error in assess handler: ${errMsg}` });
        return;
      }
      break;
    }

    case 'review': {
      try {
        if (!planNote?.value) {
          if (spawnRepairJob(workflow, 'review', job.workflow_cycle ?? workflow.current_cycle, ['plan'])) return;
          const reviewReason = 'Review phase completed but plan note was deleted or empty';
          console.log(`[workflow ${workflow.id}] ${reviewReason} — marking blocked`);
          updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'review' as WorkflowPhase, blocked_reason: reviewReason });
          return;
        }
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
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow ${workflow.id}] error in review handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'review' as WorkflowPhase, blocked_reason: `Internal error in review handler: ${errMsg}` });
        return;
      }
      break;
    }

    case 'implement': {
      try {
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
          // Max cycles reached but milestones remain — block instead of completing.
          // Marking as "complete" with unchecked milestones is misleading and prevents
          // the user from resuming. Block so they can increase max_cycles and continue.
          console.log(`[workflow ${workflow.id}] reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones — marking blocked (not complete)`);
          updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'idle' as WorkflowPhase, blocked_reason: `Reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones complete` });
          // Create a draft PR for partial work so it's not lost
          if (milestones.done > 0) {
            const latestWf = queries.getWorkflowById(workflow.id)!;
            pushAndCreatePr(latestWf, true);
          }
        } else {
          // Zero-progress detection: if milestones_done didn't increase during this implement
          // cycle, track consecutive zero-progress cycles and block after 2 to avoid burning
          // max_cycles on an agent that can't make progress.
          const preImplKey = `workflow/${workflow.id}/pre-implement-milestones/${updated.current_cycle}`;
          const preImplNote = queries.getNote(preImplKey);
          const zeroProgressKey = `workflow/${workflow.id}/zero-progress-count`;

          if (preImplNote) {
            const preImplDone = parseInt(preImplNote.value, 10);

            // Compute progress delta. Clamp to 0: reviewer restructuring can make done < preImplDone
            const delta = Math.max(0, milestones.done - preImplDone);
            // Only write cycle-progress note when no reviewer restructuring occurred.
            // When milestones.done < preImplDone, the reviewer changed the plan during implement —
            // skip the note so the diminishing returns detector doesn't count a false zero.
            if (milestones.done >= preImplDone) {
              queries.upsertNote(`workflow/${workflow.id}/cycle-progress/${updated.current_cycle}`, String(delta), null);
            }

            if (delta > 0) {
              // Actual progress was made — reset counter
              queries.upsertNote(zeroProgressKey, '0', null);
            } else if (milestones.done >= preImplDone) {
              // No progress this cycle (genuine zero-progress, not reviewer restructuring)
              const prevCount = parseInt(queries.getNote(zeroProgressKey)?.value ?? '0', 10);
              const newCount = prevCount + 1;
              const MAX_ZERO_PROGRESS = 2;
              if (newCount >= MAX_ZERO_PROGRESS) {
                const zpReason = `${newCount} consecutive implement cycles with no milestone progress (${milestones.done}/${milestones.total} complete)`;
                console.log(`[workflow ${workflow.id}] ${zpReason} — marking blocked`);
                updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: zpReason });
                break;
              }
              queries.upsertNote(zeroProgressKey, String(newCount), null);
              console.log(`[workflow ${workflow.id}] zero-progress implement cycle ${newCount}/${MAX_ZERO_PROGRESS} (${milestones.done}/${milestones.total})`);
            }
            // else: milestones.done < preImplDone (reviewer restructuring) — leave counter unchanged

            // Diminishing returns detector: if rolling 3-cycle average < 0.3, block.
            // This catches sustained slow progress (0.1-0.3/cycle) that zero-progress misses.
            const cycle = updated.current_cycle;
            if (cycle >= 3) {
              const cp1 = queries.getNote(`workflow/${workflow.id}/cycle-progress/${cycle}`);
              const cp2 = queries.getNote(`workflow/${workflow.id}/cycle-progress/${cycle - 1}`);
              const cp3 = queries.getNote(`workflow/${workflow.id}/cycle-progress/${cycle - 2}`);
              if (cp1 && cp2 && cp3) {
                const avg = (parseFloat(cp1.value) + parseFloat(cp2.value) + parseFloat(cp3.value)) / 3;
                if (avg < 0.3) {
                  const freshWf = queries.getWorkflowById(workflow.id)!;
                  if (freshWf.status !== 'blocked') {
                    const drReason = `Diminishing returns: average ${avg.toFixed(2)} milestones/cycle over last 3 cycles (${milestones.done}/${milestones.total} complete)`;
                    console.log(`[workflow ${workflow.id}] ${drReason} — marking blocked`);
                    updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: drReason });
                    break;
                  }
                }
              }
            }
          }

          // Advance to next cycle's review phase
          const nextCycle = updated.current_cycle + 1;
          updateAndEmit(workflow.id, { current_cycle: nextCycle });
          spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow ${workflow.id}] error in implement handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: `Internal error in implement handler: ${errMsg}` });
        return;
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

// ─── Worktree Health & Branch Verification ─────────────────────────────────

/**
 * Verify a worktree HEAD is on the expected branch. If drifted, attempt checkout.
 * Returns { ok: true } on success, or { ok: false, error } if checkout fails.
 */
export function ensureWorktreeBranch(
  worktreePath: string,
  expectedBranch: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (currentBranch !== expectedBranch) {
      console.warn(`[worktree] on '${currentBranch}' instead of '${expectedBranch}' — switching`);
      execSync(`git checkout ${JSON.stringify(expectedBranch)}`, {
        cwd: worktreePath, stdio: 'pipe', timeout: 10000,
      });
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

/**
 * Deep health check for a worktree. Verifies directory, .git, git internals,
 * and branch — attempting auto-repair when possible.
 *
 * Repair strategy:
 * - Directory missing or .git broken → attempt worktree recreation from mainRepoDir
 * - git internals broken (rev-parse fails) → force checkout branch
 * - Branch drift → delegate to ensureWorktreeBranch
 *
 * All repair attempts are logged via logResilienceEvent.
 */
export function verifyWorktreeHealth(
  worktreePath: string,
  expectedBranch: string,
  mainRepoDir?: string | null,
): { ok: true } | { ok: false; error: string } {
  // Check 1: directory exists
  if (!existsSync(worktreePath)) {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'directory_missing', action: 'recreate', branch: expectedBranch,
    });
    if (!mainRepoDir) {
      return { ok: false, error: `Worktree directory does not exist: ${worktreePath}` };
    }
    return recreateWorktree(worktreePath, expectedBranch, mainRepoDir);
  }

  // Check 2: .git file/dir is present (worktrees use a .git file pointing to main repo)
  const gitPath = path.join(worktreePath, '.git');
  if (!existsSync(gitPath)) {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'git_missing', action: 'recreate', branch: expectedBranch,
    });
    if (!mainRepoDir) {
      return { ok: false, error: `Worktree .git is missing: ${worktreePath}` };
    }
    return recreateWorktree(worktreePath, expectedBranch, mainRepoDir);
  }

  // Check 3: git rev-parse --is-inside-work-tree
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: worktreePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'not_inside_work_tree', action: 'force_checkout', branch: expectedBranch,
    });
    try {
      execSync(`git checkout -f ${JSON.stringify(expectedBranch)}`, {
        cwd: worktreePath, stdio: 'pipe', timeout: 10000,
      });
    } catch (err: any) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'not_inside_work_tree', action: 'force_checkout', outcome: 'failed', error: err.message,
      });
      return { ok: false, error: `git not functional in worktree and force checkout failed: ${err.message}` };
    }
  }

  // Check 4: HEAD is valid (git rev-parse HEAD)
  try {
    execSync('git rev-parse HEAD', {
      cwd: worktreePath, stdio: 'pipe', timeout: 5000,
    });
  } catch {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'invalid_head', action: 'force_checkout', branch: expectedBranch,
    });
    try {
      execSync(`git checkout -f ${JSON.stringify(expectedBranch)}`, {
        cwd: worktreePath, stdio: 'pipe', timeout: 10000,
      });
    } catch (err: any) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'invalid_head', action: 'force_checkout', outcome: 'failed', error: err.message,
      });
      return { ok: false, error: `Invalid HEAD and force checkout failed: ${err.message}` };
    }
  }

  // Check 5: branch is correct (delegate to ensureWorktreeBranch)
  return ensureWorktreeBranch(worktreePath, expectedBranch);
}

/**
 * Remove and re-create a worktree from the main repo directory.
 */
function recreateWorktree(
  worktreePath: string,
  branch: string,
  mainRepoDir: string,
): { ok: true } | { ok: false; error: string } {
  try {
    // Force-remove any stale worktree registration
    try {
      execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, {
        cwd: mainRepoDir, stdio: 'pipe', timeout: 15000,
      });
    } catch { /* may not be registered — fine */ }
    execSync('git worktree prune', { cwd: mainRepoDir, stdio: 'pipe', timeout: 10000 });
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    execSync(`git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`, {
      cwd: mainRepoDir, stdio: 'pipe', timeout: 30000,
    });
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      action: 'recreate', outcome: 'success', branch,
    });
    return { ok: true };
  } catch (err: any) {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      action: 'recreate', outcome: 'failed', branch, error: err.message,
    });
    return { ok: false, error: `Worktree recreation failed: ${err.message}` };
  }
}

// ─── Phase Job Spawning ─────────────────────────────────────────────────────

function repairAttemptsKey(workflowId: string, phase: 'assess' | 'review', cycle: number): string {
  return `workflow/${workflowId}/repair/${phase}/cycle-${cycle}`;
}

function spawnRepairJob(
  workflow: Workflow,
  phase: 'assess' | 'review',
  cycle: number,
  missingArtifacts: string[],
): boolean {
  const attemptsKey = repairAttemptsKey(workflow.id, phase, cycle);
  const existingAttempts = parseInt(queries.getNote(attemptsKey)?.value ?? '0', 10);
  if (existingAttempts >= 2) return false;

  queries.upsertNote(attemptsKey, String(existingAttempts + 1), null);
  const model = phase === 'review' ? workflow.reviewer_model : workflow.implementer_model;
  const stopMode = phase === 'review' ? workflow.stop_mode_review : workflow.stop_mode_assess;
  const stopValue = phase === 'review' ? workflow.stop_value_review : workflow.stop_value_assess;
  const prompt = buildWorkflowRepairPrompt(workflow, phase, cycle, missingArtifacts);
  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${phase.charAt(0).toUpperCase() + phase.slice(1)} repair`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: workflow.template_id,
    work_dir: workflow.worktree_path ?? workflow.work_dir,
    max_turns: effectiveMaxTurns(stopMode, stopValue),
    stop_mode: stopMode,
    stop_value: stopValue,
    project_id: workflow.project_id,
    use_worktree: 0,
    workflow_id: workflow.id,
    workflow_cycle: cycle,
    workflow_phase: phase,
  });

  try {
    socket.emitJobNew(job);
  } catch (emitErr) {
    console.warn(`[workflow ${workflow.id}] socket.emitJobNew failed for repair job ${job.id.slice(0, 8)}:`, emitErr);
  }
  nudgeQueue();
  updateAndEmit(workflow.id, { current_phase: phase, current_cycle: cycle, status: 'running' });
  console.log(`[workflow ${workflow.id}] spawned ${phase} repair job ${job.id.slice(0, 8)} for missing ${missingArtifacts.join(', ')}`);
  return true;
}

/**
 * Pre-read plan, contract, and worklog notes for a workflow so they can be
 * inlined in review/implement prompts. This eliminates 2-4 MCP tool
 * round-trips at phase start.
 */
export function preReadWorkflowContext(workflowId: string): InlineWorkflowContext {
  const plan = queries.getNote(`workflow/${workflowId}/plan`);
  const contract = queries.getNote(`workflow/${workflowId}/contract`);
  const worklogNotes = queries.listNotes(`workflow/${workflowId}/worklog/`);
  const recentDiff = queries.getLastImplementDiff(workflowId);
  return {
    plan: plan?.value ?? undefined,
    contract: contract?.value ?? undefined,
    worklogs: worklogNotes.map(n => ({ key: n.key, value: n.value })),
    recentDiff: recentDiff ?? undefined,
  };
}

function spawnPhaseJob(workflow: Workflow, phase: WorkflowPhase, cycle: number, modelOverride?: string): void {
  const phaseLabels: Record<string, string> = { assess: 'Assess', review: 'Review', implement: 'Implement' };
  const label = phaseLabels[phase] ?? phase;

  // Choose model, max_turns, and stop config based on phase
  let model: string;
  let maxTurns: number;
  let stopMode: StopMode;
  let stopValue: number | null;
  let prompt: string;

  // Pre-read scratchpad notes for review/implement phases to inline in prompts
  const inlineContext = (phase === 'review' || phase === 'implement')
    ? preReadWorkflowContext(workflow.id)
    : undefined;

  switch (phase) {
    case 'assess':
      model = workflow.implementer_model;
      maxTurns = workflow.max_turns_assess;
      stopMode = workflow.stop_mode_assess;
      stopValue = workflow.stop_value_assess;
      prompt = buildAssessPrompt(workflow);
      break;
    case 'review': {
      model = workflow.reviewer_model;
      maxTurns = workflow.max_turns_review;
      stopMode = workflow.stop_mode_review;
      stopValue = workflow.stop_value_review;
      prompt = buildReviewPrompt(workflow, cycle, inlineContext);
      break;
    }
    case 'implement': {
      model = workflow.implementer_model;
      maxTurns = workflow.max_turns_implement;
      stopMode = workflow.stop_mode_implement;
      stopValue = workflow.stop_value_implement;
      prompt = buildImplementPrompt(workflow, cycle, inlineContext);
      break;
    }
    default:
      throw new Error(`Invalid phase: ${phase}`);
  }

  // Apply model override (used for auto-retry with fallback model on rate limits)
  if (modelOverride) model = modelOverride;
  model = getWorkflowFallbackModel(workflow, phase, model) ?? model;

  // Verify worktree branch before spawning
  if (workflow.worktree_path && workflow.worktree_branch) {
    const branchCheck = ensureWorktreeBranch(workflow.worktree_path, workflow.worktree_branch);
    if (!branchCheck.ok) {
      const reason = `Worktree branch verification failed before ${phase}: ${branchCheck.error}`;
      console.log(`[workflow ${workflow.id}] ${reason} — marking blocked`);
      updateAndEmit(workflow.id, { status: 'blocked', current_phase: phase, blocked_reason: reason });
      return;
    }
  }

  // Before spawning an implement job, snapshot current milestones_done so we can
  // detect zero-progress cycles when the implement job completes.
  if (phase === 'implement') {
    const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
    const milestones = parseMilestones(planNote?.value ?? '');
    queries.upsertNote(`workflow/${workflow.id}/pre-implement-milestones/${cycle}`, String(milestones.done), null);
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${label}${modelOverride ? ' (fallback)' : ''}`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: workflow.template_id,
    // All phases share the single workflow-level worktree (created at startWorkflow).
    // use_worktree=0 tells WorkQueueManager not to create another one.
    work_dir: workflow.worktree_path ?? workflow.work_dir,
    max_turns: effectiveMaxTurns(stopMode, stopValue),
    stop_mode: stopMode,
    stop_value: stopValue,
    project_id: workflow.project_id,
    use_worktree: 0,
    workflow_id: workflow.id,
    workflow_cycle: cycle,
    workflow_phase: phase,
  });

  try {
    socket.emitJobNew(job);
  } catch (emitErr) {
    // Socket notification failure is non-fatal — the queue's 2s poll will find the job
    console.warn(`[workflow ${workflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr);
  }
  nudgeQueue();

  // Update workflow state — must always run even if socket emit failed
  updateAndEmit(workflow.id, {
    current_phase: phase,
    current_cycle: cycle,
  });

  console.log(`[workflow ${workflow.id}] spawned ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle}, model: ${model})`);
}

function getWorkflowFallbackModel(
  workflow: Workflow,
  phase: WorkflowPhase,
  currentModel: string,
): string | null {
  // Fix-5: early return — no fallback needed if the current model is already available.
  if (getAvailableModel(currentModel) === currentModel) return null;

  const candidates = new Set<string>();
  const directFallback = getFallbackModel(currentModel);
  if (directFallback && directFallback !== currentModel) candidates.add(directFallback);

  // Fix-6: include the phase-appropriate workflow model so the user's chosen
  // reviewer_model is tried before falling through to hardcoded alternatives.
  if (phase === 'review') candidates.add(workflow.reviewer_model);
  candidates.add(workflow.implementer_model);

  // Fix-8: use [1m] variants to match MODEL_FALLBACK_CHAIN and avoid returning
  // a non-[1m] variant of the same model family as a "fallback".
  candidates.add('claude-sonnet-4-6[1m]');
  candidates.add('claude-opus-4-6[1m]');
  candidates.add('claude-haiku-4-5-20251001');
  candidates.add('codex');

  for (const candidate of candidates) {
    if (!candidate || candidate === currentModel) continue;
    const available = getAvailableModel(candidate);
    if (available && available !== currentModel) return available;
  }
  return null;
}

export function reconcileRunningWorkflows(): void {
  const ACTIVE = new Set(['queued', 'assigned', 'running']);
  for (const workflow of queries.listWorkflows()) {
    if (workflow.status !== 'running') continue;

    // Startup worktree integrity check — verify worktrees are healthy before
    // allowing any running workflow to continue.
    if (workflow.worktree_path && workflow.worktree_branch) {
      const healthCheck = verifyWorktreeHealth(workflow.worktree_path, workflow.worktree_branch, workflow.work_dir);
      if (!healthCheck.ok) {
        const reason = `Startup worktree health check failed: ${healthCheck.error}`;
        console.warn(`[workflow ${workflow.id}] ${reason} — marking blocked`);
        logResilienceEvent('worktree_startup_check', 'workflow', workflow.id, {
          worktree_path: workflow.worktree_path,
          branch: workflow.worktree_branch,
          error: healthCheck.error,
          outcome: 'blocked',
        });
        updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
        continue;
      }
    }

    const jobs = queries.getJobsForWorkflow(workflow.id);
    const hasActiveJob = jobs.some(job => ACTIVE.has(job.status));
    if (hasActiveJob) continue;

    if (workflow.current_phase === 'idle') {
      updateAndEmit(workflow.id, {
        status: 'blocked',
        blocked_reason: 'Workflow marked running but no active phase job exists',
      });
      continue;
    }

    const expectedCycle = workflow.current_phase === 'assess' ? 0 : workflow.current_cycle;
    const latestPhaseJob = jobs
      .filter(job => job.workflow_phase === workflow.current_phase && job.workflow_cycle === expectedCycle)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

    if (!latestPhaseJob) {
      updateAndEmit(workflow.id, {
        status: 'blocked',
        blocked_reason: `Workflow stuck in ${workflow.current_phase} with no phase job to resume`,
      });
      continue;
    }

    if (latestPhaseJob.status === 'done' || latestPhaseJob.status === 'failed' || latestPhaseJob.status === 'cancelled') {
      const before = queries.getWorkflowById(workflow.id);
      onJobCompleted(latestPhaseJob, { force: true });
      const after = queries.getWorkflowById(workflow.id);
      const progressed = !!after && (
        after.status !== 'running'
        || after.current_phase !== before?.current_phase
        || after.current_cycle !== before?.current_cycle
        || queries.getJobsForWorkflow(workflow.id).some(job => ACTIVE.has(job.status))
      );
      if (progressed) {
        console.log(`[workflow-gap] recovered workflow ${workflow.id.slice(0, 8)}: ${before?.current_phase}/${before?.current_cycle} → ${after!.current_phase}/${after!.current_cycle}`);
        logResilienceEvent('gap_detector_recovery', 'workflow', workflow.id, {
          from_phase: before?.current_phase,
          from_cycle: before?.current_cycle,
          to_phase: after!.current_phase,
          to_cycle: after!.current_cycle,
          to_status: after!.status,
          trigger_job_id: latestPhaseJob.id,
          trigger_job_status: latestPhaseJob.status,
        });
      } else {
        updateAndEmit(workflow.id, {
          status: 'blocked',
          blocked_reason: `Workflow stuck after ${latestPhaseJob.status} ${workflow.current_phase} job ${latestPhaseJob.id.slice(0, 8)}`,
        });
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start a workflow by spawning the assess phase job.
 * Called from the API route when a workflow is created.
 */
export function startWorkflow(workflow: Workflow): Job | null {
  // Pre-flight validation: ensure work_dir exists and git is functional
  if (workflow.work_dir) {
    if (!existsSync(workflow.work_dir)) {
      const reason = `Pre-flight failed: work_dir does not exist: ${workflow.work_dir}`;
      console.warn(`[workflow ${workflow.id}] ${reason}`);
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
      return null;
    }
    try {
      execSync('git status --porcelain', { cwd: workflow.work_dir, timeout: 5000, stdio: 'pipe' });
    } catch (err: any) {
      const reason = `Pre-flight failed: git is not functional in ${workflow.work_dir}: ${err.message}`;
      console.warn(`[workflow ${workflow.id}] ${reason}`);
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
      return null;
    }
  }

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
    model: getWorkflowFallbackModel(activeWorkflow, 'assess', activeWorkflow.implementer_model) ?? activeWorkflow.implementer_model,
    template_id: activeWorkflow.template_id,
    work_dir: activeWorkflow.worktree_path ?? activeWorkflow.work_dir,
    max_turns: effectiveMaxTurns(activeWorkflow.stop_mode_assess, activeWorkflow.stop_value_assess),
    stop_mode: activeWorkflow.stop_mode_assess,
    stop_value: activeWorkflow.stop_value_assess,
    project_id: activeWorkflow.project_id,
    use_worktree: 0,
    workflow_id: activeWorkflow.id,
    workflow_cycle: 0,
    workflow_phase: 'assess',
  });

  try {
    socket.emitJobNew(job);
  } catch (emitErr) {
    // Socket notification failure is non-fatal — the queue's 2s poll will find the job
    console.warn(`[workflow ${activeWorkflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr);
  }
  nudgeQueue();
  updateAndEmit(activeWorkflow.id, { current_phase: 'assess' as WorkflowPhase, current_cycle: 0 });
  console.log(`[workflow ${activeWorkflow.id}] started — assess job ${job.id.slice(0, 8)}`);
  return job;
}

/**
 * Resume a blocked workflow by re-spawning the phase that failed.
 * Optionally accepts a target phase/cycle to enable partial workflow recovery
 * (e.g. restart just the implement phase instead of the whole workflow).
 */
export function resumeWorkflow(
  workflow: Workflow,
  options: { phase?: WorkflowPhase; cycle?: number } = {},
): Job {
  if (workflow.status !== 'blocked') {
    throw new Error(`Cannot resume workflow in status '${workflow.status}'`);
  }

  // Re-fetch to get current worktree fields (caller's object may be stale)
  const current = queries.getWorkflowById(workflow.id)!;

  // Verify worktree health BEFORE changing status — if this fails, workflow stays 'blocked'
  if (current.worktree_path && current.worktree_branch) {
    const healthCheck = verifyWorktreeHealth(current.worktree_path, current.worktree_branch, current.work_dir);
    if (!healthCheck.ok) {
      throw new Error(`Worktree health check failed before resuming: ${healthCheck.error}`);
    }
  }

  updateAndEmit(workflow.id, { status: 'running', blocked_reason: null });
  // Reset zero-progress counter so resumed workflows get a fresh budget
  queries.upsertNote(`workflow/${workflow.id}/zero-progress-count`, '0', null);
  // Clear stale cycle-progress notes so the diminishing returns detector starts fresh
  for (let c = current.current_cycle; c >= 1 && c > current.current_cycle - 3; c--) {
    queries.deleteNote(`workflow/${workflow.id}/cycle-progress/${c}`);
  }
  const updated = queries.getWorkflowById(workflow.id)!;

  // Use target phase/cycle if provided, otherwise resume the blocked phase
  const phase = options.phase ?? (updated.current_phase === 'idle' ? 'assess' : updated.current_phase);
  const cycle = options.cycle ?? updated.current_cycle;

  // Update workflow state to reflect the target phase/cycle
  if (options.phase || options.cycle) {
    updateAndEmit(workflow.id, {
      current_phase: phase,
      current_cycle: cycle,
    });
    console.log(`[workflow ${workflow.id}] partial recovery: resuming from ${phase} cycle ${cycle}`);
  }

  let model: string;
  let maxTurns: number;
  let stopMode: StopMode;
  let stopValue: number | null;
  let prompt: string;

  // Pre-read scratchpad notes for review/implement phases
  const inlineContext = (phase === 'review' || phase === 'implement')
    ? preReadWorkflowContext(updated.id)
    : undefined;

  switch (phase) {
    case 'assess':
      model = updated.implementer_model;
      maxTurns = updated.max_turns_assess;
      stopMode = updated.stop_mode_assess;
      stopValue = updated.stop_value_assess;
      prompt = buildAssessPrompt(updated);
      break;
    case 'review': {
      model = updated.reviewer_model;
      maxTurns = updated.max_turns_review;
      stopMode = updated.stop_mode_review;
      stopValue = updated.stop_value_review;
      prompt = buildReviewPrompt(updated, cycle, inlineContext);
      break;
    }
    case 'implement': {
      model = updated.implementer_model;
      maxTurns = updated.max_turns_implement;
      stopMode = updated.stop_mode_implement;
      stopValue = updated.stop_value_implement;
      prompt = buildImplementPrompt(updated, cycle, inlineContext);
      break;
    }
    default:
      throw new Error(`Cannot resume from phase '${phase}'`);
  }

  model = getWorkflowFallbackModel(updated, phase as WorkflowPhase, model) ?? model;

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${phase.charAt(0).toUpperCase() + phase.slice(1)} (resumed)`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: updated.template_id,
    work_dir: updated.worktree_path ?? updated.work_dir,
    max_turns: effectiveMaxTurns(stopMode, stopValue),
    stop_mode: stopMode,
    stop_value: stopValue,
    project_id: updated.project_id,
    use_worktree: 0,
    workflow_id: updated.id,
    workflow_cycle: cycle,
    workflow_phase: phase as WorkflowPhase,
  });

  try {
    socket.emitJobNew(job);
  } catch (emitErr) {
    // Socket notification failure is non-fatal — the queue's 2s poll will find the job
    console.warn(`[workflow ${workflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr);
  }
  nudgeQueue();
  console.log(`[workflow ${workflow.id}] resumed — ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle})`);
  return job;
}

// ─── Finalization & Cleanup ──────────────────────────────────────────────────

/**
 * Push the worktree branch and create a GitHub PR.
 * Does NOT remove the worktree — callers decide when to clean up.
 * Returns the PR URL on success, or null if no PR was created.
 */
export function pushAndCreatePr(workflow: Workflow, isDraft: boolean): string | null {
  const { worktree_path, worktree_branch, work_dir } = workflow;
  if (!worktree_path || !work_dir) return null;

  // Ensure the worktree is on the correct branch before pushing.
  if (worktree_branch) {
    const branchCheck = ensureWorktreeBranch(worktree_path, worktree_branch);
    if (!branchCheck.ok) {
      console.warn(`[workflow ${workflow.id}] branch check failed:`, branchCheck.error);
    }
  }

  // Count commits on the branch that aren't on the remote default branch
  let hasCommits = false;
  try {
    const n = execSync(
      'git rev-list --count HEAD ^origin/HEAD 2>/dev/null || git rev-list --count HEAD',
      { cwd: worktree_path, stdio: 'pipe', timeout: 10000 }
    ).toString().trim();
    hasCommits = parseInt(n, 10) > 0;
  } catch { /* not a git repo or no remote — skip PR */ }

  if (!hasCommits || !worktree_branch) {
    console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR`);
    return null;
  }

  try {
    // Push branch to remote
    execSync(`git push -u origin ${JSON.stringify(worktree_branch)}`, {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    });

    // Build PR body from plan note milestones
    const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
    const body = _buildPrBody(workflow, planNote?.value ?? null, { partial: isDraft });
    const title = `[Workflow] ${workflow.title}`;

    // For draft (partial) PRs, ensure the "partial" label exists and attach it
    let labelFlag = '';
    if (isDraft) {
      try {
        execSync('gh label create partial --description "Partial workflow completion" --color FBCA04', {
          cwd: worktree_path, stdio: 'pipe', timeout: 10000,
        });
      } catch { /* label already exists — fine */ }
      labelFlag = ' --label partial';
    }

    // Create PR via gh CLI
    const draftFlag = isDraft ? ' --draft' : '';
    const prUrl = execSync(
      `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --head ${JSON.stringify(worktree_branch)}${draftFlag}${labelFlag}`,
      { cwd: worktree_path, stdio: 'pipe', timeout: 30000 }
    ).toString().trim();

    updateAndEmit(workflow.id, { pr_url: prUrl });
    console.log(`[workflow ${workflow.id}] ${isDraft ? 'draft ' : ''}PR created: ${prUrl}`);
    return prUrl;
  } catch (err: any) {
    console.warn(`[workflow ${workflow.id}] push/PR failed (worktree branch preserved locally):`, err.message);
    return null;
  }
}

/**
 * Called when a workflow completes successfully.
 * Pushes the worktree branch, opens a GitHub PR, then removes the local worktree.
 */
export function finalizeWorkflow(workflow: Workflow): void {
  if (!workflow.worktree_path || !workflow.work_dir) return;

  try {
    pushAndCreatePr(workflow, false);
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

export function _buildPrBody(workflow: Workflow, planText: string | null, options?: { partial?: boolean }): string {
  const { total, done } = parseMilestones(planText ?? '');
  const milestoneLines = planText
    ? planText.split('\n')
        .filter(l => /^\s*[-*]\s+\[/.test(l))
        .map(l => {
          const isDone = CHECKBOX_CHECKED.test(l);
          // Strip the checkbox prefix, keeping the milestone title (bold or plain)
          const title = l.replace(/^\s*[-*]\s+\[[xX ]*\]\s*/, '');
          return isDone ? `- Done: ${title}` : `- Pending: ${title}`;
        })
        .join('\n')
    : '';
  const lines = [
    `## ${workflow.title}`,
    '',
  ];
  if (options?.partial) {
    lines.push(`**Partial completion** — ${done}/${total} milestones done. Remaining milestones need manual intervention or resuming the workflow.`);
    lines.push('');
  }
  lines.push(
    `**Task:** ${workflow.task}`,
    '',
    `**Cycles:** ${workflow.current_cycle}/${workflow.max_cycles} · **Milestones:** ${done}/${total} complete`,
    '',
    '## Milestones',
    milestoneLines || '_No plan available_',
  );
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clear module-level dedup state. Test-only — call in beforeEach to ensure per-test independence. */
export function _resetForTest(): void {
  _processedJobs.clear();
}

function updateAndEmit(id: string, fields: Parameters<typeof queries.updateWorkflow>[1]): void {
  if (fields.status) {
    const current = queries.getWorkflowById(id);
    validateTransition('workflow', current?.status, fields.status, id);
  }
  const updated = queries.updateWorkflow(id, fields);
  if (!updated) {
    console.warn(`[workflow] updateAndEmit: workflow ${id} not found — DB update returned null`);
    return;
  }
  try {
    socket.emitWorkflowUpdate(updated);
  } catch (emitErr) {
    // Socket failure is non-fatal — the DB write already succeeded
    console.warn(`[workflow] updateAndEmit: socket.emitWorkflowUpdate failed for workflow ${id}:`, emitErr);
  }
}
