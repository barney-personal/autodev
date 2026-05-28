import { describe, it, expect } from 'vitest';
import {
  INITIAL_TASK_FORM_STATE,
  applyPresetPatch,
  buildTaskRequest,
  deriveTaskFormConfig,
  taskFormReducer,
  type TaskFormState,
} from '../../client/hooks/useTaskFormState';

function withState(patch: Partial<TaskFormState>): TaskFormState {
  return { ...INITIAL_TASK_FORM_STATE, ...patch };
}

describe('useTaskFormState — applyPresetPatch', () => {
  it('quick preset disables review, single iteration, no worktree, interactive on', () => {
    expect(applyPresetPatch('quick')).toEqual({
      preset: 'quick',
      review: false,
      iterations: 1,
      useWorktree: false,
      interactive: true,
    });
  });

  it('reviewed preset enables review and worktree, single iteration', () => {
    expect(applyPresetPatch('reviewed')).toEqual({
      preset: 'reviewed',
      review: true,
      iterations: 1,
      useWorktree: true,
    });
  });

  it('autonomous preset enables review/worktree and uses backend default iterations (10)', () => {
    const patch = applyPresetPatch('autonomous');
    expect(patch.preset).toBe('autonomous');
    expect(patch.review).toBe(true);
    expect(patch.useWorktree).toBe(true);
    expect(patch.iterations).toBe(10);
    expect(patch.interactive).toBe(false);
  });
});

describe('useTaskFormState — reducer', () => {
  it('set patches multiple fields at once', () => {
    const next = taskFormReducer(INITIAL_TASK_FORM_STATE, {
      type: 'set',
      patch: { title: 'hi', description: 'world' },
    });
    expect(next.title).toBe('hi');
    expect(next.description).toBe('world');
  });

  it('applyPreset switches the routing-critical fields', () => {
    const next = taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'applyPreset', preset: 'autonomous' });
    expect(next.iterations).toBeGreaterThan(1);
    expect(next.review).toBe(true);
    expect(next.useWorktree).toBe(true);
    expect(next.preset).toBe('autonomous');
  });

  it('setIterations clamps non-finite and negative values to 1', () => {
    expect(taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'setIterations', raw: NaN }).iterations).toBe(1);
    expect(taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'setIterations', raw: -5 }).iterations).toBe(1);
    expect(taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'setIterations', raw: 9999 }).iterations).toBe(50);
  });

  it('setIterations >1 forces review=true and useWorktree=true', () => {
    const next = taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'setIterations', raw: 3 });
    expect(next.iterations).toBe(3);
    expect(next.review).toBe(true);
    expect(next.useWorktree).toBe(true);
  });

  it('toggleDepend adds and removes job ids', () => {
    const added = taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'toggleDepend', id: 'j1' });
    expect(added.dependsOn).toEqual(['j1']);
    const removed = taskFormReducer(added, { type: 'toggleDepend', id: 'j1' });
    expect(removed.dependsOn).toEqual([]);
  });

  it('toggleReviewModel adds and removes review models', () => {
    const added = taskFormReducer(INITIAL_TASK_FORM_STATE, { type: 'toggleReviewModel', model: 'haiku' });
    expect(added.reviewModels).toEqual(['haiku']);
    const removed = taskFormReducer(added, { type: 'toggleReviewModel', model: 'haiku' });
    expect(removed.reviewModels).toEqual([]);
  });
});

describe('useTaskFormState — deriveTaskFormConfig', () => {
  it('routes to job for iterations=1', () => {
    const config = deriveTaskFormConfig(withState({ iterations: 1, preset: 'quick' }));
    expect(config.routesTo).toBe('job');
    expect(config.iterations).toBe(1);
  });

  it('routes to workflow for iterations>1 and forces review on', () => {
    const config = deriveTaskFormConfig(withState({ iterations: 5, preset: 'autonomous', review: false }));
    expect(config.routesTo).toBe('workflow');
    expect(config.review).toBe(true);
  });
});

describe('useTaskFormState — buildTaskRequest', () => {
  it('quick preset produces a minimal job request', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick',
      description: ' build it ',
      title: '  ',
      iterations: 1,
      review: false,
      useWorktree: false,
    }));
    expect(req).toMatchObject({
      description: 'build it',
      preset: 'quick',
      review: false,
      iterations: 1,
      title: undefined,
      stopMode: 'completion',
      interactive: true,
    });
    expect(req.useWorktree).toBeUndefined();
    expect(req.reviewerModel).toBeUndefined();
    expect(req.reviewConfig).toBeUndefined();
    expect(req.debate).toBeUndefined();
    expect(req.startCommand).toBeUndefined();
    expect(req.completionChecks).toBeUndefined();
  });

  it('reviewed preset sets reviewerModel and review=true on job route', () => {
    const req = buildTaskRequest(withState({
      preset: 'reviewed',
      description: 'review me',
      review: true,
      iterations: 1,
      useWorktree: true,
      reviewerModel: 'codex-x',
    }));
    expect(req.review).toBe(true);
    expect(req.iterations).toBe(1);
    expect(req.useWorktree).toBe(true);
    expect(req.reviewerModel).toBe('codex-x');
  });

  it('autonomous preset routes to workflow with reviewer model and verify start command', () => {
    const req = buildTaskRequest(withState({
      preset: 'autonomous',
      description: 'do the thing',
      iterations: 10,
      review: true,
      useWorktree: true,
      reviewerModel: 'codex-x',
      verifyEnabled: true,
      startCommand: '  npm run dev  ',
    }));
    expect(req.iterations).toBe(10);
    expect(req.useWorktree).toBe(true);
    expect(req.reviewerModel).toBe('codex-x');
    expect(req.startCommand).toBe('npm run dev');
    // workflow route must not carry job-only fields
    expect(req.stopMode).toBeUndefined();
    expect(req.dependsOn).toBeUndefined();
    expect(req.retryPolicy).toBeUndefined();
    expect(req.completionChecks).toBeUndefined();
    expect(req.debate).toBeUndefined();
  });

  it('workflow with verify disabled or blank command omits startCommand', () => {
    const off = buildTaskRequest(withState({
      preset: 'autonomous', description: 'x', iterations: 4, review: true,
      verifyEnabled: false, startCommand: 'npm run dev',
    }));
    expect(off.startCommand).toBeUndefined();
    const blank = buildTaskRequest(withState({
      preset: 'autonomous', description: 'x', iterations: 4, review: true,
      verifyEnabled: true, startCommand: '   ',
    }));
    expect(blank.startCommand).toBeUndefined();
  });

  it('template-only job request keeps trimmed description blank but passes templateId', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick',
      description: '   ',
      templateId: 'tpl-1',
    }));
    expect(req.description).toBe('');
    expect(req.templateId).toBe('tpl-1');
  });

  it('completion checks include diff/no_errors/custom in order', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick', description: 'x',
      checkDiffNotEmpty: true,
      checkNoErrors: true,
      customCheckCmd: '  npm test  ',
    }));
    expect(req.completionChecks).toEqual([
      'diff_not_empty', 'no_error_in_output', 'custom_command:npm test',
    ]);
  });

  it('dependencies and priority are passed through on job route', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick', description: 'x',
      dependsOn: ['j1', 'j2'], priority: 5,
    }));
    expect(req.dependsOn).toEqual(['j1', 'j2']);
    expect(req.priority).toBe(5);
  });

  it('retry policy=same passes retryPolicy + maxRetries; none clears them', () => {
    const same = buildTaskRequest(withState({
      preset: 'quick', description: 'x', retryPolicy: 'same', maxRetries: 5,
    }));
    expect(same.retryPolicy).toBe('same');
    expect(same.maxRetries).toBe(5);

    const none = buildTaskRequest(withState({
      preset: 'quick', description: 'x', retryPolicy: 'none', maxRetries: 5,
    }));
    expect(none.retryPolicy).toBeUndefined();
    expect(none.maxRetries).toBeUndefined();
  });

  it('reviewConfig is only included when review=true and review models are picked', () => {
    const withModels = buildTaskRequest(withState({
      preset: 'reviewed', description: 'x', review: true,
      reviewModels: ['claude-opus-4-7[1m]'], reviewAuto: false,
    }));
    expect(withModels.reviewConfig).toEqual({ models: ['claude-opus-4-7[1m]'], auto: false });

    const noModels = buildTaskRequest(withState({
      preset: 'reviewed', description: 'x', review: true, reviewModels: [],
    }));
    expect(noModels.reviewConfig).toBeUndefined();

    const reviewOff = buildTaskRequest(withState({
      preset: 'quick', description: 'x', review: false,
      reviewModels: ['claude-opus-4-7[1m]'],
    }));
    expect(reviewOff.reviewConfig).toBeUndefined();
  });

  it('debate flags are passed through when enabled', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick', description: 'x',
      debateEnabled: true,
      debateClaudeModel: 'claude-opus-4-7[1m]',
      debateCodexModel: 'codex-x',
      debateMaxRounds: 7,
    }));
    expect(req.debate).toBe(true);
    expect(req.debateClaudeModel).toBe('claude-opus-4-7[1m]');
    expect(req.debateCodexModel).toBe('codex-x');
    expect(req.debateMaxRounds).toBe(7);
  });

  it('repeatSeconds is converted to milliseconds', () => {
    const req = buildTaskRequest(withState({
      preset: 'quick', description: 'x', repeatSeconds: 30,
    }));
    expect(req.repeatIntervalMs).toBe(30_000);
  });
});
