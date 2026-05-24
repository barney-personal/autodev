import { agentLogger } from '../lib/logger.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { isDbInitialized } from '../db/database.js';
import * as jobWatcher from './JobWatcherManager.js';
import type { ClaudeStreamEvent, CodexStreamEvent } from '../../shared/types.js';

export function storeOutput(agentId: string, seq: number, eventType: string, content: string): void {
  if (!isDbInitialized()) return;
  queries.insertAgentOutput({
    agent_id: agentId,
    seq,
    event_type: eventType,
    content,
    created_at: Date.now(),
  });
}

export function extractAndAccumulateTokens(
  agentId: string,
  event: ClaudeStreamEvent | CodexStreamEvent,
  raw: string,
): void {
  let inputTokens = 0;
  let outputTokens = 0;

  if (event.type === 'assistant') {
    try {
      const parsed = JSON.parse(raw);
      const usage = parsed.usage;
      if (usage) {
        inputTokens = (usage.input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0);
        outputTokens = usage.output_tokens ?? 0;
      }
    } catch { /* malformed JSON — skip */ }
  }

  const codexUsage = (event as CodexStreamEvent).usage;
  if (codexUsage) {
    inputTokens = (codexUsage.input_tokens ?? 0) + (codexUsage.cached_input_tokens ?? 0);
    outputTokens = codexUsage.output_tokens ?? 0;
  }

  if (inputTokens > 0 || outputTokens > 0) {
    queries.accumulateAgentTokens(agentId, inputTokens, outputTokens);
  }
}

export function handleStreamEvent(
  agentId: string,
  event: ClaudeStreamEvent | CodexStreamEvent,
  raw: string,
  seq: number,
): void {
  if (!isDbInitialized()) return;

  storeOutput(agentId, seq, event.type, raw);

  if (event.type === 'system' && (event as ClaudeStreamEvent).session_id) {
    queries.updateAgent(agentId, { session_id: (event as ClaudeStreamEvent).session_id });
  }

  if (event.type === 'thread.started' && (event as CodexStreamEvent).thread_id) {
    queries.updateAgent(agentId, { session_id: (event as CodexStreamEvent).thread_id });
  }

  extractAndAccumulateTokens(agentId, event, raw);

  try { jobWatcher.onAgentEvent(agentId, event); } catch (err) { agentLogger(agentId).debug({ err }, 'watcher onAgentEvent failed'); }

  const latestRow = queries.getLatestAgentOutput(agentId);
  if (latestRow) socket.emitAgentOutput(agentId, latestRow);
}
