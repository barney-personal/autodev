import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, insertTestJob } from './helpers.js';
import { markModelUnavailable, getModelUnavailability, clearModelUnavailability, isModelAccessError, hasAgentWorkStarted } from '../server/orchestrator/ModelAvailability.js';
import { getAvailableModel, _resetForTest } from '../server/orchestrator/ModelClassifier.js';
import { accumulateAgentMessageTokens, getAgentById, insertAgent } from '../server/db/queries.js';

describe('durable provider accounting and availability', () => {
  beforeEach(async () => { await setupTestDb(); _resetForTest(); });
  afterEach(async () => { vi.useRealTimers(); await cleanupTestDb(); });

  it('remembers definite model access denials and chooses an available Codex fallback', () => {
    const error = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
    expect(isModelAccessError(error)).toBe(true);
    expect(isModelAccessError('request timed out while loading model')).toBe(false);
    markModelUnavailable('codex-gpt-6.1-sol', error);
    _resetForTest(); // clear process-local state; persisted access denial remains
    expect(getAvailableModel('codex-gpt-6.1-sol')).toBe('codex-gpt-6-astra');
    expect(getModelUnavailability('codex-gpt-6.1-sol')?.reason).toBe(error);
    clearModelUnavailability('codex-gpt-6.1-sol');
    expect(getAvailableModel('codex-gpt-6.1-sol')).toBe('codex-gpt-6.1-sol');
  });

  it('does not treat missing model files or tool failures as account denial', () => {
    for (const text of ['model file not found', 'model weights not available', 'model loader failed: database not found']) {
      expect(isModelAccessError(text)).toBe(false);
    }
    expect(isModelAccessError("The model 'gpt-6-astra' does not exist or you do not have access to it.")).toBe(true);
  });

  it('blocks automatic model retry once a provider emitted work, even before usage arrives', () => {
    expect(hasAgentWorkStarted({ type: 'thread.started' })).toBe(false);
    expect(hasAgentWorkStarted({ type: 'turn.failed' })).toBe(false);
    expect(hasAgentWorkStarted({ type: 'assistant' })).toBe(true);
    expect(hasAgentWorkStarted({ type: 'item.started', item: { type: 'command_execution' } })).toBe(true);
    expect(hasAgentWorkStarted({ type: 'item.completed', item: { type: 'mcp_tool_call' } })).toBe(true);
  });

  it('expires model denials so newly enabled access can be retried', () => {
    markModelUnavailable('codex-gpt-6.1-sol', 'model not available');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(getModelUnavailability('codex-gpt-6.1-sol')).toBeNull();
  });

  it('counts repeated and growing Claude message usage once, including replay', async () => {
    const job = await insertTestJob();
    insertAgent({ id: 'accounting-agent', job_id: job.id, status: 'running' });
    accumulateAgentMessageTokens('accounting-agent', 'msg-1', 100, 20);
    accumulateAgentMessageTokens('accounting-agent', 'msg-1', 100, 20);
    accumulateAgentMessageTokens('accounting-agent', 'msg-1', 100, 45);
    accumulateAgentMessageTokens('accounting-agent', 'msg-2', 150, 30);
    accumulateAgentMessageTokens('accounting-agent', 'msg-1', 100, 20);
    expect(getAgentById('accounting-agent')).toMatchObject({ estimated_input_tokens: 250, estimated_output_tokens: 75 });
  });
});
