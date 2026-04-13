/**
 * PtySessionManager — PTY session lifecycle: attach, detach, resize, input, buffers, and tmux management.
 *
 * Extracted from PtyManager to isolate the PTY attach/detach retry loop,
 * onData/onExit handlers, terminal resize, input routing, session liveness
 * checks, and stale tmux session cleanup.
 */

import { spawn as ptySpawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { cancelledAgents, sessionName, getExistingCwd } from './AgentConfig.js';
import { AgentStateManager, AgentState } from './AgentLifecycle.js';
import { handleJobCompletion, startTailing, stopTailing } from './AgentRunner.js';
import type { Job } from '../../shared/types.js';
import { isAutoExitJob } from '../../shared/types.js';
import { markJobRunning } from './JobLifecycle.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { errMsg } from '../../shared/errors.js';
import { checkResources, escalateBackoff, resetBackoff, getBackoffMs } from './PtyResourceManager.js';
import {
  PTY_LOG_DIR,
  getPtyLogPath,
  getSnapshotPath,
  getPtyLogFd,
  closePtyLogFd,
  closeAllPtyLogFds,
  captureTmuxSnapshot,
  saveSnapshot,
  getSnapshot as getSnapshotFromDisk,
} from './PtyDiskLogger.js';
import {
  isStandalonePrintJob,
  detectRateLimitInNdjson,
  flushDebateNdjson,
  stopStandaloneExitPoll,
  standaloneExitPollAgentIds,
  setStandaloneExitPoll,
  finalizeStandalonePrintJob,
  monitorStandalonePrintJobExit,
  _resetJobFinalizerStateForTest,
} from './JobFinalizer.js';
import {
  startInteractiveAgent as _startInteractiveAgentImpl,
} from './AgentSpawner.js';
import type { StartInteractiveOptions, SpawnerContext } from './AgentSpawner.js';

const TMUX = process.env.TMUX_BIN ?? 'tmux';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** agentId -> active PTY instance */
const _ptys = new Map<string, IPty>();

/**
 * Tracks agent lifecycle states (Spawning, Attaching, Running, etc.).
 * Prevents cleanupStaleTmuxSessions from killing sessions that are still starting up.
 */
export const agentStates = new AgentStateManager();

/** Rolling buffer of raw PTY output per agent (capped at PTY_BUFFER_MAX chunks to bound memory) */
const _ptyBuffers = new Map<string, string[]>();
const _pendingResizes = new Map<string, { cols: number; rows: number }>();
const PTY_BUFFER_MAX = 2000;

// PTY spawn resilience constants
export const PTY_SPAWN_MAX_RETRIES = 3;
export const PTY_SPAWN_BASE_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// sessionName and getExistingCwd imported from AgentConfig

function logPtyLifecycleEvent(
  eventType: string,
  agentId: string,
  job: Pick<Job, 'id' | 'title' | 'model' | 'work_dir'>,
  details?: Record<string, unknown>,
): void {
  logResilienceEvent(eventType, 'agent', agentId, {
    job_id: job.id,
    job_title: job.title,
    model: job.model ?? null,
    work_dir: job.work_dir ?? null,
    ndjson_path: path.join(PTY_LOG_DIR, `${agentId}.ndjson`),
    snapshot_path: getSnapshotPath(agentId),
    ...details,
  });
}

// ---------------------------------------------------------------------------
// Session liveness
// ---------------------------------------------------------------------------

export function isTmuxSessionAlive(agentId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PTY buffer
// ---------------------------------------------------------------------------

export function getPtyBuffer(agentId: string): string[] {
  // Always prefer disk log — it has the complete, unbounded history.
  // The in-memory buffer is capped at PTY_BUFFER_MAX and loses old data.
  try {
    const logPath = getPtyLogPath(agentId);
    const stat = fs.statSync(logPath);
    const MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB cap for very long sessions

    let content: string;
    if (stat.size > MAX_READ_BYTES) {
      // Read only the tail of the file
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      content = buf.toString('utf8');
      // Skip the first (potentially partial) line
      const firstNewline = content.indexOf('\n');
      if (firstNewline >= 0) content = content.slice(firstNewline + 1);
    } else {
      content = fs.readFileSync(logPath, 'utf8');
    }

    const lines = content.split('\n').filter(Boolean);
    if (lines.length > 0) {
      return lines.map(line => JSON.parse(line) as string);
    }
  } catch { /* disk log not available */ }

  // Fall back to in-memory buffer
  return _ptyBuffers.get(agentId) ?? [];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Get a snapshot of the agent's terminal (wrapper that checks tmux liveness).
 * Delegates to PtyDiskLogger.getSnapshot with the tmuxAlive flag.
 */
export function getSnapshot(agentId: string): string | null {
  return getSnapshotFromDisk(agentId, isTmuxSessionAlive(agentId));
}

// ---------------------------------------------------------------------------
// Stale tmux cleanup
// ---------------------------------------------------------------------------

export function cleanupStaleTmuxSessions(): void {
  try {
    const output = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' }).toString();
    const sessions = output.trim().split('\n').filter(s => s.startsWith('orchestrator-'));

    // Get all currently running agent IDs from the in-memory PTY map,
    // spawning agents, and standalone jobs being monitored via exit polls
    const spawningOrAttaching = agentStates.agentIdsInStates(AgentState.Spawning, AgentState.Attaching);
    const activeAgentIds = new Set([..._ptys.keys(), ...spawningOrAttaching, ...standaloneExitPollAgentIds()]);

    for (const session of sessions) {
      const agentId = session.replace('orchestrator-', '');
      if (activeAgentIds.has(agentId)) {
        continue;
      }
      try {
        execFileSync(TMUX, ['kill-session', '-t', session], { stdio: 'pipe' });
        console.log(`[pty] cleaned up stale tmux session: ${session}`);
      } catch { /* already gone */ }
    }
  } catch {
    // tmux not running or no sessions — fine
  }
}

// ---------------------------------------------------------------------------
// Resource check (delegates to PtyResourceManager, but needs access to _ptys)
// ---------------------------------------------------------------------------

export function checkPtyResources(): { ok: boolean; reason?: string } {
  const attached = _ptys.size;
  const spawning = agentStates.countInState(AgentState.Spawning) + agentStates.countInState(AgentState.Attaching);
  return checkResources(attached, spawning);
}

// ---------------------------------------------------------------------------
// Attach PTY
// ---------------------------------------------------------------------------

export async function attachPty(agentId: string, job: Job, cols = 100, rows = 50): Promise<void> {
  if (_ptys.has(agentId)) return; // already attached

  // For agents running --print, start tailing the tee'd .ndjson file so
  // agent_output is populated live and the UI streams output as it arrives.
  if (isAutoExitJob(job) || !job.is_interactive) {
    const ndjsonPath = path.join(PTY_LOG_DIR, `${agentId}.ndjson`);
    startTailing(agentId, job, ndjsonPath, 0, null);
  }

  // Use dimensions from client resize if received before PTY was attached
  const pendingSize = _pendingResizes.get(agentId);
  if (pendingSize) {
    cols = pendingSize.cols;
    rows = pendingSize.rows;
    _pendingResizes.delete(agentId);
  }

  if (isStandalonePrintJob(job)) {
    // Standalone print jobs never attach a PTY, so their spawning window ends
    // once monitoring is active rather than when _ptys is populated.
    const currentState = agentStates.getState(agentId);
    if (currentState === AgentState.Spawning || currentState === AgentState.Attaching) {
      agentStates.transition(agentId, AgentState.Polling);
    }
    console.log(`[pty ${agentId}] standalone non-interactive job using ndjson tail + tmux-exit polling`);
    logPtyLifecycleEvent('standalone_print_monitor_started', agentId, job, {
      mode: 'ndjson_tail_poll',
    });
    monitorStandalonePrintJobExit(agentId, job, { isTmuxSessionAlive, removeAgentState: (id) => agentStates.remove(id) });
    return;
  }

  if (!isTmuxSessionAlive(agentId)) {
    try { agentStates.transition(agentId, AgentState.Failed); } catch { agentStates.remove(agentId); }
    console.warn(`[pty ${agentId}] tmux session not alive, cannot attach`);
    markJobRunning(job.id);
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  // Transition to Attaching state before we begin the PTY retry loop
  try { agentStates.transition(agentId, AgentState.Attaching); } catch { /* already past Spawning */ }

  // Retry ptySpawn with exponential backoff — posix_spawnp can fail transiently
  // under resource pressure (FD exhaustion, process limits)
  let ptyInstance: IPty | null = null;
  let lastErr: unknown = null;
  const ptyEnv = (() => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env['PATH'] = env['PATH'] ?? process.env.PATH ?? '';
    delete env['CLAUDECODE'];
    delete env['SENTRY_DSN'];
    delete env['SENTRY_RELEASE'];
    delete env['SENTRY_ENVIRONMENT'];
    return env;
  })();

  for (let attempt = 0; attempt <= PTY_SPAWN_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = PTY_SPAWN_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[pty ${agentId}] retrying PTY attach (attempt ${attempt + 1}/${PTY_SPAWN_MAX_RETRIES + 1}) after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (!isTmuxSessionAlive(agentId)) break;
    }
    try {
      ptyInstance = ptySpawn(TMUX, ['attach-session', '-t', sessionName(agentId)], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: getExistingCwd(job.work_dir ?? process.cwd()),
        env: ptyEnv,
      });
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[pty ${agentId}] PTY spawn attempt ${attempt + 1} failed: ${errMsg(err)}`);
    }
  }

  if (!ptyInstance) {
    // PTY attach failed — clear spawning flag so cleanup can reclaim the session if needed
    try { agentStates.transition(agentId, AgentState.Failed); } catch { agentStates.remove(agentId); }
    // All retries exhausted — fall back to polling if tmux session is alive
    const err = lastErr!;
    if (isAutoExitJob(job)) {
      console.log(`[pty ${agentId}] PTY attach failed after ${PTY_SPAWN_MAX_RETRIES + 1} attempts (tailing continues):`, errMsg(err));
    } else {
      console.log(`[pty ${agentId}] PTY attach failed after ${PTY_SPAWN_MAX_RETRIES + 1} attempts:`, errMsg(err));
    }
    logPtyLifecycleEvent('pty_attach_exhausted', agentId, job, {
      error: errMsg(err),
      attempts: PTY_SPAWN_MAX_RETRIES + 1,
      tmux_alive: isTmuxSessionAlive(agentId),
      fallback: isAutoExitJob(job) ? 'wait_for_tmux_exit_poll' : 'finalize_if_tmux_gone',
    });
    if (isTmuxSessionAlive(agentId)) {
      // Clear any prior fallback poll for this agent to avoid orphaned timers
      stopStandaloneExitPoll(agentId);
      const exitPoll = setInterval(() => {
        if (isTmuxSessionAlive(agentId)) return;
        // stopStandaloneExitPoll is called inside finalizeStandalonePrintJob,
        // so we don't clearInterval manually here.
        console.log(`[pty ${agentId}] tmux session ended (detected via fallback poll)`);
        finalizeStandalonePrintJob(agentId, job, 'pty_attach_fallback_poll', { removeAgentState: (id) => agentStates.remove(id) }).catch(err2 => {
          console.error(`[pty ${agentId}] handleJobCompletion error:`, err2);
          captureWithContext(err2, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
        });
      }, 5000);
      exitPoll.unref();
      setStandaloneExitPoll(agentId, exitPoll);
    } else if (!isAutoExitJob(job)) {
      finalizeStandalonePrintJob(agentId, job, 'pty_attach_exhausted_and_tmux_gone', { removeAgentState: (id) => agentStates.remove(id) }).catch(err2 => {
        console.error(`[pty ${agentId}] standalone completion fallback error:`, err2);
        captureWithContext(err2, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      });
    }
    return;
  }

  _ptys.set(agentId, ptyInstance);
  try { agentStates.transition(agentId, AgentState.Running); } catch { agentStates.remove(agentId); }
  if (!_ptyBuffers.has(agentId)) _ptyBuffers.set(agentId, []);
  console.log(`[pty ${agentId}] attached to tmux session`);
  logPtyLifecycleEvent('pty_attached', agentId, job, { cols, rows });

  ptyInstance.onData((data) => {
    try {
      const buf = _ptyBuffers.get(agentId);
      if (!buf) return; // already disconnected
      socket.emitPtyData(agentId, data);
      buf.push(data);
      if (buf.length > PTY_BUFFER_MAX) buf.splice(0, buf.length - PTY_BUFFER_MAX);
      // Persist to disk so history survives server restarts and buffer eviction.
      // Uses a persistent FD with periodic fsync (every 5s) for durability
      // without the overhead of open/close/fsync per write.
      try {
        const fd = getPtyLogFd(agentId);
        const line = JSON.stringify(data) + '\n';
        fs.writeSync(fd, line);
      } catch { /* ignore write errors */ }
    } catch (err) {
      console.error(`[pty ${agentId}] onData error:`, err);
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    }
  });

  ptyInstance.onExit(() => {
    try {
      // Best-effort snapshot before we lose the tmux session (may already be gone)
      saveSnapshot(agentId);
      closePtyLogFd(agentId);
      console.log(`[pty ${agentId}] PTY exited`);
      _ptys.delete(agentId);
      socket.emitPtyClosed(agentId);

      if (!isTmuxSessionAlive(agentId)) {
    agentStates.remove(agentId);
        // If finish_job already ran, the agent is already in a terminal state — don't double-process
        const agentRec = queries.getAgentById(agentId);
        const TERMINAL = ['done', 'failed', 'cancelled'];
        if (agentRec && TERMINAL.includes(agentRec.status)) return;

        // If cancelled, the cancel endpoint already handled cleanup
        if (cancelledAgents.has(agentId)) {
          cancelledAgents.delete(agentId);
          return;
        }

        // For interactive agents: user ended the session = done
        // For --print mode agents (debate, workflow, batch): exit naturally = done
        const usesPrintMode = isAutoExitJob(job) || !job.is_interactive;
        let status: 'done' | 'failed' = (job.is_interactive || usesPrintMode) ? 'done' : 'failed';
        let errorMsg: string | null = (job.is_interactive || usesPrintMode) ? null : 'Agent session ended without calling finish_job.';

        // For --print agents, stop the live tailer then flush any lines it missed
        // in the small race window between the last poll and the PTY exit.
        if (usesPrintMode) {
          stopTailing(agentId);
          flushDebateNdjson(agentId);
        }

        // Check the ndjson log for rate limit rejection — overrides status to failed
        // so the retry/failure pipeline handles it properly instead of treating it as success.
        const rateLimitInfo = detectRateLimitInNdjson(agentId);
        if (rateLimitInfo) {
          status = 'failed';
          errorMsg = rateLimitInfo;
          console.warn(`[pty ${agentId}] rate limit detected: ${rateLimitInfo}`);
        }

        const updateFields: Parameters<typeof queries.updateAgent>[1] = { status, finished_at: Date.now() };
        if (errorMsg) updateFields.error_message = errorMsg;
        queries.updateAgent(agentId, updateFields);
        logPtyLifecycleEvent('pty_exit_terminal_resolution', agentId, job, {
          status,
          error_message: errorMsg,
          uses_print_mode: usesPrintMode,
          tmux_alive: false,
        });
        handleJobCompletion(agentId, job, status).catch(err => {
          console.error(`[pty ${agentId}] handleJobCompletion error:`, err);
          captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
        });
      }
    } catch (err) {
      console.error(`[pty ${agentId}] onExit error:`, err);
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    }
  });
}

// ---------------------------------------------------------------------------
// Input & resize
// ---------------------------------------------------------------------------

export function writeInput(agentId: string, data: string): void {
  const ptyInstance = _ptys.get(agentId);
  if (!ptyInstance) return;

  // If tmux is in copy-mode (triggered by mouse scroll), exit it first
  // so keystrokes go to the actual process, not tmux's copy-mode handler.
  try {
    const mode = execFileSync('tmux', [
      'display-message', '-t', sessionName(agentId), '-p', '#{pane_mode}',
    ], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 1000 }).trim();
    if (mode === 'copy-mode') {
      execFileSync('tmux', ['send-keys', '-t', sessionName(agentId), 'q'], { stdio: 'pipe', timeout: 1000 });
    }
  } catch { /* tmux session may be gone — ignore */ }

  ptyInstance.write(data);
}

export function resizePty(agentId: string, cols: number, rows: number): void {
  // Always store the latest size so attachPty can use it if the PTY isn't ready yet
  _pendingResizes.set(agentId, { cols, rows });
  const ptyInstance = _ptys.get(agentId);
  if (ptyInstance) ptyInstance.resize(cols, rows);
  // Also resize tmux directly — node-pty resize doesn't always propagate
  try {
    execFileSync('tmux', ['resize-window', '-t', `orchestrator-${agentId}`, '-x', String(cols), '-y', String(rows)]);
  } catch { /* session may not exist */ }
}

export async function resizeAndSnapshot(agentId: string, cols: number, rows: number): Promise<string | null> {
  // 1. Resize the PTY if attached
  resizePty(agentId, cols, rows);
  // 2. Also resize tmux directly (in case PTY is not attached but tmux is alive)
  const sName = `orchestrator-${agentId}`;
  try {
    execFileSync('tmux', ['resize-window', '-t', sName, '-x', String(cols), '-y', String(rows)]);
  } catch { /* session may not exist */ }
  // 3. Wait for tmux to re-render
  await new Promise(resolve => setTimeout(resolve, 200));
  // 4. Capture and return fresh snapshot
  return captureTmuxSnapshot(agentId);
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

export function disconnectAgent(agentId: string): void {
  // Delete buffer first so the onData guard prevents writes during teardown
  _ptyBuffers.delete(agentId);
  agentStates.remove(agentId);
  _pendingResizes.delete(agentId);
  stopStandaloneExitPoll(agentId);
  closePtyLogFd(agentId);

  // Capture a clean snapshot before killing the session
  saveSnapshot(agentId);

  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
  } catch { /* session may already be gone */ }

  const ptyInstance = _ptys.get(agentId);
  if (ptyInstance) {
    _ptys.delete(agentId);
    try { ptyInstance.kill(); } catch { /* ignore */ }
  }

  // Clean up the launcher script and prompt file
  const SCRIPTS_DIR = path.join(process.cwd(), 'data', 'agent-scripts');
  try { fs.unlinkSync(path.join(SCRIPTS_DIR, `${agentId}.sh`)); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(SCRIPTS_DIR, `${agentId}-prompt.txt`)); } catch { /* ignore */ }

  socket.emitPtyClosed(agentId);
}

export function disconnectAll(): string[] {
  const ids = Array.from(new Set([..._ptys.keys(), ...standaloneExitPollAgentIds()]));
  for (const agentId of ids) {
    disconnectAgent(agentId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Accessors for PtyManager (spawning logic needs these)
// ---------------------------------------------------------------------------

/** Number of currently attached PTY sessions */
export function activePtyCount(): number {
  return _ptys.size;
}

/** Whether a specific agent has an attached PTY */
export function hasPty(agentId: string): boolean {
  return _ptys.has(agentId);
}

// ---------------------------------------------------------------------------
// Facade: startInteractiveAgent wrapper (provides SpawnerContext from internals)
// ---------------------------------------------------------------------------

/** Build the SpawnerContext that startInteractiveAgent needs from our internal state */
function buildSpawnerContext(): SpawnerContext {
  return {
    getAttachedCount: () => _ptys.size,
    countInState: (state) => agentStates.countInState(state),
    transition: (agentId, state) => agentStates.transition(agentId, state),
    isTmuxSessionAlive,
    cleanupStaleTmuxSessions,
    attachPty,
  };
}

/**
 * Start an interactive agent -- thin wrapper that provides the SpawnerContext
 * from our internal state to the AgentSpawner implementation.
 */
export function startInteractiveAgent(opts: StartInteractiveOptions): void {
  _startInteractiveAgentImpl(opts, buildSpawnerContext());
}

// Re-export the options type for consumers
export type { StartInteractiveOptions } from './AgentSpawner.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _getSessionNameForTest(agentId: string): string {
  return sessionName(agentId);
}

export function _checkPtyResourceAvailabilityForTest(): { ok: boolean; reason?: string } {
  return checkPtyResources();
}

export function _getResourceBackoffForTest(): number {
  return getBackoffMs();
}

export function _escalateResourceBackoffForTest(): void {
  escalateBackoff();
}

export function _resetResourceBackoffForTest(): void {
  resetBackoff();
}

export function _cleanupStaleTmuxSessionsForTest(): void {
  cleanupStaleTmuxSessions();
}

export function _seedSpawningAgentForTest(agentId: string): void {
  agentStates.transition(agentId, AgentState.Spawning);
}

export function _isAgentSpawningForTest(agentId: string): boolean {
  const state = agentStates.getState(agentId);
  return state === AgentState.Spawning || state === AgentState.Attaching;
}

export function _getAgentStateForTest(agentId: string): AgentState | undefined {
  return agentStates.getState(agentId);
}

export function _resetPtySessionManagerStateForTest(): void {
  disconnectAll();
  resetBackoff();
  agentStates.clear();
  _ptyBuffers.clear();
  _pendingResizes.clear();
  closeAllPtyLogFds();
  _resetJobFinalizerStateForTest();
}
