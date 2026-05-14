/**
 * Model option descriptor shared between server and client.
 */
export interface ModelOption {
  value: string;
  label: string;
}

export const DEFAULT_CLAUDE_OPUS_MODEL = 'claude-opus-4-7';
export const DEFAULT_CLAUDE_OPUS_MODEL_1M = 'claude-opus-4-7[1m]';
export const DEFAULT_CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CLAUDE_SONNET_MODEL_1M = 'claude-sonnet-4-6[1m]';
export const DEFAULT_CODEX_MODEL = 'codex-gpt-5.5';
export const DEFAULT_WORKFLOW_IMPLEMENTER_MODEL = DEFAULT_CLAUDE_OPUS_MODEL_1M;
export const DEFAULT_WORKFLOW_REVIEWER_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_DEBATE_CLAUDE_MODEL = DEFAULT_CLAUDE_OPUS_MODEL_1M;
export const DEFAULT_DEBATE_CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_VERIFY_MODEL = DEFAULT_CLAUDE_OPUS_MODEL;
export const DEFAULT_EYE_MODEL = DEFAULT_CLAUDE_OPUS_MODEL;
export const DEFAULT_CLAUDE_EFFORT = 'xhigh';
export const DEFAULT_CODEX_REASONING_EFFORT = 'xhigh';

/** Phases with dedicated effort/thinking-budget defaults. */
export type EffortPhase = 'assess' | 'review' | 'implement' | 'verify';

/**
 * Effort defaults by workflow phase. Tuned so judgment-heavy phases keep max
 * thinking budget and execution-heavy phases drop to `medium` — the plan was
 * already produced at `xhigh` in assess, so each implement turn doesn't need
 * to re-derive strategy. Non-workflow jobs and phases not listed here fall
 * back to `DEFAULT_CLAUDE_EFFORT` ('xhigh').
 */
const PHASE_EFFORT_DEFAULTS: Record<EffortPhase, string> = {
  assess: 'xhigh',
  review: 'xhigh',
  implement: 'medium',
  verify: 'xhigh',
};

/**
 * Resolve effort/reasoning budget for a phase, with env-var overrides:
 *   EFFORT_ASSESS, EFFORT_REVIEW, EFFORT_IMPLEMENT, EFFORT_VERIFY,
 *   EFFORT_DEFAULT (for jobs without a workflow_phase).
 *
 * Set an env var to the empty string to disable the flag for that phase
 * (the agent CLI is spawned without `--effort` / `model_reasoning_effort`).
 */
function resolveEffort(phase: string | null | undefined): string | null {
  const envKey = phase ? `EFFORT_${phase.toUpperCase()}` : 'EFFORT_DEFAULT';
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined) {
    return fromEnv === '' ? null : fromEnv;
  }
  if (phase && phase in PHASE_EFFORT_DEFAULTS) {
    return PHASE_EFFORT_DEFAULTS[phase as EffortPhase];
  }
  return DEFAULT_CLAUDE_EFFORT;
}

export function getClaudeEffort(model: string | null, phase?: string | null): string | null {
  if (model === DEFAULT_CLAUDE_OPUS_MODEL || model === DEFAULT_CLAUDE_OPUS_MODEL_1M) {
    return resolveEffort(phase);
  }
  return null;
}

export function getCodexReasoningEffort(model: string | null, phase?: string | null): string | null {
  if (model === 'codex' || (model != null && model.startsWith('codex-'))) {
    return resolveEffort(phase);
  }
  return null;
}

/** Claude models available for job dispatch. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: DEFAULT_CLAUDE_OPUS_MODEL_1M, label: 'claude-opus-4-7[1m] — most capable, 1M context (latest)' },
  { value: 'claude-opus-4-6[1m]',        label: 'claude-opus-4-6[1m] — 1M context (previous)' },
  { value: DEFAULT_CLAUDE_SONNET_MODEL_1M, label: 'claude-sonnet-4-6[1m] — balanced, 1M context' },
  { value: 'claude-haiku-4-5-20251001',  label: 'claude-haiku-4-5 — fastest, cheapest' },
];

/**
 * Fallback codex model list used when the server cannot reach the OpenAI API.
 * Update this whenever OpenAI releases a new flagship codex model.
 */
export const CODEX_MODEL_OPTIONS_FALLBACK: ModelOption[] = [
  { value: 'codex',               label: 'codex — default (gpt-5.5)' },
  { value: DEFAULT_CODEX_MODEL,   label: 'codex — gpt-5.5' },
  { value: 'codex-gpt-5.4',       label: 'codex — gpt-5.4 (previous)' },
  { value: 'codex-gpt-5.3-codex', label: 'codex — gpt-5.3-codex (older)' },
];
