import * as fs from 'fs';
import * as queries from '../db/queries.js';
import { reattachAgent, getLogPath } from './AgentRunner.js';
import { execFileSync } from 'child_process';
import { isTmuxSessionAlive, attachPty } from './PtyManager.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import { onJobCompleted as workflowOnJobCompleted } from './WorkflowManager.js';
import { orphanedWaits } from '../mcp/McpServer.js';
import type { ClaudeStreamEvent } from '../../shared/types.js';
import { isCodexModel, isAutoExitJob } from '../../shared/types.js';
import { handleRetry } from './RetryManager.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = no-op, just checks existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the agent's log file to determine the actual exit status.
 * Used for legacy stream-json (Codex batch) agents.
 */
function statusFromLog(agentId: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        // Claude result event
        if (ev.type === 'result') {
          return ev.is_error ? 'failed' : 'done';
        }
        // Codex turn events
        if (ev.type === 'turn.completed') return 'done';
        if (ev.type === 'turn.failed') return 'failed';
      } catch { /* skip malformed lines */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}

/**
 * On startup, check each previously-running agent and recover it:
 *
 * - Codex batch (pid-based, stream-json path):
 *     PID alive → reattach file tailing
 *     PID dead  → read log to determine done/failed, default to failed
 *
 * - All other agents (tmux-based):
 *     tmux alive → reattach PTY
 *     tmux dead  → interactive → mark done; batch → mark failed
 */
export function runRecovery(): void {
  const staleStatuses = ['starting', 'running', 'waiting_user'] as const;
  let codexReattached = 0;
  let codexRecovered = 0;
  let codexFailed = 0;
  let tmuxReattached = 0;
  let tmuxRecovered = 0;
  let tmuxFailed = 0;

  for (const status of staleStatuses) {
    for (const agent of queries.listAllRunningAgents()) {
      if (agent.status !== status) continue;

      const agentWithJob = queries.getAgentWithJob(agent.id);
      if (!agentWithJob) continue;
      const { job } = agentWithJob;

      const isCodexBatch = isCodexModel((job as any).model ?? null) && !job.is_interactive;

      if (isCodexBatch) {
        // Legacy stream-json path: use PID-based recovery
        const alive = agent.pid != null && isPidAlive(agent.pid);

        if (alive) {
          console.log(`[recovery] reattaching live Codex agent ${agent.id} (PID ${agent.pid})`);
          reattachAgent({ agentId: agent.id, job });
          codexReattached++;
        } else {
          const logStatus = statusFromLog(agent.id);
          const finalStatus = logStatus ?? 'failed';

          console.log(
            `[recovery] Codex agent ${agent.id} (${status}) — PID ${agent.pid ?? 'none'} not found, ` +
            `marking ${finalStatus}${logStatus ? ' (from log)' : ' (no result in log)'}`
          );

          queries.updateAgent(agent.id, {
            status: finalStatus,
            error_message: logStatus ? null : 'Agent process not found on restart.',
            finished_at: Date.now(),
          });
          queries.updateJobStatus(agent.job_id, finalStatus);
          queries.releaseLocksForAgent(agent.id);

          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Orchestrator restarted.',
              answered_at: Date.now(),
            });
          }

          // For repeat jobs, schedule the next run
          if (job.repeat_interval_ms) {
            try {
              queries.scheduleRepeatJob(job);
              console.log(`[recovery] scheduled next repeat for job "${job.title}" (${job.id})`);
            } catch (err) { console.error(`[recovery] failed to schedule repeat for job ${job.id}:`, err); }
          }

          // If failed, invoke retry policy (independent of repeat scheduling)
          if (finalStatus === 'failed') {
            try {
              const freshJob = queries.getJobById(agent.job_id);
              if (freshJob) handleRetry(freshJob, agent.id);
            } catch (err) { console.error(`[recovery] handleRetry error for job ${agent.job_id}:`, err); }
          }

          if (finalStatus === 'done') codexRecovered++;
          else codexFailed++;
        }
      } else {
        // Tmux-based path (all Claude agents, interactive or not)
        if (isTmuxSessionAlive(agent.id)) {
          const isDebateStage = isAutoExitJob(job as any);

          if (!job.is_interactive && !isDebateStage) {
            // Non-interactive automated agent (e.g. Eye, verification agents).
            // The in-memory MCP session is gone after restart and Claude Code won't
            // auto-reinitialize, so the agent can't call finish_job or any other MCP tool.
            // Kill the stale session and fail the job so the system can recover cleanly.
            // Kill tmux directly — can't use disconnectAgent() here because
            // SocketManager isn't initialized yet during recovery.
            console.log(`[recovery] killing stale automated tmux agent ${agent.id} — MCP session lost on restart`);
            try {
              execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' });
            } catch { /* session may already be gone */ }

            queries.updateAgent(agent.id, {
              status: 'failed',
              error_message: 'MCP session lost on server restart.',
              finished_at: Date.now(),
            });
            queries.updateJobStatus(agent.job_id, 'failed');
            queries.releaseLocksForAgent(agent.id);

            // For repeat jobs (e.g. Eye cycles), schedule the next run immediately
            // so the agent resumes without manual intervention.
            if (job.repeat_interval_ms) {
              try {
                queries.scheduleRepeatJob(job);
                console.log(`[recovery] scheduled next repeat for job "${job.title}" (${job.id})`);
              } catch (err) {
                console.error(`[recovery] failed to schedule repeat for job ${job.id}:`, err);
              }
            }

            // Invoke retry policy for the failed job
            try {
              const freshJob = queries.getJobById(agent.job_id);
              if (freshJob) handleRetry(freshJob, agent.id);
            } catch (err) { console.error(`[recovery] handleRetry error for job ${agent.job_id}:`, err); }

            tmuxFailed++;
          } else {
            // Interactive or debate-stage: reattach and let the user/process continue.
            console.log(`[recovery] reattaching tmux agent ${agent.id} (session alive)`);
            attachPty(agent.id, job);
            tmuxReattached++;

            // If this agent was in the middle of wait_for_jobs when the server restarted,
            // re-register it as an orphaned wait so the watchdog can restart it once its
            // child jobs are all terminal. Set disconnected_at in the past to bypass the
            // 60-second grace period — the server restart already serves as that delay.
            const pendingWaitIds: string | null = (agent as any).pending_wait_ids ?? null;
            if (pendingWaitIds) {
              try {
                const jobIds: string[] = JSON.parse(pendingWaitIds);
                if (Array.isArray(jobIds) && jobIds.length > 0) {
                  orphanedWaits.set(agent.id, {
                    job_ids: jobIds,
                    disconnected_at: Date.now() - 61_000, // bypass the 60s grace period
                  });
                  console.log(`[recovery] agent ${agent.id} was in wait_for_jobs — registered as orphaned wait for [${jobIds.join(', ')}]`);
                }
              } catch { /* malformed JSON — skip */ }
            }
          }
        } else {
          // Interactive or debate-stage → done; other non-interactive → failed (no finish_job called)
          const isDebateStage = isAutoExitJob(job as any);
          const finalStatus = (job.is_interactive || isDebateStage) ? 'done' : 'failed';
          console.log(`[recovery] tmux agent ${agent.id} — session gone, marking ${finalStatus}`);

          queries.updateAgent(agent.id, {
            status: finalStatus,
            error_message: finalStatus === 'failed' ? 'Agent session not found on restart.' : null,
            finished_at: Date.now(),
          });
          queries.updateJobStatus(agent.job_id, finalStatus);
          queries.releaseLocksForAgent(agent.id);

          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Orchestrator restarted.',
              answered_at: Date.now(),
            });
          }

          if (finalStatus === 'done') {
            const doneJob = queries.getJobById(agent.job_id);
            if (doneJob) {
              try { debateOnJobCompleted(doneJob); } catch (err) { console.error(`[recovery] debateOnJobCompleted error for agent ${agent.id}:`, err); }
              try { workflowOnJobCompleted(doneJob); } catch (err) { console.error(`[recovery] workflowOnJobCompleted error for agent ${agent.id}:`, err); }
            }
            tmuxRecovered++;
          } else {
            // For repeat jobs (e.g. Eye cycles), schedule the next run
            if (job.repeat_interval_ms) {
              try {
                queries.scheduleRepeatJob(job);
                console.log(`[recovery] scheduled next repeat for job "${job.title}" (${job.id})`);
              } catch (err) { console.error(`[recovery] failed to schedule repeat for job ${job.id}:`, err); }
            }

            // Invoke retry policy for the failed job
            try {
              const freshJob = queries.getJobById(agent.job_id);
              if (freshJob) handleRetry(freshJob, agent.id);
            } catch (err) { console.error(`[recovery] handleRetry error for job ${agent.job_id}:`, err); }

            tmuxFailed++;
          }
        }
      }
    }
  }

  if (codexReattached > 0) console.log(`[recovery] reattached ${codexReattached} live Codex agents`);
  if (codexRecovered > 0) console.log(`[recovery] recovered ${codexRecovered} completed Codex agents`);
  if (codexFailed > 0) console.log(`[recovery] failed ${codexFailed} dead Codex agents`);
  if (tmuxReattached > 0) console.log(`[recovery] reattached ${tmuxReattached} tmux agents`);
  if (tmuxRecovered > 0) console.log(`[recovery] recovered ${tmuxRecovered} completed tmux agents`);
  if (tmuxFailed > 0) console.log(`[recovery] failed ${tmuxFailed} dead tmux agents`);

  // Gap detector: find running workflows whose current-phase job is done but no next phase was spawned.
  // This happens when the server restarts between finish_job and onJobCompleted.
  _recoverStuckWorkflows();
}

let _gapDetectorTimer: NodeJS.Timeout | null = null;

/** Start a periodic gap detector that re-fires onJobCompleted for any workflow stuck mid-transition. */
export function startWorkflowGapDetector(): void {
  if (_gapDetectorTimer) return;
  // Run every 60 seconds so stuck workflows recover within a minute of getting stuck.
  _gapDetectorTimer = setInterval(() => {
    try { _recoverStuckWorkflows(); } catch (err) { console.error('[workflow-gap] tick error:', err); }
  }, 60_000);
}

export function stopWorkflowGapDetector(): void {
  if (_gapDetectorTimer) { clearInterval(_gapDetectorTimer); _gapDetectorTimer = null; }
}

function _recoverStuckWorkflows(): void {
  const runningWorkflows = queries.listWorkflows().filter(w => w.status === 'running');
  for (const workflow of runningWorkflows) {
    if (workflow.current_phase === 'idle') continue;
    const jobs = queries.getJobsForWorkflow(workflow.id);

    // Assess always runs at cycle 0, but onJobCompleted bumps current_cycle to 1
    // before calling spawnPhaseJob — so look for cycle 0 when stuck in assess.
    const jobCycle = workflow.current_phase === 'assess' ? 0 : workflow.current_cycle;

    // Find the most recent completed job for this phase
    const phaseJob = jobs
      .filter(j => j.workflow_phase === workflow.current_phase && j.workflow_cycle === jobCycle)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    if (!phaseJob || phaseJob.status !== 'done') continue;

    // Check if the expected next-phase job already exists.
    // Progression: assess→review(C1), review→implement(Cn), implement→review(Cn+1)
    const cycle = workflow.current_cycle;
    const hasNext = workflow.current_phase === 'implement'
      ? jobs.some(j => j.workflow_phase === 'review' && j.workflow_cycle === cycle + 1)
      : workflow.current_phase === 'review'
        ? jobs.some(j => j.workflow_phase === 'implement' && j.workflow_cycle === cycle)
        : jobs.some(j => j.workflow_phase === 'review' && j.workflow_cycle === 1); // assess stuck

    if (hasNext) continue;
    console.log(`[recovery] workflow ${workflow.id} stuck — ${workflow.current_phase} C${jobCycle} done but no next phase; re-firing onJobCompleted`);
    try { workflowOnJobCompleted(phaseJob, { force: true }); } catch (err) { console.error(`[recovery] stuck workflow re-fire error:`, err); }
  }
}
