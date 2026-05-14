import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_WORKFLOW_IMPLEMENTER_MODEL,
  DEFAULT_WORKFLOW_REVIEWER_MODEL,
  getClaudeEffort,
  getCodexReasoningEffort,
} from '../shared/models.js';

describe('shared model defaults', () => {
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
  const phaseEnvVars = [
    'EFFORT_ASSESS',
    'EFFORT_REVIEW',
    'EFFORT_IMPLEMENT',
    'EFFORT_VERIFY',
    'EFFORT_DEFAULT',
  ];

  afterEach(() => {
    for (const k of phaseEnvVars) delete process.env[k];
  });

  it('drops implement-phase effort to medium for both providers', () => {
    expect(getClaudeEffort('claude-opus-4-7[1m]', 'implement')).toBe('medium');
    expect(getCodexReasoningEffort('codex-gpt-5.5', 'implement')).toBe('medium');
  });

  it('keeps xhigh effort for judgment-heavy phases (assess/review/verify)', () => {
    for (const phase of ['assess', 'review', 'verify'] as const) {
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

  it('EFFORT_DEFAULT applies when no phase is set', () => {
    process.env.EFFORT_DEFAULT = 'medium';
    expect(getClaudeEffort('claude-opus-4-7', null)).toBe('medium');
    expect(getCodexReasoningEffort('codex', null)).toBe('medium');
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
