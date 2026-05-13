/**
 * Tests for estimateCostUsdDetailed — the cache-aware variant used by the
 * watcher. Regression: the original implementation lumped cache reads in
 * with regular input, overstating cache-heavy ticks by ~10× on the cache-
 * read portion (the watcher's system prompt is cache_control: ephemeral,
 * so most input after the first tick is a cache read).
 */
import { describe, it, expect } from 'vitest';
import { estimateCostUsd, estimateCostUsdDetailed } from '../server/orchestrator/CostEstimator.js';

describe('estimateCostUsdDetailed', () => {
  it('matches estimateCostUsd when there is no cache activity', () => {
    const detailed = estimateCostUsdDetailed('claude-opus-4-7', 1_000_000, 0, 0, 1_000_000);
    const plain = estimateCostUsd('claude-opus-4-7', 1_000_000, 1_000_000);
    expect(detailed).toBeCloseTo(plain, 6);
  });

  it('charges cache reads at 0.10× the base input rate', () => {
    // 1M cache-read tokens on Opus 4-7 ($15/M input) → $1.50
    const cost = estimateCostUsdDetailed('claude-opus-4-7', 0, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(1.50, 4);
  });

  it('charges cache writes at 1.25× the base input rate', () => {
    // 1M cache-create tokens on Opus 4-7 → $18.75
    const cost = estimateCostUsdDetailed('claude-opus-4-7', 0, 0, 1_000_000, 0);
    expect(cost).toBeCloseTo(18.75, 4);
  });

  it('produces meaningfully lower cost than the lumped estimate for cache-heavy ticks', () => {
    // Realistic watcher tick: 200 fresh input, 8000 cache-read, 0 cache-create, 400 output.
    const detailed = estimateCostUsdDetailed('claude-opus-4-7', 200, 8000, 0, 400);
    // The lumped estimate (old behaviour) would charge all 8200 at full input rate.
    const lumped = estimateCostUsd('claude-opus-4-7', 200 + 8000 + 0, 400);
    // Detailed cost should be at least 3× cheaper because 8000 of those tokens
    // are cache reads at 10% of base.
    expect(detailed * 3).toBeLessThan(lumped);
  });
});
