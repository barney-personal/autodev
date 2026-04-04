import { spawn as ptySpawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { SYSTEM_PROMPT, HOOK_SETTINGS, handleJobCompletion, cancelledAgents, startTailing, stopTailing, readClaudeMd, buildMemorySection } from './AgentRunner.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel, codexModelName, isAutoExitJob } from '../../shared/types.js';
import { wrapExecLineWithNice } from './ProcessPriority.js';

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const CODEX = process.env.CODEX_BIN ?? 'codex';
const MCP_PORT = process.env.MCP_PORT ?? '3947';
const SCRIPTS_DIR = path.join(process.cwd(), 'data', 'agent-scripts');
const PTY_LOG_DIR = path.join(process.cwd(), 'data', 'agent-logs');
const TMUX = process.env.TMUX_BIN ?? 'tmux';

function getExistingCwd(preferred?: string | null): string {
  if (preferred) {
    try {
      if (fs.statSync(preferred).isDirectory()) return preferred;
    } catch { /* fall through */ }
  }
  return process.cwd();
}

/**
 * Ensure a directory is marked as trusted in Codex's config.toml so the
 * "Do you trust this directory?" prompt doesn't appear. The bypass flag
 * doesn't suppress this prompt in codex v0.115.0+.
 */
export function ensureCodexTrusted(workDir: string): void {
  const configPath = path.join(process.env.HOME ?? '', '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch { /* file doesn't exist yet */ }
    const key = `[projects.${JSON.stringify(workDir)}]`;
    if (content.includes(key)) return; // already trusted
    const entry = `\n${key}\ntrust_level = "trusted"\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.appendFileSync(configPath, entry);
  } catch (err) {
    console.warn(`[codex] failed to add trust for ${workDir}:`, err);
  }
}

// agentId → active PTY instance
const _ptys = new Map<string, IPty>();

// Rolling buffer of raw PTY output per agent (capped at 2000 chunks to bound memory)
const _ptyBuffers = new Map<string, string[]>();
const _pendingResizes = new Map<string, { cols: number; rows: number }>();
const PTY_BUFFER_MAX = 2000;

// PTY spawn resilience constants
const MAX_PTY_SESSIONS = Number(process.env.MAX_PTY_SESSIONS ?? 50);
const PTY_SPAWN_MAX_RETRIES = 3;
const PTY_SPAWN_BASE_DELAY_MS = 2000;

// Resource exhaustion backoff — escalates exponentially on repeated PTY failures
let _resourceBackoffMs = 0;
let _lastResourceErrorTime = 0;
const RESOURCE_BACKOFF_BASE = 30_000;
const RESOURCE_BACKOFF_MAX = 300_000; // 5 minutes max

function getResourceBackoff(): number {
  return _resourceBackoffMs;
}

function escalateResourceBackoff(): void {
  _resourceBackoffMs = _resourceBackoffMs === 0
    ? RESOURCE_BACKOFF_BASE
    : Math.min(_resourceBackoffMs * 2, RESOURCE_BACKOFF_MAX);
}

function resetResourceBackoff(): void {
  _resourceBackoffMs = 0;
}

function checkPtyResourceAvailability(): { ok: boolean; reason?: string } {
  const active = _ptys.size;
  if (active >= MAX_PTY_SESSIONS) {
    return { ok: false, reason: `Active PTY sessions (${active}) at limit (${MAX_PTY_SESSIONS})` };
  }

  // Backoff check — don't spawn if we recently hit resource exhaustion
  if (_resourceBackoffMs > 0 && Date.now() - _lastResourceErrorTime < _resourceBackoffMs) {
    return { ok: false, reason: `Resource backoff active (${Math.ceil((_resourceBackoffMs - (Date.now() - _lastResourceErrorTime)) / 1000)}s remaining)` };
  }

  // System-level PTY probe — try to open a PTY to verify the system can allocate one
  try {
    const fd = fs.openSync('/dev/ptmx', 'r');
    fs.closeSync(fd);
  } catch {
    return { ok: false, reason: 'System PTY exhaustion detected (/dev/ptmx unavailable)' };
  }

  return { ok: true };
}

// Persistent file descriptors for PTY log writes (avoids open/close per write)
const _ptyLogFds = new Map<string, number>();
// Periodic fsync for PTY logs to ensure durability without syncing every write
let _fsyncTimer: NodeJS.Timeout | null = null;
const FSYNC_INTERVAL_MS = 5_000; // fsync all open PTY logs every 5s

function ensureFsyncTimer(): void {
  if (_fsyncTimer) return;
  _fsyncTimer = setInterval(() => {
    for (const [agentId, fd] of _ptyLogFds) {
      try { fs.fsyncSync(fd); } catch { _ptyLogFds.delete(agentId); }
    }
  }, FSYNC_INTERVAL_MS);
  _fsyncTimer.unref();
}

function getPtyLogFd(agentId: string): number {
  let fd = _ptyLogFds.get(agentId);
  if (fd !== undefined) return fd;
  fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
  fd = fs.openSync(getPtyLogPath(agentId), 'a');
  _ptyLogFds.set(agentId, fd);
  ensureFsyncTimer();
  return fd;
}

function closePtyLogFd(agentId: string): void {
  const fd = _ptyLogFds.get(agentId);
  if (fd !== undefined) {
    try { fs.fsyncSync(fd); } catch { /* ignore */ }
    try { fs.closeSync(fd); } catch { /* ignore */ }
    _ptyLogFds.delete(agentId);
  }
}

function getPtyLogPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.pty`);
}

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

function sessionName(agentId: string): string {
  return `orchestrator-${agentId}`;
}

function scriptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}.sh`);
}

function promptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}-prompt.txt`);
}

export function isTmuxSessionAlive(agentId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getSnapshotPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.snapshot`);
}

function captureTmuxSnapshot(agentId: string): string | null {
  try {
    const output = execFileSync('tmux', [
      'capture-pane', '-p', '-e', '-S', '-',
      '-t', sessionName(agentId),
    ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
    return output;
  } catch {
    return null;
  }
}

export function saveSnapshot(agentId: string): void {
  const snapshot = captureTmuxSnapshot(agentId);
  if (!snapshot) return;
  try {
    fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
    const snapshotPath = getSnapshotPath(agentId);
    fs.writeFileSync(snapshotPath, snapshot, 'utf8');
    // fsync to ensure snapshot survives a crash immediately after write
    const fd = fs.openSync(snapshotPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* ignore write errors */ }
}

export function getSnapshot(agentId: string): string | null {
  // Prefer live capture from tmux if the session is still running
  if (isTmuxSessionAlive(agentId)) {
    const live = captureTmuxSnapshot(agentId);
    if (live) return live;
  }
  // Fall back to saved snapshot file on disk
  try {
    return fs.readFileSync(getSnapshotPath(agentId), 'utf8');
  } catch {
    return null;
  }
}

function cleanupStaleTmuxSessions(): void {
  try {
    const output = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' }).toString();
    const sessions = output.trim().split('\n').filter(s => s.startsWith('orchestrator-'));

    // Get all currently running agent IDs from the in-memory PTY map
    const activeAgentIds = new Set(_ptys.keys());

    for (const session of sessions) {
      const agentId = session.replace('orchestrator-', '');
      if (!activeAgentIds.has(agentId)) {
        try {
          execFileSync(TMUX, ['kill-session', '-t', session], { stdio: 'pipe' });
          console.log(`[pty] cleaned up stale tmux session: ${session}`);
        } catch { /* already gone */ }
      }
    }
  } catch {
    // tmux not running or no sessions — fine
  }
}

export interface StartInteractiveOptions {
  agentId: string;
  job: Job;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
  /** When true, appends finish_job instruction to prompt and treats session exit as completion */
  autoFinish?: boolean;
}

export function startInteractiveAgent({ agentId, job, cols = 100, rows = 50, resumeSessionId, autoFinish = false }: StartInteractiveOptions): void {
  const workDir = getExistingCwd(job.work_dir ?? process.cwd());
  const model: string | null = job.model ?? null;
  const mcpPort = Number(MCP_PORT);

  const mcpConfig = JSON.stringify({
    mcpServers: {
      orchestrator: {
        url: `http://localhost:${mcpPort}/mcp/${agentId}`,
        type: 'http',
      },
    },
  });

  // Write the prompt to a file so the launcher can pass it as a CLI arg without quoting issues
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const pFile = promptPath(agentId);
  let promptText = buildInteractivePrompt(job);
  if (autoFinish) {
    promptText += '\n\nIMPORTANT: When you have completed this task, call the finish_job MCP tool with a summary of what was accomplished.';
  }
  fs.writeFileSync(pFile, promptText, 'utf8');

  // Capture the current git HEAD SHA so we can diff after the agent finishes
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: workDir, timeout: 5000 }).toString().trim();
    queries.updateAgent(agentId, { base_sha: sha });
  } catch { /* not a git repo or git not available */ }

  // Write a launcher script — receives the prompt as a positional arg (pre-fills input)
  const script = scriptPath(agentId);
  const useCodex = isCodexModel(model);
  if (useCodex) ensureCodexTrusted(workDir);

  // Debate-stage and workflow-phase jobs run Claude with --print so the process
  // exits automatically when the task is done, triggering the next stage.
  const isDebateStage = isAutoExitJob(job);

  let execLine: string;
  if (useCodex) {
    const mcpUrl = `http://localhost:${mcpPort}/mcp/${agentId}`;
    const codexSubModel = codexModelName(model);
    const modelFlag = codexSubModel ? ` -m ${JSON.stringify(codexSubModel)}` : '';
    // Do NOT pass the prompt as a positional arg — that causes Codex to run non-interactively
    // and exit immediately. Instead we paste it into the TUI after it initialises.
    // Note: --skip-git-repo-check is a Claude flag and does NOT exist in Codex.
    execLine = `exec ${JSON.stringify(CODEX)} --dangerously-bypass-approvals-and-sandbox -C ${JSON.stringify(workDir)} -c 'mcp_servers.orchestrator.url="${mcpUrl}"'${modelFlag}`;
  } else {
    const resumeFlag = resumeSessionId ? ` --resume ${JSON.stringify(resumeSessionId)}` : '';
    if (isDebateStage) {
      // Pipe --print output through tee so: (a) you can attach to the tmux session to observe,
      // and (b) the clean stream-json lands in a .ndjson file the UI can display properly.
      // Can't use `exec` with a pipe — the shell stays alive until claude + tee both finish.
      const ndjsonPath = path.join(PTY_LOG_DIR, `${agentId}.ndjson`);
      execLine = `${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''} --print --output-format stream-json --verbose${resumeFlag} "$(cat ${JSON.stringify(pFile)})" | tee ${JSON.stringify(ndjsonPath)}`;
    } else {
      execLine = `exec ${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''}${resumeFlag} "$(cat ${JSON.stringify(pFile)})"`;
    }
  }

  // Lower priority when available, but do not fail the launch if `nice` is missing.
  const nicedExecLine = wrapExecLineWithNice(execLine);

  // Determine the expected branch for this job (if any) to enforce branch discipline.
  // Agents must commit to their task branch, never main.
  let expectedBranch: string | null = null;
  if (job.workflow_id) {
    expectedBranch = queries.getWorkflowById(job.workflow_id)?.worktree_branch ?? null;
  }
  if (!expectedBranch) {
    // Check standalone job worktree branch from the worktrees DB table
    try {
      const wt = queries.listActiveWorktrees().find(w => w.path === workDir);
      if (wt) expectedBranch = wt.branch;
    } catch { /* ignore */ }
  }

  const scriptLines = [
    '#!/bin/sh',
    `export ORCHESTRATOR_AGENT_ID=${JSON.stringify(agentId)}`,
    `export ORCHESTRATOR_API_URL=${JSON.stringify(`http://localhost:${process.env.PORT ?? 3456}`)}`,
    `unset CLAUDECODE`,
    `unset SENTRY_DSN`,
    `unset SENTRY_RELEASE`,
    `unset SENTRY_ENVIRONMENT`,
    // Ensure the correct branch is checked out before the agent runs.
    // Prevents agents from committing to main when working in a worktree.
    ...(expectedBranch ? [
      `cd ${JSON.stringify(workDir)}`,
      `_current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)`,
      `if [ "$_current_branch" != ${JSON.stringify(expectedBranch)} ]; then`,
      `  git checkout ${JSON.stringify(expectedBranch)} 2>/dev/null || true`,
      `fi`,
      `unset _current_branch`,
    ] : []),
    // Auto-activate Python virtual environment if present in the working directory,
    // so tools like pytest are on PATH when the agent runs shell commands.
    `for _venv in venv .venv env .env; do`,
    `  if [ -f "${workDir}/$_venv/bin/activate" ]; then . "${workDir}/$_venv/bin/activate"; break; fi`,
    `done`,
    `unset _venv`,
    nicedExecLine,
  ].join('\n') + '\n';
  fs.writeFileSync(script, scriptLines, { mode: 0o755 });

  // Clean up orphaned tmux sessions to reclaim PTY resources before spawning
  cleanupStaleTmuxSessions();

  // Resource pre-check — avoid spawn-fail loops when system is exhausted
  const resourceCheck = checkPtyResourceAvailability();
  if (!resourceCheck.ok) {
    const msg = `PTY resource check failed: ${resourceCheck.reason}`;
    console.warn(`[pty ${agentId}] ${msg} — marking job failed with cooldown`);
    queries.updateAgent(agentId, { status: 'failed', error_message: msg, finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  // Clear any previous PTY log and snapshot so this fresh session starts from a clean slate
  closePtyLogFd(agentId); // close any lingering FD from a previous session
  fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
  try { fs.unlinkSync(getPtyLogPath(agentId)); } catch { /* no previous log */ }
  try { fs.unlinkSync(getSnapshotPath(agentId)); } catch { /* no previous snapshot */ }

  try {
    // Kill any existing session with this name
    try {
      execFileSync(TMUX, ['kill-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    } catch { /* no existing session — fine */ }

    // Create a new detached tmux session running our launcher script
    execFileSync(TMUX, [
      'new-session', '-d',
      '-s', sessionName(agentId),
      '-x', String(cols),
      '-y', String(rows),
      script,
    ], {
      cwd: workDir,
      stdio: 'pipe',
      env: (() => {
        const e = { ...process.env };
        delete e['SENTRY_DSN'];
        delete e['SENTRY_RELEASE'];
        delete e['SENTRY_ENVIRONMENT'];
        return e;
      })(),
    });

    // Session created successfully — reset resource backoff
    resetResourceBackoff();

    // Set large scrollback so capture-pane -S - returns full history
    try {
      execFileSync(TMUX, ['set-option', '-t', sessionName(agentId), 'history-limit', '50000'], { stdio: 'pipe' });
    } catch { /* ignore */ }

    // Enable mouse mode so scroll wheel enters tmux copy mode for history scrolling
    try {
      execFileSync(TMUX, ['set-option', '-t', sessionName(agentId), 'mouse', 'on'], { stdio: 'pipe' });
    } catch { /* ignore — older tmux may not support per-session mouse */ }

  } catch (err: any) {
    console.error(`[pty ${agentId}] failed to create tmux session:`, err.message);
    captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');

    // Detect resource exhaustion errors and escalate backoff to prevent tight retry loops
    const isResourceError = /posix_spawnp|EMFILE|ENFILE|EAGAIN|resource|Device not configured|fork failed/i.test(err.message);
    if (isResourceError) {
      _lastResourceErrorTime = Date.now();
      escalateResourceBackoff();
      console.warn(`[pty ${agentId}] resource exhaustion detected — backoff now ${_resourceBackoffMs / 1000}s`);
    }

    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  queries.updateAgent(agentId, { status: 'starting' });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  // After the TUI has initialised, submit the initial prompt.
  // For Claude: prompt is pre-filled via CLI arg, so just send Enter.
  // For Codex: prompt was NOT passed as CLI arg (that causes non-interactive exit),
  //   so paste it from file into the TUI first, then send Enter.
  setTimeout(async () => {
    try {
      if (isTmuxSessionAlive(agentId)) {
        if (useCodex) {
          try {
            execFileSync(TMUX, ['load-buffer', '-b', `agent-${agentId}`, pFile], { stdio: 'pipe' });
            execFileSync(TMUX, ['paste-buffer', '-b', `agent-${agentId}`, '-t', sessionName(agentId)], { stdio: 'pipe' });
          } catch (err: any) {
            console.warn(`[pty ${agentId}] failed to paste codex prompt:`, err.message);
          }
          // paste-buffer returns before tmux finishes feeding content into the terminal;
          // give it a moment to settle so Enter arrives after the full paste is processed.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
          execFileSync(TMUX, ['send-keys', '-t', sessionName(agentId), 'Enter'], { stdio: 'pipe' });
        } catch (err: any) {
          console.warn(`[pty ${agentId}] failed to send Enter:`, err.message);
        }
      }

      // Guard: agent may have already finished during the 4s startup delay
      const currentAgent = queries.getAgentById(agentId);
      const TERMINAL = ['done', 'failed', 'cancelled'];
      if (currentAgent && TERMINAL.includes(currentAgent.status)) return;

      queries.updateAgent(agentId, { status: 'running' });
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);

      // Attach node-pty to the tmux session
      attachPty(agentId, job, cols, rows);
    } catch (err: any) {
      console.error(`[pty ${agentId}] error in post-start setup:`, err.message);
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
    }
  }, 4000);
}

/**
 * Flush any lines from the tee'd .ndjson file that the live tailer hasn't stored yet
 * (small race window between the last interval tick and stopTailing). Also extracts
 * cost/duration/turns from the result event and updates the agent record.
 */
function flushDebateNdjson(agentId: string): void {
  const ndjsonPath = path.join(PTY_LOG_DIR, `${agentId}.ndjson`);
  try {
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    // Only import lines the live tailer hasn't stored yet
    const nextSeq = queries.getAgentLastSeq(agentId) + 1;
    let seq = nextSeq;
    let costUsd: number | null = null;
    let durationMs: number | null = null;
    let numTurns: number | null = null;
    for (const line of lines.slice(nextSeq)) {
      let eventType = 'raw';
      try {
        const event = JSON.parse(line);
        eventType = typeof event.type === 'string' ? event.type : 'raw';
        if (event.type === 'result') {
          costUsd = event.total_cost_usd ?? null;
          durationMs = event.duration_ms ?? null;
          numTurns = event.num_turns ?? null;
        }
      } catch { /* not valid JSON — store as raw */ }
      queries.insertAgentOutput({ agent_id: agentId, seq: seq++, event_type: eventType, content: line, created_at: Date.now() });
    }
    if (costUsd !== null || durationMs !== null || numTurns !== null) {
      queries.updateAgent(agentId, { cost_usd: costUsd, duration_ms: durationMs, num_turns: numTurns });
    }
    const flushed = seq - nextSeq;
    if (flushed > 0) console.log(`[pty ${agentId}] flushed ${flushed} late lines from debate ndjson`);
  } catch { /* no ndjson file or read error — skip silently */ }
}

export async function attachPty(agentId: string, job: Job, cols = 100, rows = 50): Promise<void> {
  if (_ptys.has(agentId)) return; // already attached

  // For debate-stage agents running --print, start tailing the tee'd .ndjson file so
  // agent_output is populated live and the UI streams output as it arrives.
  if (isAutoExitJob(job)) {
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

  if (!isTmuxSessionAlive(agentId)) {
    console.warn(`[pty ${agentId}] tmux session not alive, cannot attach`);
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  // Retry ptySpawn with exponential backoff — posix_spawnp can fail transiently
  // under resource pressure (FD exhaustion, process limits)
  let ptyInstance: IPty | null = null;
  let lastErr: Error | null = null;
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
    } catch (err: any) {
      lastErr = err;
      console.warn(`[pty ${agentId}] PTY spawn attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  if (!ptyInstance) {
    // All retries exhausted — fall back to polling if tmux session is alive
    const err = lastErr!;
    if (isAutoExitJob(job)) {
      console.warn(`[pty ${agentId}] PTY attach failed after ${PTY_SPAWN_MAX_RETRIES + 1} attempts (tailing continues):`, err.message);
    } else {
      console.warn(`[pty ${agentId}] PTY attach failed after ${PTY_SPAWN_MAX_RETRIES + 1} attempts:`, err.message);
    }
    if (isTmuxSessionAlive(agentId)) {
      const exitPoll = setInterval(() => {
        if (isTmuxSessionAlive(agentId)) return;
        clearInterval(exitPoll);
        const agentRec = queries.getAgentById(agentId);
        const TERMINAL = ['done', 'failed', 'cancelled'];
        if (agentRec && TERMINAL.includes(agentRec.status)) return;
        console.log(`[pty ${agentId}] tmux session ended (detected via fallback poll)`);
        handleJobCompletion(agentId, job, 'done').catch(err2 => {
          console.error(`[pty ${agentId}] handleJobCompletion error:`, err2);
          captureWithContext(err2, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
        });
      }, 5000);
    } else if (!isAutoExitJob(job)) {
      queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
    }
    return;
  }

  _ptys.set(agentId, ptyInstance);
  if (!_ptyBuffers.has(agentId)) _ptyBuffers.set(agentId, []);
  console.log(`[pty ${agentId}] attached to tmux session`);

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
        // For debate-stage jobs: --print mode exits naturally = done
        // For other non-interactive agents: tmux exit without finish_job = failed
        const isDebateStage = isAutoExitJob(job);
        const status = (job.is_interactive || isDebateStage) ? 'done' : 'failed';
        const errorMsg = (job.is_interactive || isDebateStage) ? null : 'Agent session ended without calling finish_job.';

        // For auto-exit agents, stop the live tailer then flush any lines it missed
        // in the small race window between the last poll and the PTY exit.
        if (isDebateStage) {
          stopTailing(agentId);
          flushDebateNdjson(agentId);
        }

        const updateFields: Parameters<typeof queries.updateAgent>[1] = { status, finished_at: Date.now() };
        if (errorMsg) updateFields.error_message = errorMsg;
        queries.updateAgent(agentId, updateFields);
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

export function disconnectAgent(agentId: string): void {
  // Delete buffer first so the onData guard prevents writes during teardown
  _ptyBuffers.delete(agentId);
  _pendingResizes.delete(agentId);
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
  try { fs.unlinkSync(scriptPath(agentId)); } catch { /* ignore */ }
  try { fs.unlinkSync(promptPath(agentId)); } catch { /* ignore */ }

  socket.emitPtyClosed(agentId);
}

export function disconnectAll(): string[] {
  const ids = Array.from(_ptys.keys());
  for (const agentId of ids) {
    disconnectAgent(agentId);
  }
  return ids;
}

function buildInteractivePrompt(job: Job): string {
  const model: string | null = job.model ?? null;
  let prompt = '';

  // Codex has no --append-system-prompt flag, so prepend it to the prompt
  if (isCodexModel(model)) {
    prompt += SYSTEM_PROMPT + '\n\n---\n\n';
  }

  prompt += `# Task: ${job.title}\n\n`;

  const templateId = job.template_id;
  if (templateId) {
    const template = queries.getTemplateById(templateId);
    if (template) {
      prompt += `## Guidelines\n\n${template.content}`;
      if (job.description.trim()) {
        prompt += `\n\n## Task Description\n\n`;
      }
    }
  }

  if (job.description.trim()) {
    prompt += job.description;
  }

  if (job.context) {
    try {
      const ctx = JSON.parse(job.context);
      prompt += '\n\n## Additional Context\n';
      for (const [k, v] of Object.entries(ctx)) {
        prompt += `- **${k}**: ${v}\n`;
      }
    } catch { /* ignore */ }
  }

  // Inject CLAUDE.md for Codex agents (Claude reads it natively)
  const workDir = job.work_dir ?? process.cwd();
  if (isCodexModel(model)) {
    const claudeMd = readClaudeMd(workDir);
    if (claudeMd) {
      prompt += `\n\n## Project Instructions (from CLAUDE.md)\n\n${claudeMd}`;
    }
  }

  // Inject relevant memories from knowledge base (2000-char budget)
  prompt += buildMemorySection(job);

  return prompt;
}
