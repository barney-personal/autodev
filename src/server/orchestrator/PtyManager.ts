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
import { markJobRunning } from './JobLifecycle.js';
import { wrapExecLineWithNice } from './ProcessPriority.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { errMsg } from '../../shared/errors.js';

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
// Agents currently spawning (tmux created but PTY not yet attached).
// Prevents cleanupStaleTmuxSessions from killing sessions that are still starting up.
const _spawningAgents = new Set<string>();

// Rolling buffer of raw PTY output per agent (capped at 2000 chunks to bound memory)
const _ptyBuffers = new Map<string, string[]>();
const _pendingResizes = new Map<string, { cols: number; rows: number }>();
const _standaloneExitPolls = new Map<string, NodeJS.Timeout>();
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

function getNdjsonPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.ndjson`);
}

function getPtyStderrPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.stderr`);
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

function isStandalonePrintJob(job: Pick<Job, 'is_interactive' | 'debate_role' | 'workflow_phase'>): boolean {
  return !job.is_interactive && !isAutoExitJob(job);
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

/**
 * Build a descriptive error message from a `system api_retry` ndjson event.
 * Captures the HTTP status and/or error type so the failure is identifiable in logs.
 */
function formatApiRetryErrorMessage(ev: Record<string, unknown>): string {
  const parts: string[] = ['API rate limited'];
  if (ev.error_status != null) {
    parts.push(`(HTTP ${ev.error_status})`);
  } else if (typeof ev.error === 'string' && ev.error) {
    parts.push(`(${ev.error})`);
  }
  if (typeof ev.message === 'string' && ev.message) {
    parts.push(ev.message);
  }
  return parts.join(' ');
}

/**
 * Scan the agent's ndjson log for rate_limit_event with status "rejected".
 * Returns a descriptive error string if found, or null if no rate limit detected.
 */
function detectRateLimitInNdjson(agentId: string): string | null {
  const ndjsonPath = getNdjsonPath(agentId);
  try {
    if (!fs.existsSync(ndjsonPath)) return null;
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('rate_limit')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
          const info = ev.rate_limit_info;
          const limitType = info.rateLimitType ?? 'unknown';
          const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : 'unknown';
          return `Rate limited (${limitType}), resets at ${resetsAt}`;
        }
      } catch { /* not valid JSON, skip */ }
    }
  } catch { /* file read error, skip */ }
  return null;
}

function statusFromNdjson(agentId: string): { status: 'done' | 'failed'; errorMessage: string | null; source: 'result' | 'rate_limit' } | null {
  const ndjsonPath = getNdjsonPath(agentId);
  try {
    if (!fs.existsSync(ndjsonPath)) return null;
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'result') {
          return {
            status: ev.is_error ? 'failed' : 'done',
            errorMessage: ev.is_error
              ? (typeof ev.result === 'string' ? ev.result : (typeof ev.error === 'string' ? ev.error : 'Claude result event reported an error'))
              : null,
            source: 'result',
          };
        }
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
          return {
            status: 'failed',
            errorMessage: detectRateLimitInNdjson(agentId),
            source: 'rate_limit',
          };
        }
        if (
          ev.type === 'system'
          && ev.subtype === 'api_retry'
          && (ev.error_status === 429 || ev.error === 'rate_limit')
        ) {
          return {
            status: 'failed',
            errorMessage: formatApiRetryErrorMessage(ev as Record<string, unknown>),
            source: 'rate_limit',
          };
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file may not exist yet */ }
  return null;
}

function checkCommitsSince(baseSha: string | null, workDir: string | null): boolean {
  if (!baseSha || !workDir) return false;
  try {
    const count = execSync(
      `git rev-list --count HEAD ${JSON.stringify(`^${baseSha}`)}`,
      { cwd: workDir, stdio: 'pipe', timeout: 10000 }
    ).toString().trim();
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

type StandalonePrintResolution = {
  status: 'done' | 'failed';
  source: 'result' | 'rate_limit' | 'commits' | 'incomplete_run' | 'no_terminal_evidence';
  errorMessage: string | null;
  detail: string;
};

type NdjsonTailSummary = {
  eventCount: number;
  allowedWarningCount: number;
  lastEventDescription: string | null;
  pendingToolUse: { id: string; name: string } | null;
};

function readTextTail(filePath: string, maxBytes = 4096): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }

    let text = buffer.toString('utf8');
    if (stat.size > bytesToRead) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

function describeNdjsonEvent(ev: any): string | null {
  if (!ev || typeof ev !== 'object') return null;

  if (ev.type === 'assistant') {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const toolNames = content
      .filter((part: any) => part?.type === 'tool_use' && typeof part?.name === 'string')
      .map((part: any) => part.name);
    const textPart = content.find((part: any) => part?.type === 'text' && typeof part?.text === 'string');

    if (toolNames.length > 0) return `assistant tool_use ${toolNames.join(', ')}`;
    if (textPart?.text) return `assistant text "${textPart.text.replace(/\s+/g, ' ').trim().slice(0, 120)}"`;
    return 'assistant event';
  }

  if (ev.type === 'user') {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const hasToolResult = content.some((part: any) => part?.type === 'tool_result');
    return hasToolResult ? 'user tool_result' : 'user event';
  }

  if (ev.type === 'system') {
    return ev.subtype ? `system ${ev.subtype}` : 'system event';
  }

  if (ev.type === 'rate_limit_event') {
    return `rate_limit_event ${ev.rate_limit_info?.status ?? 'unknown'}`;
  }

  if (ev.type === 'result') {
    return ev.is_error ? 'result error' : 'result success';
  }

  return typeof ev.type === 'string' ? ev.type : null;
}

function summarizeNdjsonTail(agentId: string): NdjsonTailSummary | null {
  const ndjsonPath = getNdjsonPath(agentId);
  try {
    if (!fs.existsSync(ndjsonPath)) return null;
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const unresolvedToolUses = new Map<string, { id: string; name: string }>();
    let allowedWarningCount = 0;
    let lastEventDescription: string | null = null;
    let eventCount = 0;

    for (const line of lines) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      eventCount += 1;
      lastEventDescription = describeNdjsonEvent(ev);

      if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'allowed_warning') {
        allowedWarningCount += 1;
      }

      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      if (ev.type === 'assistant') {
        for (const part of content) {
          if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
            unresolvedToolUses.set(part.id, { id: part.id, name: part.name });
          }
        }
      } else if (ev.type === 'user') {
        for (const part of content) {
          if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
            unresolvedToolUses.delete(part.tool_use_id);
          }
        }
      }
    }

    return {
      eventCount,
      allowedWarningCount,
      lastEventDescription,
      pendingToolUse: Array.from(unresolvedToolUses.values()).at(-1) ?? null,
    };
  } catch {
    return null;
  }
}

export function resolveStandalonePrintJobOutcome(agentId: string, job: Pick<Job, 'id' | 'title' | 'work_dir' | 'is_interactive' | 'debate_role' | 'workflow_phase'>): StandalonePrintResolution {
  const ndjsonStatus = statusFromNdjson(agentId);
  if (ndjsonStatus) {
    return {
      status: ndjsonStatus.status,
      source: ndjsonStatus.source,
      errorMessage: ndjsonStatus.errorMessage,
      detail: `resolved from ndjson ${ndjsonStatus.source} event`,
    };
  }

  const agent = queries.getAgentById(agentId);
  if (checkCommitsSince(agent?.base_sha ?? null, job.work_dir ?? null)) {
    return {
      status: 'done',
      source: 'commits',
      errorMessage: null,
      detail: `no final ndjson result; git commits exist since base_sha ${agent?.base_sha?.slice(0, 8) ?? 'unknown'}`,
    };
  }

  const stderrTail = readTextTail(getPtyStderrPath(agentId));
  const ndjsonSummary = summarizeNdjsonTail(agentId);
  if (stderrTail || ndjsonSummary) {
    const evidence: string[] = [];
    if (ndjsonSummary) {
      evidence.push(`parsed ${ndjsonSummary.eventCount} ndjson event${ndjsonSummary.eventCount === 1 ? '' : 's'}`);
      if (ndjsonSummary.pendingToolUse) {
        evidence.push(`session ended during pending tool call ${ndjsonSummary.pendingToolUse.name}`);
      }
      if (ndjsonSummary.allowedWarningCount > 0) {
        evidence.push(
          `${ndjsonSummary.allowedWarningCount} rate-limit warning event${ndjsonSummary.allowedWarningCount === 1 ? '' : 's'}`,
        );
      }
      if (ndjsonSummary.lastEventDescription) {
        evidence.push(`last event: ${ndjsonSummary.lastEventDescription}`);
      }
    }
    if (stderrTail) {
      evidence.push(`stderr tail: ${stderrTail.slice(0, 300)}`);
    }

    return {
      status: 'failed',
      source: 'incomplete_run',
      errorMessage: `Agent session ended before emitting a final result event.${evidence.length > 0 ? ` ${evidence.join('. ')}.` : ''}`,
      detail: `terminal evidence collected without final result${ndjsonSummary ? ` (${ndjsonSummary.eventCount} ndjson events)` : ''}`,
    };
  }

  return {
    status: 'failed',
    source: 'no_terminal_evidence',
    errorMessage: 'Agent session ended without a final result event or new commits.',
    detail: 'no final ndjson result/rate-limit event and no commits since base_sha',
  };
}

function logStandalonePrintResolution(
  agentId: string,
  job: Pick<Job, 'id' | 'title'>,
  trigger: string,
  resolution: StandalonePrintResolution,
): void {
  const suffix = resolution.errorMessage ? ` — ${resolution.errorMessage}` : '';
  console.log(
    `[pty ${agentId}] standalone print job ${job.id.slice(0, 8)} resolved ${resolution.status} ` +
    `via ${resolution.source} after ${trigger}: ${resolution.detail}${suffix}`,
  );
  logResilienceEvent('standalone_print_resolution', 'agent', agentId, {
    job_id: job.id,
    job_title: job.title,
    trigger,
    status: resolution.status,
    source: resolution.source,
    detail: resolution.detail,
    error_message: resolution.errorMessage,
  });
}

export function reportStandaloneResolutionFailure(
  agentId: string,
  jobId: string,
  component: string,
  resolution: StandalonePrintResolution,
  trigger?: string,
): void {
  if (resolution.status !== 'failed') return;
  if (
    resolution.source === 'result'
    || resolution.source === 'commits'
    || resolution.source === 'rate_limit'
  ) return;

  // Suppress Sentry noise from PTY-exhaustion: when all PTY attach retries fail,
  // the fallback poll finalizes the job as incomplete_run — this is expected and
  // already handled by workflow recovery (infrastructure failure skip).
  if (resolution.source === 'incomplete_run' && trigger === 'pty_attach_fallback_poll') return;

  const message = [
    `Standalone print job failed via ${resolution.source}`,
    resolution.detail,
    resolution.errorMessage,
  ].filter(Boolean).join(': ');

  captureWithContext(new Error(message), {
    agent_id: agentId,
    job_id: jobId,
    component,
    resolution_source: resolution.source,
    ...(trigger && { resolution_trigger: trigger }),
  });
}

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

function stopStandaloneExitPoll(agentId: string): void {
  const poll = _standaloneExitPolls.get(agentId);
  if (!poll) return;
  clearInterval(poll);
  _standaloneExitPolls.delete(agentId);
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

    // Get all currently running agent IDs from the in-memory PTY map,
    // spawning agents, and standalone jobs being monitored via exit polls
    const activeAgentIds = new Set([..._ptys.keys(), ..._spawningAgents, ..._standaloneExitPolls.keys()]);

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
  // Fail fast if an explicit work_dir was provided but doesn't exist.
  // The cd fail-hard guard in the script catches this too, but failing here
  // gives a clearer error and avoids spawning a tmux session at all.
  if (job.work_dir) {
    try {
      if (!fs.statSync(job.work_dir).isDirectory()) throw new Error('not a directory');
    } catch {
      const msg = `work_dir does not exist: ${job.work_dir}`;
      console.warn(`[pty ${agentId}] ${msg} — marking job failed`);
      captureWithContext(new Error(msg), { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      logPtyLifecycleEvent('pty_work_dir_rejected', agentId, job, {
        reason: 'work_dir_does_not_exist',
        rejected_path: job.work_dir,
      });
      queries.updateAgent(agentId, { status: 'failed', error_message: msg, finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
      return;
    }
  }
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

  // Non-interactive jobs run Claude with --print so the process exits automatically
  // when the task is done. This covers: workflow phases, debate stages, and standalone
  // batch jobs (is_interactive=0). Only truly interactive sessions use the TUI.
  const usePrintMode = !useCodex && (isAutoExitJob(job) || !job.is_interactive);

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
    if (usePrintMode) {
      // Pipe --print output through tee so: (a) you can attach to the tmux session to observe,
      // and (b) the clean stream-json lands in a .ndjson file the UI can display properly.
      // Can't use `exec` with a pipe — the shell stays alive until claude + tee both finish.
      const ndjsonPath = getNdjsonPath(agentId);
      const stderrPath = getPtyStderrPath(agentId);
      execLine = `${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''} --print --output-format stream-json --verbose${resumeFlag} "$(cat ${JSON.stringify(pFile)})" 2>> ${JSON.stringify(stderrPath)} | tee ${JSON.stringify(ndjsonPath)}`;
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
    // ANTHROPIC_API_KEY is set via tmux setenv -g before session creation,
    // so the initial shell inherits it. Not written to the script to avoid
    // persisting secrets on disk.
    // Always cd to the working directory and fail hard if it doesn't exist.
    // Without this, the agent runs in the wrong directory and can't find files.
    `cd ${JSON.stringify(workDir)} || { echo "[agent] FATAL: working directory does not exist: ${workDir}" >&2; exit 1; }`,
    // Ensure the correct branch is checked out before the agent runs.
    // Prevents agents from committing to main when working in a worktree.
    ...(expectedBranch ? [
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
    logPtyLifecycleEvent('pty_resource_check_failed', agentId, job, {
      reason: resourceCheck.reason,
      active_pty_sessions: _ptys.size,
      resource_backoff_ms: _resourceBackoffMs,
      max_pty_sessions: MAX_PTY_SESSIONS,
    });
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
  try { fs.unlinkSync(getNdjsonPath(agentId)); } catch { /* no previous ndjson */ }
  try { fs.unlinkSync(getSnapshotPath(agentId)); } catch { /* no previous snapshot */ }
  try { fs.unlinkSync(getPtyStderrPath(agentId)); } catch { /* no previous stderr */ }

  // Mark this agent as spawning so concurrent cleanupStaleTmuxSessions calls
  // don't kill its tmux session before the PTY is attached to _ptys.
  _spawningAgents.add(agentId);

  try {
    // Kill any existing session with this name
    try {
      execFileSync(TMUX, ['kill-session', '-t', sessionName(agentId)], { stdio: 'pipe' });
    } catch { /* no existing session — fine */ }

    // Set ANTHROPIC_API_KEY in the tmux global environment BEFORE creating
    // the session, so the initial shell process inherits it immediately.
    // (tmux setenv -t only affects new panes, not the already-running shell.)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        execFileSync(TMUX, ['setenv', '-g', 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY], { stdio: 'pipe' });
      } catch { /* non-fatal — agent may fall back to OAuth */ }
    }

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

  } catch (err) {
    _spawningAgents.delete(agentId);
    console.error(`[pty ${agentId}] failed to create tmux session:`, errMsg(err));
    captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    logPtyLifecycleEvent('pty_tmux_session_create_failed', agentId, job, {
      error: errMsg(err),
      cols,
      rows,
      work_dir_exists: fs.existsSync(workDir),
    });
    queries.updateAgent(agentId, { status: 'failed', error_message: errMsg(err), finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');

    // Detect resource exhaustion errors and escalate backoff to prevent tight retry loops
    const isResourceError = /posix_spawnp|EMFILE|ENFILE|EAGAIN|resource|Device not configured|fork failed/i.test(errMsg(err));
    if (isResourceError) {
      _lastResourceErrorTime = Date.now();
      escalateResourceBackoff();
      console.warn(`[pty ${agentId}] resource exhaustion detected — backoff now ${_resourceBackoffMs / 1000}s`);
      logPtyLifecycleEvent('pty_resource_backoff_escalated', agentId, job, {
        error: errMsg(err),
        backoff_ms: _resourceBackoffMs,
      });
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
          } catch (err) {
            console.warn(`[pty ${agentId}] failed to paste codex prompt:`, errMsg(err));
          }
          // paste-buffer returns before tmux finishes feeding content into the terminal;
          // give it a moment to settle so Enter arrives after the full paste is processed.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
          execFileSync(TMUX, ['send-keys', '-t', sessionName(agentId), 'Enter'], { stdio: 'pipe' });
        } catch (err) {
          console.warn(`[pty ${agentId}] failed to send Enter:`, errMsg(err));
        }
      }

      // Guard: agent may have already finished during the 4s startup delay
      const currentAgent = queries.getAgentById(agentId);
      const TERMINAL = ['done', 'failed', 'cancelled'];
      if (currentAgent && TERMINAL.includes(currentAgent.status)) return;

      queries.updateAgent(agentId, { status: 'running' });
      markJobRunning(job.id);
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
      logPtyLifecycleEvent('pty_agent_running', agentId, job, {
        transport: isStandalonePrintJob(job) ? 'ndjson_tail_poll' : 'pty_attach',
      });

      // Attach node-pty to the tmux session
      attachPty(agentId, job, cols, rows);
    } catch (err) {
      console.error(`[pty ${agentId}] error in post-start setup:`, errMsg(err));
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      logPtyLifecycleEvent('pty_post_start_setup_failed', agentId, job, {
        error: errMsg(err),
      });
      queries.updateAgent(agentId, { status: 'failed', error_message: errMsg(err), finished_at: Date.now() });
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

async function finalizeStandalonePrintJob(agentId: string, job: Job, trigger: string): Promise<void> {
  _spawningAgents.delete(agentId);
  stopStandaloneExitPoll(agentId);
  stopTailing(agentId);
  flushDebateNdjson(agentId);

  const agentRec = queries.getAgentById(agentId);
  const TERMINAL = ['done', 'failed', 'cancelled'];
  if (agentRec && TERMINAL.includes(agentRec.status)) return;
  if (cancelledAgents.has(agentId)) {
    cancelledAgents.delete(agentId);
    return;
  }

  const resolution = resolveStandalonePrintJobOutcome(agentId, job);
  logStandalonePrintResolution(agentId, job, trigger, resolution);
  reportStandaloneResolutionFailure(agentId, job.id, 'PtyManager', resolution, trigger);

  const updateFields: Parameters<typeof queries.updateAgent>[1] = {
    status: resolution.status,
    finished_at: Date.now(),
  };
  if (resolution.errorMessage) updateFields.error_message = resolution.errorMessage;
  queries.updateAgent(agentId, updateFields);

  await handleJobCompletion(agentId, job, resolution.status);
}

function monitorStandalonePrintJobExit(agentId: string, job: Job): void {
  if (_standaloneExitPolls.has(agentId)) return;

  const tick = () => {
    if (isTmuxSessionAlive(agentId)) return;
    void finalizeStandalonePrintJob(agentId, job, 'tmux_session_gone').catch(err => {
      console.error(`[pty ${agentId}] standalone exit finalization error:`, err);
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    });
  };

  tick();
  if (!isTmuxSessionAlive(agentId)) return;

  const poll = setInterval(tick, 5000);
  poll.unref();
  _standaloneExitPolls.set(agentId, poll);
}

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
    _spawningAgents.delete(agentId);
    console.log(`[pty ${agentId}] standalone non-interactive job using ndjson tail + tmux-exit polling`);
    logPtyLifecycleEvent('standalone_print_monitor_started', agentId, job, {
      mode: 'ndjson_tail_poll',
    });
    monitorStandalonePrintJobExit(agentId, job);
    return;
  }

  if (!isTmuxSessionAlive(agentId)) {
    console.warn(`[pty ${agentId}] tmux session not alive, cannot attach`);
    markJobRunning(job.id);
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

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
    _spawningAgents.delete(agentId);
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
      const exitPoll = setInterval(() => {
        if (isTmuxSessionAlive(agentId)) return;
        // stopStandaloneExitPoll is called inside finalizeStandalonePrintJob,
        // so we don't clearInterval manually here.
        console.log(`[pty ${agentId}] tmux session ended (detected via fallback poll)`);
        finalizeStandalonePrintJob(agentId, job, 'pty_attach_fallback_poll').catch(err2 => {
          console.error(`[pty ${agentId}] handleJobCompletion error:`, err2);
          captureWithContext(err2, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
        });
      }, 5000);
      exitPoll.unref();
      _standaloneExitPolls.set(agentId, exitPoll);
    } else if (!isAutoExitJob(job)) {
      finalizeStandalonePrintJob(agentId, job, 'pty_attach_exhausted_and_tmux_gone').catch(err2 => {
        console.error(`[pty ${agentId}] standalone completion fallback error:`, err2);
        captureWithContext(err2, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      });
    }
    return;
  }

  _ptys.set(agentId, ptyInstance);
  _spawningAgents.delete(agentId);
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
  _spawningAgents.delete(agentId);
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
  try { fs.unlinkSync(scriptPath(agentId)); } catch { /* ignore */ }
  try { fs.unlinkSync(promptPath(agentId)); } catch { /* ignore */ }

  socket.emitPtyClosed(agentId);
}

export function disconnectAll(): string[] {
  const ids = Array.from(new Set([..._ptys.keys(), ..._standaloneExitPolls.keys()]));
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

export function _statusFromNdjsonForTest(agentId: string): 'done' | 'failed' | null {
  return statusFromNdjson(agentId)?.status ?? null;
}

export function _checkCommitsSinceForTest(baseSha: string | null, workDir: string | null): boolean {
  return checkCommitsSince(baseSha, workDir);
}

export function _getSessionNameForTest(agentId: string): string {
  return sessionName(agentId);
}

export function _checkPtyResourceAvailabilityForTest(): { ok: boolean; reason?: string } {
  return checkPtyResourceAvailability();
}

export function _getResourceBackoffForTest(): number {
  return getResourceBackoff();
}

export function _escalateResourceBackoffForTest(): void {
  escalateResourceBackoff();
}

export function _resetResourceBackoffForTest(): void {
  resetResourceBackoff();
}

export function _cleanupStaleTmuxSessionsForTest(): void {
  cleanupStaleTmuxSessions();
}

export function _seedSpawningAgentForTest(agentId: string): void {
  _spawningAgents.add(agentId);
}

export function _isAgentSpawningForTest(agentId: string): boolean {
  return _spawningAgents.has(agentId);
}

export function _seedStandaloneExitPollForTest(agentId: string): void {
  // Seed a dummy interval so cleanupStaleTmuxSessions treats this agent as actively monitored.
  // The interval is a no-op; _resetPtyManagerStateForTest clears it via disconnectAll.
  _standaloneExitPolls.set(agentId, setInterval(() => {}, 1_000_000));
}

export function _resolveStandalonePrintJobOutcomeForTest(agentId: string, job: Pick<Job, 'id' | 'title' | 'work_dir' | 'is_interactive' | 'debate_role' | 'workflow_phase'>): StandalonePrintResolution {
  return resolveStandalonePrintJobOutcome(agentId, job);
}

export function _resetPtyManagerStateForTest(): void {
  disconnectAll();
  resetResourceBackoff();
  _spawningAgents.clear();
  _ptyBuffers.clear();
  _pendingResizes.clear();
  for (const agentId of Array.from(_ptyLogFds.keys())) closePtyLogFd(agentId);
}
