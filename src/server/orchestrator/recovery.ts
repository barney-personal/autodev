import { isPidAlive, statusFromLog } from '../lib/process-utils.js';
import { recoveryLogger } from '../lib/logger.js';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import { reattachAgent, getLogPath } from './AgentRunner.js';
import { execFileSync } from 'child_process';
import { isTmuxSessionAlive, attachPty } from './PtyManager.js';
import { resolveStandalonePrintJobOutcome, reportStandaloneResolutionFailure } from './JobFinalizer.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import { onJobCompleted as workflowOnJobCompleted, reconcileRunningWorkflows, reconcileBlockedPRs } from './WorkflowManager.js';
import { orphanedWaits } from '../mcp/McpServer.js';

const log = recoveryLogger();
import { isCodexModel, isAutoExitJob } from '../../shared/types.js';
import { handleRetry } from './RetryManager.js';
import { claimRecovery } from './RecoveryLedger.js';
import { nudgeQueue } from './WorkQueueManager.js';
import { getJobIfStatus } from './JobLifecycle.js';
import { logResilienceEvent } from './ResilienceLogger.js';

// isPidAlive → process-utils

// statusFromLog → process-utils

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

      const isCodexBatch = isCodexModel(job.model ?? null) && !job.is_interactive;

      if (isCodexBatch) {
        // Legacy stream-json path: use PID-based recovery
        const alive = agent.pid != null && isPidAlive(agent.pid);

        if (alive) {
          log.info({ agentId: agent.id, pid: agent.pid }, 'reattaching Codex');
          reattachAgent({ agentId: agent.id, job });
          codexReattached++;
        } else {
          const logStatus = statusFromLog(getLogPath(agent.id));
          const finalStatus = logStatus ?? 'failed';

          log.info({ agentId: agent.id, prevStatus: status, finalStatus, fromLog: !!logStatus }, 'Codex PID not found');

          // Accept 'assigned' too — agent may have crashed before reaching 'running'
          const activeJob = getJobIfStatus(agent.job_id, ['running', 'assigned']);
          const currentJob = queries.getJobById(agent.job_id);
          const agentStatus = currentJob?.status === 'done' ? 'done' : finalStatus;
          queries.updateAgent(agent.id, {
            status: agentStatus,
            error_message: agentStatus === 'done' ? null : (logStatus ? null : 'Agent process not found on restart.'),
            finished_at: Date.now(),
          });
          if (activeJob) queries.updateJobStatus(activeJob.id, finalStatus);
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
          if (activeJob && job.repeat_interval_ms) {
            try {
              queries.scheduleRepeatJob(job);
              nudgeQueue();
              log.info({ jobId: job.id }, 'repeat scheduled');
            } catch (err) { log.error({ err, jobId: job.id }, 'repeat schedule failed'); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'recovery' }); }
          }

          // If failed, invoke retry policy (independent of repeat scheduling)
          if (activeJob && finalStatus === 'failed') {
            try {
              const freshJob = queries.getJobById(agent.job_id);
              if (freshJob) handleRetry(freshJob, agent.id);
            } catch (err) { log.error({ err, jobId: agent.job_id }, 'handleRetry error'); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'recovery' }); }
          }

          logResilienceEvent('agent_recovered', 'agent', agent.id, { type: 'codex', outcome: agentStatus, job_id: agent.job_id });
          if (agentStatus === 'done') codexRecovered++;
          else codexFailed++;
        }
      } else {
        // Tmux-based path (all Claude agents, interactive or not)
        if (isTmuxSessionAlive(agent.id)) {
          const isDebateStage = isAutoExitJob(job);
          const isStandalonePrint = !job.is_interactive && !isDebateStage;

          if (isStandalonePrint) {
            log.info({ agentId: agent.id }, 're-monitoring print');
            attachPty(agent.id, job);
            logResilienceEvent('agent_recovered', 'agent', agent.id, {
              type: 'tmux_standalone_print',
              outcome: 're_monitored',
              job_id: agent.job_id,
            });
            tmuxReattached++;
          } else if (!job.is_interactive && !isDebateStage) {
            // Non-interactive automated agent (e.g. Eye, verification agents).
            // The in-memory MCP session is gone after restart and Claude Code won't
            // auto-reinitialize, so the agent can't call finish_job or any other MCP tool.
            // Kill the stale session and fail the job so the system can recover cleanly.
            // Kill tmux directly — can't use disconnectAgent() here because
            // SocketManager isn't initialized yet during recovery.
            log.info({ agentId: agent.id }, 'killing stale tmux');
            try {
              execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' });
            } catch { /* session may already be gone */ }

            // Accept 'assigned' too — agent may have crashed before reaching 'running'
            const activeJob = getJobIfStatus(agent.job_id, ['running', 'assigned']);
            const currentJob = queries.getJobById(agent.job_id);
            const agentStatus = currentJob?.status === 'done' ? 'done' : 'failed';
            queries.updateAgent(agent.id, {
              status: agentStatus,
              error_message: agentStatus === 'done' ? null : 'MCP session lost on server restart.',
              finished_at: Date.now(),
            });
            if (activeJob) queries.updateJobStatus(activeJob.id, 'failed');
            queries.releaseLocksForAgent(agent.id);

            // For repeat jobs (e.g. Eye cycles), schedule the next run immediately
            // so the agent resumes without manual intervention.
            if (activeJob && job.repeat_interval_ms) {
              try {
                queries.scheduleRepeatJob(job);
                nudgeQueue();
                log.info({ jobId: job.id }, 'repeat scheduled');
              } catch (err) {
                log.error({ err, jobId: job.id }, 'repeat schedule failed');
                captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'recovery' });
              }
            }

            // Invoke retry policy for the failed job
            if (activeJob) {
              try {
                const freshJob = queries.getJobById(agent.job_id);
                if (freshJob) handleRetry(freshJob, agent.id);
              } catch (err) { log.error({ err, jobId: agent.job_id }, 'handleRetry error'); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'recovery' }); }
            }

            logResilienceEvent('agent_recovered', 'agent', agent.id, { type: 'tmux_automated', outcome: agentStatus, reason: 'mcp_session_lost', job_id: agent.job_id });
            if (agentStatus === 'done') tmuxRecovered++;
            else tmuxFailed++;
          } else {
            // Interactive or debate-stage: reattach and let the user/process continue.
            log.info({ agentId: agent.id }, 'reattaching tmux');
            attachPty(agent.id, job);
            tmuxReattached++;

            // If this agent was in the middle of wait_for_jobs when the server restarted,
            // re-register it as an orphaned wait so the watchdog can restart it once its
            // child jobs are all terminal. Set disconnected_at in the past to bypass the
            // 60-second grace period — the server restart already serves as that delay.
            const pendingWaitIds: string | null = agent.pending_wait_ids ?? null;
            if (pendingWaitIds) {
              try {
                const jobIds: string[] = JSON.parse(pendingWaitIds);
                if (Array.isArray(jobIds) && jobIds.length > 0) {
                  const restartableJob = getJobIfStatus(job.id, ['running']);
                  if (!restartableJob) continue;
                  if (!claimRecovery(restartableJob, 'recovery-orphaned-wait-registration')) continue;
                  orphanedWaits.set(agent.id, {
                    job_ids: jobIds,
                    disconnected_at: Date.now() - 61_000, // bypass the 60s grace period
                  });
                  log.info({ agentId: agent.id, waitedJobIds: jobIds }, 'orphaned wait');
                }
              } catch { /* malformed JSON — skip */ }
            }
          }
        } else {
          // Interactive or debate-stage → done; other non-interactive → failed (no finish_job called)
          const isDebateStage = isAutoExitJob(job);
          const isStandalonePrint = !job.is_interactive && !isDebateStage;
          const standaloneResolution = isStandalonePrint ? resolveStandalonePrintJobOutcome(agent.id, job) : null;
          const finalStatus = standaloneResolution?.status ?? ((job.is_interactive || isDebateStage) ? 'done' : 'failed');
          log.info({ agentId: agent.id, finalStatus, source: standaloneResolution?.source }, 'tmux session gone');

          // Accept 'assigned' too — agent may have crashed before reaching 'running'
          const activeJob = getJobIfStatus(agent.job_id, ['running', 'assigned']);
          const currentJob = queries.getJobById(agent.job_id);
          const agentStatus = currentJob?.status === 'done' ? 'done' : finalStatus;
          queries.updateAgent(agent.id, {
            status: agentStatus,
            error_message: agentStatus === 'done'
              ? null
              : (
                  standaloneResolution?.errorMessage
                  ?? (finalStatus === 'failed' ? 'Agent session not found on restart.' : null)
                ),
            finished_at: Date.now(),
          });
          if (activeJob) queries.updateJobStatus(activeJob.id, finalStatus);
          queries.releaseLocksForAgent(agent.id);

          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Orchestrator restarted.',
              answered_at: Date.now(),
            });
          }

          logResilienceEvent('agent_recovered', 'agent', agent.id, {
            type: isStandalonePrint ? 'tmux_standalone_print' : 'tmux',
            outcome: finalStatus,
            source: standaloneResolution?.source,
            detail: standaloneResolution?.detail,
            job_id: agent.job_id,
          });
          if (standaloneResolution) {
            reportStandaloneResolutionFailure(agent.id, agent.job_id, 'recovery', standaloneResolution);
          }
          if (activeJob && finalStatus === 'done') {
            const doneJob = queries.getJobById(agent.job_id);
            if (doneJob) {
              try { debateOnJobCompleted(doneJob); } catch (err) { log.error({ err, agentId: agent.id }, 'debateOnJobCompleted error'); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'recovery' }); }
              try { workflowOnJobCompleted(doneJob); } catch (err) { log.error({ err, agentId: agent.id }, 'workflowOnJobCompleted error'); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'recovery' }); }
            }
            tmuxRecovered++;
          } else {
            // For repeat jobs (e.g. Eye cycles), schedule the next run
            if (activeJob && job.repeat_interval_ms) {
              try {
                queries.scheduleRepeatJob(job);
                nudgeQueue();
                log.info({ jobId: job.id }, 'repeat scheduled');
              } catch (err) { log.error({ err, jobId: job.id }, 'repeat schedule failed'); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'recovery' }); }
            }

            // Invoke retry policy for the failed job
            if (activeJob) {
              try {
                const freshJob = queries.getJobById(agent.job_id);
                if (freshJob) handleRetry(freshJob, agent.id);
              } catch (err) { log.error({ err, jobId: agent.job_id }, 'handleRetry error'); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'recovery' }); }
            }

            if (activeJob) tmuxFailed++;
          }
        }
      }
    }
  }

  if (codexReattached > 0) log.info({ count: codexReattached }, 'reattached Codex');
  if (codexRecovered > 0) log.info({ count: codexRecovered }, 'recovered Codex');
  if (codexFailed > 0) log.warn({ count: codexFailed }, 'failed Codex');
  if (tmuxReattached > 0) log.info({ count: tmuxReattached }, 'reattached tmux');
  if (tmuxRecovered > 0) log.info({ count: tmuxRecovered }, 'recovered tmux');
  if (tmuxFailed > 0) log.warn({ count: tmuxFailed }, 'failed tmux');

  const totalRecovered = codexReattached + codexRecovered + tmuxReattached + tmuxRecovered + codexFailed + tmuxFailed;
  if (totalRecovered > 0) {
    logResilienceEvent('startup_recovery', 'system', 'recovery', {
      codex: { reattached: codexReattached, recovered: codexRecovered, failed: codexFailed },
      tmux: { reattached: tmuxReattached, recovered: tmuxRecovered, failed: tmuxFailed },
    });
  }

  // Gap detector: find running workflows whose current-phase job is done but no next phase was spawned.
  // This happens when the server restarts between finish_job and onJobCompleted.
  reconcileRunningWorkflows();

  // Fire-and-forget: retry PR creation for workflows blocked on PR failure.
  reconcileBlockedPRs().catch(err =>
    log.error({ err }, 'reconcileBlockedPRs error'),
  );
}

let _gapDetectorTimer: NodeJS.Timeout | null = null;

/** Start a periodic gap detector that re-fires onJobCompleted for any workflow stuck mid-transition. */
export function startWorkflowGapDetector(): void {
  if (_gapDetectorTimer) return;
  // Run every 60 seconds so stuck workflows recover within a minute of getting stuck.
  _gapDetectorTimer = setInterval(() => {
    try {
      reconcileRunningWorkflows();
    } catch (err) {
      log.error({ err }, 'gap detector error');
      logResilienceEvent('gap_detector_error', 'system', 'gap_detector', { error: String(err) });
      captureWithContext(err, { component: 'recovery' });
    }
  }, 60_000);
}

export function stopWorkflowGapDetector(): void {
  if (_gapDetectorTimer) { clearInterval(_gapDetectorTimer); _gapDetectorTimer = null; }
}
