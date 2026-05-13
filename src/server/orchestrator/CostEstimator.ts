/**
 * Estimate USD cost from model + token counts.
 *
 * Pricing is per million tokens. We use regular (non-cached) input pricing
 * which slightly overestimates when cache reads are involved — safe direction
 * for budget enforcement.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Pricing as of May 2025 — update when Anthropic changes rates.
const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':         { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-7[1m]':     { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-6':         { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-6[1m]':     { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-sonnet-4-6':       { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-sonnet-4-6[1m]':   { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80, outputPerMillion: 4 },
};

// Default fallback — Sonnet pricing
const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15 };

function getPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  return PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Estimate cost in USD given a model and accumulated token counts.
 */
export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = getPricing(model);
  return (inputTokens / 1_000_000) * p.inputPerMillion
       + (outputTokens / 1_000_000) * p.outputPerMillion;
}

// Anthropic prompt-caching pricing multipliers (relative to base input rate).
// 5-minute ephemeral cache (the kind we use on the watcher's system prompt):
//   - cache writes cost 1.25× the base input rate
//   - cache reads  cost 0.10× the base input rate
// See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

/**
 * Estimate cost in USD with disaggregated cache-tier token counts.
 *
 * Critical for components that anchor a cache_control breakpoint and pay
 * mostly cache-read input (e.g. the live watcher's repeated system prompt).
 * `estimateCostUsd` lumps cache reads in with regular input, which overstates
 * cache-heavy workloads by ~10× on the cache-read portion.
 */
export function estimateCostUsdDetailed(
  model: string | null,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  outputTokens: number,
): number {
  const p = getPricing(model);
  return (inputTokens / 1_000_000) * p.inputPerMillion
       + (cacheReadTokens / 1_000_000) * p.inputPerMillion * CACHE_READ_MULTIPLIER
       + (cacheCreateTokens / 1_000_000) * p.inputPerMillion * CACHE_WRITE_MULTIPLIER
       + (outputTokens / 1_000_000) * p.outputPerMillion;
}
