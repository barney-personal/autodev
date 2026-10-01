import { useState, useEffect } from 'react';
import type { ModelOption } from '@shared/models';
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS_FALLBACK } from '@shared/models';

interface ModelsResponse {
  claude: ModelOption[];
  codex: ModelOption[];
  lastFetchedAt: number | null;
}

// Module-level cache so all component instances share one fetch result
let cached: ModelsResponse | null = null;
let pendingFetch: Promise<ModelsResponse> | null = null;

function fetchModels(): Promise<ModelsResponse> {
  if (pendingFetch) return pendingFetch;
  pendingFetch = fetch('/api/models')
    .then(r => { if (!r.ok) throw new Error('Model catalog unavailable'); return r.json(); })
    .then((data: ModelsResponse) => {
      cached = data;
      pendingFetch = null;
      return data;
    })
    .catch(() => {
      pendingFetch = null;
      return { claude: CLAUDE_MODEL_OPTIONS, codex: CODEX_MODEL_OPTIONS_FALLBACK, lastFetchedAt: null };
    });
  return pendingFetch;
}

export function useModels() {
  const [models, setModels] = useState<ModelsResponse>(
    cached ?? { claude: CLAUDE_MODEL_OPTIONS, codex: CODEX_MODEL_OPTIONS_FALLBACK, lastFetchedAt: null }
  );

  useEffect(() => {
    if (cached) return; // already have fresh data
    fetchModels().then(setModels);
  }, []);

  return models;
}
