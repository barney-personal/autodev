/**
 * Unified task normalization — resolves presets, defaults, and routing for
 * CreateTaskRequest, and converts to the existing CreateJobRequest or
 * CreateWorkflowRequest payloads consumed by the backend managers.
 *
 * Deterministic rules (no randomness, no IO):
 *   preset    → review / iterations / useWorktree defaults
 *   iterations=1  → routes to Job
 *   iterations>1  → routes to Workflow
 */

import type {
  CreateJobRequest,
  CreateTaskRequest,
  CreateWorkflowRequest,
  ResolvedTaskConfig,
  ReviewConfig,
  TaskPreset,
} from './types.js';
import { DEFAULT_CODEX_MODEL } from './models.js';

// ─── Preset defaults ────────────────────────────────────────────────────────

interface PresetDefaults {
  review: boolean;
  iterations: number;
  useWorktree: boolean;
}

const PRESET_DEFAULTS: Record<TaskPreset, PresetDefaults> = {
  quick:      { review: false, iterations: 1,  useWorktree: false },
  reviewed:   { review: true,  iterations: 1,  useWorktree: true  },
  autonomous: { review: true,  iterations: 10, useWorktree: true  },
};

// ─── Preset inference ───────────────────────────────────────────────────────

/** Infer a preset from explicit field values when no preset is specified. */
export function inferPreset(req: CreateTaskRequest): TaskPreset {
  if (req.preset) return req.preset;
  const iterations = req.iterations ?? 1;
  if (iterations > 1) return 'autonomous';
  if (req.review === true) return 'reviewed';
  return 'quick';
}

// ─── Config resolution ──────────────────────────────────────────────────────

/**
 * Resolve the routing-critical fields for a task request.  Explicit values in
 * the request always win; gaps are filled from preset defaults.
 */
export function resolveTaskConfig(req: CreateTaskRequest): ResolvedTaskConfig {
  const preset = inferPreset(req);
  const defaults = PRESET_DEFAULTS[preset];

  const iterations = clampIterations(req.iterations ?? defaults.iterations);
  // Workflow engine always runs a review phase — force review on for workflow routing
  const review     = iterations > 1 ? true : (req.review ?? defaults.review);
  const useWorktree = req.useWorktree ?? (iterations > 1 ? true : defaults.useWorktree);

  return {
    preset,
    routesTo: iterations > 1 ? 'workflow' : 'job',
    review,
    iterations,
    useWorktree,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a CreateTaskRequest.  Returns an error string or null if valid. */
export function validateTaskRequest(req: CreateTaskRequest): string | null {
  const hasDescription = !!req.description?.trim();
  const hasTemplate = !!req.templateId;

  if (!hasDescription && !hasTemplate) {
    return 'description is required (or provide a templateId)';
  }
  if (req.iterations !== undefined) {
    if (!Number.isInteger(req.iterations) || req.iterations < 1 || req.iterations > 50) {
      return 'iterations must be an integer between 1 and 50';
    }
  }
  if (req.preset !== undefined && !PRESET_DEFAULTS[req.preset]) {
    return `invalid preset: ${req.preset}`;
  }
  // Universal numeric range checks (regardless of routing)
  if (req.stopValue !== undefined && req.stopValue <= 0) {
    return 'stopValue must be a positive number';
  }
  if (req.maxTurns !== undefined && req.maxTurns <= 0) {
    return 'maxTurns must be a positive number';
  }
  // Job-only options are invalid for autonomous tasks
  const config = resolveTaskConfig(req);
  if (config.routesTo === 'workflow') {
    // Workflow engine always includes a review phase — explicit review=false is contradictory
    if (req.review === false) return 'review cannot be disabled for autonomous tasks (iterations > 1) — the workflow engine always includes a review phase';
    // Workflows require a description — the task field is the workflow's main input
    if (!hasDescription) return 'description is required for autonomous tasks (templateId alone is not sufficient)';
    if (req.stopMode !== undefined)      return 'stopMode is not supported for autonomous tasks; use stopModeAssess/Review/Implement instead';
    if (req.stopValue !== undefined)     return 'stopValue is not supported for autonomous tasks; use stopValueAssess/Review/Implement instead';
    if (req.maxTurns !== undefined)      return 'maxTurns is not supported for autonomous tasks; use maxTurnsAssess/Review/Implement instead';
    if (req.dependsOn?.length)       return 'dependsOn is not supported for autonomous tasks (iterations > 1)';
    if (req.interactive)             return 'interactive mode is not supported for autonomous tasks';
    if (req.debate)                  return 'debate is not supported for autonomous tasks';
    if (req.repeatIntervalMs !== undefined) return 'repeatIntervalMs is not supported for autonomous tasks';
    if (req.scheduledAt !== undefined)      return 'scheduledAt is not supported for autonomous tasks';
    if (req.priority !== undefined)  return 'priority is not supported for autonomous tasks (iterations > 1)';
    if (req.retryPolicy !== undefined) return 'retryPolicy is not supported for autonomous tasks (iterations > 1)';
    if (req.maxRetries !== undefined) return 'maxRetries is not supported for autonomous tasks (iterations > 1)';
    if (req.completionChecks?.length) return 'completionChecks is not supported for autonomous tasks (iterations > 1)';
    if (req.context !== undefined)   return 'context is not supported for autonomous tasks (iterations > 1)';
    if (req.reviewConfig !== undefined) return 'reviewConfig is not supported for autonomous tasks (iterations > 1); reviewer model is set via reviewerModel';
    if (req.projectId !== undefined)   return 'projectId is not supported for autonomous tasks (iterations > 1) — workflows always create their own project';
  }
  // Per-phase stop fields and verify fields are workflow-only — reject on job-routed tasks
  if (config.routesTo === 'job') {
    const perPhaseFields = [
      'maxTurnsAssess', 'maxTurnsReview', 'maxTurnsImplement',
      'stopModeAssess', 'stopModeReview', 'stopModeImplement',
      'stopValueAssess', 'stopValueReview', 'stopValueImplement',
    ] as const;
    for (const field of perPhaseFields) {
      if (req[field] !== undefined) {
        return `${field} is a workflow-only field and cannot be used on job-routed tasks (iterations = 1)`;
      }
    }
    if (req.startCommand !== undefined) {
      return 'startCommand is a workflow-only field and cannot be used on job-routed tasks (iterations = 1)';
    }
    if (req.maxVerifyRetries !== undefined) {
      return 'maxVerifyRetries is a workflow-only field and cannot be used on job-routed tasks (iterations = 1)';
    }
  }
  return null;
}

// ─── Conversion: Task → Job ─────────────────────────────────────────────────

/**
 * Convert a CreateTaskRequest into a CreateJobRequest for the existing
 * WorkQueueManager.  Only valid when `resolveTaskConfig(req).routesTo === 'job'`.
 */
export function taskToJobRequest(req: CreateTaskRequest, config?: ResolvedTaskConfig): CreateJobRequest {
  const canonical = resolveTaskConfig(req);
  if (config) {
    // Reject any supplied config that disagrees with canonical on ANY normalized field.
    // This prevents stale same-route configs from being silently accepted.
    const mismatches: string[] = [];
    if (config.routesTo !== canonical.routesTo) mismatches.push(`routesTo: supplied '${config.routesTo}' vs canonical '${canonical.routesTo}'`);
    if (config.preset !== canonical.preset) mismatches.push(`preset: supplied '${config.preset}' vs canonical '${canonical.preset}'`);
    if (config.review !== canonical.review) mismatches.push(`review: supplied ${config.review} vs canonical ${canonical.review}`);
    if (config.iterations !== canonical.iterations) mismatches.push(`iterations: supplied ${config.iterations} vs canonical ${canonical.iterations}`);
    if (config.useWorktree !== canonical.useWorktree) mismatches.push(`useWorktree: supplied ${config.useWorktree} vs canonical ${canonical.useWorktree}`);
    if (mismatches.length > 0) {
      throw new Error(`Supplied config does not match the request's resolved configuration: ${mismatches.join('; ')}`);
    }
  }
  if (canonical.routesTo !== 'job') {
    throw new Error('Cannot convert autonomous task (iterations > 1) to a job request');
  }

  const jobReq: CreateJobRequest = {
    description: req.description ?? '',
    title: req.title,
    model: req.model,
    workDir: req.workDir,
    templateId: req.templateId,
    projectId: req.projectId,
    useWorktree: canonical.useWorktree,
    stopMode: req.stopMode,
    stopValue: req.stopValue,
    maxTurns: req.maxTurns,
    priority: req.priority,
    dependsOn: req.dependsOn,
    interactive: req.interactive,
    repeatIntervalMs: req.repeatIntervalMs,
    scheduledAt: req.scheduledAt,
    retryPolicy: req.retryPolicy,
    maxRetries: req.maxRetries,
    completionChecks: req.completionChecks,
    context: req.context,
    debate: req.debate,
    debateClaudeModel: req.debateClaudeModel,
    debateCodexModel: req.debateCodexModel,
    debateMaxRounds: req.debateMaxRounds,
  };

  // Wire up review when enabled — always uses canonical to prevent stale
  // config from adding/removing reviewConfig.
  if (canonical.review) {
    jobReq.reviewConfig = req.reviewConfig ?? buildReviewConfig(req.reviewerModel);
  }

  return jobReq;
}

// ─── Conversion: Task → Workflow ────────────────────────────────────────────

/**
 * Convert a CreateTaskRequest into a CreateWorkflowRequest for the existing
 * AutonomousAgentRunManager.  Only valid when `resolveTaskConfig(req).routesTo === 'workflow'`.
 */
export function taskToWorkflowRequest(req: CreateTaskRequest, config?: ResolvedTaskConfig): CreateWorkflowRequest {
  const canonical = resolveTaskConfig(req);
  if (config) {
    // Reject any supplied config that disagrees with canonical on ANY normalized field.
    // This prevents stale same-route configs from being silently accepted.
    const mismatches: string[] = [];
    if (config.routesTo !== canonical.routesTo) mismatches.push(`routesTo: supplied '${config.routesTo}' vs canonical '${canonical.routesTo}'`);
    if (config.preset !== canonical.preset) mismatches.push(`preset: supplied '${config.preset}' vs canonical '${canonical.preset}'`);
    if (config.review !== canonical.review) mismatches.push(`review: supplied ${config.review} vs canonical ${canonical.review}`);
    if (config.iterations !== canonical.iterations) mismatches.push(`iterations: supplied ${config.iterations} vs canonical ${canonical.iterations}`);
    if (config.useWorktree !== canonical.useWorktree) mismatches.push(`useWorktree: supplied ${config.useWorktree} vs canonical ${canonical.useWorktree}`);
    if (mismatches.length > 0) {
      throw new Error(`Supplied config does not match the request's resolved configuration: ${mismatches.join('; ')}`);
    }
  }
  if (canonical.routesTo !== 'workflow') {
    throw new Error('Cannot convert single-pass task (iterations = 1) to a workflow request');
  }

  if (!req.description?.trim()) {
    throw new Error('Workflow tasks require a description (templateId alone is not sufficient)');
  }

  // Workflow engine always includes a review phase — explicit review=false is contradictory
  if (req.review === false) {
    throw new Error('review cannot be disabled for workflow tasks (iterations > 1) — the workflow engine always includes a review phase');
  }

  // Fail fast on single-pass stop fields that have no workflow equivalent —
  // callers should not rely on a separate validation step to catch these.
  if (req.stopMode !== undefined) {
    throw new Error('stopMode is not supported for workflow tasks; use stopModeAssess/Review/Implement instead');
  }
  if (req.stopValue !== undefined) {
    throw new Error('stopValue is not supported for workflow tasks; use stopValueAssess/Review/Implement instead');
  }
  if (req.maxTurns !== undefined) {
    throw new Error('maxTurns is not supported for workflow tasks; use maxTurnsAssess/Review/Implement instead');
  }

  // Fail fast on job-only fields that have no workflow equivalent —
  // callers should not rely on a separate validation step to catch these.
  if (req.priority !== undefined) {
    throw new Error('priority is not supported for workflow tasks (iterations > 1)');
  }
  if (req.retryPolicy !== undefined) {
    throw new Error('retryPolicy is not supported for workflow tasks (iterations > 1)');
  }
  if (req.maxRetries !== undefined) {
    throw new Error('maxRetries is not supported for workflow tasks (iterations > 1)');
  }
  if (req.completionChecks?.length) {
    throw new Error('completionChecks is not supported for workflow tasks (iterations > 1)');
  }
  if (req.context !== undefined) {
    throw new Error('context is not supported for workflow tasks (iterations > 1)');
  }
  if (req.reviewConfig !== undefined) {
    throw new Error('reviewConfig is not supported for workflow tasks (iterations > 1); reviewer model is set via reviewerModel');
  }
  if (req.projectId !== undefined) {
    throw new Error('projectId is not supported for workflow tasks (iterations > 1) — workflows always create their own project');
  }

  // Fail fast on original job-only fields that have no workflow equivalent —
  // mirrors the validator guards so direct callers cannot silently lose these.
  if (req.dependsOn?.length) {
    throw new Error('dependsOn is not supported for workflow tasks (iterations > 1)');
  }
  if (req.interactive) {
    throw new Error('interactive mode is not supported for workflow tasks (iterations > 1)');
  }
  if (req.debate) {
    throw new Error('debate is not supported for workflow tasks (iterations > 1)');
  }
  if (req.repeatIntervalMs !== undefined) {
    throw new Error('repeatIntervalMs is not supported for workflow tasks (iterations > 1)');
  }
  if (req.scheduledAt !== undefined) {
    throw new Error('scheduledAt is not supported for workflow tasks (iterations > 1)');
  }

  // Always derive maxCycles from canonical config — a stale same-route config
  // must not inflate or shrink the workflow cycle count.
  return {
    task: req.description,
    title: req.title,
    workDir: req.workDir,
    implementerModel: req.model,
    reviewerModel: req.reviewerModel,
    maxCycles: canonical.iterations,
    // Always derive useWorktree from canonical config — a stale same-route
    // config must not silently enable or disable worktree creation.
    useWorktree: canonical.useWorktree,
    templateId: req.templateId,
    completionThreshold: req.completionThreshold,
    startCommand: req.startCommand,
    maxVerifyRetries: req.maxVerifyRetries,
    // Per-phase stopping conditions
    maxTurnsAssess: req.maxTurnsAssess,
    maxTurnsReview: req.maxTurnsReview,
    maxTurnsImplement: req.maxTurnsImplement,
    stopModeAssess: req.stopModeAssess,
    stopValueAssess: req.stopValueAssess,
    stopModeReview: req.stopModeReview,
    stopValueReview: req.stopValueReview,
    stopModeImplement: req.stopModeImplement,
    stopValueImplement: req.stopValueImplement,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampIterations(n: number): number {
  return Math.min(Math.max(Math.round(n), 1), 50);
}

function buildReviewConfig(reviewerModel?: string): ReviewConfig {
  return {
    models: [reviewerModel?.trim() || DEFAULT_CODEX_MODEL],
    auto: true,
  };
}
