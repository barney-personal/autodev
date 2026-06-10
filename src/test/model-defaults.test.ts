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

  it('pins workflow defaults to fable 5 implementer and gpt-5.5 reviewer', () => {
    expect(DEFAULT_WORKFLOW_IMPLEMENTER_MODEL).toBe('claude-fable-5[1m]');
    expect(DEFAULT_WORKFLOW_REVIEWER_MODEL).toBe('codex-gpt-5.5');
    expect(DEFAULT_CODEX_MODEL).toBe('codex-gpt-5.5');
  });

  it('uses xhigh effort for fable 5 and opus 4.7 by default (no phase)', () => {
    expect(getClaudeEffort(null)).toBeNull();
    expect(getClaudeEffort('claude-fable-5')).toBe('xhigh');
    expect(getClaudeEffort('claude-fable-5[1m]')).toBe('xhigh');
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

  it('drops implement-phase effort to medium for opus and codex', () => {
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBe('medium');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'implement')).toBe('medium');
  });

  it('keeps implement-phase effort at high for fable 5 (frontier-model tuning)', () => {
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement')).toBe('high');
    expect(getClaudeEffort('claude-fable-5', 'implement')).toBe('high');
    // Other fable phases match the shared table
    expect(getClaudeEffort('claude-fable-5[1m]', 'assess')).toBe('xhigh');
    expect(getClaudeEffort('claude-fable-5[1m]', 'review')).toBe('high');
    expect(getClaudeEffort('claude-fable-5[1m]', 'verify')).toBe('xhigh');
  });

  it('env vars override the fable phase table too', () => {
    process.env.EFFORT_IMPLEMENT = 'low';
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement')).toBe('low');
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

  it('falls back to xhigh for the idle phase (not a real dispatch phase)', () => {
    expect(getClaudeEffort('claude-opus-4-7', 'idle')).toBe('xhigh');
    expect(getCodexReasoningEffort('codex', 'idle')).toBe('xhigh');
  });

  it('idle phase routes through EFFORT_DEFAULT, not EFFORT_IDLE', () => {
    // EFFORT_IDLE is intentionally undocumented — set it and confirm it is ignored
    process.env.EFFORT_IDLE = 'minimal';
    process.env.EFFORT_DEFAULT = 'low';
    expect(getClaudeEffort('claude-opus-4-7', 'idle')).toBe('low');
    expect(getCodexReasoningEffort('codex', 'idle')).toBe('low');
    delete process.env.EFFORT_IDLE; // not in EFFORT_ENV_VARS, restore manually
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

describe('job-pinned effort (classifier complexity scaling)', () => {
  beforeEach(clearEffortEnv);
  afterEach(restoreEffortEnv);

  it('a job-pinned effort wins over phase and env defaults', () => {
    expect(getClaudeEffort('claude-fable-5[1m]', null, 'medium')).toBe('medium');
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement', 'xhigh')).toBe('xhigh');
    process.env.EFFORT_DEFAULT = 'low';
    expect(getClaudeEffort('claude-fable-5[1m]', null, 'xhigh')).toBe('xhigh');
  });

  it('survives a rate-limit fallback to opus (pin still applies)', () => {
    expect(getClaudeEffort('claude-opus-4-7[1m]', null, 'medium')).toBe('medium');
  });

  it('is dropped entirely for models without effort gating', () => {
    expect(getClaudeEffort('claude-sonnet-4-6[1m]', null, 'medium')).toBeNull();
    expect(getClaudeEffort('claude-haiku-4-5-20251001', null, 'xhigh')).toBeNull();
  });

  it('rejects values outside the allowlist (shell-injection defence) and falls back', () => {
    expect(getClaudeEffort('claude-fable-5[1m]', null, 'medum')).toBe('xhigh');
    expect(getClaudeEffort('claude-fable-5[1m]', null, 'high$(rm -rf /)')).toBe('xhigh');
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement', 'bogus')).toBe('high');
  });

  it('null/undefined pin falls through to normal resolution', () => {
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement', null)).toBe('high');
    expect(getClaudeEffort('claude-fable-5[1m]', 'implement', undefined)).toBe('high');
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

  it('rejects unknown effort values (returns null) and warns once', () => {
    process.env.EFFORT_IMPLEMENT = 'medum'; // intentional typo
    // Unknown values are not passed to the CLI — they'd reach a shell string
    // in AgentSpawner.ts where JSON.stringify doesn't escape `$()`/backticks.
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('EFFORT_IMPLEMENT="medum"');
    expect(warnSpy.mock.calls[0][0]).toContain('not a recognised effort level');

    // Repeat calls for the same value don't re-warn
    getClaudeEffort('claude-opus-4-7[1m]', 'implement');
    getCodexReasoningEffort('codex', 'implement');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects shell-metachar payloads (defence-in-depth for AgentSpawner shell path)', () => {
    process.env.EFFORT_IMPLEMENT = 'high$(rm -rf /)';
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBeNull();
    expect(getCodexReasoningEffort('codex', 'implement')).toBeNull();
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

  it('idle phase routes through CODEX_SERVICE_TIER_DEFAULT, not _IDLE', () => {
    process.env.CODEX_SERVICE_TIER_IDLE = 'priority';
    process.env.CODEX_SERVICE_TIER_DEFAULT = 'flex';
    expect(getCodexServiceTier('codex', 'idle')).toBe('flex');
    delete process.env.CODEX_SERVICE_TIER_IDLE;
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

  it('rejects unknown tiers (returns null) and warns once', () => {
    process.env.CODEX_SERVICE_TIER_REVIEW = 'turbo'; // not a real tier
    // Same rationale as the effort path: tier value reaches a shell string
    // in AgentSpawner.ts, so unknown/typo values must not pass through.
    expect(getCodexServiceTier('codex', 'review')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('CODEX_SERVICE_TIER_REVIEW="turbo"');
    expect(warnSpy.mock.calls[0][0]).toContain('not a recognised Codex service tier');

    getCodexServiceTier('codex', 'review');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects shell-metachar payloads', () => {
    process.env.CODEX_SERVICE_TIER_REVIEW = 'fast$(touch /tmp/pwn)';
    expect(getCodexServiceTier('codex', 'review')).toBeNull();
  });

  it('does not warn for known tiers', () => {
    for (const tier of ['default', 'flex', 'priority', 'fast', 'auto']) {
      process.env.CODEX_SERVICE_TIER_REVIEW = tier;
      getCodexServiceTier('codex', 'review');
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
