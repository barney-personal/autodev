import { describe, it, expect } from 'vitest';
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

  it('uses xhigh effort for opus 4.7', () => {
    expect(getClaudeEffort('claude-opus-4-7')).toBe('xhigh');
    expect(getClaudeEffort('claude-opus-4-7[1m]')).toBe('xhigh');
    expect(getClaudeEffort('claude-opus-4-6')).toBeNull();
  });

  it('uses xhigh reasoning effort for codex models', () => {
    expect(getCodexReasoningEffort('codex')).toBe('xhigh');
    expect(getCodexReasoningEffort('codex-gpt-5.5')).toBe('xhigh');
    expect(getCodexReasoningEffort('claude-opus-4-7')).toBeNull();
  });
});
