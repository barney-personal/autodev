import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from './helpers.js';

describe('ModelClassifier provider cooldowns', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/ModelClassifier.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('falls through to codex when the Anthropic provider is cooled down', async () => {
    const {
      markProviderRateLimited,
      getFallbackModel,
      getAvailableModel,
      clearProviderRateLimit,
    } = await import('../server/orchestrator/ModelClassifier.js');

    markProviderRateLimited('anthropic', 60_000);
    expect(getFallbackModel('claude-sonnet-4-6[1m]')).toBe('codex');
    expect(getAvailableModel('claude-sonnet-4-6[1m]')).toBe('codex');

    clearProviderRateLimit('anthropic');
    expect(getFallbackModel('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6[1m]');
  });

  it('returns null when both providers are cooled down', async () => {
    const {
      markProviderRateLimited,
      getAvailableModel,
      clearProviderRateLimit,
    } = await import('../server/orchestrator/ModelClassifier.js');

    markProviderRateLimited('anthropic', 60_000);
    markProviderRateLimited('openai', 60_000);

    expect(getAvailableModel('claude-sonnet-4-6[1m]')).toBeNull();

    clearProviderRateLimit('anthropic');
    clearProviderRateLimit('openai');
  });
});
