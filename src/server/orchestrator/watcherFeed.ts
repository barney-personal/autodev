/**
 * watcherFeed — builds a curated "tick" payload for the live watcher.
 *
 * The watcher does NOT see raw stream-json. We compact it server-side so the
 * watcher gets a small, high-signal feed: recent tool calls (name + truncated
 * input), turn results, the current diff stat, status/warnings, and any
 * commentary already posted. Total budget is ~8KB per tick.
 *
 * Pure functions — easy to unit-test.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as queries from '../db/queries.js';

/**
 * Lazy-promisified execFile — same pattern as AgentRunner. Some test files
 * mock `child_process` without exposing `execFile`, so `promisify(undefined)`
 * at module init would crash the import. Deferring to first call keeps those
 * tests' mocks valid until the function is actually exercised.
 */
type ExecFileAsyncOpts = { cwd?: string; timeout?: number; maxBuffer?: number; encoding?: BufferEncoding };
let _execFileAsync: ((file: string, args: string[], opts?: ExecFileAsyncOpts) => Promise<{ stdout: string; stderr: string }>) | null = null;
function execFileAsync(
  file: string,
  args: string[],
  opts: ExecFileAsyncOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!_execFileAsync) {
    _execFileAsync = promisify(execFile) as unknown as (
      file: string,
      args: string[],
      opts?: ExecFileAsyncOpts,
    ) => Promise<{ stdout: string; stderr: string }>;
  }
  return _execFileAsync(file, args, opts);
}
import type {
  Agent,
  AgentOutput,
  Job,
  WatcherCommentary,
} from '../../shared/types.js';

const MAX_TURNS_IN_FEED = 12;
const MAX_TOOL_INPUT_PREVIEW = 200;
const MAX_TEXT_PREVIEW = 320;
const MAX_DIFF_STAT_LINES = 40;
const MAX_RECENT_TEXT_BLOCKS = 6;
const MAX_FEED_TEXT_CHARS = 12_000;

export interface WatcherTick {
  /** Why this tick fired — surfaced to the watcher so it can prioritise. */
  trigger: WatcherTrigger;
  /** UNIX ms when the tick was assembled. */
  assembled_at: number;
  /** Highest agent_output seq included in this tick. Used to advance `last_seq`. */
  high_water_seq: number;
  job: WatcherJobView;
  agent: WatcherAgentView;
  events: WatcherEventSummary[];
  /** Concatenated free-text from assistant turns since last tick (truncated). */
  assistant_text: string;
  warnings: WatcherWarningView[];
  diff_stat: string | null;
  /** Last few commentary entries the watcher itself posted. */
  recent_commentary: WatcherCommentaryView[];
  /** Count of fresh events that existed past sinceSeq but didn't fit in the
   * curated tail. The watcher can call read_recent_output if it needs to see
   * what was elided — useful when a high-rank trigger (turn_failed) fires
   * mid-burst and we want the watcher to investigate the actual failure. */
  omitted_event_count: number;
}

export type WatcherTrigger =
  | 'initial'
  | 'tool_use'
  | 'turn_complete'
  | 'turn_failed'
  | 'warning'
  | 'heartbeat'
  | 'agent_done'
  | 'agent_failed'
  | 'agent_cancelled'
  | 'user_request';

/**
 * Rank ordering for trigger types — used by the manager's debounce coalescer
 * and the session's pending-trigger merge logic. Higher rank wins when
 * multiple triggers arrive within the same debounce window so a turn_failed
 * mid-burst takes precedence over a stream of tool_use ticks.
 *
 * Defined here so both `JobWatcherManager` and `WatcherSession` agree on
 * priority — keeping the source of truth single avoids silent drift.
 */
export const TRIGGER_RANK: Record<WatcherTrigger, number> = {
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

export function highestTrigger(a: WatcherTrigger | null, b: WatcherTrigger): WatcherTrigger {
  if (a == null) return b;
  return TRIGGER_RANK[b] >= TRIGGER_RANK[a] ? b : a;
}

export interface WatcherJobView {
  id: string;
  title: string;
  description: string;
  work_dir: string | null;
  model: string | null;
  is_interactive: boolean;
  use_worktree: boolean;
  max_turns: number;
  stop_mode: string;
  stop_value: number | null;
  workflow_phase: string | null;
}

export interface WatcherAgentView {
  id: string;
  status: string;
  num_turns: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  elapsed_ms: number;
  status_message: string | null;
  error_message: string | null;
  active_locks: string[];
  pending_question: string | null;
}

export interface WatcherEventSummary {
  seq: number;
  /** Compact descriptor like "Edit(src/foo.ts)" or "Bash(npm test)". */
  kind: 'tool' | 'text' | 'system' | 'result' | 'error';
  detail: string;
  /** UNIX ms. */
  at: number;
}

export interface WatcherWarningView {
  type: string;
  message: string;
  created_at: number;
}

export interface WatcherCommentaryView {
  severity: string;
  headline: string;
  detail: string | null;
  created_at: number;
}

export interface BuildTickInput {
  agentId: string;
  trigger: WatcherTrigger;
  sinceSeq: number;
}

/**
 * Build a tick payload by reading the current DB state for an agent.
 * Returns null if the agent no longer exists.
 */
export async function buildWatcherTick(input: BuildTickInput): Promise<WatcherTick | null> {
  const { agentId, trigger, sinceSeq } = input;
  const agent = queries.getAgentById(agentId);
  if (!agent) return null;
  const job = queries.getJobById(agent.job_id);
  if (!job) return null;

  // Bounded read: fetch only the most recent MAX_TURNS_IN_FEED events newer
  // than sinceSeq. Avoids the O(total_rows) scan + in-memory filter that the
  // original implementation did on every tick — important for long-running
  // agents with thousands of stream-json events.
  const tail = queries.getAgentOutputSinceSeq(agentId, sinceSeq, MAX_TURNS_IN_FEED);
  const events: WatcherEventSummary[] = [];
  let highSeq = sinceSeq;
  const textPieces: string[] = [];
  let textBudget = MAX_RECENT_TEXT_BLOCKS;

  for (const row of tail) {
    if (row.seq > highSeq) highSeq = row.seq;
    const summary = summarizeEvent(row);
    if (summary) events.push(summary);
    if (textBudget > 0) {
      const t = extractAssistantText(row);
      if (t) {
        textPieces.push(t);
        textBudget--;
      }
    }
  }
  // Advance high_water_seq past any events that exist beyond sinceSeq but
  // weren't included in the bounded tail — otherwise we'd re-summarise older
  // events on the next tick. getAgentLastSeq is a single MAX(seq) query.
  const absoluteLastSeq = queries.getAgentLastSeq(agentId);
  if (absoluteLastSeq > highSeq) highSeq = absoluteLastSeq;
  // Count of fresh events that existed past sinceSeq but were elided from the
  // bounded tail. Surfaced to the watcher so it knows to use read_recent_output
  // when it needs the full picture.
  const totalFresh = sinceSeq >= 0
    ? Math.max(0, absoluteLastSeq - sinceSeq)
    : (absoluteLastSeq >= 0 ? absoluteLastSeq + 1 : 0);
  const omittedEventCount = Math.max(0, totalFresh - tail.length);

  const warnings: WatcherWarningView[] = queries.getActiveWarningsForAgent(agentId).map(w => ({
    type: w.type,
    message: w.message,
    created_at: w.created_at,
  }));

  const pendingQ = queries.getPendingQuestion(agentId);
  const activeLocks = queries.getActiveLocksForAgent(agentId).map(l => l.file_path);

  const elapsed_ms = Date.now() - agent.started_at;

  const diff_stat = job.work_dir && agent.base_sha
    ? await safeDiffStat(job.work_dir, agent.base_sha)
    : null;

  const recent: WatcherCommentaryView[] = queries.getRecentCommentaryForAgent(agentId, 6).map((c: WatcherCommentary) => ({
    severity: c.severity,
    headline: c.headline,
    detail: c.detail,
    created_at: c.created_at,
  }));

  const tick: WatcherTick = {
    trigger,
    assembled_at: Date.now(),
    high_water_seq: highSeq,
    job: viewJob(job),
    agent: viewAgent(agent, pendingQ?.question ?? null, activeLocks, elapsed_ms),
    events,
    assistant_text: capChars(textPieces.join('\n\n'), Math.floor(MAX_FEED_TEXT_CHARS / 2)),
    warnings,
    diff_stat,
    recent_commentary: recent,
    omitted_event_count: omittedEventCount,
  };

  return tick;
}

/**
 * Render a tick as a compact human-readable string that the watcher receives
 * as the user message of its tick. Bounded by MAX_FEED_TEXT_CHARS.
 */
export function renderWatcherTick(tick: WatcherTick): string {
  const lines: string[] = [];
  lines.push(`[trigger=${tick.trigger}] tick @ ${new Date(tick.assembled_at).toISOString()}`);
  lines.push('');
  lines.push(`Job: ${tick.job.title} (id ${tick.job.id.slice(0, 8)})`);
  if (tick.job.workflow_phase) lines.push(`Workflow phase: ${tick.job.workflow_phase}`);
  if (tick.job.work_dir) lines.push(`Work dir: ${tick.job.work_dir}`);
  if (tick.job.model) lines.push(`Model: ${tick.job.model}`);
  lines.push(`Stop: ${tick.job.stop_mode}${tick.job.stop_value != null ? '=' + tick.job.stop_value : ''}, max_turns=${tick.job.max_turns}`);
  lines.push('');
  lines.push(`Agent: ${tick.agent.id.slice(0, 8)} status=${tick.agent.status} turns=${tick.agent.num_turns ?? 0} elapsed=${Math.round(tick.agent.elapsed_ms / 1000)}s`);
  if (tick.agent.cost_usd != null) lines.push(`Cost so far: $${tick.agent.cost_usd.toFixed(4)}`);
  if (tick.agent.status_message) lines.push(`Last status: ${tick.agent.status_message}`);
  if (tick.agent.error_message) lines.push(`Error: ${tick.agent.error_message}`);
  if (tick.agent.pending_question) lines.push(`Pending question: ${tick.agent.pending_question.slice(0, 200)}`);
  if (tick.agent.active_locks.length > 0) lines.push(`Locks held: ${tick.agent.active_locks.join(', ')}`);
  lines.push('');

  if (tick.warnings.length > 0) {
    lines.push('WARNINGS:');
    for (const w of tick.warnings) lines.push(`  - [${w.type}] ${w.message}`);
    lines.push('');
  }

  if (tick.events.length > 0) {
    lines.push('RECENT EVENTS (oldest → newest):');
    for (const e of tick.events) {
      lines.push(`  #${e.seq} [${e.kind}] ${e.detail}`);
    }
    if (tick.omitted_event_count > 0) {
      lines.push(`  … (${tick.omitted_event_count} earlier event${tick.omitted_event_count === 1 ? '' : 's'} omitted — call read_recent_output if you need the full picture)`);
    }
    lines.push('');
  } else {
    lines.push('No new events since last tick.');
    lines.push('');
  }

  if (tick.assistant_text) {
    lines.push('AGENT NARRATION (recent text blocks):');
    lines.push(tick.assistant_text);
    lines.push('');
  }

  if (tick.diff_stat) {
    lines.push('DIFF STAT vs base:');
    lines.push(tick.diff_stat);
    lines.push('');
  }

  if (tick.recent_commentary.length > 0) {
    lines.push('YOUR RECENT COMMENTARY:');
    for (const c of tick.recent_commentary) {
      lines.push(`  [${c.severity}] ${c.headline}${c.detail ? ' — ' + c.detail.slice(0, 160) : ''}`);
    }
    lines.push('');
  }

  return capChars(lines.join('\n'), MAX_FEED_TEXT_CHARS);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function viewJob(job: Job): WatcherJobView {
  return {
    id: job.id,
    title: job.title,
    description: capChars(job.description ?? '', 1500),
    work_dir: job.work_dir,
    model: job.model,
    is_interactive: !!job.is_interactive,
    use_worktree: !!job.use_worktree,
    max_turns: job.max_turns,
    stop_mode: job.stop_mode,
    stop_value: job.stop_value,
    workflow_phase: job.workflow_phase,
  };
}

function viewAgent(
  agent: Agent,
  pendingQuestion: string | null,
  activeLocks: string[],
  elapsed_ms: number,
): WatcherAgentView {
  return {
    id: agent.id,
    status: agent.status,
    num_turns: agent.num_turns,
    cost_usd: agent.cost_usd,
    duration_ms: agent.duration_ms,
    elapsed_ms,
    status_message: agent.status_message,
    error_message: agent.error_message,
    active_locks: activeLocks,
    pending_question: pendingQuestion,
  };
}

function summarizeEvent(row: AgentOutput): WatcherEventSummary | null {
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(row.content); }
  catch { return { seq: row.seq, kind: 'system', detail: '(raw)', at: row.created_at }; }

  const type = String(ev.type ?? '');

  // Claude assistant tool calls + text
  if (type === 'assistant') {
    const message = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
    const blocks = message?.content ?? [];
    const toolDescs: string[] = [];
    let hadText = false;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const name = String(block.name ?? '?');
        const input = block.input as unknown;
        const inputStr = input == null
          ? ''
          : (typeof input === 'string' ? input : JSON.stringify(input));
        const preview = inputStr.length > MAX_TOOL_INPUT_PREVIEW
          ? inputStr.slice(0, MAX_TOOL_INPUT_PREVIEW) + '…'
          : inputStr;
        toolDescs.push(preview && preview !== '{}' ? `${name}(${preview})` : name);
      } else if (block.type === 'text') {
        hadText = true;
      }
    }
    if (toolDescs.length > 0) {
      return { seq: row.seq, kind: 'tool', detail: toolDescs.join(' | '), at: row.created_at };
    }
    if (hadText) {
      return { seq: row.seq, kind: 'text', detail: '(narration)', at: row.created_at };
    }
    return null;
  }

  if (type === 'result') {
    const isError = ev.is_error === true;
    const cost = typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(4)}` : '?';
    const turns = typeof ev.num_turns === 'number' ? `${ev.num_turns} turns` : '';
    const detail = `${isError ? 'failed' : 'done'} ${turns} ${cost}`.trim();
    return { seq: row.seq, kind: 'result', detail, at: row.created_at };
  }

  if (type === 'error') {
    const err = ev.error as { message?: string } | undefined;
    return { seq: row.seq, kind: 'error', detail: capChars(String(err?.message ?? ev.message ?? 'error'), 300), at: row.created_at };
  }

  if (type === 'turn.completed') return { seq: row.seq, kind: 'result', detail: 'codex turn complete', at: row.created_at };
  if (type === 'turn.failed') {
    const err = ev.error as { message?: string } | undefined;
    return { seq: row.seq, kind: 'error', detail: capChars(String(err?.message ?? 'codex turn failed'), 300), at: row.created_at };
  }

  if (type === 'item.completed') {
    const item = ev.item as { type?: string; command?: string; text?: string; exit_code?: number } | undefined;
    if (!item) return null;
    if (item.type === 'command_execution') {
      const cmd = capChars(String(item.command ?? ''), MAX_TOOL_INPUT_PREVIEW);
      const exit = item.exit_code != null ? ` exit=${item.exit_code}` : '';
      return { seq: row.seq, kind: 'tool', detail: `Bash(${cmd})${exit}`, at: row.created_at };
    }
    if (item.type === 'agent_message') {
      return { seq: row.seq, kind: 'text', detail: '(narration)', at: row.created_at };
    }
  }

  return null;
}

function extractAssistantText(row: AgentOutput): string | null {
  try {
    const ev = JSON.parse(row.content);
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const text = ev.message.content
        .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
        .map((b: { text: string }) => b.text)
        .join('\n');
      if (text.trim()) return capChars(text, MAX_TEXT_PREVIEW);
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      return capChars(ev.item.text, MAX_TEXT_PREVIEW);
    }
    if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.trim()) {
      return capChars(`(result) ${ev.result}`, MAX_TEXT_PREVIEW);
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Async — runs `git diff --stat` without blocking the event loop. Bounded by
 * a 4s timeout AND a 64KB maxBuffer so an unexpectedly huge diff can't
 * stall the runtime or run the process out of memory.
 */
async function safeDiffStat(workDir: string, baseSha: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', '--no-color', baseSha],
      { cwd: workDir, encoding: 'utf8', timeout: 4000, maxBuffer: 64 * 1024 },
    );
    const out = stdout.trim();
    if (!out) return null;
    const lines = out.split('\n');
    if (lines.length > MAX_DIFF_STAT_LINES) {
      return lines.slice(0, MAX_DIFF_STAT_LINES).join('\n') + `\n… (+${lines.length - MAX_DIFF_STAT_LINES} more files)`;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Truncate `s` to at most `max` UTF-16 code units (NOT bytes). For ASCII-
 * dominant content (commit messages, file paths, command output) code units
 * are ~1:1 with bytes, which is fine for the watcher's tick budget. For
 * multi-byte content (CJK, emoji-heavy log lines) the actual byte size can
 * be larger, but the API token limit is what really constrains us — this
 * helper just keeps the rendered tick payload roughly bounded.
 */
export function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
