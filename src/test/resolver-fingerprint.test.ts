import { describe, it, expect } from 'vitest';
import {
  normalizeReason,
  fingerprint,
  classifyHeuristic,
  autoResumeConfidenceThreshold,
} from '../server/orchestrator/ResolverFingerprint.js';

describe('ResolverFingerprint.normalizeReason', () => {
  it('returns empty string for nullish input', () => {
    expect(normalizeReason(null)).toBe('');
    expect(normalizeReason(undefined)).toBe('');
    expect(normalizeReason('')).toBe('');
  });

  it('lowercases the input', () => {
    expect(normalizeReason('PHASE FAILED')).toBe('phase failed');
  });

  it('replaces hex IDs', () => {
    const a = normalizeReason("Phase 'review' job a1b2c3d4 failed (rate_limit)");
    const b = normalizeReason("Phase 'review' job 9f8e7d6c failed (rate_limit)");
    expect(a).toBe(b);
    expect(a).toContain('<ID>');
  });

  it('replaces numbers', () => {
    const a = normalizeReason('Reached max cycles (10) with 3/5 milestones complete');
    const b = normalizeReason('Reached max cycles (15) with 7/9 milestones complete');
    expect(a).toBe(b);
  });

  it('replaces ISO timestamps', () => {
    const a = normalizeReason('Worker crashed at 2026-05-19T13:24:01.123Z');
    const b = normalizeReason('Worker crashed at 2026-05-18T08:12:33.456Z');
    expect(a).toBe(b);
  });

  it('keeps filenames but strips absolute path roots', () => {
    const a = normalizeReason('missing /Users/foo/repo/src/auth.ts');
    expect(a).toContain('auth.ts');
    expect(a).not.toContain('/users/foo');
  });
});

describe('ResolverFingerprint.fingerprint', () => {
  it('produces stable 16-char hex digest', () => {
    const fp = fingerprint("Phase 'review' job a1b2c3d4 failed (rate_limit)");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('equates semantically-equivalent reasons', () => {
    const a = fingerprint("Phase 'review' job a1b2c3d4 failed (rate_limit)");
    const b = fingerprint("Phase 'review' job 9f8e7d6c failed (rate_limit)");
    expect(a).toBe(b);
  });

  it('differentiates different reason structures', () => {
    const a = fingerprint("Phase 'review' job a1b2c3d4 failed (rate_limit)");
    const b = fingerprint("Phase 'review' job a1b2c3d4 failed (provider_overload)");
    expect(a).not.toBe(b);
  });

  it('handles null safely', () => {
    expect(fingerprint(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ResolverFingerprint.classifyHeuristic', () => {
  it('classifies PTY exhaustion as transient_infra', () => {
    expect(classifyHeuristic('fork failed: device not configured')).toBe('transient_infra');
    expect(classifyHeuristic('pty exhausted; retry')).toBe('transient_infra');
    expect(classifyHeuristic('infrastructure failure: 0 turns')).toBe('transient_infra');
  });

  it('classifies worktree problems as config_drift', () => {
    expect(classifyHeuristic('work_dir is unavailable')).toBe('config_drift');
    expect(classifyHeuristic('missing worktree_path and worktree_branch')).toBe('config_drift');
  });

  it('classifies model exhaustion as model_capability', () => {
    expect(classifyHeuristic('model-fallback recovery exhausted')).toBe('model_capability');
    expect(classifyHeuristic('Reached max cycles (10) with 1/5 milestones complete')).toBe('model_capability');
    expect(classifyHeuristic('diminishing returns over last 3 cycles')).toBe('model_capability');
  });

  it('classifies external service problems', () => {
    expect(classifyHeuristic('rate-limit hit on Anthropic')).toBe('external_service');
    expect(classifyHeuristic('gh: command not found; push failed')).toBe('external_service');
  });

  it('classifies code bugs', () => {
    expect(classifyHeuristic('pytest assertion failed in test_foo.py')).toBe('code_bug');
    expect(classifyHeuristic('typecheck error: type mismatch')).toBe('code_bug');
  });

  it('falls back to unknown', () => {
    expect(classifyHeuristic('totally unfamiliar message')).toBe('unknown');
    expect(classifyHeuristic(null)).toBe('unknown');
  });
});

describe('ResolverFingerprint.autoResumeConfidenceThreshold', () => {
  it('returns 0.6 for transient_infra', () => {
    expect(autoResumeConfidenceThreshold('transient_infra')).toBe(0.6);
  });

  it('returns 0.85 for code_bug (most cautious)', () => {
    expect(autoResumeConfidenceThreshold('code_bug')).toBe(0.85);
  });

  it('returns >1 for unknown (never auto-resume)', () => {
    expect(autoResumeConfidenceThreshold('unknown')).toBeGreaterThan(1);
  });
});
