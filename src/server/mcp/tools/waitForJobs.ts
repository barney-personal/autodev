import { z } from 'zod';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';
import { onAnyTerminal } from '../../orchestrator/JobCompletionNotifier.js';
import type { JobStatus } from '../../../shared/types.js';

export const waitForJobsSchema = z.object({
  job_ids: z.array(z.string()).describe('Job IDs to wait for'),
  timeout_ms: z.number().optional().describe('Max wait time in ms (default: 1800000 = 30 min)'),
});

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];
// rmcp (Codex CLI's Rust MCP client) has a hardcoded 120s timeout for all tool
// calls. Cap each wait_for_jobs call to 90s so we always return before that
// limit fires. Codex agents are expected to retry for still-pending jobs.
const MAX_SINGLE_WAIT_MS = 90_000;
const POLL_SEQUENCE_MS = [500, 1000, 2000, 3000, 5000] as const;

/**
 * In-memory registry of active wait_for_jobs calls: agentId → job_ids[].
 * Used by StuckJobWatchdog and McpServer to detect agents stuck waiting when
 * their MCP connection drops.
 */
export const activeWaits = new Map<string, string[]>();

/** AbortControllers for in-flight wait_for_jobs loops, keyed by agentId. */
const activeWaitAborts = new Map<string, AbortController>();

/**
 * Abort the wait_for_jobs loop for the given agent (e.g. when MCP session closes).
 * No-op if the agent has no active wait.
 */
export function abortAgentWait(agentId: string): void {
  activeWaitAborts.get(agentId)?.abort();
}

export function nextWaitPollMs(iteration: number): number {
  const idx = Math.min(Math.max(iteration, 0), POLL_SEQUENCE_MS.length - 1);
  return POLL_SEQUENCE_MS[idx];
}

export async function waitForJobsHandler(
  agentId: string,
  input: z.infer<typeof waitForJobsSchema>,
): Promise<string> {
  const { job_ids, timeout_ms = 1800000 } = input;

  if (job_ids.length === 0) {
    return JSON.stringify({ error: 'job_ids must not be empty' });
  }

  // Abort any previous wait for this agent (e.g. rmcp timed out and retried)
  // before setting new state, to prevent zombie handlers with orphaned abort controllers.
  abortAgentWait(agentId);

  console.log(`[wait_for_jobs] agent ${agentId} starting — waiting for ${job_ids.length} jobs: [${job_ids.join(', ')}]`);
  activeWaits.set(agentId, job_ids);
  // Persist to DB so recovery can re-register the orphaned wait after a server restart
  queries.updateAgent(agentId, { pending_wait_ids: JSON.stringify(job_ids) });

  // Cap to MAX_SINGLE_WAIT_MS to stay under rmcp's 120s tool-call timeout.
  // If jobs aren't done yet, we return their current statuses and the agent retries.
  const deadline = Date.now() + Math.min(timeout_ms, MAX_SINGLE_WAIT_MS);
  const abortCtrl = new AbortController();
  activeWaitAborts.set(agentId, abortCtrl);

  // Update status message while waiting
  const updateStatus = (pending: number) => {
    const msg = `Waiting for ${pending} sub-job${pending !== 1 ? 's' : ''} to complete…`;
    queries.updateAgent(agentId, { status_message: msg });
    const agentWithJob = queries.getAgentWithJob(agentId);
    if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
  };

  updateStatus(job_ids.length);
  let lastReportedPending = job_ids.length;
  let iteration = 0;

  try {
    while (Date.now() < deadline && !abortCtrl.signal.aborted) {
      const jobs = job_ids.map(id => queries.getJobById(id));
      const missing = job_ids.filter((_, i) => !jobs[i]);
      if (missing.length > 0) {
        return JSON.stringify({ error: `Unknown job IDs: ${missing.join(', ')}` });
      }

      const pending = jobs.filter(j => !TERMINAL.includes(j!.status));
      if (pending.length === 0) {
        // All done — clear status and pending wait IDs, build results
        queries.updateAgent(agentId, { status_message: null, pending_wait_ids: null });
        const agentWithJob = queries.getAgentWithJob(agentId);
        if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

        const results = jobs.map(j => {
          const job = j!;
          // Get the most recent agent for this job
          const agents = queries.getAgentsWithJobByJobId(job.id);
          const latestAgent = agents[0] ?? null;
          return {
            job_id: job.id,
            title: job.title,
            status: job.status,
            work_dir: job.work_dir ?? null,
            result_text: latestAgent ? queries.getAgentResultText(latestAgent.id) : null,
            // Omit diff — it can be hundreds of KB per job, and a multi-job
            // wait can produce a multi-MB SSE event that causes delivery failures.
            // Agents that need the diff can query the job directly.
          };
        });

        console.log(`[wait_for_jobs] agent ${agentId} — all ${job_ids.length} jobs complete`);
        return JSON.stringify(results);
      }

      // Only emit a status update when the pending count changes — avoids hammering
      // SQLite + Socket.IO on every 2-second tick when nothing has changed.
      if (pending.length !== lastReportedPending) {
        updateStatus(pending.length);
        lastReportedPending = pending.length;
      }

      // Race the fallback poll sleep against an event-driven wakeup so we
      // observe terminal transitions within milliseconds instead of waiting
      // for the next poll interval.
      const pendingIds = pending.map(j => j!.id);
      const wakeup = onAnyTerminal(pendingIds);
      const waitMs = nextWaitPollMs(iteration++);
      const jitterMs = Math.floor(Math.random() * 500);
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, waitMs + jitterMs)),
        wakeup.promise,
      ]);
      wakeup.cancel(); // clean up listeners if the sleep won the race
    }

    // Aborted (MCP connection closed) — exit silently; McpServer will track for recovery
    if (abortCtrl.signal.aborted) {
      console.log(`[wait_for_jobs] agent ${agentId} — aborted (MCP connection closed)`);
      // Leave pending_wait_ids set so recovery.ts can re-register the orphaned wait
      return JSON.stringify({ error: 'MCP connection closed while waiting' });
    }

    // Hit the 90s cap (or the caller's timeout). Return current statuses so the
    // agent can see which jobs finished and retry wait_for_jobs for the rest.
    queries.updateAgent(agentId, { status_message: null, pending_wait_ids: null });
    const agentWithJob = queries.getAgentWithJob(agentId);
    if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

    const jobs = job_ids.map(id => queries.getJobById(id));
    const stillPending = jobs.filter(j => j && !TERMINAL.includes(j!.status)).map(j => j!.id);
    console.log(`[wait_for_jobs] agent ${agentId} — returning after cap; ${stillPending.length} still pending: [${stillPending.join(', ')}]`);

    const results = jobs.map(j => {
      if (!j) return { job_id: null, status: 'unknown', work_dir: null, result_text: null };
      const agents = queries.getAgentsWithJobByJobId(j.id);
      const latestAgent = agents[0] ?? null;
      return {
        job_id: j.id,
        title: j.title,
        status: j.status,
        work_dir: j.work_dir ?? null,
        result_text: TERMINAL.includes(j.status) && latestAgent
          ? queries.getAgentResultText(latestAgent.id)
          : null,
      };
    });
    const stillPendingIds = jobs
      .filter(j => j && !TERMINAL.includes(j!.status))
      .map(j => j!.id);
    return JSON.stringify({
      timeout: true,
      message: stillPendingIds.length > 0
        ? `Timeout reached. ${stillPendingIds.length} job(s) still pending. You MUST call wait_for_jobs again with still_pending_ids to continue waiting.`
        : 'Timeout reached. All jobs are now in terminal states.',
      still_pending_ids: stillPendingIds,
      results,
    });
  } finally {
    activeWaits.delete(agentId);
    activeWaitAborts.delete(agentId);
  }
}
