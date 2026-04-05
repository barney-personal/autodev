import { getDb } from './database.js';
import { getJobById } from './jobQueries.js';
import { getAgentById } from './agentQueries.js';
import type { Agent, AgentOutput, AgentOutputSegment, SearchResult } from '../../shared/types.js';

// A raw database row before casting to a typed interface.
type DbRow = Record<string, unknown>;

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── Event rendering types ───────────────────────────────────────────────────

interface ClaudeContentBlock { type: string; text?: string; name?: string; input?: unknown }

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  model?: string;
  message?: { content?: ClaudeContentBlock[] };
  result?: string;
  is_error?: boolean;
  error?: { message?: string };
}

interface CodexStreamEvent {
  type: string;
  thread_id?: string;
  item?: {
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  message?: string;
  error?: { message?: string };
}

// ─── Agent Output ─────────────────────────────────────────────────────────────

function extractSearchText(content: string): string {
  try {
    const ev = JSON.parse(content);
    // Claude events
    if (ev.type === 'assistant' && ev.message?.content) {
      return (ev.message.content as ClaudeContentBlock[])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join(' ');
    }
    if (ev.type === 'result') return ev.result ?? '';
    if (ev.type === 'error') return ev.error?.message ?? '';
    // Codex events
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && ev.item.text) return ev.item.text;
      if (ev.item.type === 'reasoning' && ev.item.text) return ev.item.text;
      if (ev.item.type === 'command_execution') {
        return [ev.item.command, ev.item.aggregated_output].filter(Boolean).join(' ');
      }
    }
    return '';
  } catch { return ''; }
}

export function insertAgentOutput(output: Omit<AgentOutput, 'id'>): void {
  const db = getDb();
  // INSERT OR IGNORE for idempotency — if recovery replays a log file we may
  // encounter duplicate (agent_id, seq) pairs. The unique index on
  // (agent_id, seq) prevents double-inserts without erroring.
  const result = db.prepare(`
    INSERT OR IGNORE INTO agent_output (agent_id, seq, event_type, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(output.agent_id, output.seq, output.event_type, output.content, output.created_at);

  // Only index in FTS if a row was actually inserted (changes > 0 means not a duplicate)
  if (result.changes > 0) {
    const text = extractSearchText(output.content);
    if (text.trim()) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(result.lastInsertRowid, text, output.agent_id);
    }
  }
}

export function rebuildFts(): void {
  const db = getDb();
  // Repopulate FTS for any rows not yet indexed (rowid lookup in FTS5 is O(1))
  const rows = db.prepare('SELECT id, agent_id, content FROM agent_output').all() as Array<{ id: number; agent_id: string; content: string }>;
  let added = 0;
  for (const row of rows) {
    const text = extractSearchText(row.content);
    if (!text.trim()) continue;
    const exists = db.prepare('SELECT rowid FROM output_fts WHERE rowid = ?').get(row.id);
    if (!exists) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(row.id, text, row.agent_id);
      added++;
    }
  }
  if (added > 0) console.log(`[fts] indexed ${added} new output rows`);
}

export function searchOutputs(query: string, limit = 50): SearchResult[] {
  const db = getDb();
  const sql = `
    SELECT
      f.agent_id,
      snippet(output_fts, 0, '<mark>', '</mark>', '…', 20) as excerpt,
      ao.seq, ao.event_type,
      a.status as agent_status,
      j.id as job_id, j.title as job_title
    FROM output_fts f
    JOIN agent_output ao ON ao.id = f.rowid
    JOIN agents a ON a.id = f.agent_id
    JOIN jobs j ON j.id = a.job_id
    WHERE output_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const rows = db.prepare(sql).all(query, limit);
    return rows.map(r => cast<SearchResult>({ ...r as DbRow }));
  } catch {
    // Invalid FTS query — try as quoted phrase
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const rows = db.prepare(sql).all(escaped, limit);
      return rows.map(r => cast<SearchResult>({ ...r as DbRow }));
    } catch { return []; }
  }
}

export function getAgentOutput(agentId: string, tail?: number): AgentOutput[] {
  const db = getDb();
  if (tail) {
    // Fetch the last `tail` rows then re-order ascending
    const rows = db.prepare(
      'SELECT * FROM (SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC'
    ).all(agentId, tail);
    return rows.map(r => cast<AgentOutput>(r));
  }
  const rows = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq ASC').all(agentId);
  return rows.map(r => cast<AgentOutput>(r));
}

export function getLatestAgentOutput(agentId: string): AgentOutput | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT 1').get(agentId);
  return row ? cast<AgentOutput>(row) : null;
}

export function getAgentFullOutput(agentId: string, tailLines?: number): AgentOutputSegment[] {
  const db = getDb();
  // Walk the parent chain to build oldest-first list of agents
  const chain: Agent[] = [];
  let current = getAgentById(agentId);
  while (current) {
    chain.unshift(current);
    if (!current.parent_agent_id) break;
    // MCP sub-agents have parent_agent_id set to the spawning agent, but their
    // job was created via create_job (created_by_agent_id is set). Their output
    // is independent — don't prepend the parent's transcript.
    const currentJob = getJobById(current.job_id);
    if (currentJob?.created_by_agent_id) break;
    current = getAgentById(current.parent_agent_id);
  }

  return chain.map(agent => {
    const job = getJobById(agent.job_id);
    const output = getAgentOutput(agent.id, tailLines);
    let truncated = false;
    if (tailLines) {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_output WHERE agent_id = ?').get(agent.id);
      const total = cast<{ cnt: number }>(row).cnt;
      truncated = total > tailLines;
    }
    return { agent_id: agent.id, job_title: job?.title ?? '(unknown)', job_description: job?.description ?? '', output, truncated };
  });
}

/**
 * Trim a raw stream-json content string for terminal display.
 * The terminal renderer only displays: assistant text blocks, tool names
 * (with a 120-char input preview), system/result/error messages.
 * Everything else (user/tool_result events, large tool inputs) is invisible
 * but can account for 90%+ of the payload. Strip it server-side.
 */
function trimContentForDisplay(content: string): string {
  // Fast path: short strings never need trimming
  if (content.length < 512) return content;
  try {
    const ev = JSON.parse(content);
    // 'user' events render to empty string in the terminal — gut them entirely.
    // Keep just the type so the client's JSON.parse still works.
    if (ev.type === 'user') {
      return '{"type":"user"}';
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      let changed = false;
      for (const block of ev.message.content) {
        if (block.type === 'tool_use' && block.input != null) {
          const str = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
          if (str.length > 200) {
            block.input = str.slice(0, 200);
            changed = true;
          }
        }
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string' && block.content.length > 200) {
            block.content = block.content.slice(0, 200) + '…';
            changed = true;
          } else if (Array.isArray(block.content)) {
            block.content = [{ type: 'text', text: '(trimmed)' }];
            changed = true;
          }
        }
        // Extended thinking blocks are not rendered in the terminal.
        // Strip the large cryptographic signature and trim the thinking text.
        if (block.type === 'thinking') {
          if (block.signature) { delete block.signature; changed = true; }
          if (typeof block.thinking === 'string' && block.thinking.length > 100) {
            block.thinking = block.thinking.slice(0, 100) + '…';
            changed = true;
          }
        }
      }
      if (changed) return JSON.stringify(ev);
    }
    if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.length > 2000) {
      ev.result = ev.result.slice(0, 2000) + '…';
      return JSON.stringify(ev);
    }
    // Codex: item.completed with command_execution — client caps aggregated_output at 500 chars
    if (ev.type === 'item.completed' && ev.item) {
      let changed = false;
      if (ev.item.type === 'command_execution' && typeof ev.item.aggregated_output === 'string' && ev.item.aggregated_output.length > 600) {
        ev.item.aggregated_output = ev.item.aggregated_output.slice(0, 600);
        changed = true;
      }
      if (changed) return JSON.stringify(ev);
    }
    // Codex: item.started events can be large but render nothing
    if (ev.type === 'item.started' && ev.item) {
      return JSON.stringify({ type: ev.type, item: { type: ev.item.type, id: ev.item.id } });
    }
    return content;
  } catch {
    return content;
  }
}

/** Like getAgentFullOutput but trims content payloads for terminal display. */
export function getAgentFullOutputSlim(agentId: string, tailLines?: number): AgentOutputSegment[] {
  const segments = getAgentFullOutput(agentId, tailLines);
  for (const seg of segments) {
    for (const row of seg.output) {
      row.content = trimContentForDisplay(row.content);
    }
  }
  return segments;
}

// ── Server-side terminal rendering ────────────────────────────────────────────
// Mirrors the client's renderEvent/renderCodexEvent logic so the client can
// just term.write() a single string instead of JSON.parse-ing each row.

function renderEventServer(content: string): string {
  try {
    const ev = JSON.parse(content);
    // Codex events have dotted type names
    if (typeof ev.type === 'string' && ev.type.includes('.')) {
      return renderCodexEventServer(ev);
    }
    return renderClaudeEventServer(ev);
  } catch {
    return content + '\r\n';
  }
}

function renderClaudeEventServer(ev: ClaudeStreamEvent): string {
  switch (ev.type) {
    case 'system': {
      const modelInfo = ev.model ? ` | ${ev.model}` : '';
      return `\x1b[36m[${ev.subtype ?? 'system'}${modelInfo}]\x1b[0m\r\n`;
    }
    case 'assistant': {
      const blocks = ev.message?.content ?? [];
      let out = '';
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          out += `\r\n${block.text}\r\n`;
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? (typeof block.input === 'string' ? block.input : JSON.stringify(block.input)) : '';
          const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
          out += `\r\n\x1b[2m⚙ ${block.name}`;
          if (preview && preview !== '{}') out += `(${preview})`;
          out += `\x1b[0m\r\n`;
        }
      }
      return out;
    }
    case 'result': {
      if (ev.is_error) {
        return `\r\n\x1b[31m✗ ${ev.result || 'error'}\x1b[0m\r\n`;
      }
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    }
    case 'error':
      return `\x1b[31m✗ ${ev.error?.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

function renderCodexEventServer(ev: CodexStreamEvent): string {
  switch (ev.type) {
    case 'thread.started':
      return `\x1b[36m[codex thread ${ev.thread_id ?? ''}]\x1b[0m\r\n`;
    case 'item.completed': {
      const item = ev.item;
      if (!item) return '';
      if (item.type === 'reasoning' && item.text) {
        return `\r\n\x1b[2m\x1b[3m${item.text}\x1b[0m\r\n`;
      }
      if (item.type === 'agent_message' && item.text) {
        return `\r\n${item.text}\r\n`;
      }
      if (item.type === 'command_execution') {
        let out = `\r\n\x1b[2m⚙ ${item.command ?? 'command'}\x1b[0m\r\n`;
        if (item.aggregated_output) {
          const preview = item.aggregated_output.length > 500
            ? item.aggregated_output.slice(0, 500) + '…'
            : item.aggregated_output;
          out += `\x1b[2m${preview}\x1b[0m\r\n`;
        }
        if (item.exit_code != null && item.exit_code !== 0) {
          out += `\x1b[31m(exit ${item.exit_code})\x1b[0m\r\n`;
        }
        return out;
      }
      return '';
    }
    case 'turn.completed':
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    case 'turn.failed':
      return `\r\n\x1b[31m✗ Turn failed${ev.message ? ': ' + ev.message : ''}\x1b[0m\r\n`;
    case 'error':
      return `\x1b[31m✗ ${ev.error?.message ?? ev.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

export interface PrerenderedOutput {
  text: string;
  truncated: boolean;
}

/** Pre-render agent output to terminal ANSI text server-side. */
export function getAgentPrerenderedOutput(agentId: string, tailLines?: number): PrerenderedOutput {
  const segments = getAgentFullOutput(agentId, tailLines);
  let text = '';
  let truncated = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.truncated) truncated = true;
    if (i > 0) {
      text += `\r\n\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n`;
      text += `\x1b[2m↩ ${seg.job_description}\x1b[0m\r\n`;
      text += `\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n\r\n`;
    }
    for (const row of seg.output) {
      text += renderEventServer(row.content);
    }
  }
  return { text, truncated };
}

export function getAgentLastSeq(agentId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT MAX(seq) as last_seq FROM agent_output WHERE agent_id = ?').get(agentId);
  const v = cast<{ last_seq: number | null }>(row);
  return v.last_seq ?? -1;
}

/**
 * Prune output rows for agents that have been in a terminal state for a while.
 * Keeps the last `keepTail` rows per agent and deletes the rest, preventing
 * unbounded growth of the agent_output table for long-running orchestrator
 * instances with many completed agents.
 *
 * Returns the total number of rows deleted.
 */
export function pruneOldAgentOutput(maxAgeMs: number = 24 * 60 * 60 * 1000, keepTail: number = 200): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;

  // Find agents that finished before the cutoff and have output rows beyond keepTail
  const candidates = db.prepare(`
    SELECT a.id as agent_id, COUNT(o.id) as output_count
    FROM agents a
    JOIN agent_output o ON o.agent_id = a.id
    WHERE a.status IN ('done', 'failed', 'cancelled')
      AND a.finished_at IS NOT NULL
      AND a.finished_at < ?
    GROUP BY a.id
    HAVING output_count > ?
  `).all(cutoff, keepTail) as Array<{ agent_id: string; output_count: number }>;

  let totalDeleted = 0;
  for (const { agent_id, output_count } of candidates) {
    const deleteCount = output_count - keepTail;
    // Delete the oldest rows (lowest seq values) beyond the tail
    const result = db.prepare(`
      DELETE FROM agent_output
      WHERE id IN (
        SELECT id FROM agent_output
        WHERE agent_id = ?
        ORDER BY seq ASC
        LIMIT ?
      )
    `).run(agent_id, deleteCount);
    totalDeleted += result.changes;
  }

  return totalDeleted;
}
