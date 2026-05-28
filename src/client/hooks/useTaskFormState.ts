import { useReducer, useCallback } from 'react';
import type {
  CreateTaskRequest,
  ResolvedTaskConfig,
  RetryPolicy,
  StopMode,
  TaskPreset,
} from '@shared/types';
import { resolveTaskConfig } from '@shared/taskNormalization';
import {
  DEFAULT_DEBATE_CLAUDE_MODEL,
  DEFAULT_DEBATE_CODEX_MODEL,
  DEFAULT_WORKFLOW_REVIEWER_MODEL,
} from '@shared/models';

export interface TaskFormState {
  preset: TaskPreset;

  title: string;
  description: string;
  workDir: string;
  model: string;
  templateId: string;

  review: boolean;
  reviewerModel: string;
  iterations: number;
  useWorktree: boolean;

  stopMode: StopMode;
  stopValue: number | null;
  maxTurns: number | '';
  priority: number;
  dependsOn: string[];
  interactive: boolean;
  repeatSeconds: number | '';
  retryPolicy: RetryPolicy;
  maxRetries: number;

  checkDiffNotEmpty: boolean;
  checkNoErrors: boolean;
  customCheckCmd: string;

  reviewModels: string[];
  reviewAuto: boolean;

  debateEnabled: boolean;
  debateClaudeModel: string;
  debateCodexModel: string;
  debateMaxRounds: number;

  verifyEnabled: boolean;
  startCommand: string;
}

export const INITIAL_TASK_FORM_STATE: TaskFormState = {
  preset: 'quick',
  title: '',
  description: '',
  workDir: '',
  model: '',
  templateId: '',
  review: false,
  reviewerModel: DEFAULT_WORKFLOW_REVIEWER_MODEL,
  iterations: 1,
  useWorktree: false,
  stopMode: 'completion',
  stopValue: null,
  maxTurns: '',
  priority: 0,
  dependsOn: [],
  interactive: true,
  repeatSeconds: '',
  retryPolicy: 'none',
  maxRetries: 3,
  checkDiffNotEmpty: false,
  checkNoErrors: false,
  customCheckCmd: '',
  reviewModels: [],
  reviewAuto: true,
  debateEnabled: false,
  debateClaudeModel: DEFAULT_DEBATE_CLAUDE_MODEL,
  debateCodexModel: DEFAULT_DEBATE_CODEX_MODEL,
  debateMaxRounds: 3,
  verifyEnabled: true,
  startCommand: 'npm run dev',
};

export type TaskFormAction =
  | { type: 'set'; patch: Partial<TaskFormState> }
  | { type: 'applyPreset'; preset: TaskPreset }
  | { type: 'setIterations'; raw: number }
  | { type: 'toggleDepend'; id: string }
  | { type: 'toggleReviewModel'; model: string };

/**
 * Return the state patch that applying `preset` should produce.  Pure — does
 * not read or mutate component state.  Routing-critical defaults are derived
 * from the shared resolver so the client cannot drift from backend behaviour.
 */
export function applyPresetPatch(preset: TaskPreset): Partial<TaskFormState> {
  const config = resolveTaskConfig({ preset });
  const patch: Partial<TaskFormState> = {
    preset,
    review: config.review,
    iterations: config.iterations,
    useWorktree: config.useWorktree,
  };
  // Preset-specific UX nudges that don't live on ResolvedTaskConfig
  if (preset === 'quick') patch.interactive = true;
  if (preset === 'autonomous') patch.interactive = false;
  return patch;
}

function clampIterations(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.round(raw), 50);
}

export function taskFormReducer(state: TaskFormState, action: TaskFormAction): TaskFormState {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };
    case 'applyPreset':
      return { ...state, ...applyPresetPatch(action.preset) };
    case 'setIterations': {
      const n = clampIterations(action.raw);
      const next: TaskFormState = { ...state, iterations: n };
      // Workflow engine always runs a review phase + worktree is the safer default
      if (n > 1) {
        next.review = true;
        next.useWorktree = true;
      }
      return next;
    }
    case 'toggleDepend':
      return {
        ...state,
        dependsOn: state.dependsOn.includes(action.id)
          ? state.dependsOn.filter(x => x !== action.id)
          : [...state.dependsOn, action.id],
      };
    case 'toggleReviewModel':
      return {
        ...state,
        reviewModels: state.reviewModels.includes(action.model)
          ? state.reviewModels.filter(x => x !== action.model)
          : [...state.reviewModels, action.model],
      };
    default:
      return state;
  }
}

/**
 * Derive the canonical ResolvedTaskConfig for the current form state.  Uses
 * the same shared resolver the backend uses, so routing/defaults cannot drift.
 */
export function deriveTaskFormConfig(state: TaskFormState): ResolvedTaskConfig {
  return resolveTaskConfig({
    preset: state.preset,
    review: state.review,
    iterations: state.iterations,
    useWorktree: state.useWorktree,
  });
}

/**
 * Build the CreateTaskRequest payload for the current form state.  Pure;
 * mirrors the previous inline construction in TaskForm.handleSubmit but uses
 * the shared resolver for routing instead of duplicating `iterations > 1`.
 */
export function buildTaskRequest(state: TaskFormState): CreateTaskRequest {
  const config = deriveTaskFormConfig(state);

  const req: CreateTaskRequest = {
    description: state.description.trim(),
    title: state.title.trim() || undefined,
    preset: state.preset,
    model: state.model.trim() || undefined,
    workDir: state.workDir.trim() || undefined,
    templateId: state.templateId || undefined,
    review: config.review,
    iterations: config.iterations,
    useWorktree: config.useWorktree || undefined,
  };

  if (config.routesTo === 'job') {
    req.reviewerModel = config.review ? (state.reviewerModel || undefined) : undefined;
    req.stopMode = state.stopMode;
    req.stopValue = state.stopValue ?? undefined;
    req.maxTurns = state.maxTurns ? Number(state.maxTurns) : undefined;
    req.priority = state.priority || undefined;
    req.dependsOn = state.dependsOn.length > 0 ? state.dependsOn : undefined;
    req.interactive = state.interactive || undefined;
    req.repeatIntervalMs = state.repeatSeconds ? Number(state.repeatSeconds) * 1000 : undefined;
    req.retryPolicy = state.retryPolicy !== 'none' ? state.retryPolicy : undefined;
    req.maxRetries = state.retryPolicy !== 'none' ? state.maxRetries : undefined;

    const completionChecks: string[] = [];
    if (state.checkDiffNotEmpty) completionChecks.push('diff_not_empty');
    if (state.checkNoErrors) completionChecks.push('no_error_in_output');
    if (state.customCheckCmd.trim()) {
      completionChecks.push(`custom_command:${state.customCheckCmd.trim()}`);
    }
    if (completionChecks.length > 0) req.completionChecks = completionChecks;

    if (config.review && state.reviewModels.length > 0) {
      req.reviewConfig = { models: state.reviewModels, auto: state.reviewAuto };
    }

    if (state.debateEnabled) {
      req.debate = true;
      req.debateClaudeModel = state.debateClaudeModel;
      req.debateCodexModel = state.debateCodexModel;
      req.debateMaxRounds = state.debateMaxRounds;
    }
  } else {
    req.reviewerModel = state.reviewerModel || undefined;
    req.startCommand = state.verifyEnabled && state.startCommand.trim()
      ? state.startCommand.trim()
      : undefined;
  }

  return req;
}

export interface TaskFormStateApi {
  state: TaskFormState;
  config: ResolvedTaskConfig;
  set: (patch: Partial<TaskFormState>) => void;
  applyPreset: (preset: TaskPreset) => void;
  setIterations: (raw: number) => void;
  toggleDepend: (id: string) => void;
  toggleReviewModel: (model: string) => void;
  buildRequest: () => CreateTaskRequest;
}

export function useTaskFormState(initial?: Partial<TaskFormState>): TaskFormStateApi {
  const [state, dispatch] = useReducer(
    taskFormReducer,
    { ...INITIAL_TASK_FORM_STATE, ...(initial ?? {}) },
  );

  const set = useCallback((patch: Partial<TaskFormState>) => dispatch({ type: 'set', patch }), []);
  const applyPreset = useCallback((preset: TaskPreset) => dispatch({ type: 'applyPreset', preset }), []);
  const setIterations = useCallback((raw: number) => dispatch({ type: 'setIterations', raw }), []);
  const toggleDepend = useCallback((id: string) => dispatch({ type: 'toggleDepend', id }), []);
  const toggleReviewModel = useCallback(
    (model: string) => dispatch({ type: 'toggleReviewModel', model }),
    [],
  );

  return {
    state,
    config: deriveTaskFormConfig(state),
    set,
    applyPreset,
    setIterations,
    toggleDepend,
    toggleReviewModel,
    buildRequest: () => buildTaskRequest(state),
  };
}
