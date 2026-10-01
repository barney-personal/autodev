import { describe, it, expect } from 'vitest';
import { parseCodexCatalog } from '../server/orchestrator/ModelCatalog.js';
import { estimateCostUsd, estimateCostUsdDetailed } from '../shared/modelPricing.js';
import { getCodexReasoningEffort, getClaudeEffort } from '../shared/models.js';

describe('frontier model catalog and usage', () => {
  it('uses CLI access order and excludes hidden, duplicate, and unsafe entries', () => {
    const result = parseCodexCatalog(JSON.stringify({ fetched_at: '2026-10-01T09:00:00Z', models: [
      { slug: 'gpt-6.1-sol', visibility: 'list' },
      { slug: 'gpt-6-astra', visibility: 'list' },
      { slug: 'gpt-reserve', visibility: 'hide' },
      { slug: 'gpt-6.1-sol', visibility: 'list' },
      { slug: '$(touch unsafe)', visibility: 'list' },
    ] }));
    expect(result?.models.map(m => m.value)).toEqual(['codex', 'codex-gpt-6.1-sol', 'codex-gpt-6-astra']);
    expect(result?.source).toBe('codex-cli');
    expect(result?.fetchedAt).toBe(Date.parse('2026-10-01T09:00:00Z'));
  });
  it('rejects incomplete or malformed catalogs', () => {
    for (const raw of ['nope', '{}', '{"models":[]}', '{"models":[{"visibility":"list"}]}']) expect(parseCodexCatalog(raw)).toBeNull();
  });
  it('prices model roles independently and applies current cache rates', () => {
    expect(estimateCostUsd('codex-gpt-6-astra', 1e6, 1e6)).toBe(60);
    expect(estimateCostUsd('codex-gpt-6.1-sol', 1e6, 1e6)).toBe(12);
    expect(estimateCostUsd('codex-gpt-6-luna', 1e6, 1e6)).toBe(0.6);
    expect(estimateCostUsdDetailed('claude-opus-5-5', 0, 1e6, 0, 0)).toBe(0.2);
  });
  it('preserves pinned Codex effort and maps unsupported levels', () => {
    expect(getCodexReasoningEffort('codex-gpt-6-astra', 'implement', 'max')).toBe('max');
    expect(getCodexReasoningEffort('codex-gpt-6.1-sol', 'review', 'low')).toBe('low');
    expect(getCodexReasoningEffort('codex-gpt-6.1-sol', 'review', 'minimal')).toBe('low');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'review', 'max')).toBe('xhigh');
    expect(getClaudeEffort('claude-opus-5-5', 'review', 'max')).toBe('max');
    expect(getClaudeEffort('claude-opus-4-7', 'review', 'max')).toBe('xhigh');
  });
});
