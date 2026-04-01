import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ModelOption } from '../../shared/models.js';
import { CODEX_MODEL_OPTIONS_FALLBACK, CLAUDE_MODEL_OPTIONS } from '../../shared/models.js';
import { getRateLimitStatus, markModelRateLimited, clearModelRateLimit } from '../orchestrator/ModelClassifier.js';

const router = Router();

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Codex-relevant model slugs: include gpt-5.x that work in codex (not chat/search/nano variants)
const CODEX_MODEL_INCLUDE = /^gpt-5(\.\d+)?(-codex|-pro)?$/;
const CODEX_MODEL_EXCLUDE = /chat|search|nano|mini/;

let cachedCodexModels: ModelOption[] = CODEX_MODEL_OPTIONS_FALLBACK;
let lastFetchedAt: number | null = null;

function getCodexApiKey(): string | null {
  try {
    const auth = JSON.parse(readFileSync(join(process.env.HOME ?? '~', '.codex', 'auth.json'), 'utf8'));
    return auth.OPENAI_API_KEY ?? auth.api_key ?? null;
  } catch {
    return null;
  }
}

async function refreshCodexModels(): Promise<void> {
  const apiKey = getCodexApiKey();
  if (!apiKey) {
    console.log('[models] no codex API key found, using fallback list');
    return;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[models] OpenAI API returned ${res.status}, keeping cached list`);
      return;
    }
    const data = await res.json() as { data: { id: string }[] };

    const slugs = data.data
      .map(m => m.id)
      .filter(id => CODEX_MODEL_INCLUDE.test(id) && !CODEX_MODEL_EXCLUDE.test(id))
      .sort((a, b) => b.localeCompare(a)); // newest first

    if (slugs.length === 0) {
      console.warn('[models] OpenAI returned no matching codex models, keeping cached list');
      return;
    }

    cachedCodexModels = [
      { value: 'codex', label: `codex — default (${slugs[0]})` },
      ...slugs.map(slug => ({ value: `codex-${slug}`, label: `codex — ${slug}` })),
    ];
    lastFetchedAt = Date.now();
    console.log(`[models] refreshed codex model list: ${slugs.join(', ')}`);
  } catch (err: any) {
    console.warn('[models] failed to fetch OpenAI models:', err.message);
  }
}

// Fetch on startup, then on a repeating interval
refreshCodexModels();
setInterval(refreshCodexModels, REFRESH_INTERVAL_MS);

router.get('/', (_req, res) => {
  res.json({
    claude: CLAUDE_MODEL_OPTIONS,
    codex: cachedCodexModels,
    lastFetchedAt,
    rateLimits: getRateLimitStatus(),
  });
});

router.get('/rate-limits', (_req, res) => {
  res.json(getRateLimitStatus());
});

router.post('/rate-limits', (req, res) => {
  const { model, cooldownMs } = req.body;
  if (!model || typeof model !== 'string') {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  markModelRateLimited(model, cooldownMs ?? 300_000);
  res.json(getRateLimitStatus());
});

router.delete('/rate-limits/:model', (req, res) => {
  clearModelRateLimit(decodeURIComponent(req.params.model));
  res.json(getRateLimitStatus());
});

export default router;
