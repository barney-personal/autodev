/**
 * StuckJobWatchdog — periodic runtime monitor for stuck/inconsistent agent state.
 *
 * Runs every 30 seconds and handles four failure modes:
 *
 * 1. Dead agents: an agent's tmux session (or legacy PID) has died but the DB
 *    still shows it as running. Mark done/failed and release locks.
 *
 * 2. Orphaned waits: agent MCP connection dropped while wait_for_jobs was active,
 *    and all waited jobs have since finished. Kill session and re-queue.
 *
 * 3. MCP-disconnected agents: agent lost MCP connection outside of wait_for_jobs
 *    and hasn't reconnected within the grace period. Kill and re-queue.
 *
 * 4. Job/agent inconsistency: a job is marked terminal but an agent row still
 *    shows 'running'. Clean up the stale row.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent, getLogPath } from './AgentRunner.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import { onJobCompleted as workflowOnJobCompleted } from './WorkflowManager.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { isTmuxSessionAlive, startInteractiveAgent, saveSnapshot } from './PtyManager.js';
import { handleRetry } from './RetryManager.js';
import { orphanedWaits, disconnectedAgents, hasActiveTransport } from '../mcp/McpServer.js';
import { isCodexModel, isAutoExitJob } from '../../shared/types.js';
import { markModelRateLimited, getFallbackModel, getModelProvider, markProviderRateLimited } from './ModelClassifier.js';
import { claimRecovery } from './RecoveryLedger.js';
import { classifyFailureText, isFallbackEligibleFailure, shouldMarkProviderUnavailable } from './FailureClassifier.js';
import { nudgeQueue } from './WorkQueueManager.js';
import { parseMilestones } from './WorkflowManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';

const WATCHDOG_INTERVAL_MS = 30_000;
const SLOW_PROGRESS_WARN_MS = 15 * 60 * 1000;  // 15 minutes
const SLOW_PROGRESS_BLOCK_MS = 30 * 60 * 1000;  // 30 minutes
const SLOW_PROGRESS_ACTIVE_MS = 5 * 60 * 1000;  // agent must be active within 5 min

/** Tracks milestone progress snapshots per workflow_id for slow-progress detection. */
const _milestoneSnapshots = new Map<string, { milestonesDone: number; checkedAt: number }>();

let _timer: NodeJS.Timeout | null = null;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusFromLog(agentId: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'result') return ev.is_error ? 'failed' : 'done';
        if (ev.type === 'turn.completed') return 'done';
        if (ev.type === 'turn.failed') return 'failed';
      } catch { /* skip */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}

function killProcess(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* not a process group leader */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Scan the agent's last output events to find a wait_for_jobs tool call.
 * Returns the job_ids it was waiting on, or null if not found.
 */
function findLastWaitForJobsIds(agentId: string): string[] | null {
  // Only scan the last 20 assistant events (from the end) instead of loading all output.
  // The wait_for_jobs call is always near the tail of the transcript.
  const output = queries.getAgentOutput(agentId, 50);
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i].event_type !== 'assistant') continue;
    try {
      const ev = JSON.parse(output[i].content);
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (
          block.type === 'tool_use' &&
          (block.name === 'mcp__orchestrator__wait_for_jobs' || block.name === 'wait_for_jobs') &&
          Array.isArray(block.input?.job_ids)
        ) {
          return block.input.job_ids as string[];
        }
      }
      break; // checked last assistant message, no wait_for_jobs
    } catch { /* skip */ }
  }
  return null;
}

function check(): void {
  const TERMINAL = ['done', 'failed', 'cancelled'];

  // ── Check 1: Dead agents ────────────────────────────────────────────────────
  // For all running agents, check if tmux session (or legacy PID) is alive.
  // Agents with pid = legacy stream-json path (Codex batch); without = tmux path.
  for (const agent of queries.listAllRunningAgents()) {
    const tmuxAlive = isTmuxSessionAlive(agent.id);
    const pidAlive = agent.pid != null && isPidAlive(agent.pid);

    if (tmuxAlive || pidAlive) {
      // Idle timeout: non-interactive agents should be making MCP calls regularly.
      // If updated_at hasn't changed in IDLE_THRESHOLD_MS and there's no active
      // wait_for_jobs, the agent is likely stuck (e.g. at Claude's ❯ prompt, or in
      // a sleep-retry loop after MCP disconnect) — kill and restart.
      const IDLE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes
      if ((tmuxAlive || pidAlive) && !agent.pending_wait_ids) {
        const idleJob = queries.getJobById(agent.job_id);
        const isStuckCandidate = idleJob && !idleJob.is_interactive && !isAutoExitJob(idleJob);
        const idleMs = Date.now() - agent.updated_at;
        if (isStuckCandidate && idleMs > IDLE_THRESHOLD_MS) {
          console.warn(`[watchdog] non-interactive agent ${agent.id} idle ${Math.round(idleMs / 60000)}min without MCP activity — killing`);
          if (tmuxAlive) {
            saveSnapshot(agent.id);
            try { execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' }); } catch { /* already gone */ }
          }
          if (agent.pid != null) killProcess(agent.pid);
          queries.updateAgent(agent.id, {
            status: 'failed',
            error_message: `Agent idle ${Math.round(idleMs / 60000)}min without MCP activity; watchdog killed.`,
            finished_at: Date.now(),
          });
          queries.updateJobStatus(agent.job_id, 'failed');
          getFileLockRegistry().releaseAll(agent.id);
          disconnectedAgents.delete(agent.id);
          const pendingQ = queries.getPendingQuestion(agent.id);
          if (pendingQ) {
            queries.updateQuestion(pendingQ.id, {
              status: 'timeout',
              answer: '[TIMEOUT] Agent went idle; watchdog killed.',
              answered_at: Date.now(),
            });
          }
          const updatedAgent2 = queries.getAgentWithJob(agent.id);
          if (updatedAgent2) socket.emitAgentUpdate(updatedAgent2);
          const idleJobFresh = queries.getJobById(agent.job_id);
          if (idleJobFresh) {
            try { socket.emitJobUpdate(idleJobFresh); } catch { /* ignore */ }
            try { workflowOnJobCompleted(idleJobFresh); } catch { /* ignore */ }
            if (idleJobFresh.repeat_interval_ms) {
              try {
                const nextJob = queries.scheduleRepeatJob(idleJobFresh);
                socket.emitJobNew(nextJob);
                nudgeQueue();
                console.log(`[watchdog] scheduled next repeat for idle job "${idleJobFresh.title}"`);
              } catch (err) { console.error(`[watchdog] scheduleRepeatJob error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
            }
            if (idleJobFresh.status === 'failed') {
              try { handleRetry(idleJobFresh, agent.id); } catch (err) { console.error(`[watchdog] handleRetry error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
            }
          }
        }
      }
      continue; // still alive
    }

    const job = queries.getJobById(agent.job_id);

    // For legacy PID-based agents (Codex batch): check log and attempt auto-resume
    if (agent.pid != null) {
      const logStatus = statusFromLog(agent.id);

      if (!logStatus || logStatus === 'failed') {
        const waitedIds = findLastWaitForJobsIds(agent.id);
        if (waitedIds && waitedIds.length > 0) {
          const waitedJobs = waitedIds.map(id => queries.getJobById(id));
          const allDone = waitedJobs.every(j => j && j.status === 'done');
          if (allDone && job && !TERMINAL.includes(job.status)) {
            if (!claimRecovery(job, 'watchdog-wait-for-jobs-auto-resume')) continue;
            console.log(`[watchdog] agent ${agent.id} died in wait_for_jobs with all deps done — auto-resuming job ${job.id}`);
            queries.updateAgent(agent.id, {
              status: 'failed',
              error_message: 'Process died during wait_for_jobs; watchdog auto-resumed.',
              finished_at: Date.now(),
            });
            getFileLockRegistry().releaseAll(agent.id);

            const pendingQ = queries.getPendingQuestion(agent.id);
            if (pendingQ) {
              queries.updateQuestion(pendingQ.id, {
                status: 'timeout',
                answer: '[TIMEOUT] Agent process died; watchdog re-queued.',
                answered_at: Date.now(),
              });
            }

            const newAgentId = randomUUID();
            queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
            queries.updateJobStatus(job.id, 'assigned');

            const newAgentWithJob = queries.getAgentWithJob(newAgentId);
            if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
            const updatedJob = queries.getJobById(job.id);
            if (updatedJob) socket.emitJobUpdate(updatedJob);

            runAgent({ agentId: newAgentId, job, resumeSessionId: agent.session_id ?? undefined });
            console.log(`[watchdog] re-spawned agent ${newAgentId} for job ${job.id} with resume session ${agent.session_id ?? '(none)'}`);
            continue;
          } else if (!allDone) {
            const stillPending = waitedJobs
              .filter(j => j && !TERMINAL.includes(j.status))
              .map(j => j!.id);
            console.log(`[watchdog] agent ${agent.id} dead in wait_for_jobs, ${stillPending.length} deps still pending: [${stillPending.join(', ')}]`);
          }
        }
      }

      const finalStatus = logStatus ?? 'failed';
      console.log(
        `[watchdog] agent ${agent.id} (pid-based) — PID ${agent.pid} dead, ` +
        `marking ${finalStatus}${logStatus ? ' (from log)' : ' (no result in log)'}`
      );

      queries.updateAgent(agent.id, {
        status: finalStatus,
        error_message: logStatus ? null : 'Agent process died unexpectedly.',
        finished_at: Date.now(),
      });
      queries.updateJobStatus(agent.job_id, finalStatus);
    } else {
      // Tmux-based agent: session ended without finish_job being called.
      // Interactive or debate-stage → done; other non-interactive → failed.
      const isDebateStage = job ? isAutoExitJob(job) : false;
      const finalStatus = (job?.is_interactive || isDebateStage) ? 'done' : 'failed';
      console.log(
        `[watchdog] agent ${agent.id} (tmux-based) — session gone, marking ${finalStatus}`
      );

      queries.updateAgent(agent.id, {
        status: finalStatus,
        error_message: finalStatus === 'failed' ? 'Agent session ended without calling finish_job.' : null,
        finished_at: Date.now(),
      });
      queries.updateJobStatus(agent.job_id, finalStatus);
    }

    getFileLockRegistry().releaseAll(agent.id);

    const pendingQ = queries.getPendingQuestion(agent.id);
    if (pendingQ) {
      queries.updateQuestion(pendingQ.id, {
        status: 'timeout',
        answer: '[TIMEOUT] Agent session ended.',
        answered_at: Date.now(),
      });
    }

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);

    // Trigger debate/workflow state machines for the completed job
    const updatedJob = queries.getJobById(agent.job_id);
    if (updatedJob) {
      try { socket.emitJobUpdate(updatedJob); } catch (err) { console.error(`[watchdog] emitJobUpdate error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
      try { debateOnJobCompleted(updatedJob); } catch (err) { console.error(`[watchdog] debateOnJobCompleted error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
      try { workflowOnJobCompleted(updatedJob); } catch (err) { console.error(`[watchdog] workflowOnJobCompleted error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
      // For repeat jobs (e.g. Eye cycles), schedule the next run so the cycle continues
      if (updatedJob.repeat_interval_ms) {
        try {
          const nextJob = queries.scheduleRepeatJob(updatedJob);
          socket.emitJobNew(nextJob);
          nudgeQueue();
          console.log(`[watchdog] scheduled next repeat for job "${updatedJob.title}" (${updatedJob.id})`);
        } catch (err) { console.error(`[watchdog] scheduleRepeatJob error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
      }
      // Invoke retry policy for failed jobs
      if (updatedJob.status === 'failed') {
        try {
          handleRetry(updatedJob, agent.id);
        } catch (err) { console.error(`[watchdog] handleRetry error for job ${agent.job_id}:`, err); captureWithContext(err, { agent_id: agent.id, job_id: agent.job_id, component: 'StuckJobWatchdog' }); }
      }
    }
  }

  // ── Check 2: Orphaned waits after MCP disconnect ────────────────────────────
  // When an MCP session closes while wait_for_jobs is active, McpServer registers
  // an orphaned wait entry. Once all waited jobs are terminal AND the agent hasn't
  // reconnected, we kill the stuck tmux session and re-queue the job.
  for (const [agentId, orphan] of orphanedWaits) {
    // Give the agent a moment to reconnect before acting
    if (Date.now() - orphan.disconnected_at < 60_000) continue;

    // Agent has reconnected? Clear and skip
    if (hasActiveTransport(agentId)) {
      orphanedWaits.delete(agentId);
      continue;
    }

    const agent = queries.getAgentById(agentId);
    if (!agent || agent.status !== 'running') {
      orphanedWaits.delete(agentId);
      continue;
    }

    const job = queries.getJobById(agent.job_id);
    if (!job || TERMINAL.includes(job.status)) {
      orphanedWaits.delete(agentId);
      continue;
    }

    // Only act once all the waited jobs have reached a terminal state
    const waitedJobs = orphan.job_ids.map(id => queries.getJobById(id));
    const allTerminal = waitedJobs.every(j => j && TERMINAL.includes(j.status));
    if (!allTerminal) {
      const stillPending = waitedJobs.filter(j => j && !TERMINAL.includes(j.status)).map(j => j!.id);
      console.log(`[watchdog] orphaned wait for agent ${agentId}: ${stillPending.length} job(s) still pending [${stillPending.join(', ')}]`);
      continue;
    }

    const stuckMs = Date.now() - orphan.disconnected_at;
    console.warn(`[watchdog] agent ${agentId} stuck after MCP disconnect (${stuckMs}ms), all sub-jobs terminal — restarting job ${job.id}`);
    orphanedWaits.delete(agentId);
    if (!claimRecovery(job, 'watchdog-orphaned-wait-restart')) continue;

    // Capture a snapshot before killing the stuck tmux session
    if (isTmuxSessionAlive(agentId)) {
      saveSnapshot(agentId);
      try {
        execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agentId}`], { stdio: 'pipe' });
      } catch { /* already gone */ }
    }

    // Mark old agent failed
    queries.updateAgent(agent.id, {
      status: 'failed',
      error_message: `MCP connection dropped during wait_for_jobs; watchdog restarted after ${Math.round(stuckMs / 1000)}s.`,
      finished_at: Date.now(),
    });
    getFileLockRegistry().releaseAll(agent.id);

    const pendingQ = queries.getPendingQuestion(agent.id);
    if (pendingQ) {
      queries.updateQuestion(pendingQ.id, {
        status: 'timeout',
        answer: '[TIMEOUT] MCP connection dropped; watchdog restarted agent.',
        answered_at: Date.now(),
      });
    }

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);

    // Re-queue with a new agent
    const newAgentId = randomUUID();
    queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
    queries.updateJobStatus(job.id, 'assigned');

    const newAgentWithJob = queries.getAgentWithJob(newAgentId);
    if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
    const updatedJob = queries.getJobById(job.id);
    if (updatedJob) socket.emitJobUpdate(updatedJob);

    if (job.is_interactive) {
      startInteractiveAgent({ agentId: newAgentId, job });
    } else {
      runAgent({ agentId: newAgentId, job, resumeSessionId: agent.session_id ?? undefined });
    }
    console.log(`[watchdog] re-spawned agent ${newAgentId} for job ${job.id}`);
  }

  // ── Check 3: MCP-disconnected agents (not in wait_for_jobs) ────────────────
  // When an MCP session closes and the agent was NOT in wait_for_jobs, it's
  // tracked in disconnectedAgents. If the agent hasn't reconnected within the
  // grace period, it's stuck in a sleep-retry loop and should be killed + restarted.
  const MCP_DISCONNECT_GRACE_MS = 120_000; // 2 minutes
  for (const [agentId, disconnectedAt] of disconnectedAgents) {
    if (Date.now() - disconnectedAt < MCP_DISCONNECT_GRACE_MS) continue;

    // Agent reconnected? Clear and skip
    if (hasActiveTransport(agentId)) {
      disconnectedAgents.delete(agentId);
      continue;
    }

    const agent = queries.getAgentById(agentId);
    if (!agent || agent.status !== 'running') {
      disconnectedAgents.delete(agentId);
      continue;
    }

    const job = queries.getJobById(agent.job_id);
    if (!job || TERMINAL.includes(job.status)) {
      disconnectedAgents.delete(agentId);
      continue;
    }

    const stuckMs = Date.now() - disconnectedAt;
    console.warn(`[watchdog] agent ${agentId} MCP-disconnected ${Math.round(stuckMs / 1000)}s without reconnecting — killing and restarting job ${job.id}`);
    disconnectedAgents.delete(agentId);
    if (!claimRecovery(job, 'watchdog-mcp-disconnect-restart')) continue;

    // Kill the session/process
    if (isTmuxSessionAlive(agentId)) {
      saveSnapshot(agentId);
      try { execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agentId}`], { stdio: 'pipe' }); } catch { /* already gone */ }
    }
    if (agent.pid != null) killProcess(agent.pid);

    // Mark old agent failed
    queries.updateAgent(agent.id, {
      status: 'failed',
      error_message: `MCP connection lost (not in wait_for_jobs); watchdog restarted after ${Math.round(stuckMs / 1000)}s.`,
      finished_at: Date.now(),
    });
    queries.updateJobStatus(agent.job_id, 'failed');
    getFileLockRegistry().releaseAll(agent.id);

    const pendingQ = queries.getPendingQuestion(agent.id);
    if (pendingQ) {
      queries.updateQuestion(pendingQ.id, {
        status: 'timeout',
        answer: '[TIMEOUT] MCP connection lost; watchdog restarted agent.',
        answered_at: Date.now(),
      });
    }

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);

    // Re-queue with a new agent
    const newAgentId = randomUUID();
    queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
    queries.updateJobStatus(job.id, 'assigned');

    const newAgentWithJob = queries.getAgentWithJob(newAgentId);
    if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
    const updatedJob = queries.getJobById(job.id);
    if (updatedJob) socket.emitJobUpdate(updatedJob);

    if (job.is_interactive) {
      startInteractiveAgent({ agentId: newAgentId, job });
    } else {
      runAgent({ agentId: newAgentId, job, resumeSessionId: agent.session_id ?? undefined });
    }
    console.log(`[watchdog] re-spawned agent ${newAgentId} for job ${job.id} (MCP disconnect recovery)`);
  }

  // ── Check 4: Job/agent inconsistency ───────────────────────────────────────
  // A job is in a terminal state but an agent row still shows 'running'.
  for (const agent of queries.listAllRunningAgents()) {
    const job = queries.getJobById(agent.job_id);
    if (!job || !TERMINAL.includes(job.status)) continue;

    console.warn(
      `[watchdog] inconsistency: agent ${agent.id} is 'running' but job ${agent.job_id} is '${job.status}' — cleaning up`
    );

    if (agent.pid) killProcess(agent.pid);

    queries.updateAgent(agent.id, {
      status: job.status === 'done' ? 'done' : 'failed',
      error_message: `Watchdog: job was '${job.status}' while agent still showed running.`,
      finished_at: Date.now(),
    });
    getFileLockRegistry().releaseAll(agent.id);

    const updatedAgent = queries.getAgentWithJob(agent.id);
    if (updatedAgent) socket.emitAgentUpdate(updatedAgent);

    // Trigger workflow/debate state machines so the workflow doesn't get orphaned.
    // Without this, a job that failed (and was cleaned up here) would leave its
    // parent workflow stuck in 'running' with no active job forever.
    try { socket.emitJobUpdate(job); } catch (err) { console.error(`[watchdog] Check 4 emitJobUpdate error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'StuckJobWatchdog' }); }
    try { debateOnJobCompleted(job); } catch (err) { console.error(`[watchdog] Check 4 debateOnJobCompleted error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'StuckJobWatchdog' }); }
    try { workflowOnJobCompleted(job); } catch (err) { console.error(`[watchdog] Check 4 workflowOnJobCompleted error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'StuckJobWatchdog' }); }
    if (job.status === 'failed') {
      try { handleRetry(job, agent.id); } catch (err) { console.error(`[watchdog] Check 4 handleRetry error:`, err); captureWithContext(err, { agent_id: agent.id, job_id: job.id, component: 'StuckJobWatchdog' }); }
    }
  }

  // ── Check 6: Debates stuck in 'running' with no active jobs ─────────────────
  // Can happen when the server restarts after debate jobs finish but before the
  // state machine fires — recovery skips agents already in a terminal state so
  // the debate record is never advanced.
  for (const debate of queries.listDebates()) {
    if (debate.status !== 'running') continue;

    const debateJobs = queries.getJobsForDebate(debate.id);
    if (debateJobs.length === 0) continue; // not started yet

    const ACTIVE = ['queued', 'assigned', 'running'];
    const hasActiveJob = debateJobs.some(j => ACTIVE.includes(j.status));
    if (hasActiveJob) continue; // still working normally

    // All jobs terminal but debate is still 'running' — re-trigger state machine
    // using the last job in the current loop so the transition logic can fire.
    const currentLoopJobs = debateJobs.filter(j => j.debate_loop === debate.current_loop);
    if (currentLoopJobs.length === 0) continue;

    const lastJob = currentLoopJobs[currentLoopJobs.length - 1];
    console.warn(`[watchdog] debate ${debate.id} stuck in 'running' with no active jobs — re-triggering state machine via job ${lastJob.id.slice(0, 8)}`);
    try { debateOnJobCompleted(lastJob); } catch (err) { console.error(`[watchdog] stuck-debate recovery error for debate ${debate.id}:`, err); captureWithContext(err, { job_id: lastJob.id, component: 'StuckJobWatchdog' }); }
  }

  // ── Check 5: Rate-limited agents in tmux ──────────────────────────────────
  // Scan all orchestrator tmux sessions for rate limit errors (429/529).
  // When detected, mark the model as rate-limited, kill the stuck agent,
  // and restart the job with a fallback model.
  const RATE_LIMIT_STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes stuck on rate limit
  try {
    const sessionsRaw = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    for (const session of sessionsRaw.split('\n')) {
      if (!session.startsWith('orchestrator-')) continue;
      const agentId = session.replace('orchestrator-', '');

      const agent = queries.getAgentById(agentId);
      if (!agent) continue;
      // Check agents that are running OR were marked failed by PTY posix_spawnp
      // (those are actually running in tmux despite the DB status)
      if (!['running', 'starting', 'failed'].includes(agent.status)) continue;

      const job = queries.getJobById(agent.job_id);
      if (!job) continue;
      // Skip if job is already terminal and agent isn't in the PTY-failed state
      if (TERMINAL.includes(job.status) && agent.status !== 'failed') continue;

      let output: string;
      try {
        output = execFileSync('tmux', [
          'capture-pane', '-t', session, '-p', '-S', '-30',
        ], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { continue; }

      const failureKind = classifyFailureText(output);
      if (!isFallbackEligibleFailure(failureKind)) continue;

      // Check how long the agent has been stuck (last MCP heartbeat)
      const stuckMs = Date.now() - agent.updated_at;
      if (stuckMs < RATE_LIMIT_STUCK_THRESHOLD_MS) continue;

      const currentModel = job.model ?? null;
      if (!currentModel) continue;

      markModelRateLimited(currentModel, 5 * 60 * 1000);
      if (shouldMarkProviderUnavailable(failureKind)) {
        markProviderRateLimited(getModelProvider(currentModel), 5 * 60 * 1000);
      }
      const fallbackModel = getFallbackModel(currentModel);

      if (fallbackModel === currentModel) {
        console.log(`[watchdog] agent ${agentId.slice(0, 8)} hit ${failureKind} on ${currentModel} but no fallback available — letting it retry`);
        continue;
      }

      console.warn(`[watchdog] agent ${agentId.slice(0, 8)} stuck on ${failureKind} (${currentModel}, ${Math.round(stuckMs / 60000)}min) → restarting with ${fallbackModel}`);

      saveSnapshot(agentId);
      try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' }); } catch { /* already gone */ }

      queries.updateAgent(agentId, {
        status: 'failed',
        error_message: `Provider failure (${failureKind}) on ${currentModel}; watchdog restarting with ${fallbackModel}.`,
        finished_at: Date.now(),
      });
      getFileLockRegistry().releaseAll(agentId);

      // Update the job's model and re-queue it
      queries.updateJobModel(job.id, fallbackModel);
      queries.updateJobStatus(job.id, 'queued');
      const updatedJob = queries.getJobById(job.id);
      if (updatedJob) socket.emitJobUpdate(updatedJob);
      const updatedAgent = queries.getAgentWithJob(agentId);
      if (updatedAgent) socket.emitAgentUpdate(updatedAgent);
      nudgeQueue();

      console.log(`[watchdog] re-queued job "${job.title}" with model ${fallbackModel}`);
    }
  } catch (err: any) {
    if (!err.message?.includes('no server running')) {
      console.warn('[watchdog] rate-limit scan error:', err.message);
    }
  }

  // ── Check 9: Slow-progress detection for workflow implement agents ─────────
  // Track milestone progress over time for workflow agents in the implement phase.
  // If no milestone progress for 15 min → warning; 30 min → block.
  {
    const seenWorkflows = new Set<string>();
    for (const agent of queries.listAllRunningAgents()) {
      const job = queries.getJobById(agent.job_id);
      if (!job?.workflow_id || job.workflow_phase !== 'implement') continue;
      if (seenWorkflows.has(job.workflow_id)) continue;
      seenWorkflows.add(job.workflow_id);

      const workflow = queries.getWorkflowById(job.workflow_id);
      if (!workflow || workflow.status !== 'running') {
        // Workflow completed/cancelled/blocked — clean up snapshot
        _milestoneSnapshots.delete(job.workflow_id);
        continue;
      }

      // Read real-time milestone count from the plan note (NOT workflow.milestones_done which is stale)
      const planNote = queries.getNote(`workflow/${job.workflow_id}/plan`);
      if (!planNote?.value) {
        // Plan note missing (e.g., during repair job rewrite or race condition).
        // Clear any existing snapshot to prevent stale checkedAt from triggering
        // a false warning/block when the plan note reappears.
        const existingSnapshot = _milestoneSnapshots.get(job.workflow_id);
        if (existingSnapshot) {
          logResilienceEvent('slow_progress_snapshot_cleared', 'workflow', job.workflow_id, {
            reason: 'plan_note_missing',
            stale_checked_at: existingSnapshot.checkedAt,
            stale_milestones_done: existingSnapshot.milestonesDone,
          });
          _milestoneSnapshots.delete(job.workflow_id);
        }
        continue;
      }
      const { done: currentDone } = parseMilestones(planNote.value);

      const snapshot = _milestoneSnapshots.get(job.workflow_id);
      if (!snapshot) {
        // First observation — record baseline and skip
        _milestoneSnapshots.set(job.workflow_id, { milestonesDone: currentDone, checkedAt: Date.now() });
        continue;
      }

      // Milestone count changed (progress or plan rewrite) — reset snapshot
      if (currentDone !== snapshot.milestonesDone) {
        _milestoneSnapshots.set(job.workflow_id, { milestonesDone: currentDone, checkedAt: Date.now() });
        continue;
      }

      // No progress — check if agent is actually active (updated within last 5 min)
      const agentIdleMs = Date.now() - agent.updated_at;
      if (agentIdleMs > SLOW_PROGRESS_ACTIVE_MS) continue; // agent isn't active, idle detection handles this

      const stalledMs = Date.now() - snapshot.checkedAt;

      if (stalledMs >= SLOW_PROGRESS_BLOCK_MS) {
        // 30 min without progress — block the workflow
        console.warn(`[watchdog] workflow ${job.workflow_id.slice(0, 8)} implement agent active but 0 milestone progress for ${Math.round(stalledMs / 60000)}min — blocking`);
        queries.updateWorkflow(job.workflow_id, {
          status: 'blocked',
          blocked_reason: `Slow progress: implement agent active for ${Math.round(stalledMs / 60000)}min with no milestone advancement (${currentDone} milestones done). Manual review needed.`,
        });
        const updatedWorkflow = queries.getWorkflowById(job.workflow_id);
        if (updatedWorkflow) {
          try { socket.emitWorkflowUpdate(updatedWorkflow); } catch { /* ignore */ }
        }
        logResilienceEvent('slow_progress_block', 'workflow', job.workflow_id, {
          agent_id: agent.id,
          stalled_ms: stalledMs,
          milestones_done: currentDone,
        });
        _milestoneSnapshots.delete(job.workflow_id);
      } else if (stalledMs >= SLOW_PROGRESS_WARN_MS) {
        // 15 min without progress — emit warning (deduplicated)
        if (!queries.hasUndismissedWarning(agent.id, 'slow_progress')) {
          console.warn(`[watchdog] workflow ${job.workflow_id.slice(0, 8)} implement agent active but 0 milestone progress for ${Math.round(stalledMs / 60000)}min — warning`);
          const warning = queries.insertWarning({
            id: randomUUID(),
            agent_id: agent.id,
            type: 'slow_progress',
            message: `Implement agent active for ${Math.round(stalledMs / 60000)}min with no milestone progress (${currentDone} done). May be stuck in a loop.`,
          });
          try { socket.emitWarningNew(warning); } catch { /* ignore */ }
          logResilienceEvent('slow_progress_warning', 'workflow', job.workflow_id, {
            agent_id: agent.id,
            stalled_ms: stalledMs,
            milestones_done: currentDone,
          });
        }
      }
    }

    // Clean up snapshots for workflows that no longer have running implement agents
    for (const workflowId of _milestoneSnapshots.keys()) {
      if (!seenWorkflows.has(workflowId)) {
        _milestoneSnapshots.delete(workflowId);
      }
    }
  }

  // ── Check 4: Orphaned locks from terminal agents ────────────────────────────
  const orphaned = queries.getActiveLocksForTerminalAgents();
  if (orphaned.length > 0) {
    const agentIds = [...new Set(orphaned.map(l => l.agent_id))];
    console.warn(`[watchdog] releasing ${orphaned.length} orphaned lock(s) from ${agentIds.length} terminal agent(s): [${agentIds.map(id => id.slice(0, 6)).join(', ')}]`);
    for (const agentId of agentIds) {
      getFileLockRegistry().releaseAll(agentId);
    }
  }

  // ── Check 7: TTL-expired locks cleanup ─────────────────────────────────────
  // Locks whose TTL has expired are no longer enforced (getActiveLocksForFile
  // filters by expires_at > now), but the unreleased DB rows linger. Clean them
  // up to prevent DB bloat and stale UI display.
  const expired = queries.getExpiredUnreleasedLocks();
  if (expired.length > 0) {
    const agentIds = [...new Set(expired.map(l => l.agent_id))];
    console.log(`[watchdog] cleaning ${expired.length} TTL-expired lock(s) from ${agentIds.length} agent(s)`);
    for (const lock of expired) {
      queries.releaseLock(lock.id);
      socket.emitLockReleased(lock.id, lock.file_path);
    }
  }

  // ── Check 8: Zombie process cleanup ───────────────────────────────────────
  // Detect and kill OS processes whose parent agent record is in a terminal state.
  // This catches leaked child processes that survived agent teardown (e.g. detached
  // subprocesses, orphaned tmux sessions from crashed agents).
  cleanupZombieProcesses();
}

/**
 * Find tmux sessions named orchestrator-* that don't correspond to any running agent,
 * and kill any OS processes whose agent is in a terminal state.
 */
function cleanupZombieProcesses(): void {
  try {
    const sessionsRaw = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!sessionsRaw) return;

    for (const session of sessionsRaw.split('\n')) {
      if (!session.startsWith('orchestrator-')) continue;
      const agentId = session.replace('orchestrator-', '');

      const agent = queries.getAgentById(agentId);
      if (!agent) {
        // No agent record at all — orphaned tmux session
        console.warn(`[watchdog] zombie tmux session ${session} — no matching agent record, killing`);
        try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' }); } catch { /* already gone */ }
        continue;
      }

      // Agent exists but is in a terminal state — session should have been cleaned up
      if (['done', 'failed', 'cancelled'].includes(agent.status)) {
        console.warn(`[watchdog] zombie tmux session ${session} — agent is ${agent.status}, killing`);
        try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' }); } catch { /* already gone */ }
      }
    }
  } catch (err: any) {
    if (!err.message?.includes('no server running')) {
      // tmux not running or not installed — that's fine
    }
  }

  // Also check for zombie PIDs: agents in terminal state that still have a live PID
  try {
    const allAgents = queries.listAgents();
    for (const agent of allAgents) {
      if (!['done', 'failed', 'cancelled'].includes(agent.status)) continue;
      if (agent.pid == null) continue;

      try {
        process.kill(agent.pid, 0); // check if alive
        // Still alive — this is a zombie
        console.warn(`[watchdog] zombie process PID ${agent.pid} for terminal agent ${agent.id.slice(0, 8)} (${agent.status}) — killing`);
        try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* not a process group */ }
        try { process.kill(agent.pid, 'SIGTERM'); } catch { /* already gone */ }
        queries.updateAgent(agent.id, { pid: null });
        // Schedule SIGKILL as fallback
        setTimeout(() => {
          try {
            process.kill(agent.pid!, 0);
            try { process.kill(-agent.pid!, 'SIGKILL'); } catch { /* ignore */ }
            try { process.kill(agent.pid!, 'SIGKILL'); } catch { /* ignore */ }
          } catch { /* already gone */ }
        }, 5_000).unref();
      } catch (err: any) {
        if (err?.code === 'ESRCH') {
          queries.updateAgent(agent.id, { pid: null });
        }
      }
    }
  } catch (err) {
    console.warn('[watchdog] zombie PID scan error:', err);
  }
}

export function startWatchdog(): void {
  console.log('[watchdog] started (interval: 30s)');
  // Run once immediately to catch anything from startup
  try { check(); } catch (err) { console.error('[watchdog] initial check error:', err); captureWithContext(err, { component: 'StuckJobWatchdog' }); }
  _timer = setInterval(() => {
    try { check(); } catch (err) { console.error('[watchdog] check error:', err); captureWithContext(err, { component: 'StuckJobWatchdog' }); }
  }, WATCHDOG_INTERVAL_MS);
}

export function stopWatchdog(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Exposed for test isolation — clears the milestone snapshot map. */
export function _resetMilestoneSnapshotsForTest(): void {
  _milestoneSnapshots.clear();
}

/** Exposed for tests — read-only access to snapshot map. */
export function _getMilestoneSnapshotsForTest(): Map<string, { milestonesDone: number; checkedAt: number }> {
  return _milestoneSnapshots;
}
