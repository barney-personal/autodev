import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_WORKFLOW_IMPLEMENTER_MODEL,
  DEFAULT_WORKFLOW_REVIEWER_MODEL,
  getClaudeEffort,
  getCodexReasoningEffort,
  getCodexServiceTier,
  _resetEffortWarningsForTest,
} from '../shared/models.js';

// Save/restore any EFFORT_* / CODEX_SERVICE_TIER_* env vars the developer may
// have set locally so the assertions below (which depend on built-in defaults)
// stay deterministic.
const EFFORT_ENV_VARS = [
  'EFFORT_ASSESS', 'EFFORT_REVIEW', 'EFFORT_IMPLEMENT', 'EFFORT_VERIFY', 'EFFORT_DEFAULT',
  'CODEX_SERVICE_TIER_ASSESS', 'CODEX_SERVICE_TIER_REVIEW', 'CODEX_SERVICE_TIER_IMPLEMENT',
  'CODEX_SERVICE_TIER_VERIFY', 'CODEX_SERVICE_TIER_DEFAULT',
];
const savedEffortEnv: Record<string, string | undefined> = {};
function clearEffortEnv() {
  for (const k of EFFORT_ENV_VARS) {
    savedEffortEnv[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEffortEnv() {
  for (const k of EFFORT_ENV_VARS) {
    if (savedEffortEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEffortEnv[k];
  }
}

describe('shared model defaults', () => {
  beforeEach(clearEffortEnv);
  afterEach(restoreEffortEnv);

  it('pins workflow defaults to opus 4.7 and gpt-5.5', () => {
    expect(DEFAULT_WORKFLOW_IMPLEMENTER_MODEL).toBe('claude-opus-4-7[1m]');
    expect(DEFAULT_WORKFLOW_REVIEWER_MODEL).toBe('codex-gpt-5.5');
    expect(DEFAULT_CODEX_MODEL).toBe('codex-gpt-5.5');
  });

  it('uses xhigh effort for opus 4.7 by default (no phase)', () => {
    expect(getClaudeEffort(null)).toBeNull();
    expect(getClaudeEffort('claude-opus-4-7')).toBe('xhigh');
    expect(getClaudeEffort('claude-opus-4-7[1m]')).toBe('xhigh');
    expect(getClaudeEffort('claude-opus-4-6')).toBeNull();
  });

  it('uses xhigh reasoning effort for codex models by default (no phase)', () => {
    expect(getCodexReasoningEffort(null)).toBeNull();
    expect(getCodexReasoningEffort('codex')).toBe('xhigh');
    expect(getCodexReasoningEffort('codex-gpt-5.5')).toBe('xhigh');
    expect(getCodexReasoningEffort('claude-opus-4-7')).toBeNull();
  });
});

describe('phase-aware effort', () => {
  beforeEach(clearEffortEnv);
  afterEach(restoreEffortEnv);

  it('drops implement-phase effort to medium for both providers', () => {
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBe('medium');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'implement')).toBe('medium');
  });

  it('drops review-phase effort to high for both providers (paired with fast service tier)', () => {
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'review')).toBe('high');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'review')).toBe('high');
  });

  it('keeps xhigh effort for assess and verify phases', () => {
    for (const phase of ['assess', 'verify'] as const) {
      expect(getClaudeEffort('claude-opus-4-7', phase)).toBe('xhigh');
      expect(getCodexReasoningEffort('codex', phase)).toBe('xhigh');
    }
  });

  it('falls back to xhigh for unknown / idle phases', () => {
    expect(getClaudeEffort('claude-opus-4-7', 'idle')).toBe('xhigh');
    expect(getCodexReasoningEffort('codex', 'idle')).toBe('xhigh');
  });

  it('env vars override per-phase defaults', () => {
    process.env.EFFORT_IMPLEMENT = 'high';
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBe('high');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'implement')).toBe('high');
  });

  it('EFFORT_DEFAULT applies when no phase is set (null, undefined, or omitted)', () => {
    process.env.EFFORT_DEFAULT = 'medium';
    expect(getClaudeEffort('claude-opus-4-7', null)).toBe('medium');
    expect(getClaudeEffort('claude-opus-4-7', undefined)).toBe('medium');
    expect(getClaudeEffort('claude-opus-4-7')).toBe('medium');
    expect(getCodexReasoningEffort('codex', null)).toBe('medium');
    expect(getCodexReasoningEffort('codex', undefined)).toBe('medium');
    expect(getCodexReasoningEffort('codex')).toBe('medium');
  });

  it('empty env var disables the flag', () => {
    process.env.EFFORT_IMPLEMENT = '';
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBeNull();
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'implement')).toBeNull();
  });

  it('still returns null for models without effort gating, regardless of phase', () => {
    expect(getClaudeEffort('claude-sonnet-4-6[1m]', 'implement')).toBeNull();
    expect(getClaudeEffort('claude-opus-4-6', 'assess')).toBeNull();
    expect(getCodexReasoningEffort('claude-opus-4-7', 'implement')).toBeNull();
  });
});

describe('effort typo detection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearEffortEnv();
    _resetEffortWarningsForTest();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEffortEnv();
    warnSpy.mockRestore();
  });

  it('warns once when an env var has an unrecognised value', () => {
    process.env.EFFORT_IMPLEMENT = 'medum'; // intentional typo
    // Returns the value verbatim so the CLI surfaces the error
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBe('medum');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('EFFORT_IMPLEMENT="medum"');
    expect(warnSpy.mock.calls[0][0]).toContain('not a recognised effort level');

    // Repeat calls for the same value don't re-warn
    getClaudeEffort('claude-opus-4-7[1m]', 'implement');
    getCodexReasoningEffort('codex', 'implement');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn for known effort levels', () => {
    process.env.EFFORT_IMPLEMENT = 'low';
    process.env.EFFORT_ASSESS = 'minimal';
    process.env.EFFORT_REVIEW = 'xhigh';
    getClaudeEffort('claude-opus-4-7', 'implement');
    getClaudeEffort('claude-opus-4-7', 'assess');
    getClaudeEffort('claude-opus-4-7', 'review');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for the empty-string opt-out', () => {
    process.env.EFFORT_IMPLEMENT = '';
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('codex service tier', () => {
  beforeEach(clearEffortEnv);
  afterEach(restoreEffortEnv);

  it('defaults to fast tier for the review phase', () => {
    expect(getCodexServiceTier('codex-gpt-5.5', 'review')).toBe('fast');
    expect(getCodexServiceTier('codex', 'review')).toBe('fast');
  });

  it('returns null for non-review phases so config.toml takes effect', () => {
    expect(getCodexServiceTier('codex', 'assess')).toBeNull();
    expect(getCodexServiceTier('codex', 'implement')).toBeNull();
    expect(getCodexServiceTier('codex', 'verify')).toBeNull();
    expect(getCodexServiceTier('codex', null)).toBeNull();
    expect(getCodexServiceTier('codex')).toBeNull();
  });

  it('returns null for non-codex models', () => {
    expect(getCodexServiceTier('claude-opus-4-7', 'review')).toBeNull();
    expect(getCodexServiceTier(null, 'review')).toBeNull();
  });

  it('env vars override per-phase defaults', () => {
    process.env.CODEX_SERVICE_TIER_REVIEW = 'priority';
    process.env.CODEX_SERVICE_TIER_IMPLEMENT = 'fast';
    expect(getCodexServiceTier('codex', 'review')).toBe('priority');
    expect(getCodexServiceTier('codex', 'implement')).toBe('fast');
  });

  it('CODEX_SERVICE_TIER_DEFAULT applies when no phase is set', () => {
    process.env.CODEX_SERVICE_TIER_DEFAULT = 'flex';
    expect(getCodexServiceTier('codex', null)).toBe('flex');
    expect(getCodexServiceTier('codex')).toBe('flex');
  });

  it('empty string disables the per-phase default (config.toml takes effect)', () => {
    process.env.CODEX_SERVICE_TIER_REVIEW = '';
    expect(getCodexServiceTier('codex', 'review')).toBeNull();
  });
});

describe('codex service tier typo detection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearEffortEnv();
    _resetEffortWarningsForTest();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEffortEnv();
    warnSpy.mockRestore();
  });

  it('warns once when an unrecognised tier is passed via env', () => {
    process.env.CODEX_SERVICE_TIER_REVIEW = 'turbo'; // not a real tier
    expect(getCodexServiceTier('codex', 'review')).toBe('turbo');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('CODEX_SERVICE_TIER_REVIEW="turbo"');
    expect(warnSpy.mock.calls[0][0]).toContain('not a recognised Codex service tier');

    getCodexServiceTier('codex', 'review');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn for known tiers', () => {
    for (const tier of ['default', 'flex', 'priority', 'fast', 'auto']) {
      process.env.CODEX_SERVICE_TIER_REVIEW = tier;
      getCodexServiceTier('codex', 'review');
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
