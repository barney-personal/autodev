import { estimateCostUsd } from './CostEstimator.js';
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
      const usage = parsed.message?.usage ?? parsed.usage;
      if (usage) {
        inputTokens = (usage.input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0);
        outputTokens = usage.output_tokens ?? 0;
        if (typeof parsed.message?.id === 'string') {
          queries.accumulateAgentMessageTokens(agentId, parsed.message.id, inputTokens, outputTokens);
          return;
        }
      }
    } catch { /* malformed JSON — skip */ }
  }

  const codexUsage = (event as CodexStreamEvent).usage;
  if (event.type === 'turn.completed' && codexUsage) {
    // Codex input_tokens already includes cached_input_tokens.
    inputTokens = codexUsage.input_tokens ?? 0;
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

  // Terminal accounting must also run when finish_job already marked the
  // lifecycle complete; process-exit idempotency must not discard the bill.
  if (event.type === 'result') {
    const result = event as ClaudeStreamEvent;
    if (typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)) {
      queries.updateAgent(agentId, { cost_usd: result.total_cost_usd, ...(result.num_turns != null ? { num_turns: result.num_turns } : {}), ...(result.duration_ms != null ? { duration_ms: result.duration_ms } : {}) });
    }
  } else if (event.type === 'turn.completed') {
    const agent = queries.getAgentWithJob(agentId);
    if (agent) queries.updateAgent(agentId, { cost_usd: estimateCostUsd(agent.job.model, agent.estimated_input_tokens ?? 0, agent.estimated_output_tokens ?? 0) });
  }

  try { jobWatcher.onAgentEvent(agentId, event); } catch (err) { agentLogger(agentId).debug({ err }, 'watcher onAgentEvent failed'); }

  const latestRow = queries.getLatestAgentOutput(agentId);
  if (latestRow) socket.emitAgentOutput(agentId, latestRow);
}
