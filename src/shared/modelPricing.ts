/**
 * Estimate USD cost from model + token counts.
 *
 * Pricing is per million tokens. We use regular (non-cached) input pricing
 * which slightly overestimates when cache reads are involved — safe direction
 * for budget enforcement.
 */

interface ModelPricing {
  cacheReadMultiplier?: number;
  inputPerMillion: number;
  outputPerMillion: number;
}

// Current model prices verified October 2026; legacy prices retained for historical jobs.
// 1M-context ([1m]) variants are billed at the standard rate (no long-context premium).
const PRICING: Record<string, ModelPricing> = {
  // Standard API prices verified 2026-10-01; subscription usage is an estimate.
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20, cacheReadMultiplier: 0.05 },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, cacheReadMultiplier: 0.05 },
  'codex-gpt-6-astra': { inputPerMillion: 10, outputPerMillion: 50 },
  'codex-gpt-6.1-sol': { inputPerMillion: 2, outputPerMillion: 10, cacheReadMultiplier: 0.05 },
  'codex-gpt-6-luna': { inputPerMillion: 0.1, outputPerMillion: 0.5 },

  // Fable 5 launch pricing (June 2026).
  'claude-fable-5':          { inputPerMillion: 10,  outputPerMillion: 50 },
  'claude-fable-5[1m]':      { inputPerMillion: 10,  outputPerMillion: 50 },
  'claude-opus-4-8':         { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-opus-4-8[1m]':     { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-opus-4-7':         { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-opus-4-7[1m]':     { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-opus-4-6':         { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-opus-4-6[1m]':     { inputPerMillion: 5,   outputPerMillion: 25 },
  'claude-sonnet-4-6':       { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-sonnet-4-6[1m]':   { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
};

// Default fallback — Sonnet pricing
const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15 };

function getPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  return PRICING[model] ?? DEFAULT_PRICING;
}

/** List of Claude model names this server knows pricing for. Used as a
 * sanity-check at startup for env-configured model names. */
export function getKnownClaudeModels(): string[] {
  return Object.keys(PRICING).filter(model => model.startsWith('claude-'));
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
       + (cacheReadTokens / 1_000_000) * p.inputPerMillion * (p.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER)
       + (cacheCreateTokens / 1_000_000) * p.inputPerMillion * CACHE_WRITE_MULTIPLIER
       + (outputTokens / 1_000_000) * p.outputPerMillion;
}
