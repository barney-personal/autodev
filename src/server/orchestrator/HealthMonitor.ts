import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { estimateCostUsd } from './CostEstimator.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import { onJobCompleted as workflowOnJobCompleted } from './WorkflowManager.js';
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
  _timer = setInterval(() => { try { tick(); } catch (err) { console.error('[health] tick error:', err); captureWithContext(err, { component: 'HealthMonitor' }); } }, TICK_INTERVAL_MS);
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
          // Before warning, check if the tmux session shows active work.
          // Claude Code displays a spinner/progress indicator while thinking.
          // If the tmux pane has recent activity, the agent is likely thinking, not stuck.
          const isThinking = isTmuxActive(agent.id);
          if (!isThinking && !queries.hasUndismissedWarning(agent.id, 'stalled')) {
            const mins = Math.round(gap / 60_000);
            emitWarning(agent.id, 'stalled', `No output for ${mins} minutes (no tmux activity detected)`);
          } else if (isThinking && queries.hasUndismissedWarning(agent.id, 'stalled')) {
            // Agent resumed activity — dismiss stale stall warning
            queries.dismissWarningsByType(agent.id, 'stalled');
            const agentWithJob = queries.getAgentWithJob(agent.id);
            if (agentWithJob) try { socket.emitAgentUpdate(agentWithJob); } catch (err) { console.debug('[health] socket emit failed after dismissing stall warning (agent resumed):', err); }
          }
        } else if (queries.hasUndismissedWarning(agent.id, 'stalled')) {
          // Activity is recent — dismiss any stale stall warning
          queries.dismissWarningsByType(agent.id, 'stalled');
          const agentWithJob = queries.getAgentWithJob(agent.id);
          if (agentWithJob) try { socket.emitAgentUpdate(agentWithJob); } catch (err) { console.debug('[health] socket emit failed after dismissing stall warning (activity detected):', err); }
        }
      }
    }

    // High turns: approaching max_turns
    const maxTurns = job.max_turns ?? 50;
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

    // ── Token tracking for PTY agents ──────────────────────────────────
    // NDJSON agents get token counts from stream events, but tmux/PTY agents
    // don't. Scrape the cost from tmux pane content where Claude Code outputs
    // cost summaries like "Total cost: $1.23" or "Cost: $0.45".
    if ((agent.estimated_input_tokens ?? 0) === 0 && (agent.estimated_output_tokens ?? 0) === 0) {
      const tmuxCost = extractCostFromTmux(agent.id);
      if (tmuxCost !== null) {
        // Store as cost_usd directly rather than token counts — more accurate for PTY agents
        queries.updateAgent(agent.id, { cost_usd: tmuxCost });
      }
    }

    // ── Budget enforcement (stop_mode === 'budget') ──────────────────────
    const stopMode: StopMode = job.stop_mode ?? 'turns';
    const stopValue: number | null = job.stop_value ?? null;

    if (stopMode === 'budget' && stopValue != null) {
      // Use direct cost_usd if available (from PTY scraping), otherwise estimate from tokens
      const agentRec = queries.getAgentById(agent.id);
      let estimated: number;
      if (agentRec?.cost_usd != null && agentRec.cost_usd > 0) {
        estimated = agentRec.cost_usd;
      } else {
        const inputTokens = agent.estimated_input_tokens ?? 0;
        const outputTokens = agent.estimated_output_tokens ?? 0;
        const model: string | null = job.model ?? null;
        estimated = estimateCostUsd(model, inputTokens, outputTokens);
      }
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

    // ── Question timeout enforcement ────────────────────────────────────
    // If an agent is waiting for a user answer that has exceeded its timeout,
    // auto-timeout the question so the agent can resume or fail gracefully.
    if (agent.status === 'waiting_user') {
      const pendingQ = queries.getPendingQuestion(agent.id);
      if (pendingQ && pendingQ.asked_at + pendingQ.timeout_ms < now) {
        console.log(`[health] question ${pendingQ.id} for agent ${agent.id.slice(0, 6)} timed out after ${Math.round(pendingQ.timeout_ms / 60_000)}min`);
        queries.updateQuestion(pendingQ.id, {
          status: 'timeout',
          answer: '[TIMEOUT] No response received within the time limit.',
          answered_at: now,
        });
        if (!queries.hasUndismissedWarning(agent.id, 'question_timeout')) {
          emitWarning(agent.id, 'question_timeout', `User question timed out after ${Math.round(pendingQ.timeout_ms / 60_000)} minutes`);
        }
      }
    }
  }
}

/**
 * Gracefully stop an agent that has hit a budget or time limit.
 * Sends SIGTERM first to allow the agent to commit work-in-progress,
 * then SIGKILL after a grace period if it hasn't exited.
 * Marks as done (not failed) — the limit was expected, not an error.
 */
const GRACEFUL_KILL_TIMEOUT_MS = 15_000; // 15s grace after SIGTERM before SIGKILL

function killAgentGracefully(agentId: string, reason: string): void {
  const agent = queries.getAgentById(agentId);
  if (!agent) return;

  // Send SIGTERM first to let the agent clean up (commit, release locks, etc.)
  if (agent.pid != null) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch { /* already gone */ }

    // Schedule a SIGKILL if the process doesn't exit within the grace period
    setTimeout(() => {
      try {
        // Check if still alive
        process.kill(agent.pid!, 0);
        // Still running — force kill
        console.warn(`[health] agent ${agentId.slice(0, 6)} didn't exit after SIGTERM — sending SIGKILL`);
        try { process.kill(-agent.pid!, 'SIGKILL'); } catch { /* process group gone */ }
        try { process.kill(agent.pid!, 'SIGKILL'); } catch { /* already gone */ }
      } catch {
        // Process already exited — nothing to do
      }
    }, GRACEFUL_KILL_TIMEOUT_MS).unref();
  }

  // Also kill tmux session if present
  try {
    execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agentId}`], { stdio: 'pipe' });
  } catch { /* session doesn't exist or already gone */ }

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
    try { socket.emitAgentUpdate(agentWithJob); } catch (err) { console.debug('[health] socket emit failed for agent update after graceful kill:', err); }
  }
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) {
    try { socket.emitJobUpdate(updatedJob); } catch (err) { console.debug('[health] socket emit failed for job update after graceful kill:', err); }
    // Trigger workflow/debate handlers so phases advance immediately
    try { debateOnJobCompleted(updatedJob); } catch (err) { console.debug('[health] debateOnJobCompleted error after graceful kill:', err); }
    try { workflowOnJobCompleted(updatedJob); } catch (err) { console.debug('[health] workflowOnJobCompleted error after graceful kill:', err); }
  }

  console.log(`[health] agent ${agentId.slice(0, 6)} stopped: ${reason}`);
}

/**
 * Extract cost from tmux pane content for PTY agents.
 * Claude Code displays cost info like "$1.23" or "Total cost: $0.45" in its output.
 * Returns the highest dollar amount found, or null if none found.
 */
function extractCostFromTmux(agentId: string): number | null {
  const sessionName = `orchestrator-${agentId}`;
  try {
    // Capture the last 50 lines of the tmux pane (cost summary appears near the end)
    const output = execFileSync('tmux', [
      'capture-pane', '-t', sessionName, '-p', '-S', '-50',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });

    if (!output) return null;

    // Look for cost patterns: "$X.XX", "cost: $X.XX", "Total cost: $X.XX"
    // Claude Code displays: "Total cost: $X.XX" at the end of a session
    const costPattern = /\$(\d+\.?\d*)/g;
    let maxCost: number | null = null;

    for (const match of output.matchAll(costPattern)) {
      const cost = parseFloat(match[1]);
      if (!isNaN(cost) && cost > 0 && (maxCost === null || cost > maxCost)) {
        maxCost = cost;
      }
    }

    return maxCost;
  } catch {
    // tmux command failed or session not found — cost scraping is best-effort
    return null;
  }
}

/**
 * Check if a tmux session shows recent activity by comparing the last few lines
 * of the pane content. Claude Code shows a spinner/progress indicator while
 * thinking, which changes the pane content even when no MCP calls are made.
 * Returns true if the pane seems active (non-empty, contains typical Claude
 * Code indicators like spinners, progress bars, or tool calls).
 */
const _lastTmuxHash = new Map<string, string>();

function isTmuxActive(agentId: string): boolean {
  const sessionName = `orchestrator-${agentId}`;
  try {
    // Capture the last 5 lines of the tmux pane
    const output = execFileSync('tmux', [
      'capture-pane', '-t', sessionName, '-p', '-S', '-5',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });

    const trimmed = output.trim();
    if (!trimmed) return false;

    // Compare with last capture — if content changed, the session is active
    const prevHash = _lastTmuxHash.get(agentId);
    _lastTmuxHash.set(agentId, trimmed);

    if (prevHash === undefined) return true; // first check, assume active
    return prevHash !== trimmed;
  } catch {
    // tmux session not found or command failed
    return false;
  }
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
  } catch (err) { console.debug('[health] socket emit failed for emitWarningNew (socket may not be ready):', err); }
  // Also refresh the agent card so the badge appears
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) {
    try { socket.emitAgentUpdate(agentWithJob); } catch (err) { console.debug('[health] socket emit failed for agent card update in emitWarning:', err); }
  }
  console.log(`[health] warning for agent ${agentId.slice(0, 6)}: [${type}] ${message}`);
}
