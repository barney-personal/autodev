/**
 * Server-side handlers for the tools the watcher LLM can call.
 *
 * The watcher uses the Anthropic SDK's tool-use feature directly — these
 * handlers are NOT MCP tools. They run in-process and produce one of:
 *   - dashboard commentary
 *   - a recorded action (nudge / restart / escalate) with an outcome
 *
 * Each action is layered by authority:
 *   • post_commentary  → unlimited
 *   • read_recent_output / read_diff → unlimited (read-only)
 *   • nudge_job        → cooldown NUDGE_COOLDOWN_MS, no hard cap
 *   • restart_job      → max MAX_RESTARTS_PER_AGENT applied, then auto-escalates
 *   • escalate_to_user → max MAX_ESCALATIONS_PER_AGENT applied
 */
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { agentLogger } from '../lib/logger.js';
import { cancelledAgents } from './AgentConfig.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { nudgeQueue } from './WorkQueueManager.js';
import type {
  JobWatcher,
  WatcherAction,
  WatcherActionOutcome,
  WatcherCommentary,
  WatcherSeverity,
} from '../../shared/types.js';

export const NUDGE_COOLDOWN_MS = 60_000;
export const MAX_RESTARTS_PER_AGENT = 3;
export const MAX_ESCALATIONS_PER_AGENT = 5;

// ─── Tool input shapes ───────────────────────────────────────────────────────

export interface PostCommentaryInput {
  severity: WatcherSeverity;
  headline: string;
  detail?: string;
  evidence?: string;
}

export interface ReadRecentOutputInput {
  /** Default 40, hard-capped at 200 to keep tick payloads bounded. */
  limit?: number;
}

export interface NudgeJobInput {
  message: string;
  reason?: string;
}

export interface RestartJobInput {
  reason: string;
  /** Additional context to pass into the requeued job's description. */
  diagnosis?: string;
}

export interface EscalateToUserInput {
  question: string;
  context?: string;
}

export interface ToolExecResult {
  ok: boolean;
  message: string;
  action_id?: string;
  outcome?: WatcherActionOutcome;
}

// ─── post_commentary ─────────────────────────────────────────────────────────

export function execPostCommentary(watcher: JobWatcher, input: PostCommentaryInput): ToolExecResult {
  const headline = sanitiseHeadline(input.headline);
  if (!headline) return { ok: false, message: 'headline is required and must be non-empty' };

  const commentary: WatcherCommentary = queries.insertCommentary({
    id: randomUUID(),
    watcher_id: watcher.id,
    agent_id: watcher.agent_id,
    severity: input.severity ?? 'info',
    headline,
    detail: input.detail?.slice(0, 4000) ?? null,
    evidence: input.evidence?.slice(0, 4000) ?? null,
  });

  // Bump watcher's next_severity hint so the dashboard badge reflects worst recent state.
  queries.updateWatcher(watcher.id, { next_severity: bumpSeverity(watcher.next_severity, commentary.severity) });
  emitWatcherUpdate(watcher.id);

  socket.emitWatcherCommentaryNew(commentary);
  return { ok: true, message: `commentary posted (${commentary.severity})` };
}

// ─── read_recent_output ──────────────────────────────────────────────────────

export function execReadRecentOutput(watcher: JobWatcher, input: ReadRecentOutputInput): ToolExecResult {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 200);
  const rows = queries.getAgentOutput(watcher.agent_id, limit);
  // Return a slim text-only summary; the watcher rarely needs raw stream-json.
  const lines: string[] = [];
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.content);
      const t = ev.type;
      if (t === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text) {
            lines.push(`#${row.seq} text: ${truncate(b.text, 400)}`);
          } else if (b.type === 'tool_use') {
            const inp = b.input == null ? '' : (typeof b.input === 'string' ? b.input : JSON.stringify(b.input));
            lines.push(`#${row.seq} tool ${b.name}: ${truncate(inp, 300)}`);
          }
        }
      } else if (t === 'result' && typeof ev.result === 'string') {
        lines.push(`#${row.seq} result: ${truncate(ev.result, 600)}`);
      } else if (t === 'error') {
        lines.push(`#${row.seq} error: ${truncate(String(ev.error?.message ?? ev.message ?? 'error'), 400)}`);
      } else if (t === 'item.completed' && ev.item) {
        if (ev.item.type === 'command_execution') {
          lines.push(`#${row.seq} bash: ${truncate(String(ev.item.command ?? ''), 200)} exit=${ev.item.exit_code ?? '?'}`);
          if (ev.item.aggregated_output) lines.push(`  stdout: ${truncate(String(ev.item.aggregated_output), 400)}`);
        } else if (ev.item.type === 'agent_message' && ev.item.text) {
          lines.push(`#${row.seq} text: ${truncate(ev.item.text, 400)}`);
        }
      }
    } catch {
      lines.push(`#${row.seq} (unparseable)`);
    }
  }
  return { ok: true, message: lines.join('\n') || '(no output yet)' };
}

// ─── read_diff ───────────────────────────────────────────────────────────────

export function execReadDiff(watcher: JobWatcher): ToolExecResult {
  const agent = queries.getAgentById(watcher.agent_id);
  if (!agent || !agent.base_sha) return { ok: false, message: 'no base_sha recorded for this agent' };
  const job = queries.getJobById(agent.job_id);
  if (!job?.work_dir) return { ok: false, message: 'job has no work_dir' };
  try {
    // Capped at 64KB for cost — watcher rarely needs the full diff.
    const out = execFileSync('git', ['diff', '--no-color', agent.base_sha], {
      cwd: job.work_dir,
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!out.trim()) return { ok: true, message: '(no diff vs base)' };
    return { ok: true, message: out.length > 60_000 ? out.slice(0, 60_000) + '\n… (truncated)' : out };
  } catch (err) {
    return { ok: false, message: `git diff failed: ${(err as Error).message}` };
  }
}

// ─── nudge_job ───────────────────────────────────────────────────────────────

/**
 * Surface a nudge: writes a note that the running agent can poll via the new
 * MCP check_watcher_nudges tool, records an action, and emits a socket event.
 * Subject to NUDGE_COOLDOWN_MS to prevent flooding.
 */
export function execNudgeJob(watcher: JobWatcher, input: NudgeJobInput): ToolExecResult {
  const message = (input.message ?? '').trim();
  if (!message) return { ok: false, message: 'nudge message is required' };

  const lastAt = queries.lastActionAtForAgent(watcher.agent_id, 'nudge');
  if (lastAt != null && Date.now() - lastAt < NUDGE_COOLDOWN_MS) {
    const action = recordAction(watcher, 'nudge', input.reason ?? null, message, 'gated', `cooldown ${Math.ceil((NUDGE_COOLDOWN_MS - (Date.now() - lastAt)) / 1000)}s remaining`);
    return { ok: false, message: 'nudge gated by cooldown', action_id: action.id, outcome: 'gated' };
  }

  const action = recordAction(watcher, 'nudge', input.reason ?? null, message, 'pending', null);

  // Persist nudge so the agent can pick it up via the MCP check_watcher_nudges tool
  // (delivered as a "user" turn on its next MCP call). Multiple pending nudges
  // are concatenated in the watcher/nudges/<agentId> note.
  appendNudgeToNote(watcher.agent_id, message);

  // Also record in the legacy nudges table for audit consistency
  try {
    queries.insertNudge({ id: randomUUID(), agent_id: watcher.agent_id, message });
  } catch (err) {
    agentLogger(watcher.agent_id).warn({ err }, 'watcher: insertNudge failed');
  }

  queries.updateActionOutcome(action.id, 'applied', 'queued for delivery');
  emitWatcherUpdate(watcher.id);

  // Add a synthetic commentary entry so the dashboard records the nudge in the stream.
  execPostCommentary(watcher, {
    severity: 'concern',
    headline: `Nudged agent: ${truncate(message, 80)}`,
    detail: input.reason ?? message,
  });

  return { ok: true, message: 'nudge delivered', action_id: action.id, outcome: 'applied' };
}

function appendNudgeToNote(agentId: string, message: string): void {
  const key = `watcher/nudges/${agentId}`;
  const existing = queries.getNote(key);
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${message}`;
  const combined = existing?.value ? `${existing.value}\n${entry}` : entry;
  // Bound the note so it doesn't grow unbounded across long jobs.
  const bounded = combined.length > 8000 ? combined.slice(-8000) : combined;
  queries.upsertNote(key, bounded, null);
}

// ─── restart_job ─────────────────────────────────────────────────────────────

/**
 * Kill the running agent (preserving uncommitted work via tmux snapshot) and
 * mark the job back to 'queued' with the watcher's diagnosis appended to the
 * description. Capped per-agent — exceeding the cap auto-escalates instead.
 */
export function execRestartJob(watcher: JobWatcher, input: RestartJobInput): ToolExecResult {
  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, message: 'reason is required' };

  const applied = queries.countActionsForAgent(watcher.agent_id, 'restart');
  if (applied >= MAX_RESTARTS_PER_AGENT) {
    const action = recordAction(watcher, 'restart', reason, input.diagnosis ?? null, 'gated', `cap of ${MAX_RESTARTS_PER_AGENT} restarts reached — escalating`);
    // Auto-escalate so the human is involved
    execEscalateToUser(watcher, {
      question: `Watcher would restart this agent for the ${applied + 1}th time. Please intervene.`,
      context: reason,
    });
    return { ok: false, message: 'restart gated by cap, escalated to user', action_id: action.id, outcome: 'gated' };
  }

  const agent = queries.getAgentById(watcher.agent_id);
  if (!agent) return { ok: false, message: 'agent not found' };
  if (!['starting', 'running', 'waiting_user'].includes(agent.status)) {
    return { ok: false, message: `agent is not running (status=${agent.status})` };
  }

  const action = recordAction(watcher, 'restart', reason, input.diagnosis ?? null, 'pending', null);

  // Mark cancelled before killing so handleAgentExit won't overwrite the status
  cancelledAgents.add(agent.id);

  try {
    // Best-effort kill — the watcher's role is to mark cancelled + requeue.
    // If the OS rejects the signal (process gone, permission, race) we still
    // proceed with the DB transition so the agent isn't stuck "running".
    if (agent.pid) {
      try { process.kill(-agent.pid, 'SIGTERM'); }
      catch (err) {
        agentLogger(agent.id).debug({ err }, 'watcher kill failed — proceeding with requeue');
      }
    }
    // Best-effort kill the tmux session too
    try { execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' }); } catch { /* gone */ }

    queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });

    const job = queries.getJobById(agent.job_id);
    if (job) {
      // Append the watcher's diagnosis to the job description so the next dispatch
      // includes the context that motivated the restart.
      const annotated = appendWatcherDiagnosis(job.description, reason, input.diagnosis);
      if (annotated !== job.description) {
        queries.updateJobDescription(job.id, annotated);
      }
      queries.updateJobStatus(job.id, 'queued');
    }

    // Pending question — timeout it so the MCP ask_user call doesn't hang
    const pendingQ = queries.getPendingQuestion(agent.id);
    if (pendingQ) {
      queries.updateQuestion(pendingQ.id, {
        status: 'timeout',
        answer: '[TIMEOUT] Watcher restarted the agent.',
        answered_at: Date.now(),
      });
    }

    getFileLockRegistry().releaseAll(agent.id);

    const updated = queries.getAgentWithJob(agent.id);
    if (updated) socket.emitAgentUpdate(updated);
    const updatedJob = queries.getJobById(agent.job_id);
    if (updatedJob) socket.emitJobUpdate(updatedJob);

    nudgeQueue();
    queries.updateActionOutcome(action.id, 'applied', null);
    emitWatcherUpdate(watcher.id);

    execPostCommentary(watcher, {
      severity: 'blocker',
      headline: `Restarted agent (${applied + 1}/${MAX_RESTARTS_PER_AGENT})`,
      detail: reason,
      evidence: input.diagnosis,
    });

    return { ok: true, message: 'agent killed; job requeued with diagnosis', action_id: action.id, outcome: 'applied' };
  } catch (err) {
    cancelledAgents.delete(agent.id);
    queries.updateActionOutcome(action.id, 'failed', (err as Error).message);
    return { ok: false, message: `restart failed: ${(err as Error).message}`, action_id: action.id, outcome: 'failed' };
  }
}

function appendWatcherDiagnosis(description: string, reason: string, diagnosis: string | undefined): string {
  const marker = '\n\n---\n## Watcher restart notes';
  const idx = description.lastIndexOf(marker);
  const body = `${marker}\n_${new Date().toISOString()}_\n\n**Reason:** ${reason}\n${diagnosis ? `\n${diagnosis}\n` : ''}`;
  if (idx === -1) return description + body;
  // Keep all prior restart notes; append the new one.
  return description + body.replace(marker, '\n\n');
}

// ─── escalate_to_user ────────────────────────────────────────────────────────

export function execEscalateToUser(watcher: JobWatcher, input: EscalateToUserInput): ToolExecResult {
  const question = (input.question ?? '').trim();
  if (!question) return { ok: false, message: 'question is required' };

  const applied = queries.countActionsForAgent(watcher.agent_id, 'escalate');
  if (applied >= MAX_ESCALATIONS_PER_AGENT) {
    const action = recordAction(watcher, 'escalate', input.context ?? null, question, 'gated', `cap of ${MAX_ESCALATIONS_PER_AGENT} escalations reached`);
    return { ok: false, message: 'escalation gated by cap', action_id: action.id, outcome: 'gated' };
  }

  const action = recordAction(watcher, 'escalate', input.context ?? null, question, 'pending', null);

  try {
    // Open a discussion thread tagged to this agent. The dashboard already
    // surfaces eye discussions; we reuse that channel so users have a single
    // inbox for agent-attached threads.
    const discussion = queries.insertDiscussion({
      id: randomUUID(),
      agent_id: watcher.agent_id,
      topic: `Watcher escalation: ${truncate(question, 60)}`,
      category: 'alert',
      priority: 'high',
      context: input.context ?? null,
    });
    queries.insertDiscussionMessage({
      id: randomUUID(),
      discussion_id: discussion.id,
      role: 'eye',
      content: question,
      requires_reply: true,
    });
    const firstMsg = queries.getDiscussionMessages(discussion.id)[0];
    socket.emitDiscussionNew(discussion, firstMsg);

    queries.updateActionOutcome(action.id, 'applied', `discussion ${discussion.id.slice(0, 8)}`);
    emitWatcherUpdate(watcher.id);

    execPostCommentary(watcher, {
      severity: 'blocker',
      headline: 'Escalated to user',
      detail: question,
      evidence: input.context,
    });

    return { ok: true, message: 'escalation posted', action_id: action.id, outcome: 'applied' };
  } catch (err) {
    queries.updateActionOutcome(action.id, 'failed', (err as Error).message);
    return { ok: false, message: `escalation failed: ${(err as Error).message}`, action_id: action.id, outcome: 'failed' };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recordAction(
  watcher: JobWatcher,
  type: 'nudge' | 'restart' | 'escalate' | 'comment',
  reason: string | null,
  payload: string | null,
  outcome: WatcherActionOutcome,
  outcomeDetail: string | null,
): WatcherAction {
  const action = queries.insertAction({
    id: randomUUID(),
    watcher_id: watcher.id,
    agent_id: watcher.agent_id,
    type,
    reason,
    payload,
    outcome,
    outcome_detail: outcomeDetail,
  });
  socket.emitWatcherActionNew(action);
  return action;
}

function emitWatcherUpdate(watcherId: string): void {
  const w = queries.getWatcherById(watcherId);
  if (w) socket.emitWatcherSessionUpdate(w);
}

const SEVERITY_RANK: Record<WatcherSeverity, number> = {
  info: 0, resolved: 0, progress: 1, concern: 2, blocker: 3,
};

function bumpSeverity(current: WatcherSeverity, incoming: WatcherSeverity): WatcherSeverity {
  // 'resolved' clears bad state regardless of current.
  if (incoming === 'resolved') return 'resolved';
  return SEVERITY_RANK[incoming] >= SEVERITY_RANK[current] ? incoming : current;
}

function sanitiseHeadline(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
