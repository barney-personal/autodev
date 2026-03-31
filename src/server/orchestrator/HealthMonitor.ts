import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { estimateCostUsd } from './CostEstimator.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import type { StopMode } from '../../shared/types.js';

const PTY_LOG_DIR = path.join(process.cwd(), 'data', 'agent-logs');

const TICK_INTERVAL_MS = 30_000;
const STALL_THRESHOLD_MS = 10 * 60 * 1000;  // 10 minutes
const LONG_RUNNING_THRESHOLD_MS = 60 * 60 * 1000;  // 60 minutes
const TURN_WARNING_RATIO = 0.8;  // warn at 80% of max_turns
const LIMIT_WARNING_RATIO = 0.8;  // warn at 80% of budget/time limit

let _timer: NodeJS.Timeout | null = null;

export function startHealthMonitor(): void {
  if (_timer) return;
  console.log('[health] HealthMonitor started');
  _timer = setInterval(() => { try { tick(); } catch (err) { console.error('[health] tick error:', err); } }, TICK_INTERVAL_MS);
}

export function stopHealthMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function tick(): void {
  const agents = queries.listAgents().filter(a =>
    a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user'
  );

  const now = Date.now();

  for (const agent of agents) {
    const job = queries.getJobById(agent.job_id);
    if (!job) continue;

    // Stall detection: no output for > threshold
    // Skip if agent is waiting for user input — silence is expected in that state
    if (agent.status !== 'waiting_user') {
      // Primary: PTY log mtime (covers interactive/tmux agents)
      let lastActivity: number | null = null;
      try {
        const ptyLog = path.join(PTY_LOG_DIR, `${agent.id}.pty`);
        lastActivity = fs.statSync(ptyLog).mtimeMs;
      } catch { /* no PTY log — not an interactive agent */ }

      // Fallback: agent_output DB table (covers --print mode agents)
      if (lastActivity === null) {
        const latestOutput = queries.getLatestAgentOutput(agent.id);
        if (latestOutput) lastActivity = latestOutput.created_at;
      }

      // Last resort: agent start time
      if (lastActivity === null && agent.started_at) {
        lastActivity = agent.started_at;
      }

      if (lastActivity !== null) {
        const gap = now - lastActivity;
        if (gap > STALL_THRESHOLD_MS) {
          if (!queries.hasUndismissedWarning(agent.id, 'stalled')) {
            const mins = Math.round(gap / 60_000);
            emitWarning(agent.id, 'stalled', `No output for ${mins} minutes`);
          }
        } else if (queries.hasUndismissedWarning(agent.id, 'stalled')) {
          // Activity is recent — dismiss any stale stall warning
          queries.dismissWarningsByType(agent.id, 'stalled');
          const agentWithJob = queries.getAgentWithJob(agent.id);
          if (agentWithJob) try { socket.emitAgentUpdate(agentWithJob); } catch { /* ignore */ }
        }
      }
    }

    // High turns: approaching max_turns
    const maxTurns = (job as any).max_turns ?? 50;
    const threshold = Math.floor(maxTurns * TURN_WARNING_RATIO);
    if (agent.num_turns != null && agent.num_turns >= threshold && !queries.hasUndismissedWarning(agent.id, 'high_turns')) {
      emitWarning(agent.id, 'high_turns', `Used ${agent.num_turns}/${maxTurns} turns`);
    }

    // Long running: agent running for > threshold
    if (agent.started_at) {
      const duration = now - agent.started_at;
      if (duration > LONG_RUNNING_THRESHOLD_MS && !queries.hasUndismissedWarning(agent.id, 'long_running')) {
        const mins = Math.round(duration / 60_000);
        emitWarning(agent.id, 'long_running', `Running for ${mins} minutes`);
      }
    }

    // ── Budget enforcement (stop_mode === 'budget') ──────────────────────
    const stopMode: StopMode = (job as any).stop_mode ?? 'turns';
    const stopValue: number | null = (job as any).stop_value ?? null;

    if (stopMode === 'budget' && stopValue != null) {
      const inputTokens = agent.estimated_input_tokens ?? 0;
      const outputTokens = agent.estimated_output_tokens ?? 0;
      const model: string | null = (job as any).model ?? null;
      const estimated = estimateCostUsd(model, inputTokens, outputTokens);
      const ratio = estimated / stopValue;

      if (ratio >= 1.0) {
        console.log(`[health] agent ${agent.id.slice(0, 6)} hit budget limit ($${estimated.toFixed(2)} >= $${stopValue.toFixed(2)}) — stopping gracefully`);
        killAgentGracefully(agent.id, `Budget limit reached ($${estimated.toFixed(2)}/$${stopValue.toFixed(2)})`);
      } else if (ratio >= LIMIT_WARNING_RATIO && !queries.hasUndismissedWarning(agent.id, 'budget_warning')) {
        emitWarning(agent.id, 'budget_warning', `Estimated cost $${estimated.toFixed(2)} (${Math.round(ratio * 100)}% of $${stopValue.toFixed(2)} limit)`);
      }
    }

    // ── Time enforcement (stop_mode === 'time') ──────────────────────────
    if (stopMode === 'time' && stopValue != null && agent.started_at) {
      const limitMs = stopValue * 60 * 1000; // stopValue is in minutes
      const elapsed = now - agent.started_at;
      const ratio = elapsed / limitMs;

      if (ratio >= 1.0) {
        const mins = Math.round(elapsed / 60_000);
        console.log(`[health] agent ${agent.id.slice(0, 6)} hit time limit (${mins}min >= ${stopValue}min) — stopping gracefully`);
        killAgentGracefully(agent.id, `Time limit reached (${mins}/${stopValue} minutes)`);
      } else if (ratio >= LIMIT_WARNING_RATIO && !queries.hasUndismissedWarning(agent.id, 'time_warning')) {
        const mins = Math.round(elapsed / 60_000);
        emitWarning(agent.id, 'time_warning', `Running ${mins} minutes (${Math.round(ratio * 100)}% of ${stopValue}min limit)`);
      }
    }
  }
}

/**
 * Gracefully stop an agent that has hit a budget or time limit.
 * Marks as done (not failed) — the limit was expected, not an error.
 */
function killAgentGracefully(agentId: string, reason: string): void {
  const agent = queries.getAgentById(agentId);
  if (!agent) return;

  // Kill the process
  if (agent.pid != null) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch { /* already gone */ }
  }

  // Mark agent as done with a status message explaining the stop
  queries.updateAgent(agentId, {
    status: 'done',
    status_message: reason,
    finished_at: Date.now(),
  });

  // Mark job as done (limit reached is a successful stop, not a failure)
  queries.updateJobStatus(agent.job_id, 'done');

  // Release all file locks held by this agent
  getFileLockRegistry().releaseAll(agentId);

  // Emit updates
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) {
    try { socket.emitAgentUpdate(agentWithJob); } catch { /* ignore */ }
  }
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) {
    try { socket.emitJobUpdate(updatedJob); } catch { /* ignore */ }
  }

  console.log(`[health] agent ${agentId.slice(0, 6)} stopped: ${reason}`);
}

function emitWarning(agentId: string, type: string, message: string): void {
  const warning = queries.insertWarning({
    id: randomUUID(),
    agent_id: agentId,
    type,
    message,
  });
  try {
    socket.emitWarningNew(warning);
  } catch { /* socket may not be ready */ }
  // Also refresh the agent card so the badge appears
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) {
    try { socket.emitAgentUpdate(agentWithJob); } catch { /* ignore */ }
  }
  console.log(`[health] warning for agent ${agentId.slice(0, 6)}: [${type}] ${message}`);
}
