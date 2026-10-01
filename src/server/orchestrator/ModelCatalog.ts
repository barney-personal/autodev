import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CODEX_MODEL_OPTIONS_FALLBACK, type ModelOption } from '../../shared/models.js';

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Authentication is checked afresh: logging in must not require a server restart. */
export function hasCodexCredentials(): boolean {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return true;
  try {
    const auth = JSON.parse(readFileSync(join(codexHome(), 'auth.json'), 'utf8'));
    return Boolean(auth.OPENAI_API_KEY || auth.api_key || auth.tokens?.access_token);
  } catch { return false; }
}

export interface CodexCatalog {
  models: ModelOption[];
  source: 'codex-cli' | 'fallback';
  fetchedAt: number | null;
}

/** Use the installed harness catalog. Actual startup denials override advertised access. */
export function parseCodexCatalog(raw: string): CodexCatalog | null {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return null;
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const model of data.models) {
      if (model.visibility !== 'list' || typeof model.slug !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model.slug) || seen.has(model.slug)) continue;
      seen.add(model.slug);
      models.push({ value: `codex-${model.slug}`, label: `Codex — ${model.slug}` });
    }
    if (!models.length) return null;
    const date = Date.parse(data.fetched_at ?? '');
    return {
      models: [{ value: 'codex', label: 'Codex — configured CLI default' }, ...models],
      source: 'codex-cli',
      fetchedAt: Number.isFinite(date) ? date : null,
    };
  } catch { return null; }
}

export function getCodexCatalog(): CodexCatalog {
  // Tests must not read the developer's account catalog.
  if (process.env.NODE_ENV !== 'test') {
    try {
      const catalog = parseCodexCatalog(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8'));
      if (catalog) return catalog;
    } catch { /* CLI absent or has not fetched a catalog yet */ }
  }
  return { models: CODEX_MODEL_OPTIONS_FALLBACK, source: 'fallback', fetchedAt: null };
}
