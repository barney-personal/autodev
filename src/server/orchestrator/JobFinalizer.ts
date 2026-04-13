/**
 * JobFinalizer — standalone print job finalization logic.
 *
 * Extracted from PtyManager to isolate the resolution pipeline: ndjson parsing,
 * git-commit detection, rate-limit handling, exit-poll management, and final
 * status resolution for non-interactive (--print) agent jobs.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import { cancelledAgents } from './AgentConfig.js';
import { handleJobCompletion, stopTailing } from './AgentRunner.js';
import { getNdjsonPath, getPtyStderrPath, readTextTail } from './PtyDiskLogger.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import type { Job } from '../../shared/types.js';
import { isAutoExitJob } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StandalonePrintResolution = {
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

// ---------------------------------------------------------------------------
// Standalone print job detection
// ---------------------------------------------------------------------------

export function isStandalonePrintJob(job: Pick<Job, 'is_interactive' | 'debate_role' | 'workflow_phase'>): boolean {
  return !job.is_interactive && !isAutoExitJob(job);
}

// ---------------------------------------------------------------------------
// NDJSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Build a descriptive error message from a `system api_retry` ndjson event.
 * Captures the HTTP status and/or error type so the failure is identifiable in logs.
 */
export function formatApiRetryErrorMessage(ev: Record<string, unknown>): string {
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
export function detectRateLimitInNdjson(agentId: string): string | null {
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

export function statusFromNdjson(agentId: string): { status: 'done' | 'failed'; errorMessage: string | null; source: 'result' | 'rate_limit' } | null {
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

// ---------------------------------------------------------------------------
// NDJSON description / summary helpers
// ---------------------------------------------------------------------------

export function describeNdjsonEvent(ev: any): string | null {
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

export function summarizeNdjsonTail(agentId: string): NdjsonTailSummary | null {
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

// ---------------------------------------------------------------------------
// Git commit check
// ---------------------------------------------------------------------------

// Note: uses execSync with shell interpolation — the baseSha is from our own DB,
// not from user input, so command injection is not a concern here.
export function checkCommitsSince(baseSha: string | null, workDir: string | null): boolean {
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

// ---------------------------------------------------------------------------
// Core resolution logic
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Logging & Sentry reporting
// ---------------------------------------------------------------------------

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
  // the fallback poll or exhaustion handler finalizes the job as incomplete_run —
  // this is expected and already handled by workflow recovery (infrastructure failure skip).
  if (
    resolution.source === 'incomplete_run'
    && (trigger === 'pty_attach_fallback_poll' || trigger === 'pty_attach_exhausted_and_tmux_gone')
  ) return;

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

// ---------------------------------------------------------------------------
// NDJSON flush (cost/duration/turns extraction)
// ---------------------------------------------------------------------------

/**
 * Flush any lines from the tee'd .ndjson file that the live tailer hasn't stored yet
 * (small race window between the last interval tick and stopTailing). Also extracts
 * cost/duration/turns from the result event and updates the agent record.
 */
export function flushDebateNdjson(agentId: string): void {
  const ndjsonPath = getNdjsonPath(agentId);
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

// ---------------------------------------------------------------------------
// Exit poll management
// ---------------------------------------------------------------------------

/** agentId -> active exit poll interval */
const _standaloneExitPolls = new Map<string, NodeJS.Timeout>();

export function stopStandaloneExitPoll(agentId: string): void {
  const poll = _standaloneExitPolls.get(agentId);
  if (!poll) return;
  clearInterval(poll);
  _standaloneExitPolls.delete(agentId);
}

export function hasStandaloneExitPoll(agentId: string): boolean {
  return _standaloneExitPolls.has(agentId);
}

export function standaloneExitPollAgentIds(): string[] {
  return Array.from(_standaloneExitPolls.keys());
}

export function setStandaloneExitPoll(agentId: string, poll: NodeJS.Timeout): void {
  _standaloneExitPolls.set(agentId, poll);
}

// ---------------------------------------------------------------------------
// Main finalization orchestrator
// ---------------------------------------------------------------------------

/**
 * Finalize a standalone --print job after its tmux session has exited.
 * Accepts callbacks for operations that live in PtyManager (agent state removal,
 * tmux session liveness check) to avoid circular imports.
 */
export async function finalizeStandalonePrintJob(
  agentId: string,
  job: Job,
  trigger: string,
  deps: {
    removeAgentState: (agentId: string) => void;
  },
): Promise<void> {
  deps.removeAgentState(agentId);
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

// ---------------------------------------------------------------------------
// Exit polling setup
// ---------------------------------------------------------------------------

export function monitorStandalonePrintJobExit(
  agentId: string,
  job: Job,
  deps: {
    isTmuxSessionAlive: (agentId: string) => boolean;
    removeAgentState: (agentId: string) => void;
  },
): void {
  if (_standaloneExitPolls.has(agentId)) return;

  const tick = () => {
    if (deps.isTmuxSessionAlive(agentId)) return;
    void finalizeStandalonePrintJob(agentId, job, 'tmux_session_gone', deps).catch(err => {
      console.error(`[pty ${agentId}] standalone exit finalization error:`, err);
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    });
  };

  tick();
  if (!deps.isTmuxSessionAlive(agentId)) return;

  const poll = setInterval(tick, 5000);
  poll.unref();
  _standaloneExitPolls.set(agentId, poll);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _statusFromNdjsonForTest(agentId: string): 'done' | 'failed' | null {
  return statusFromNdjson(agentId)?.status ?? null;
}

export function _checkCommitsSinceForTest(baseSha: string | null, workDir: string | null): boolean {
  return checkCommitsSince(baseSha, workDir);
}

export function _resolveStandalonePrintJobOutcomeForTest(agentId: string, job: Pick<Job, 'id' | 'title' | 'work_dir' | 'is_interactive' | 'debate_role' | 'workflow_phase'>): StandalonePrintResolution {
  return resolveStandalonePrintJobOutcome(agentId, job);
}

export function _seedStandaloneExitPollForTest(agentId: string): void {
  _standaloneExitPolls.set(agentId, setInterval(() => {}, 1_000_000));
}

export function _resetJobFinalizerStateForTest(): void {
  for (const [, poll] of _standaloneExitPolls) clearInterval(poll);
  _standaloneExitPolls.clear();
}
