/**
 * WatcherSession — one Anthropic SDK conversation per watched agent.
 *
 * Each session keeps a rolling Messages-API conversation cache between ticks.
 * Per tick we:
 *   1. Build a curated WatcherTick from the agent's current state.
 *   2. Append it as a `user` message and call the API with tools available.
 *   3. Execute every tool call the model returns (post_commentary, nudge_job,
 *      restart_job, escalate_to_user, read_recent_output, read_diff).
 *   4. Feed `tool_result` blocks back as a follow-up turn, loop until the model
 *      stops requesting tools (max MAX_TOOL_ROUNDS per tick).
 *   5. Trim history to keep cost bounded while preserving cache hits on the
 *      system prompt + tools definition.
 *
 * Robustness:
 * - All errors are caught and surfaced as a 'concern'-severity commentary, the
 *   session does NOT block the watched agent's lifecycle.
 * - Rate-limit / 5xx errors back the session into 'error' state, with auto-
 *   retry on the next tick.
 * - Concurrent triggers per session are serialised via _ticking flag — only
 *   one tick runs at a time per agent; queued triggers coalesce.
 */
import Anthropic from '@anthropic-ai/sdk';
import { agentLogger } from '../lib/logger.js';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { buildWatcherTick, renderWatcherTick, type WatcherTrigger } from './watcherFeed.js';
import {
  execPostCommentary,
  execReadRecentOutput,
  execReadDiff,
  execNudgeJob,
  execRestartJob,
  execEscalateToUser,
  type ToolExecResult,
} from './watcherTools.js';
import { estimateCostUsd } from './CostEstimator.js';
import type { JobWatcher } from '../../shared/types.js';

export const DEFAULT_WATCHER_MODEL = process.env.WATCHER_MODEL ?? 'claude-opus-4-7';
const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_TURNS = 12;  // user+assistant pairs to keep before trimming
const MAX_OUTPUT_TOKENS = 1500;

const SYSTEM_PROMPT = `You are the LIVE WATCHER for a single autonomous coding agent in an orchestration system.

Your job: continuously interpret what the agent is doing, narrate progress for the human dashboard, and intervene when the agent is stuck, looping, or off-track.

You receive "ticks" — curated snapshots of recent events, narration, the diff stat against the worktree base, active warnings, and your own recent commentary. You do NOT see the agent's full transcript unless you ask for it.

PRIORITIES (in order):
1. SAFETY: Never recommend destructive actions on user systems beyond what the agent is already doing. Respect ongoing edits.
2. PROGRESS NARRATION: Every tick where something changed, post one short commentary. Severity = info (normal progress), progress (clear milestone), concern (going off-track), blocker (cannot recover without help), resolved (recovered from a prior concern/blocker).
3. INTERVENE WHEN NEEDED: If the agent is genuinely stuck — repeating the same failing command, idle while sub-jobs are done, ignoring a warning, missing the actual goal — use nudge_job. If a nudge would not work or the agent has crashed, use restart_job. If you don't have enough information or the agent needs a human decision, use escalate_to_user.

TOOLS:
- post_commentary(severity, headline, detail?, evidence?) — short dashboard message. Headline ≤ 80 chars. Use frequently — this is your main job.
- read_recent_output(limit?) — pull deeper detail when you need it. Use sparingly; tick context usually covers it.
- read_diff() — full git diff vs base. Use when commentary depends on what changed on disk.
- nudge_job(message, reason?) — surface a concrete suggestion the agent can read via MCP. Use when the agent is heading off-track but still functional.
- restart_job(reason, diagnosis?) — kill the agent and requeue with your diagnosis. Use only when the agent is truly stuck or crashed. Capped at 3 per agent before auto-escalation.
- escalate_to_user(question, context?) — open a dashboard discussion thread for the human. Use when work cannot proceed without a decision.

STYLE:
- Be terse. Headlines like: "Agent stuck reading the same file", "Tests passing after 3rd attempt", "Lock contention on src/foo.ts".
- Don't restate the obvious. Don't post if nothing has changed since your last commentary.
- One commentary per tick is the norm. Skip commentary on quiet ticks unless severity changed.
- Use 'progress' when the agent ships a milestone (tests pass, PR opened, milestone box ticked). Use 'concern' early — better to flag false alarms than to miss real stalls.

OUTPUT: After thinking, call exactly the tools you want. Do not write narrative text outside of tool calls — the dashboard only displays what you post via post_commentary.`;

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    name: 'post_commentary',
    description: 'Post a short commentary item visible to the user in the dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['info', 'progress', 'concern', 'blocker', 'resolved'] },
        headline: { type: 'string', description: 'One-line summary, max ~80 chars.' },
        detail: { type: 'string', description: 'Optional longer explanation.' },
        evidence: { type: 'string', description: 'Optional supporting evidence (e.g. a short log snippet).' },
      },
      required: ['severity', 'headline'],
    },
  },
  {
    name: 'read_recent_output',
    description: 'Read the agent\'s recent text-only output (assistant text, tool calls, results) — text-only summary, not raw JSON.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max output rows (default 40, max 200).' },
      },
    },
  },
  {
    name: 'read_diff',
    description: 'Read the full git diff between the agent\'s base SHA and the current worktree HEAD/working tree.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'nudge_job',
    description: 'Queue a short message the running agent can pick up on its next MCP call. Cooldown: 60s between nudges.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The instruction or hint to deliver to the agent.' },
        reason: { type: 'string', description: 'Why you are nudging (for audit).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'restart_job',
    description: 'Kill the running agent and requeue the job. Use only when the agent is stuck or crashed. Capped at 3 per agent.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you are restarting.' },
        diagnosis: { type: 'string', description: 'Diagnostic notes appended to the requeued job description.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'escalate_to_user',
    description: 'Open a discussion thread asking the user a question that blocks progress. Capped at 5 per agent.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to ask the user.' },
        context: { type: 'string', description: 'Optional supporting context.' },
      },
      required: ['question'],
    },
  },
];

// Cache control on the last system block + tools makes repeated ticks reuse
// the system prompt cache.
const SYSTEM: Anthropic.Messages.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export class WatcherSession {
  readonly watcherId: string;
  readonly agentId: string;
  private readonly log: ReturnType<typeof agentLogger>;
  private readonly history: Anthropic.Messages.MessageParam[] = [];
  private _ticking = false;
  private _pendingTrigger: WatcherTrigger | null = null;
  private _stopped = false;

  constructor(watcherId: string, agentId: string) {
    this.watcherId = watcherId;
    this.agentId = agentId;
    this.log = agentLogger(agentId, { watcherId, component: 'watcher' });
  }

  stop(): void { this._stopped = true; }

  isStopped(): boolean { return this._stopped; }

  /**
   * Request a tick. Coalesces concurrent triggers: at most one tick runs at a
   * time per session, and the most recent trigger wins for the next run.
   */
  async requestTick(trigger: WatcherTrigger): Promise<void> {
    if (this._stopped) return;
    this._pendingTrigger = highest(this._pendingTrigger, trigger);
    if (this._ticking) return;
    this._ticking = true;
    try {
      while (this._pendingTrigger && !this._stopped) {
        const t = this._pendingTrigger;
        this._pendingTrigger = null;
        await this.runTick(t);
      }
    } finally {
      this._ticking = false;
    }
  }

  private async runTick(trigger: WatcherTrigger): Promise<void> {
    const watcher = queries.getWatcherById(this.watcherId);
    if (!watcher) { this._stopped = true; return; }
    if (watcher.status === 'stopped') { this._stopped = true; return; }

    const tick = buildWatcherTick({ agentId: this.agentId, trigger, sinceSeq: watcher.last_seq });
    if (!tick) {
      this.log.debug('agent gone — stopping watcher');
      this._stopped = true;
      return;
    }

    // Skip heartbeats when the agent is quiet and there are no warnings —
    // posting "still working" commentary every 45s would be pure noise.
    if (trigger === 'heartbeat' && tick.events.length === 0 && tick.warnings.length === 0) {
      queries.updateWatcher(this.watcherId, { last_seq: tick.high_water_seq, last_tick_at: Date.now() });
      return;
    }

    const userText = renderWatcherTick(tick);
    this.history.push({ role: 'user', content: [{ type: 'text', text: userText, cache_control: { type: 'ephemeral' } }] });

    let rounds = 0;
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
    let highSeq = tick.high_water_seq;

    try {
      while (rounds++ < MAX_TOOL_ROUNDS && !this._stopped) {
        const resp = await getClient().messages.create({
          model: watcher.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM,
          tools: TOOLS,
          messages: trimHistory(this.history),
        });

        totalInput += resp.usage.input_tokens ?? 0;
        totalOutput += resp.usage.output_tokens ?? 0;
        totalCacheRead += resp.usage.cache_read_input_tokens ?? 0;
        totalCacheCreate += resp.usage.cache_creation_input_tokens ?? 0;

        // Persist the assistant turn so the next round's tool_result can refer to it.
        this.history.push({ role: 'assistant', content: resp.content });

        const toolUses = resp.content.filter(b => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
        if (toolUses.length === 0 || resp.stop_reason === 'end_turn') break;

        const fresh = queries.getWatcherById(this.watcherId);
        if (!fresh) break;
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const result = await this.dispatchTool(fresh, use);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: result.message,
            is_error: !result.ok,
          });
        }
        this.history.push({ role: 'user', content: toolResults });
      }

      const cost = estimateCostUsd(watcher.model, totalInput + totalCacheRead + totalCacheCreate, totalOutput);
      queries.accumulateWatcherUsage(
        this.watcherId,
        totalInput,
        totalOutput,
        totalCacheRead,
        totalCacheCreate,
        cost,
      );
      queries.updateWatcher(this.watcherId, {
        last_seq: highSeq,
        status: 'running',
        error_message: null,
      });
      const updated = queries.getWatcherById(this.watcherId);
      if (updated) socket.emitWatcherSessionUpdate(updated);
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      this.log.error({ err }, 'tick failed');
      captureWithContext(err, { agent_id: this.agentId, watcher_id: this.watcherId, component: 'WatcherSession' });
      queries.updateWatcher(this.watcherId, { status: 'error', error_message: errMsg.slice(0, 500) });
      const updated = queries.getWatcherById(this.watcherId);
      if (updated) socket.emitWatcherSessionUpdate(updated);
      // Drop the last user turn so the next retry doesn't carry malformed history.
      const tail = this.history.pop();
      if (tail && tail.role === 'assistant') {
        // We may have pushed both user + assistant; clean both
        this.history.pop();
      }
    }
  }

  private async dispatchTool(watcher: JobWatcher, use: Anthropic.Messages.ToolUseBlock): Promise<ToolExecResult> {
    const input = (use.input ?? {}) as Record<string, unknown>;
    try {
      switch (use.name) {
        case 'post_commentary':
          return execPostCommentary(watcher, input as never);
        case 'read_recent_output':
          return execReadRecentOutput(watcher, input as never);
        case 'read_diff':
          return execReadDiff(watcher);
        case 'nudge_job':
          return execNudgeJob(watcher, input as never);
        case 'restart_job':
          return execRestartJob(watcher, input as never);
        case 'escalate_to_user':
          return execEscalateToUser(watcher, input as never);
        default:
          return { ok: false, message: `unknown tool: ${use.name}` };
      }
    } catch (err) {
      this.log.error({ err, tool: use.name }, 'tool dispatch failed');
      captureWithContext(err, { tool: use.name, watcher_id: this.watcherId, component: 'WatcherSession' });
      return { ok: false, message: `tool error: ${(err as Error).message}` };
    }
  }
}

const TRIGGER_RANK: Record<WatcherTrigger, number> = {
  heartbeat: 0,
  tool_use: 1,
  turn_complete: 2,
  initial: 3,
  user_request: 4,
  warning: 5,
  turn_failed: 6,
  agent_done: 7,
  agent_failed: 8,
  agent_cancelled: 8,
};

function highest(a: WatcherTrigger | null, b: WatcherTrigger): WatcherTrigger {
  if (a == null) return b;
  return TRIGGER_RANK[b] >= TRIGGER_RANK[a] ? b : a;
}

/**
 * Trim the message history while preserving cache hits.
 *
 * Anthropic's prompt cache keys on the longest matching prefix, so we always
 * keep the first user turn (which contains the job briefing) and trim from
 * the middle. We also drop tool_use/tool_result pairs first since they're
 * the bulkiest.
 */
function trimHistory(history: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
  if (history.length <= MAX_HISTORY_TURNS) return history;
  // Always keep the first message (briefing) and the most recent MAX_HISTORY_TURNS-1.
  const head = history.slice(0, 1);
  const tail = history.slice(-(MAX_HISTORY_TURNS - 1));
  // Splice a placeholder so the model knows context was elided.
  const placeholder: Anthropic.Messages.MessageParam = {
    role: 'user',
    content: [{ type: 'text', text: '… [earlier tick history elided] …' }],
  };
  return [...head, placeholder, ...tail];
}
