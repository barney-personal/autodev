import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job } from '../../shared/types.js';

// The model used to do the classification itself — always Haiku, cheap and fast
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const COMPLEXITY_TO_MODEL: Record<string, string> = {
  simple:  'claude-haiku-4-5-20251001',
  medium:  'claude-sonnet-4-6[1m]',
  complex: 'claude-opus-4-6[1m]',
};

// ─── Rate Limit Fallback Chain ──────────────────────────────────────────────
// When a model is rate-limited, fall through to the next available model.
const MODEL_FALLBACK_CHAIN: string[] = [
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const _rateLimitCooldowns = new Map<string, number>();

export function markModelRateLimited(model: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  const expiry = Date.now() + cooldownMs;
  _rateLimitCooldowns.set(model, expiry);
  queries.upsertNote(`ratelimit:${model}`, String(expiry), null);
  console.log(`[classifier] marked ${model} as rate-limited for ${Math.round(cooldownMs / 1000)}s (until ${new Date(expiry).toISOString()})`);
}

export function clearModelRateLimit(model: string): void {
  _rateLimitCooldowns.delete(model);
  try { queries.upsertNote(`ratelimit:${model}`, '0', null); } catch { /* ignore */ }
}

export function isModelRateLimited(model: string): boolean {
  const memExpiry = _rateLimitCooldowns.get(model);
  if (memExpiry) {
    if (Date.now() < memExpiry) return true;
    _rateLimitCooldowns.delete(model);
  }
  const note = queries.getNote(`ratelimit:${model}`);
  if (note) {
    const exp = parseInt(note.value, 10);
    if (!isNaN(exp) && Date.now() < exp) {
      _rateLimitCooldowns.set(model, exp);
      return true;
    }
  }
  return false;
}

/**
 * Given a preferred model, return the best available model that isn't
 * currently rate-limited. Falls through MODEL_FALLBACK_CHAIN in order.
 * If the preferred model isn't in the chain, returns it as-is.
 */
export function getFallbackModel(preferredModel: string): string {
  if (!isModelRateLimited(preferredModel)) return preferredModel;
  const idx = MODEL_FALLBACK_CHAIN.indexOf(preferredModel);
  if (idx < 0) return preferredModel;
  for (let i = idx + 1; i < MODEL_FALLBACK_CHAIN.length; i++) {
    if (!isModelRateLimited(MODEL_FALLBACK_CHAIN[i])) {
      console.log(`[classifier] ${preferredModel} rate-limited → falling back to ${MODEL_FALLBACK_CHAIN[i]}`);
      return MODEL_FALLBACK_CHAIN[i];
    }
  }
  const last = MODEL_FALLBACK_CHAIN[MODEL_FALLBACK_CHAIN.length - 1];
  console.log(`[classifier] all models rate-limited → using ${last} (lowest tier)`);
  return last;
}

export function getRateLimitStatus(): Array<{ model: string; rateLimited: boolean; expiresAt: number | null }> {
  return MODEL_FALLBACK_CHAIN.map(model => {
    const memExpiry = _rateLimitCooldowns.get(model);
    const noteExpiry = (() => {
      const note = queries.getNote(`ratelimit:${model}`);
      return note ? parseInt(note.value, 10) : 0;
    })();
    const expiry = Math.max(memExpiry ?? 0, noteExpiry);
    const limited = expiry > Date.now();
    return { model, rateLimited: limited, expiresAt: limited ? expiry : null };
  });
}

/**
 * If the job has no model set (null), ask Haiku to classify it as
 * simple/medium/complex, then map that to haiku/sonnet/opus and persist
 * the result on the job row.
 *
 * If the selected model is rate-limited, falls through the fallback chain.
 * If ANTHROPIC_API_KEY is absent or the API call fails, falls back to sonnet.
 *
 * Returns the model string that should be passed to the agent.
 */
export async function resolveModel(job: Job): Promise<string> {
  // Explicit model chosen by user — respect it, but check rate limits
  if (job.model !== null) {
    const effective = getFallbackModel(job.model);
    if (effective !== job.model) {
      queries.updateJobModel(job.id, effective);
      socket.emitJobUpdate(queries.getJobById(job.id)!);
    }
    return effective;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const fallback = getFallbackModel('claude-sonnet-4-6[1m]');
    console.warn(`[classifier] ANTHROPIC_API_KEY not set — defaulting to ${fallback}`);
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }

  const prompt = buildClassifierPrompt(job);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as any;
    const word = (data.content?.[0]?.text ?? '').trim().toLowerCase();
    const complexity = (['simple', 'medium', 'complex'] as const).find(c => word.includes(c)) ?? 'medium';
    const classified = COMPLEXITY_TO_MODEL[complexity];
    const model = getFallbackModel(classified);

    console.log(`[classifier] "${job.title}" → ${complexity} → ${classified}${model !== classified ? ` → ${model} (fallback)` : ''}`);

    queries.updateJobModel(job.id, model);
    socket.emitJobUpdate(queries.getJobById(job.id)!);

    return model;
  } catch (err) {
    const fallback = getFallbackModel('claude-sonnet-4-6[1m]');
    console.error(`[classifier] failed, falling back to ${fallback}:`, err);
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }
}

function buildClassifierPrompt(job: Job): string {
  const desc = job.description.slice(0, 600);
  return `Classify this software task by complexity. Reply with exactly one word: simple, medium, or complex.

simple  = small, well-scoped, one file or one function (e.g. fix a typo, list files, add a log line)
medium  = moderate scope, some reasoning needed (e.g. add a feature, write tests, refactor a module)
complex = broad scope, architecture/design decisions, many files (e.g. new subsystem, large refactor)

Title: ${job.title}
Description: ${desc}`;
}
