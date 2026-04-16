import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import type { KBEntry } from '../../shared/types.js';

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_ENTRY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

let _interval: NodeJS.Timeout | null = null;

export function startKBConsolidator(): void {
  if (_interval) return;
  // Run first consolidation after a short delay (don't block startup)
  setTimeout(() => {
    runConsolidation().catch(err => { console.error('[kb-consolidator] error:', err); captureWithContext(err, { component: 'KBConsolidator' }); });
  }, 60_000);
  _interval = setInterval(() => {
    runConsolidation().catch(err => { console.error('[kb-consolidator] error:', err); captureWithContext(err, { component: 'KBConsolidator' }); });
  }, CONSOLIDATION_INTERVAL_MS);
  console.log('[kb-consolidator] started (every 6h)');
}

export function stopKBConsolidator(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

export interface ConsolidationResult {
  pruned: number;
  deduped: number;
  contradictions: number;
}

export async function runConsolidation(): Promise<ConsolidationResult> {
  console.log('[kb-consolidator] starting consolidation run');
  const result: ConsolidationResult = { pruned: 0, deduped: 0, contradictions: 0 };

  // Step 1: Prune stale entries (older than 90 days, never hit)
  result.pruned = queries.pruneStaleKBEntries(STALE_ENTRY_MAX_AGE_MS);
  if (result.pruned > 0) {
    console.log(`[kb-consolidator] pruned ${result.pruned} stale entries`);
  }

  // Step 2: Dedup clusters per project
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[kb-consolidator] no ANTHROPIC_API_KEY, skipping AI-based dedup/contradiction checks');
    return result;
  }

  const projects = queries.listProjects();
  // Process each project + global (null project)
  const projectIds: Array<string | null> = [...projects.map(p => p.id), null];

  for (const projectId of projectIds) {
    const entries = queries.getKBEntriesForProject(projectId);
    if (entries.length < 2) continue;

    // Step 2: Find duplicate clusters using FTS
    const dedupResult = await dedupCluster(entries, apiKey);
    result.deduped += dedupResult;

    // Step 3: Contradiction check (newest first, in batches of 20)
    const contradictionResult = await checkContradictions(entries, apiKey);
    result.contradictions += contradictionResult;
  }

  console.log(`[kb-consolidator] done: pruned=${result.pruned}, deduped=${result.deduped}, contradictions=${result.contradictions}`);
  return result;
}

/**
 * Send batches of entries to Haiku to identify duplicates.
 * Returns count of entries removed.
 */
async function dedupCluster(entries: KBEntry[], apiKey: string): Promise<number> {
  if (entries.length < 2) return 0;

  // Process in batches of 20 entries
  const BATCH_SIZE = 20;
  let removed = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    if (batch.length < 2) break;

    const entriesList = batch.map(e =>
      `[${e.id}] "${e.title}": ${e.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `You are deduplicating a knowledge base. These entries are from the same project scope.

Entries:
${entriesList}

Identify groups of DUPLICATE entries — entries that encode the SAME fact even if worded differently.
For each duplicate group, pick the BEST entry (most complete/accurate) to KEEP and list the rest to DELETE.

Respond with ONLY a JSON array of IDs to delete. If no duplicates found, respond with [].
Example: ["id-to-delete-1", "id-to-delete-2"]`;

    try {
      const idsToDelete = await callHaiku(apiKey, prompt);
      let parsed: unknown;
      try { parsed = JSON.parse(idsToDelete); } catch { parsed = []; }
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && batch.some(e => e.id === id)) {
            queries.deleteKBEntry(id);
            removed++;
          }
        }
      }
    } catch (err) {
      console.warn('[kb-consolidator] dedup batch error:', err);
    }
  }

  return removed;
}

/**
 * Send batches of entries (newest first) to Haiku to find contradictions.
 * When newer entries contradict older ones, the older entry is removed.
 * Returns count of entries removed.
 */
async function checkContradictions(entries: KBEntry[], apiKey: string): Promise<number> {
  if (entries.length < 2) return 0;

  // entries are already sorted newest-first from the query
  const BATCH_SIZE = 20;
  let removed = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    if (batch.length < 2) break;

    const entriesList = batch.map(e =>
      `[${e.id}] (${new Date(e.created_at).toISOString().split('T')[0]}) "${e.title}": ${e.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `You are checking a knowledge base for contradictions. Entries are listed newest first.

Entries:
${entriesList}

Identify entries that are CONTRADICTED by a NEWER entry (e.g., an older entry says "use npm" but a newer one says "use bun").
When a newer entry contradicts an older one, the older one should be removed.

Respond with ONLY a JSON array of IDs of the OLDER contradicted entries to delete. If no contradictions, respond with [].
Example: ["old-contradicted-id-1"]`;

    try {
      const idsToDelete = await callHaiku(apiKey, prompt);
      let parsed: unknown;
      try { parsed = JSON.parse(idsToDelete); } catch { parsed = []; }
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && batch.some(e => e.id === id)) {
            queries.deleteKBEntry(id);
            removed++;
          }
        }
      }
    } catch (err) {
      console.warn('[kb-consolidator] contradiction check error:', err);
    }
  }

  return removed;
}

// HTTP statuses that indicate a transient failure worth retrying.
// 408 request timeout, 429 rate limit, 500/502/503/504 server errors, 529 overloaded.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3; // up to 4 total attempts

/**
 * A network-level fetch failure that should be retried.
 * Node's undici wraps low-level connect errors in `TypeError: fetch failed`
 * with the real cause in `err.cause` (ECONNRESET, ETIMEDOUT, EHOSTUNREACH, etc.).
 */
function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Our own 30s AbortController timeout — don't retry, request took too long already.
  if (err.name === 'AbortError') return false;
  if (err.name === 'TypeError' && err.message === 'fetch failed') return true;
  const cause = (err as { cause?: unknown }).cause;
  const code = (err as { code?: string }).code
    ?? (cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined);
  return code !== undefined && RETRYABLE_NET_CODES.has(code);
}

const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE',
]);

/** Parse a Retry-After header value (seconds-or-HTTP-date) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Jittered backoff for inline HTTP retries: 1s, 3s, 8s (+/- 30%). */
function retryBackoffMs(attempt: number): number {
  const base = [1000, 3000, 8000][attempt] ?? 8000;
  const jitter = base * 0.3 * (2 * Math.random() - 1);
  return Math.max(250, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Exported for unit testing. Not part of the public orchestrator API.
export async function callHaiku(apiKey: string, prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: TRIAGE_MODEL,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
          const waitMs = retryAfter ?? retryBackoffMs(attempt);
          console.warn(`[kb-consolidator] Anthropic API ${response.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`Anthropic API ${response.status}: ${body}`);
      }

      const data = await response.json() as { content?: Array<{ text?: string }> };
      const text = (data.content?.[0]?.text ?? '').trim();
      return extractFirstJsonArray(text) ?? '[]';
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryableFetchError(err)) {
        const waitMs = retryBackoffMs(attempt);
        console.warn(`[kb-consolidator] fetch failed, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES}): ${(err as Error).message}`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

/**
 * Extract the first complete top-level JSON array from model output.
 * This is more robust than a greedy regex when the model adds commentary
 * before/after the array or includes additional bracketed text later on.
 */
export function extractFirstJsonArray(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === '[') {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '[') {
      depth++;
      continue;
    }

    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
