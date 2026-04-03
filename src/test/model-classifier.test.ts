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

describe('ModelClassifier cooldown restart resilience', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/ModelClassifier.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('isModelRateLimited returns true from DB fallback after memory clear', async () => {
    const {
      markModelRateLimited,
      isModelRateLimited,
      _resetForTest,
    } = await import('../server/orchestrator/ModelClassifier.js');

    // Mark a model as rate-limited (persists to both memory + DB)
    markModelRateLimited('claude-opus-4-6[1m]', 60_000);
    expect(isModelRateLimited('claude-opus-4-6[1m]')).toBe(true);

    // Simulate server restart: clear in-memory state
    _resetForTest();

    // DB fallback should still detect the cooldown
    expect(isModelRateLimited('claude-opus-4-6[1m]')).toBe(true);
  });

  it('isProviderRateLimited returns true from DB fallback after memory clear', async () => {
    const {
      markProviderRateLimited,
      isProviderRateLimited,
      _resetForTest,
    } = await import('../server/orchestrator/ModelClassifier.js');

    markProviderRateLimited('anthropic', 60_000);
    expect(isProviderRateLimited('anthropic')).toBe(true);

    // Simulate restart
    _resetForTest();

    // DB fallback still works
    expect(isProviderRateLimited('anthropic')).toBe(true);
  });

  it('rehydrateCooldownState pre-populates memory from DB', async () => {
    const {
      markModelRateLimited,
      markProviderRateLimited,
      rehydrateCooldownState,
      isModelRateLimited,
      isProviderRateLimited,
      _resetForTest,
    } = await import('../server/orchestrator/ModelClassifier.js');

    // Set up cooldowns (writes to DB)
    markModelRateLimited('claude-sonnet-4-6[1m]', 60_000);
    markProviderRateLimited('openai', 60_000);

    // Clear memory (simulates restart)
    _resetForTest();

    // Rehydrate from DB
    rehydrateCooldownState();

    // Both should be detected from memory now (no DB read needed)
    expect(isModelRateLimited('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isProviderRateLimited('openai')).toBe(true);
  });

  it('rehydrateCooldownState skips expired cooldowns', async () => {
    const {
      rehydrateCooldownState,
      isModelRateLimited,
      _resetForTest,
    } = await import('../server/orchestrator/ModelClassifier.js');
    const { upsertNote } = await import('../server/db/queries.js');

    // Insert an already-expired cooldown directly in DB
    upsertNote('ratelimit:claude-haiku-4-5-20251001', String(Date.now() - 1000), null);

    _resetForTest();
    rehydrateCooldownState();

    // Expired cooldown should NOT be treated as rate-limited
    expect(isModelRateLimited('claude-haiku-4-5-20251001')).toBe(false);
  });
});
