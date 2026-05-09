/**
 * Tests for the unified task normalization layer.
 * Pure functions — no DB, no socket mocking needed.
 */
import { describe, it, expect } from 'vitest';
import {
  inferPreset,
  resolveTaskConfig,
  validateTaskRequest,
  taskToJobRequest,
  taskToWorkflowRequest,
} from '../shared/taskNormalization.js';
import type { CreateTaskRequest, ReviewConfig } from '../shared/types.js';

// ─── Shared test helpers ────────────────────────────────────────────────────

/**
 * Recursively freeze an object and all nested objects/arrays so any in-place
 * mutation attempt throws at runtime.  Used by mutation-safety regression tests
 * for both success and stale-config failure paths.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  const values = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);
  for (const val of values) {
    deepFreeze(val);
  }
  return obj;
}

// ─── deepFreeze (helper regression) ────────────────────────────────────────

describe('deepFreeze', () => {
  it('freezes grandchild objects and arrays that a one-level helper would leave mutable', () => {
    // Structure with three nesting levels: top → child → grandchild.
    // The pre-M44 helper froze the top level and its immediate children but
    // never recursed into grandchildren, so `grandchildArray` and
    // `grandchildObj` would have remained mutable under the old implementation.
    const grandchildArray = ['a', 'b'];
    const grandchildObj = { key: 'value' };
    const fixture = deepFreeze({
      child: {
        grandchildArray,
        grandchildObj,
      },
      items: [{ nested: 'inside-array' }],
    });

    // Top level is frozen
    expect(Object.isFrozen(fixture)).toBe(true);
    // Immediate children are frozen
    expect(Object.isFrozen(fixture.child)).toBe(true);
    expect(Object.isFrozen(fixture.items)).toBe(true);
    // Grandchildren must also be frozen — the old helper would fail here
    expect(Object.isFrozen(grandchildArray)).toBe(true);
    expect(Object.isFrozen(grandchildObj)).toBe(true);
    // Object nested inside a frozen array must also be frozen
    expect(Object.isFrozen(fixture.items[0])).toBe(true);

    // Mutation attempts on grandchildren must throw
    expect(() => { (grandchildArray as string[]).push('c'); }).toThrow();
    expect(() => { (grandchildObj as Record<string, string>).key = 'changed'; }).toThrow();
    expect(() => { (fixture.items[0] as Record<string, string>).nested = 'changed'; }).toThrow();
  });
});

// ─── inferPreset ────────────────────────────────────────────────────────────

describe('inferPreset', () => {
  it('returns the explicit preset when provided', () => {
    expect(inferPreset({ description: 'x', preset: 'autonomous' })).toBe('autonomous');
    expect(inferPreset({ description: 'x', preset: 'reviewed' })).toBe('reviewed');
    expect(inferPreset({ description: 'x', preset: 'quick' })).toBe('quick');
  });

  it('infers autonomous when iterations > 1', () => {
    expect(inferPreset({ description: 'x', iterations: 5 })).toBe('autonomous');
  });

  it('infers reviewed when review=true and iterations absent/1', () => {
    expect(inferPreset({ description: 'x', review: true })).toBe('reviewed');
    expect(inferPreset({ description: 'x', review: true, iterations: 1 })).toBe('reviewed');
  });

  it('infers quick by default', () => {
    expect(inferPreset({ description: 'x' })).toBe('quick');
    expect(inferPreset({ description: 'x', review: false })).toBe('quick');
  });

  it('iterations > 1 wins over review=false', () => {
    expect(inferPreset({ description: 'x', review: false, iterations: 3 })).toBe('autonomous');
  });
});

// ─── resolveTaskConfig ──────────────────────────────────────────────────────

describe('resolveTaskConfig', () => {
  it('quick preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'quick' });
    expect(cfg).toEqual({
      preset: 'quick',
      routesTo: 'job',
      review: false,
      iterations: 1,
      useWorktree: false,
    });
  });

  it('reviewed preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'reviewed' });
    expect(cfg).toEqual({
      preset: 'reviewed',
      routesTo: 'job',
      review: true,
      iterations: 1,
      useWorktree: true,
    });
  });

  it('autonomous preset defaults', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous' });
    expect(cfg).toEqual({
      preset: 'autonomous',
      routesTo: 'workflow',
      review: true,
      iterations: 10,
      useWorktree: true,
    });
  });

  it('explicit values override preset defaults', () => {
    const cfg = resolveTaskConfig({
      description: 'x',
      preset: 'quick',
      review: true,
      iterations: 5,
      useWorktree: true,
    });
    // iterations > 1 but preset was explicitly 'quick'
    expect(cfg.preset).toBe('quick');
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
    expect(cfg.iterations).toBe(5);
    expect(cfg.useWorktree).toBe(true);
  });

  it('useWorktree defaults to true when iterations > 1 regardless of preset', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'quick', iterations: 3 });
    expect(cfg.useWorktree).toBe(true);
  });

  it('useWorktree can be explicitly disabled for autonomous tasks', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous', useWorktree: false });
    expect(cfg.useWorktree).toBe(false);
  });

  it('forces review=true for workflow-routed tasks even when explicitly false', () => {
    const cfg = resolveTaskConfig({ description: 'x', iterations: 5, review: false });
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
  });

  it('forces review=true for autonomous preset with explicit review=false', () => {
    const cfg = resolveTaskConfig({ description: 'x', preset: 'autonomous', review: false });
    expect(cfg.routesTo).toBe('workflow');
    expect(cfg.review).toBe(true);
  });

  it('preserves review=false for job-routed tasks', () => {
    const cfg = resolveTaskConfig({ description: 'x', iterations: 1, review: false });
    expect(cfg.routesTo).toBe('job');
    expect(cfg.review).toBe(false);
  });

  it('clamps iterations to [1, 50]', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 0 }).iterations).toBe(1);
    expect(resolveTaskConfig({ description: 'x', iterations: 100 }).iterations).toBe(50);
    expect(resolveTaskConfig({ description: 'x', iterations: -5 }).iterations).toBe(1);
  });

  it('rounds fractional iterations', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 2.7 }).iterations).toBe(3);
  });

  it('routing: iterations=1 → job, iterations>1 → workflow', () => {
    expect(resolveTaskConfig({ description: 'x', iterations: 1 }).routesTo).toBe('job');
    expect(resolveTaskConfig({ description: 'x', iterations: 2 }).routesTo).toBe('workflow');
    expect(resolveTaskConfig({ description: 'x', iterations: 50 }).routesTo).toBe('workflow');
  });
});

// ─── validateTaskRequest ────────────────────────────────────────────────────

describe('validateTaskRequest', () => {
  it('requires description or templateId', () => {
    expect(validateTaskRequest({})).toMatch(/description is required/);
    expect(validateTaskRequest({ description: '' })).toMatch(/description is required/);
    expect(validateTaskRequest({ description: '  ' })).toMatch(/description is required/);
    expect(validateTaskRequest({ description: 'do something' })).toBeNull();
  });

  it('allows template-only tasks (no description) for job-routed tasks', () => {
    expect(validateTaskRequest({ templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ description: '', templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ description: '  ', templateId: 'tpl-1' })).toBeNull();
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'quick' })).toBeNull();
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'reviewed' })).toBeNull();
  });

  it('rejects template-only tasks for workflow-routed tasks (autonomous)', () => {
    expect(validateTaskRequest({ templateId: 'tpl-1', iterations: 5 }))
      .toMatch(/description is required for autonomous/);
    expect(validateTaskRequest({ templateId: 'tpl-1', preset: 'autonomous' }))
      .toMatch(/description is required for autonomous/);
  });

  it('rejects out-of-range iterations', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 0 })).toMatch(/iterations/);
    expect(validateTaskRequest({ description: 'x', iterations: 51 })).toMatch(/iterations/);
    expect(validateTaskRequest({ description: 'x', iterations: 1.5 })).toMatch(/iterations/);
  });

  it('rejects invalid preset', () => {
    expect(validateTaskRequest({ description: 'x', preset: 'invalid' as any })).toMatch(/invalid preset/);
  });

  it('rejects explicit review=false for workflow-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, review: false }))
      .toMatch(/review cannot be disabled/);
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', review: false }))
      .toMatch(/review cannot be disabled/);
    // Quick preset with iterations override still routes to workflow
    expect(validateTaskRequest({ description: 'x', preset: 'quick', iterations: 3, review: false }))
      .toMatch(/review cannot be disabled/);
  });

  it('allows review=true or review=undefined for workflow-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, review: true })).toBeNull();
    expect(validateTaskRequest({ description: 'x', iterations: 5 })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous' })).toBeNull();
  });

  it('allows review=false for job-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 1, review: false })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'quick', review: false })).toBeNull();
  });

  it('rejects job-only options on autonomous tasks', () => {
    const base: CreateTaskRequest = { description: 'x', iterations: 5 };
    expect(validateTaskRequest({ ...base, dependsOn: ['abc'] })).toMatch(/dependsOn/);
    expect(validateTaskRequest({ ...base, interactive: true })).toMatch(/interactive/);
    expect(validateTaskRequest({ ...base, debate: true })).toMatch(/debate/);
    expect(validateTaskRequest({ ...base, repeatIntervalMs: 60000 })).toMatch(/repeatIntervalMs/);
    expect(validateTaskRequest({ ...base, scheduledAt: Date.now() })).toMatch(/scheduledAt/);
  });

  it('rejects repeatIntervalMs: 0 on autonomous tasks (falsey numeric bypass)', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 3, repeatIntervalMs: 0 }))
      .toMatch(/repeatIntervalMs is not supported/);
  });

  it('rejects scheduledAt: 0 on autonomous tasks (falsey numeric bypass)', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 3, scheduledAt: 0 }))
      .toMatch(/scheduledAt is not supported/);
  });

  it('rejects single-pass stop settings on autonomous tasks', () => {
    const base: CreateTaskRequest = { description: 'x', iterations: 5 };
    expect(validateTaskRequest({ ...base, stopMode: 'turns' })).toMatch(/stopMode/);
    expect(validateTaskRequest({ ...base, stopValue: 25 })).toMatch(/stopValue/);
    expect(validateTaskRequest({ ...base, maxTurns: 25 })).toMatch(/maxTurns/);
  });

  it('rejects single-pass stop settings on autonomous preset override combinations', () => {
    expect(validateTaskRequest({
      description: 'x',
      preset: 'autonomous',
      stopMode: 'budget',
    })).toMatch(/stopMode/);

    expect(validateTaskRequest({
      description: 'x',
      preset: 'quick',
      iterations: 3,
      stopValue: 10,
    })).toMatch(/stopValue/);

    expect(validateTaskRequest({
      description: 'x',
      preset: 'reviewed',
      iterations: 4,
      maxTurns: 40,
    })).toMatch(/maxTurns/);
  });

  it('rejects priority on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, priority: 10 }))
      .toMatch(/priority is not supported/);
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', priority: 1 }))
      .toMatch(/priority is not supported/);
  });

  it('rejects retryPolicy on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, retryPolicy: 'analyze' }))
      .toMatch(/retryPolicy is not supported/);
  });

  it('rejects maxRetries on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, maxRetries: 3 }))
      .toMatch(/maxRetries is not supported/);
  });

  it('rejects completionChecks on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, completionChecks: ['lint'] }))
      .toMatch(/completionChecks is not supported/);
    // Empty array should pass (falsy length)
    expect(validateTaskRequest({ description: 'x', iterations: 5, completionChecks: [] }))
      .toBeNull();
  });

  it('rejects context on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, context: { env: 'prod' } }))
      .toMatch(/context is not supported/);
  });

  it('rejects reviewConfig on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, reviewConfig: { models: ['codex'], auto: true } }))
      .toMatch(/reviewConfig is not supported/);
  });

  it('rejects projectId on autonomous tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 5, projectId: 'proj-1' }))
      .toMatch(/projectId is not supported/);
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', projectId: 'proj-1' }))
      .toMatch(/projectId is not supported/);
  });

  it('allows projectId on job-routed tasks', () => {
    expect(validateTaskRequest({ description: 'x', iterations: 1, projectId: 'proj-1' })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'quick', projectId: 'proj-1' })).toBeNull();
    expect(validateTaskRequest({ description: 'x', preset: 'reviewed', projectId: 'proj-1' })).toBeNull();
  });

  it('rejects remaining job-only fields on preset override combinations routing to workflow', () => {
    // Quick preset with iterations override
    expect(validateTaskRequest({ description: 'x', preset: 'quick', iterations: 3, priority: 5 }))
      .toMatch(/priority is not supported/);
    // Reviewed preset with iterations override
    expect(validateTaskRequest({ description: 'x', preset: 'reviewed', iterations: 4, retryPolicy: 'same' }))
      .toMatch(/retryPolicy is not supported/);
    // Autonomous preset with context
    expect(validateTaskRequest({ description: 'x', preset: 'autonomous', context: { key: 'val' } }))
      .toMatch(/context is not supported/);
  });

  it('allows priority, retryPolicy, maxRetries, completionChecks, context, reviewConfig on job-routed tasks', () => {
    expect(validateTaskRequest({
      description: 'x',
      iterations: 1,
      priority: 10,
      retryPolicy: 'analyze',
      maxRetries: 3,
      completionChecks: ['lint', 'test'],
      context: { env: 'prod' },
      reviewConfig: { models: ['codex'], auto: true },
    })).toBeNull();
  });

  it('allows job-only options on single-pass tasks', () => {
    expect(validateTaskRequest({
      description: 'x',
      iterations: 1,
      dependsOn: ['abc'],
      interactive: true,
    })).toBeNull();
  });

  it('rejects negative or zero stopValue', () => {
    expect(validateTaskRequest({ description: 'x', stopValue: -1 })).toMatch(/stopValue must be a positive number/);
    expect(validateTaskRequest({ description: 'x', stopValue: 0 })).toMatch(/stopValue must be a positive number/);
    // positive is fine
    expect(validateTaskRequest({ description: 'x', stopValue: 10 })).toBeNull();
  });

  it('rejects negative or zero maxTurns', () => {
    expect(validateTaskRequest({ description: 'x', maxTurns: -5 })).toMatch(/maxTurns must be a positive number/);
    expect(validateTaskRequest({ description: 'x', maxTurns: 0 })).toMatch(/maxTurns must be a positive number/);
    // positive is fine
    expect(validateTaskRequest({ description: 'x', maxTurns: 25 })).toBeNull();
  });

  it('rejects per-phase stop fields on job-routed tasks', () => {
    const jobBase: CreateTaskRequest = { description: 'x', iterations: 1 };
    expect(validateTaskRequest({ ...jobBase, maxTurnsAssess: 10 })).toMatch(/maxTurnsAssess is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, maxTurnsReview: 10 })).toMatch(/maxTurnsReview is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, maxTurnsImplement: 10 })).toMatch(/maxTurnsImplement is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopModeAssess: 'turns' })).toMatch(/stopModeAssess is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopModeReview: 'budget' })).toMatch(/stopModeReview is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopModeImplement: 'time' })).toMatch(/stopModeImplement is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopValueAssess: 5 })).toMatch(/stopValueAssess is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopValueReview: 30 })).toMatch(/stopValueReview is a workflow-only field/);
    expect(validateTaskRequest({ ...jobBase, stopValueImplement: 80 })).toMatch(/stopValueImplement is a workflow-only field/);
  });

  it('allows per-phase stop fields on workflow-routed tasks', () => {
    expect(validateTaskRequest({
      description: 'x',
      iterations: 5,
      maxTurnsAssess: 10,
      stopModeReview: 'budget',
      stopValueImplement: 80,
    })).toBeNull();
  });
});

// ─── taskToJobRequest ───────────────────────────────────────────────────────

describe('taskToJobRequest', () => {
  it('maps core fields', () => {
    const result = taskToJobRequest({
      description: 'Fix the bug',
      title: 'Bug fix',
      model: 'claude-sonnet-4-6',
      workDir: '/repo',
      templateId: 'tpl-1',
      projectId: 'proj-1',
    });
    expect(result.description).toBe('Fix the bug');
    expect(result.title).toBe('Bug fix');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.workDir).toBe('/repo');
    expect(result.templateId).toBe('tpl-1');
    expect(result.projectId).toBe('proj-1');
  });

  it('enables useWorktree for reviewed preset requests', () => {
    const result = taskToJobRequest({ description: 'x', preset: 'reviewed' });
    expect(result.useWorktree).toBe(true);
  });

  it('passes through advanced options', () => {
    const result = taskToJobRequest({
      description: 'x',
      priority: 10,
      dependsOn: ['a', 'b'],
      retryPolicy: 'analyze',
      maxRetries: 3,
      completionChecks: ['lint', 'test'],
      context: { env: 'prod' },
      debate: true,
      debateClaudeModel: 'claude-opus-4-6',
      debateCodexModel: 'codex',
      debateMaxRounds: 5,
    });
    expect(result.priority).toBe(10);
    expect(result.dependsOn).toEqual(['a', 'b']);
    expect(result.retryPolicy).toBe('analyze');
    expect(result.maxRetries).toBe(3);
    expect(result.completionChecks).toEqual(['lint', 'test']);
    expect(result.context).toEqual({ env: 'prod' });
    expect(result.debate).toBe(true);
    expect(result.debateClaudeModel).toBe('claude-opus-4-6');
    expect(result.debateCodexModel).toBe('codex');
    expect(result.debateMaxRounds).toBe(5);
  });

  it('auto-builds reviewConfig when review is enabled', () => {
    const result = taskToJobRequest({
      description: 'x',
      preset: 'reviewed',
      reviewerModel: 'claude-opus-4-6',
    });
    expect(result.reviewConfig).toEqual({
      models: ['claude-opus-4-6'],
      auto: true,
    });
  });

  it('uses default reviewer model in reviewConfig when not specified', () => {
    const result = taskToJobRequest({
      description: 'x',
      review: true,
    });
    expect(result.reviewConfig).toEqual({
      models: ['codex-gpt-5.5'],
      auto: true,
    });
  });

  it('falls back to default reviewer model when reviewerModel is whitespace-only', () => {
    const result = taskToJobRequest({
      description: 'x',
      review: true,
      reviewerModel: '  ',
    });
    expect(result.reviewConfig).toEqual({
      models: ['codex-gpt-5.5'],
      auto: true,
    });
  });

  it('preserves explicit reviewConfig over auto-built one', () => {
    const explicitConfig = { models: ['model-a', 'model-b'], auto: false };
    const result = taskToJobRequest({
      description: 'x',
      review: true,
      reviewConfig: explicitConfig,
    });
    expect(result.reviewConfig).toEqual(explicitConfig);
  });

  it('does not set reviewConfig when review is off', () => {
    const result = taskToJobRequest({ description: 'x', preset: 'quick' });
    expect(result.reviewConfig).toBeUndefined();
  });

  it('handles template-only tasks (empty description)', () => {
    const result = taskToJobRequest({ templateId: 'tpl-1' });
    expect(result.description).toBe('');
    expect(result.templateId).toBe('tpl-1');
  });

  it('handles template-only task with review enabled', () => {
    const result = taskToJobRequest({ templateId: 'tpl-1', review: true });
    expect(result.description).toBe('');
    expect(result.templateId).toBe('tpl-1');
    expect(result.reviewConfig).toEqual({ models: ['codex-gpt-5.5'], auto: true });
  });

  it('throws when called for autonomous task', () => {
    expect(() => taskToJobRequest({ description: 'x', iterations: 5 })).toThrow(/iterations > 1/);
  });

  it('throws when supplied config fabricates routesTo=job for a workflow-routed request', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const fabricated = { preset: 'autonomous' as const, routesTo: 'job' as const, review: true, iterations: 5, useWorktree: true };
    expect(() => taskToJobRequest(req, fabricated)).toThrow(/routesTo: supplied 'job' vs canonical 'workflow'/);
  });

  it('accepts supplied config only when it exactly matches the canonical resolved config', () => {
    // Use a reviewed preset so derived fields (reviewConfig, useWorktree) are exercised.
    const req: CreateTaskRequest = { description: 'reviewed task', preset: 'reviewed' };
    const matching = resolveTaskConfig(req);
    const withConfig = taskToJobRequest(req, matching);
    const withoutConfig = taskToJobRequest(req);
    // Full output equality ensures the matching-config path cannot diverge from canonical.
    expect(withConfig).toEqual(withoutConfig);
    // Spot-check that derived fields are actually populated (not both empty).
    expect(withConfig.useWorktree).toBe(true);
    expect(withConfig.reviewConfig).toBeDefined();
  });

  it('exact-match success: reviewConfig built from explicit reviewerModel', () => {
    // Exercises the buildReviewConfig(req.reviewerModel) branch with a non-default model.
    const req: CreateTaskRequest = { description: 'review task', review: true, reviewerModel: 'claude-sonnet-4-6' };
    const matching = resolveTaskConfig(req);
    const withConfig = taskToJobRequest(req, matching);
    const withoutConfig = taskToJobRequest(req);
    expect(withConfig).toEqual(withoutConfig);
    // Spot-check the reviewerModel was actually used, not the default 'codex'.
    expect(withConfig.reviewConfig).toEqual({ models: ['claude-sonnet-4-6'], auto: true });
  });

  it('exact-match success: template-only reviewed job conversion', () => {
    // Exercises the description ?? '' branch with a template-only reviewed request.
    const req: CreateTaskRequest = { templateId: 'tpl-42', review: true };
    const matching = resolveTaskConfig(req);
    const withConfig = taskToJobRequest(req, matching);
    const withoutConfig = taskToJobRequest(req);
    expect(withConfig).toEqual(withoutConfig);
    // Spot-check that template-only branch specifics are correct.
    expect(withConfig.description).toBe('');
    expect(withConfig.templateId).toBe('tpl-42');
    // Assert canonical reviewed defaults directly so a shared regression in
    // resolveTaskConfig or buildReviewConfig cannot hide behind path equality.
    expect(withConfig.useWorktree).toBe(true);
    expect(withConfig.reviewConfig).toEqual({ models: ['codex-gpt-5.5'], auto: true });
  });

  it('exact-match success: caller-supplied reviewConfig preserved as-is (per-call deep-freeze mutation safety)', () => {
    // Exercises the req.reviewConfig ?? ... branch where the caller supplies their own config.
    // Each converter call gets its own fresh input and immediate pre/post snapshot so a
    // transient mutation in one call cannot be masked by the other.
    // Uses the file-level deepFreeze helper so both success and failure paths
    // share one recursive-freeze implementation.

    // --- with-config path: deep-frozen objects, immediate assertion ---
    const models1 = ['gpt-4', 'codex'];
    const customReview1 = deepFreeze({ models: models1, auto: false });
    const snapshot1 = JSON.parse(JSON.stringify(customReview1));
    const req1: CreateTaskRequest = { description: 'custom review', review: true, reviewConfig: customReview1 };
    const matching1 = resolveTaskConfig(req1);
    const withConfig = taskToJobRequest(req1, matching1);
    // Assert immutability immediately after this single call.
    expect(customReview1).toEqual(snapshot1);
    expect(customReview1.models).toEqual(['gpt-4', 'codex']);
    // Nested array identity: the exact same array reference must survive.
    expect(withConfig.reviewConfig!.models).toBe(models1);
    // Top-level reference identity: pass-through semantics require the exact supplied object.
    expect(withConfig.reviewConfig).toBe(customReview1);

    // --- without-config path: separate deep-frozen objects, immediate assertion ---
    const models2 = ['gpt-4', 'codex'];
    const customReview2 = deepFreeze({ models: models2, auto: false });
    const snapshot2 = JSON.parse(JSON.stringify(customReview2));
    const req2: CreateTaskRequest = { description: 'custom review', review: true, reviewConfig: customReview2 };
    const withoutConfig = taskToJobRequest(req2);
    // Assert immutability immediately after this single call.
    expect(customReview2).toEqual(snapshot2);
    expect(customReview2.models).toEqual(['gpt-4', 'codex']);
    // Nested array identity for the no-config path too.
    expect(withoutConfig.reviewConfig!.models).toBe(models2);
    // Top-level reference identity for the no-config path too.
    expect(withoutConfig.reviewConfig).toBe(customReview2);

    // Both paths must produce equivalent derived output (modulo the distinct reviewConfig refs).
    const { reviewConfig: rc1, ...rest1 } = withConfig;
    const { reviewConfig: rc2, ...rest2 } = withoutConfig;
    expect(rest1).toEqual(rest2);
    expect(rc1).toEqual(rc2);
  });

  it('exact-match success: nested reviewConfig with non-JSON-preserved values remains frozen and unchanged after conversion', () => {
    // Uses a typed cast to thread a reviewConfig with genuine grandchild nesting
    // through the converter's pass-through path.  The fixture intentionally
    // includes non-JSON-preserved nested values — an `undefined` property and a
    // `NaN` value — so that reverting the snapshot strategy from structuredClone
    // back to JSON round-tripping would silently drop them and miss a mutation.
    //
    // A non-recursive deepFreeze would also leave the grandchild objects/arrays
    // unfrozen, so the Object.isFrozen assertions below would fail — proving the
    // success-path mutation regression depends on recursive freezing, not just the
    // standalone helper test.
    const grandchild = { tag: 'important', removed: undefined as string | undefined, threshold: NaN };
    const nestedModels = [{ name: 'gpt-4', settings: grandchild }];
    const customReview = deepFreeze({ models: nestedModels, auto: false } as unknown as ReviewConfig);

    // Snapshot the full nested structure before conversion so we can detect any
    // field-level mutation, not just changes to the specific grandchildren we
    // spot-check below.  Uses structuredClone instead of JSON round-tripping so
    // the snapshot preserves undefined values and NaN that JSON would erase.
    const fullSnapshotBefore = structuredClone(customReview);

    // Verify the snapshot actually preserved the non-JSON state (sanity check).
    const snapGC = ((fullSnapshotBefore as unknown as Record<string, unknown[]>).models[0] as Record<string, Record<string, unknown>>).settings;
    expect('removed' in snapGC).toBe(true);
    expect(snapGC.removed).toBeUndefined();
    expect(snapGC.threshold).toBeNaN();

    // --- with-config path ---
    const req1: CreateTaskRequest = { description: 'nested review', review: true, reviewConfig: customReview };
    const matching1 = resolveTaskConfig(req1);
    const withConfig = taskToJobRequest(req1, matching1);

    // Full-object unchanged: compare the frozen original directly to the
    // pre-conversion structuredClone.  Because the clone preserves undefined
    // and NaN, any mutation the JSON approach would miss is caught.
    expect(customReview).toEqual(fullSnapshotBefore);

    // Top-level supplied object must be frozen.
    expect(Object.isFrozen(customReview)).toBe(true);
    // Pass-through identity: exact same frozen reference returned.
    expect(withConfig.reviewConfig).toBe(customReview);
    // Grandchild objects must still be frozen — a non-recursive deepFreeze fails here.
    expect(Object.isFrozen((customReview as Record<string, unknown>).models)).toBe(true);
    expect(Object.isFrozen(nestedModels[0])).toBe(true);
    expect(Object.isFrozen(grandchild)).toBe(true);
    // Content and identity of the grandchild must survive the converter.
    expect((nestedModels[0] as Record<string, unknown>).settings).toBe(grandchild);
    expect(grandchild.tag).toBe('important');
    // Non-JSON-preserved nested values must survive the with-config path.
    expect('removed' in grandchild).toBe(true);
    expect(grandchild.removed).toBeUndefined();
    expect(grandchild.threshold).toBeNaN();

    // --- without-config path (separate frozen input) ---
    const grandchild2 = { tag: 'important', removed: undefined as string | undefined, threshold: NaN };
    const nestedModels2 = [{ name: 'gpt-4', settings: grandchild2 }];
    const customReview2 = deepFreeze({ models: nestedModels2, auto: false } as unknown as ReviewConfig);

    // Snapshot before the no-config conversion call (structuredClone preserves
    // non-JSON state the JSON round-trip would silently drop).
    const fullSnapshotBefore2 = structuredClone(customReview2);

    const req2: CreateTaskRequest = { description: 'nested review', review: true, reviewConfig: customReview2 };
    const withoutConfig = taskToJobRequest(req2);

    // Full-object unchanged after the no-config call.
    expect(customReview2).toEqual(fullSnapshotBefore2);

    // Top-level supplied object must be frozen.
    expect(Object.isFrozen(customReview2)).toBe(true);
    // Same identity and frozen-state assertions for the no-config path.
    expect(withoutConfig.reviewConfig).toBe(customReview2);
    // Nested models array itself must remain frozen — symmetric with the with-config branch.
    expect(Object.isFrozen((customReview2 as Record<string, unknown>).models)).toBe(true);
    expect(Object.isFrozen(nestedModels2[0])).toBe(true);
    expect(Object.isFrozen(grandchild2)).toBe(true);
    expect((nestedModels2[0] as Record<string, unknown>).settings).toBe(grandchild2);
    // Non-JSON-preserved nested values must survive the no-config path.
    expect('removed' in grandchild2).toBe(true);
    expect(grandchild2.removed).toBeUndefined();
    expect(grandchild2.threshold).toBeNaN();

    // Both paths must produce equivalent derived output (modulo distinct reviewConfig refs).
    const { reviewConfig: rc1, ...r1 } = withConfig;
    const { reviewConfig: rc2, ...r2 } = withoutConfig;
    expect(r1).toEqual(r2);
    expect(rc1).toEqual(rc2);
  });

  it('throws on stale config with review=true when canonical review is false', () => {
    const req: CreateTaskRequest = { description: 'x', preset: 'quick' };
    const stale = { ...resolveTaskConfig(req), review: true };
    expect(() => taskToJobRequest(req, stale)).toThrow(/review: supplied true vs canonical false/);
  });

  it('throws on stale config with review=false when canonical review is true', () => {
    const req: CreateTaskRequest = { description: 'x', preset: 'reviewed' };
    const stale = { ...resolveTaskConfig(req), review: false };
    expect(() => taskToJobRequest(req, stale)).toThrow(/review: supplied false vs canonical true/);
  });

  it('throws on stale config with useWorktree=true when canonical useWorktree is false', () => {
    const req: CreateTaskRequest = { description: 'x', preset: 'quick' };
    const stale = { ...resolveTaskConfig(req), useWorktree: true };
    expect(() => taskToJobRequest(req, stale)).toThrow(/useWorktree: supplied true vs canonical false/);
  });

  it('throws on stale config with useWorktree=false when canonical useWorktree is true', () => {
    const req: CreateTaskRequest = { description: 'x', preset: 'reviewed' };
    const stale = { ...resolveTaskConfig(req), useWorktree: false };
    expect(() => taskToJobRequest(req, stale)).toThrow(/useWorktree: supplied false vs canonical true/);
  });

  it('throws on stale config with mismatched preset', () => {
    // Request infers quick (default), stale config claims reviewed
    const req: CreateTaskRequest = { description: 'x' };
    const stale = { ...resolveTaskConfig(req), preset: 'reviewed' as const };
    expect(() => taskToJobRequest(req, stale)).toThrow(/preset: supplied 'reviewed' vs canonical 'quick'/);
  });

  it('throws on stale config with mismatched iterations', () => {
    // Job-routed requests always have iterations=1; stale config claims 5
    const req: CreateTaskRequest = { description: 'x', preset: 'quick' };
    const stale = { ...resolveTaskConfig(req), iterations: 5 };
    expect(() => taskToJobRequest(req, stale)).toThrow(/iterations: supplied 5 vs canonical 1/);
  });

  it('reports all mismatched fields in a single error', () => {
    const req: CreateTaskRequest = { description: 'x', preset: 'quick' };
    const stale = { ...resolveTaskConfig(req), review: true, useWorktree: true };
    expect(() => taskToJobRequest(req, stale)).toThrow(/review:.*useWorktree:/);
  });

});

// ─── taskToWorkflowRequest ──────────────────────────────────────────────────

describe('taskToWorkflowRequest', () => {
  it('maps core fields using task-request field names', () => {
    const result = taskToWorkflowRequest({
      description: 'Refactor module',
      title: 'Refactor',
      model: 'claude-sonnet-4-6',
      reviewerModel: 'codex',
      iterations: 5,
      workDir: '/repo',
      templateId: 'tpl-1',
    });
    expect(result.task).toBe('Refactor module');
    expect(result.title).toBe('Refactor');
    expect(result.implementerModel).toBe('claude-sonnet-4-6');
    expect(result.reviewerModel).toBe('codex');
    expect(result.maxCycles).toBe(5);
    expect(result.workDir).toBe('/repo');
    expect(result.templateId).toBe('tpl-1');
    // projectId is intentionally not supported — workflows always create their own project
    expect((result as any).projectId).toBeUndefined();
  });

  it('maps per-phase stop conditions', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxTurnsAssess: 40,
      maxTurnsReview: 20,
      maxTurnsImplement: 80,
      stopModeAssess: 'budget',
      stopValueAssess: 5,
      stopModeReview: 'time',
      stopValueReview: 30,
      stopModeImplement: 'turns',
      stopValueImplement: 80,
      completionThreshold: 0.8,
    });
    expect(result.maxTurnsAssess).toBe(40);
    expect(result.maxTurnsReview).toBe(20);
    expect(result.maxTurnsImplement).toBe(80);
    expect(result.stopModeAssess).toBe('budget');
    expect(result.stopValueAssess).toBe(5);
    expect(result.stopModeReview).toBe('time');
    expect(result.stopValueReview).toBe(30);
    expect(result.stopModeImplement).toBe('turns');
    expect(result.stopValueImplement).toBe(80);
    expect(result.completionThreshold).toBe(0.8);
  });

  it('throws on stopMode (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopMode: 'turns',
    })).toThrow(/stopMode is not supported for workflow/);
  });

  it('throws on stopValue (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopValue: 99,
    })).toThrow(/stopValue is not supported for workflow/);
  });

  it('throws on maxTurns (single-pass field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxTurns: 99,
    })).toThrow(/maxTurns is not supported for workflow/);
  });

  it('throws on all three single-pass stop fields together', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      stopMode: 'turns',
      stopValue: 99,
      maxTurns: 99,
    })).toThrow(/stopMode is not supported for workflow/);
  });

  it('throws on priority (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      priority: 10,
    })).toThrow(/priority is not supported for workflow/);
  });

  it('throws on retryPolicy (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      retryPolicy: 'analyze',
    })).toThrow(/retryPolicy is not supported for workflow/);
  });

  it('throws on maxRetries (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      maxRetries: 3,
    })).toThrow(/maxRetries is not supported for workflow/);
  });

  it('throws on completionChecks (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      completionChecks: ['lint', 'test'],
    })).toThrow(/completionChecks is not supported for workflow/);
  });

  it('allows empty completionChecks array on workflow tasks', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      completionChecks: [],
    });
    expect(result.task).toBe('x');
  });

  it('throws on context (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      context: { env: 'prod' },
    })).toThrow(/context is not supported for workflow/);
  });

  it('throws on reviewConfig (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      reviewConfig: { models: ['codex'], auto: true },
    })).toThrow(/reviewConfig is not supported for workflow/);
  });

  it('throws on projectId (workflows always create their own project)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      projectId: 'proj-1',
    })).toThrow(/projectId is not supported for workflow/);
  });

  it('throws on dependsOn (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      dependsOn: ['job-abc'],
    })).toThrow(/dependsOn is not supported for workflow/);
  });

  it('throws on interactive (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      interactive: true,
    })).toThrow(/interactive mode is not supported for workflow/);
  });

  it('throws on debate (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      debate: true,
    })).toThrow(/debate is not supported for workflow/);
  });

  it('throws on repeatIntervalMs (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      repeatIntervalMs: 60000,
    })).toThrow(/repeatIntervalMs is not supported for workflow/);
  });

  it('throws on repeatIntervalMs: 0 (falsey numeric bypass)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      repeatIntervalMs: 0,
    })).toThrow(/repeatIntervalMs is not supported for workflow/);
  });

  it('throws on scheduledAt (job-only field unsupported for workflows)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      scheduledAt: Date.now(),
    })).toThrow(/scheduledAt is not supported for workflow/);
  });

  it('throws on scheduledAt: 0 (falsey numeric bypass)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      scheduledAt: 0,
    })).toThrow(/scheduledAt is not supported for workflow/);
  });

  it('throws on original job-only fields via preset override routing to workflow', () => {
    // Quick preset with iterations override should still reject dependsOn
    expect(() => taskToWorkflowRequest({
      description: 'x',
      preset: 'quick',
      iterations: 3,
      dependsOn: ['job-1'],
    })).toThrow(/dependsOn is not supported for workflow/);
  });

  it('throws on explicit review=false (contradicts workflow review phase)', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      review: false,
    })).toThrow(/review cannot be disabled for workflow/);
  });

  it('throws on review=false with autonomous preset', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      preset: 'autonomous',
      review: false,
    })).toThrow(/review cannot be disabled for workflow/);
  });

  it('throws on review=false with quick preset override routing to workflow', () => {
    expect(() => taskToWorkflowRequest({
      description: 'x',
      preset: 'quick',
      iterations: 3,
      review: false,
    })).toThrow(/review cannot be disabled for workflow/);
  });

  it('allows review=true on workflow tasks', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
      review: true,
    });
    expect(result.task).toBe('x');
  });

  it('allows review=undefined on workflow tasks', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 3,
    });
    expect(result.task).toBe('x');
  });

  it('respects explicit useWorktree=false from the request', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 10,
      useWorktree: false,
    });
    // Canonical behavior: useWorktree derives from the request, not a supplied config
    expect(result.useWorktree).toBe(false);
  });

  it('defaults useWorktree=true when request omits it for workflow tasks', () => {
    const result = taskToWorkflowRequest({
      description: 'x',
      iterations: 10,
    });
    // Workflow-routed tasks default to useWorktree=true via resolveTaskConfig
    expect(result.useWorktree).toBe(true);
  });

  it('throws when called for single-pass task', () => {
    expect(() => taskToWorkflowRequest({ description: 'x', iterations: 1 })).toThrow(/iterations = 1/);
  });

  it('throws when description is missing (template-only)', () => {
    expect(() => taskToWorkflowRequest({ templateId: 'tpl-1', iterations: 5 }))
      .toThrow(/Workflow tasks require a description/);
  });

  it('throws when supplied config fabricates routesTo=workflow for a job-routed request', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 1 };
    const fabricated = { preset: 'quick' as const, routesTo: 'workflow' as const, review: false, iterations: 1, useWorktree: false };
    expect(() => taskToWorkflowRequest(req, fabricated)).toThrow(/routesTo: supplied 'workflow' vs canonical 'job'/);
  });

  it('accepts supplied config only when it exactly matches the canonical resolved config', () => {
    // Use explicit iterations and useWorktree so derived fields (maxCycles, useWorktree) are exercised.
    const req: CreateTaskRequest = { description: 'autonomous task', iterations: 7, useWorktree: true };
    const matching = resolveTaskConfig(req);
    const withConfig = taskToWorkflowRequest(req, matching);
    const withoutConfig = taskToWorkflowRequest(req);
    // Full output equality ensures the matching-config path cannot diverge from canonical.
    expect(withConfig).toEqual(withoutConfig);
    // Spot-check that derived fields are actually populated (not both empty/default).
    expect(withConfig.maxCycles).toBe(7);
    expect(withConfig.useWorktree).toBe(true);
  });

  it('exact-match success: defaulted worktree and mapped workflow fields', () => {
    // Omit useWorktree so the canonical defaulting path (iterations > 1 → true) is exercised.
    // Include non-default mapped fields to verify they survive the matching-config path.
    const req: CreateTaskRequest = {
      description: 'full workflow task',
      title: 'Mapped fields test',
      iterations: 4,
      reviewerModel: 'claude-sonnet-4-6',
      templateId: 'tmpl-abc',
      maxTurnsAssess: 20,
      maxTurnsReview: 15,
      maxTurnsImplement: 80,
      stopModeAssess: 'turns' as const,
      stopValueAssess: 18,
      stopModeReview: 'turns' as const,
      stopValueReview: 12,
      stopModeImplement: 'budget' as const,
      stopValueImplement: 500000,
    };
    const matching = resolveTaskConfig(req);
    const withConfig = taskToWorkflowRequest(req, matching);
    const withoutConfig = taskToWorkflowRequest(req);
    // Full output equality ensures the matching-config path cannot diverge from canonical.
    expect(withConfig).toEqual(withoutConfig);
    // Spot-check that defaulted useWorktree was applied and mapped fields are present.
    expect(withConfig.useWorktree).toBe(true);
    expect(withConfig.maxCycles).toBe(4);
    expect(withConfig.reviewerModel).toBe('claude-sonnet-4-6');
    expect(withConfig.title).toBe('Mapped fields test');
    expect(withConfig.templateId).toBe('tmpl-abc');
    expect(withConfig.stopModeImplement).toBe('budget');
    expect(withConfig.stopValueImplement).toBe(500000);
  });

  it('throws on stale config with inflated iterations', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const stale = { ...resolveTaskConfig(req), iterations: 10 };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/iterations: supplied 10 vs canonical 5/);
  });

  it('throws on stale config with shrunk iterations', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 10 };
    const stale = { ...resolveTaskConfig(req), iterations: 2 };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/iterations: supplied 2 vs canonical 10/);
  });

  it('throws on stale config with useWorktree=true when canonical is false', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 5, useWorktree: false };
    const stale = { ...resolveTaskConfig(req), useWorktree: true };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/useWorktree: supplied true vs canonical false/);
  });

  it('throws on stale config with useWorktree=false when canonical is true', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const stale = { ...resolveTaskConfig(req), useWorktree: false };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/useWorktree: supplied false vs canonical true/);
  });

  it('throws on stale config with mismatched preset', () => {
    // Request infers autonomous (iterations=5), stale config claims reviewed
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const stale = { ...resolveTaskConfig(req), preset: 'reviewed' as const };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/preset: supplied 'reviewed' vs canonical 'autonomous'/);
  });

  it('throws on stale config with mismatched review', () => {
    // Workflow-routed tasks always have review=true; stale config claims false
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const stale = { ...resolveTaskConfig(req), review: false };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/review: supplied false vs canonical true/);
  });

  it('reports all mismatched fields in a single error', () => {
    const req: CreateTaskRequest = { description: 'x', iterations: 5 };
    const stale = { ...resolveTaskConfig(req), iterations: 10, useWorktree: false };
    expect(() => taskToWorkflowRequest(req, stale)).toThrow(/iterations:.*useWorktree:/);
  });
});

// ─── Round-trip: preset → resolve → convert determinism ─────────────────────

describe('round-trip determinism', () => {
  it('quick preset always routes to job', () => {
    const req: CreateTaskRequest = { description: 'hello', preset: 'quick' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.description).toBe('hello');
    expect(job.useWorktree).toBe(false);
    expect(job.reviewConfig).toBeUndefined();
  });

  it('reviewed preset routes to job with review', () => {
    const req: CreateTaskRequest = { description: 'review me', preset: 'reviewed' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.useWorktree).toBe(true);
    expect(job.reviewConfig).toEqual({ models: ['codex-gpt-5.5'], auto: true });
  });

  it('autonomous preset routes to workflow', () => {
    const req: CreateTaskRequest = { description: 'big task', preset: 'autonomous' };
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('workflow');
    const wf = taskToWorkflowRequest(req, cfg);
    expect(wf.task).toBe('big task');
    expect(wf.maxCycles).toBe(10);
    expect(wf.useWorktree).toBe(true);
  });

  it('template-only task routes to job with empty description', () => {
    const req: CreateTaskRequest = { templateId: 'tpl-1' };
    expect(validateTaskRequest(req)).toBeNull();
    const cfg = resolveTaskConfig(req);
    expect(cfg.routesTo).toBe('job');
    const job = taskToJobRequest(req, cfg);
    expect(job.description).toBe('');
    expect(job.templateId).toBe('tpl-1');
  });

  it('same input always produces the same output', () => {
    const req: CreateTaskRequest = { description: 'test', model: 'claude-opus-4-6', iterations: 3 };
    const a = resolveTaskConfig(req);
    const b = resolveTaskConfig(req);
    expect(a).toEqual(b);
    expect(taskToWorkflowRequest(req, a)).toEqual(taskToWorkflowRequest(req, b));
  });
});
