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

const WATCHDOG_INTERVAL_MS = 30_000;

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
        const isStuckCandidate = idleJob && !idleJob.is_interactive && !isAutoExitJob(idleJob as any);
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
                console.log(`[watchdog] scheduled next repeat for idle job "${idleJobFresh.title}"`);
              } catch (err) { console.error(`[watchdog] scheduleRepeatJob error:`, err); }
            }
            if (idleJobFresh.status === 'failed') {
              try { handleRetry(idleJobFresh, agent.id); } catch (err) { console.error(`[watchdog] handleRetry error:`, err); }
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
      const isDebateStage = job ? isAutoExitJob(job as any) : false;
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
      try { socket.emitJobUpdate(updatedJob); } catch (err) { console.error(`[watchdog] emitJobUpdate error:`, err); }
      try { debateOnJobCompleted(updatedJob); } catch (err) { console.error(`[watchdog] debateOnJobCompleted error:`, err); }
      try { workflowOnJobCompleted(updatedJob); } catch (err) { console.error(`[watchdog] workflowOnJobCompleted error:`, err); }
      // For repeat jobs (e.g. Eye cycles), schedule the next run so the cycle continues
      if (updatedJob.repeat_interval_ms) {
        try {
          const nextJob = queries.scheduleRepeatJob(updatedJob);
          socket.emitJobNew(nextJob);
          console.log(`[watchdog] scheduled next repeat for job "${updatedJob.title}" (${updatedJob.id})`);
        } catch (err) { console.error(`[watchdog] scheduleRepeatJob error:`, err); }
      }
      // Invoke retry policy for failed jobs
      if (updatedJob.status === 'failed') {
        try {
          handleRetry(updatedJob, agent.id);
        } catch (err) { console.error(`[watchdog] handleRetry error for job ${agent.job_id}:`, err); }
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
    try { debateOnJobCompleted(lastJob); } catch (err) { console.error(`[watchdog] stuck-debate recovery error for debate ${debate.id}:`, err); }
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
}

export function startWatchdog(): void {
  console.log('[watchdog] started (interval: 30s)');
  // Run once immediately to catch anything from startup
  try { check(); } catch (err) { console.error('[watchdog] initial check error:', err); }
  _timer = setInterval(() => {
    try { check(); } catch (err) { console.error('[watchdog] check error:', err); }
  }, WATCHDOG_INTERVAL_MS);
}

export function stopWatchdog(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
