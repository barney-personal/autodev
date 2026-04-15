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

describe('ModelClassifier family-level rate-limit aliasing', () => {
  beforeEach(async () => {
    await setupTestDb();
    const { _resetForTest } = await import('../server/orchestrator/ModelClassifier.js');
    _resetForTest();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  // Real-world motivation: the Anthropic prompt-bytes-per-hour limit is shared
  // between claude-sonnet-4-6 and claude-sonnet-4-6[1m] (same underlying model,
  // different context windows). If we mark only one variant as rate-limited,
  // the fallback chain picks the sibling and hits the same 429 immediately,
  // burning a fallback slot and wall-clock time.

  it('marking claude-sonnet-4-6[1m] also marks claude-sonnet-4-6 (shared org bucket)', async () => {
    const { markModelRateLimited, isModelRateLimited } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    markModelRateLimited('claude-sonnet-4-6[1m]', 60_000);

    expect(isModelRateLimited('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isModelRateLimited('claude-sonnet-4-6')).toBe(true);
  });

  it('marking claude-opus-4-6 also marks claude-opus-4-6[1m]', async () => {
    const { markModelRateLimited, isModelRateLimited } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    markModelRateLimited('claude-opus-4-6', 60_000);

    expect(isModelRateLimited('claude-opus-4-6')).toBe(true);
    expect(isModelRateLimited('claude-opus-4-6[1m]')).toBe(true);
  });

  it('does NOT cross family boundaries — opus limit does not affect sonnet', async () => {
    const { markModelRateLimited, isModelRateLimited } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    markModelRateLimited('claude-opus-4-6[1m]', 60_000);

    expect(isModelRateLimited('claude-opus-4-6')).toBe(true);
    expect(isModelRateLimited('claude-opus-4-6[1m]')).toBe(true);
    expect(isModelRateLimited('claude-sonnet-4-6')).toBe(false);
    expect(isModelRateLimited('claude-sonnet-4-6[1m]')).toBe(false);
    expect(isModelRateLimited('claude-haiku-4-5-20251001')).toBe(false);
    expect(isModelRateLimited('codex')).toBe(false);
  });

  it('clearModelRateLimit clears the whole family', async () => {
    const { markModelRateLimited, clearModelRateLimit, isModelRateLimited } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    markModelRateLimited('claude-sonnet-4-6[1m]', 60_000);
    expect(isModelRateLimited('claude-sonnet-4-6')).toBe(true);
    expect(isModelRateLimited('claude-sonnet-4-6[1m]')).toBe(true);

    clearModelRateLimit('claude-sonnet-4-6');

    expect(isModelRateLimited('claude-sonnet-4-6')).toBe(false);
    expect(isModelRateLimited('claude-sonnet-4-6[1m]')).toBe(false);
  });

  it('haiku and codex are singleton families (no [1m] variant)', async () => {
    const { markModelRateLimited, isModelRateLimited } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    markModelRateLimited('claude-haiku-4-5-20251001', 60_000);
    expect(isModelRateLimited('claude-haiku-4-5-20251001')).toBe(true);
    // No siblings to mark — just the one model.
    expect(isModelRateLimited('claude-sonnet-4-6')).toBe(false);
    expect(isModelRateLimited('codex')).toBe(false);
  });

  it('getAvailableModel skips the whole family once any variant is limited', async () => {
    const { markModelRateLimited, getAvailableModel } = await import(
      '../server/orchestrator/ModelClassifier.js'
    );

    // Simulate: sonnet family hits org-wide prompt-bytes-per-hour bucket.
    markModelRateLimited('claude-sonnet-4-6[1m]', 60_000);

    // Previously: fallback from sonnet[1m] would pick sonnet-4-6 (next in chain)
    // and hit the same 429. Now it should skip the whole sonnet family and
    // land on haiku (next-next in MODEL_FALLBACK_CHAIN).
    const fallback = getAvailableModel('claude-sonnet-4-6[1m]');
    expect(fallback).toBe('claude-haiku-4-5-20251001');
  });
});
