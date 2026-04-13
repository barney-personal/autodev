/**
 * Phase-to-config lookup table for workflow phases.
 *
 * Eliminates the duplicated switch statements in spawnPhaseJob and
 * resumeWorkflow by providing a single source of truth for each phase's
 * model key, stop mode key, stop value key, and prompt builder.
 */
import type { Workflow, StopMode } from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';
import {
  buildAssessPrompt,
  buildImplementPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  type InlineWorkflowContext,
} from './WorkflowPrompts.js';

export type WorkflowPhase = 'assess' | 'implement' | 'review' | 'verify';

export interface PhaseConfig {
  modelKey: (keyof Workflow) | null;
  stopModeKey: (keyof Workflow) | null;
  stopValueKey: (keyof Workflow) | null;
  buildPrompt: (workflow: Workflow, cycle: number, ctx: InlineWorkflowContext | undefined) => string;
  overrides?: { model?: string; stopMode?: StopMode; stopValue?: number };
  /** Optional post-resolution hook to adjust model after lookup */
  postResolve?: (model: string) => string;
}

const PHASE_CONFIGS: Record<WorkflowPhase, PhaseConfig> = {
  assess: {
    modelKey: 'implementer_model',
    stopModeKey: 'stop_mode_assess',
    stopValueKey: 'stop_value_assess',
    buildPrompt: (workflow, _cycle, _ctx) => buildAssessPrompt(workflow),
    postResolve: (model) => {
      // Codex doesn't support MCP reliably — assess phase needs MCP for report_status/write_note
      if (isCodexModel(model)) {
        console.log('[phase-config] assess phase requires reliable MCP — falling back from Codex to Claude');
        return 'claude-sonnet-4-6';
      }
      return model;
    },
  },
  review: {
    modelKey: 'reviewer_model',
    stopModeKey: 'stop_mode_review',
    stopValueKey: 'stop_value_review',
    buildPrompt: (workflow, cycle, ctx) => buildReviewPrompt(workflow, cycle, ctx),
  },
  implement: {
    modelKey: 'implementer_model',
    stopModeKey: 'stop_mode_implement',
    stopValueKey: 'stop_value_implement',
    buildPrompt: (workflow, cycle, ctx) => buildImplementPrompt(workflow, cycle, ctx),
  },
  verify: {
    modelKey: null,
    stopModeKey: null,
    stopValueKey: null,
    buildPrompt: (workflow, cycle, ctx) => buildVerifyPrompt(workflow, cycle, ctx),
    overrides: { model: 'claude-opus-4-6', stopMode: 'turns', stopValue: 40 },
  },
};

export function getPhaseConfig(phase: string): PhaseConfig {
  const config = PHASE_CONFIGS[phase as WorkflowPhase];
  if (!config) throw new Error(`Unknown workflow phase: ${phase}`);
  return config;
}
