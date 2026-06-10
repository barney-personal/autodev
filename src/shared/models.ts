import type { WorkflowPhase } from './types.js';

/**
 * Model option descriptor shared between server and client.
 */
export interface ModelOption {
  value: string;
  label: string;
}

export const DEFAULT_CLAUDE_FABLE_MODEL = 'claude-fable-5';
export const DEFAULT_CLAUDE_FABLE_MODEL_1M = 'claude-fable-5[1m]';
export const DEFAULT_CLAUDE_OPUS_MODEL = 'claude-opus-4-7';
export const DEFAULT_CLAUDE_OPUS_MODEL_1M = 'claude-opus-4-7[1m]';
export const DEFAULT_CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CLAUDE_SONNET_MODEL_1M = 'claude-sonnet-4-6[1m]';
export const DEFAULT_CODEX_MODEL = 'codex-gpt-5.5';
// Fable 5 is the default Claude model for agent work; Codex GPT-5.5 stays as
// the reviewer so plans/changes are checked by a different provider.
export const DEFAULT_WORKFLOW_IMPLEMENTER_MODEL = DEFAULT_CLAUDE_FABLE_MODEL_1M;
export const DEFAULT_WORKFLOW_REVIEWER_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_DEBATE_CLAUDE_MODEL = DEFAULT_CLAUDE_FABLE_MODEL_1M;
export const DEFAULT_DEBATE_CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_VERIFY_MODEL = DEFAULT_CLAUDE_FABLE_MODEL;
export const DEFAULT_EYE_MODEL = DEFAULT_CLAUDE_FABLE_MODEL;
export const DEFAULT_CLAUDE_EFFORT = 'xhigh';

/** Phases with dedicated effort/thinking-budget defaults. */
export type EffortPhase = 'assess' | 'review' | 'implement' | 'verify';

/**
 * Effort defaults by workflow phase. Tuned so judgment-heavy phases keep
 * max thinking budget and execution-heavy phases drop down. Reviewers run
 * at `high` rather than `xhigh` because they're paired with the `fast`
 * service tier (see `PHASE_SERVICE_TIER_DEFAULTS`) — together they trade a
 * small amount of reviewer reasoning depth for ~1.5x throughput. Non-workflow
 * jobs and phases not listed here fall back to `DEFAULT_CLAUDE_EFFORT`.
 */
const PHASE_EFFORT_DEFAULTS: Record<EffortPhase, string> = {
  assess: 'xhigh',
  review: 'high',
  implement: 'medium',
  verify: 'xhigh',
};

/**
 * Fable 5 phase defaults. Same shape as `PHASE_EFFORT_DEFAULTS`, but implement
 * runs at `high` instead of `medium`: on Fable-class models effort matters more
 * than on prior Opus tiers, and higher effort up front tends to reduce turn
 * count (and therefore total cost on a $50/MTok-output model) on agentic
 * execution. EFFORT_* env vars override both tables uniformly.
 */
const FABLE_PHASE_EFFORT_DEFAULTS: Record<EffortPhase, string> = {
  assess: 'xhigh',
  review: 'high',
  implement: 'high',
  verify: 'xhigh',
};

/**
 * Codex `service_tier` defaults by phase. `fast` gives ~1.5x throughput on
 * the priority lane at slightly higher cost — appropriate for the review
 * phase, which is judgment-heavy and benefits from faster turnaround. Other
 * phases fall through to whatever the user has in `~/.codex/config.toml`
 * (no override).
 */
const PHASE_SERVICE_TIER_DEFAULTS: Partial<Record<EffortPhase, string>> = {
  review: 'fast',
};

const KNOWN_SERVICE_TIERS = new Set(['default', 'flex', 'priority', 'fast', 'auto']);
const _warnedUnknownServiceTier = new Set<string>();

/**
 * Effort levels accepted by Claude `--effort` and Codex `model_reasoning_effort`.
 * Used to surface a typo warning when an env-var override doesn't match —
 * the CLIs would otherwise reject the value at spawn time with a confusing
 * downstream error. The array form is the single source of truth; the MCP
 * create_job schema derives its enum from it so the tool layer can never
 * accept a value the spawn-time allowlist would then drop.
 */
export const KNOWN_EFFORT_LEVEL_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const KNOWN_EFFORT_LEVELS = new Set<string>(KNOWN_EFFORT_LEVEL_VALUES);

/** Track unknown env-var values we've already warned about (warn-once). */
const _warnedUnknownEffort = new Set<string>();

/**
 * Phases that should be treated as "no phase" — they aren't real dispatch
 * phases, just workflow states. `'idle'` is the workflow's terminal/initial
 * state; jobs shouldn't be spawned in it, but if one ever is, we route to
 * `EFFORT_DEFAULT` rather than minting an undocumented `EFFORT_IDLE` key.
 */
function isDispatchPhase(phase: WorkflowPhase | null | undefined): phase is EffortPhase {
  return phase != null && phase !== 'idle';
}

/**
 * Resolve effort/reasoning budget for a phase, with env-var overrides:
 *   EFFORT_ASSESS, EFFORT_REVIEW, EFFORT_IMPLEMENT, EFFORT_VERIFY,
 *   EFFORT_DEFAULT (for jobs without a workflow_phase, or in `'idle'`).
 *
 * Set an env var to the empty string to disable the flag for that phase
 * (the agent CLI is spawned without `--effort` / `model_reasoning_effort`).
 * Unknown effort values are **rejected** (treated as "no flag" + a one-time
 * warning) rather than passed through, because the value reaches a shell
 * command string in `AgentSpawner.ts` — `JSON.stringify` escapes JSON
 * metachars but not shell metachars like `$()` or backticks. Strict
 * allowlisting closes that vector. New CLI effort levels need to be added
 * to `KNOWN_EFFORT_LEVELS` here.
 */
function resolveEffort(
  phase: WorkflowPhase | null | undefined,
  phaseDefaults: Record<EffortPhase, string> = PHASE_EFFORT_DEFAULTS,
): string | null {
  const envKey = isDispatchPhase(phase) ? `EFFORT_${phase.toUpperCase()}` : 'EFFORT_DEFAULT';
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined) {
    if (fromEnv === '') return null;
    if (KNOWN_EFFORT_LEVELS.has(fromEnv)) return fromEnv;
    const seenKey = `${envKey}=${fromEnv}`;
    if (!_warnedUnknownEffort.has(seenKey)) {
      _warnedUnknownEffort.add(seenKey);
      console.warn(
        `[models] ${envKey}="${fromEnv}" is not a recognised effort level ` +
        `(expected one of: ${[...KNOWN_EFFORT_LEVELS].join(', ')}). ` +
        `Ignoring — the CLI will run without an effort flag.`,
      );
    }
    return null;
  }
  if (isDispatchPhase(phase) && phase in phaseDefaults) {
    return phaseDefaults[phase];
  }
  return DEFAULT_CLAUDE_EFFORT;
}

/** @internal — test seam to reset the warn-once memos between specs. */
export function _resetEffortWarningsForTest(): void {
  _warnedUnknownEffort.clear();
  _warnedUnknownServiceTier.clear();
}

/**
 * Claude models that get an `--effort` flag, by family. Sonnet/Haiku run
 * without one (Sonnet 4.6 doesn't support `xhigh`, and the flag has never
 * been passed for those tiers here). Opus 4.6 is also deliberately excluded:
 * it predates the effort tuning this orchestrator uses, so a job whose
 * rate-limit fallback cascades past Opus 4.7 down to `claude-opus-4-6[1m]`
 * runs without an effort flag — including jobs with a classifier-pinned
 * effort.
 */
const FABLE_EFFORT_MODELS = new Set([DEFAULT_CLAUDE_FABLE_MODEL, DEFAULT_CLAUDE_FABLE_MODEL_1M]);
const OPUS_EFFORT_MODELS = new Set([DEFAULT_CLAUDE_OPUS_MODEL, DEFAULT_CLAUDE_OPUS_MODEL_1M]);

/**
 * Resolve the `--effort` flag for a Claude model.
 *
 * Precedence: a job-pinned effort (set by the auto-classifier to scale effort
 * with task complexity) wins over phase/env defaults. `jobEffort` is strictly
 * allowlisted against KNOWN_EFFORT_LEVELS because the value reaches a shell
 * command string in AgentSpawner.ts — unknown values fall through to the
 * phase/env resolution rather than being passed along.
 */
export function getClaudeEffort(
  model: string | null,
  phase?: WorkflowPhase | null,
  jobEffort?: string | null,
): string | null {
  if (model == null) return null;
  const isFable = FABLE_EFFORT_MODELS.has(model);
  if (!isFable && !OPUS_EFFORT_MODELS.has(model)) return null;
  if (jobEffort != null && KNOWN_EFFORT_LEVELS.has(jobEffort)) return jobEffort;
  return resolveEffort(phase, isFable ? FABLE_PHASE_EFFORT_DEFAULTS : PHASE_EFFORT_DEFAULTS);
}

export function getCodexReasoningEffort(model: string | null, phase?: WorkflowPhase | null): string | null {
  if (model === 'codex' || (model != null && model.startsWith('codex-'))) {
    return resolveEffort(phase);
  }
  return null;
}

/**
 * Resolve Codex `service_tier` for a phase. Returns `null` when no override
 * should be passed (the user's `~/.codex/config.toml` value takes effect).
 *
 * Env-var overrides: `CODEX_SERVICE_TIER_ASSESS`, `_REVIEW`, `_IMPLEMENT`,
 * `_VERIFY`, and `_DEFAULT` (for non-workflow jobs). Empty string disables
 * the per-phase default so the config.toml value is used.
 */
export function getCodexServiceTier(model: string | null, phase?: WorkflowPhase | null): string | null {
  if (!(model === 'codex' || (model != null && model.startsWith('codex-')))) return null;
  const envKey = isDispatchPhase(phase) ? `CODEX_SERVICE_TIER_${phase.toUpperCase()}` : 'CODEX_SERVICE_TIER_DEFAULT';
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined) {
    if (fromEnv === '') return null;
    if (KNOWN_SERVICE_TIERS.has(fromEnv)) return fromEnv;
    // Unknown tier — reject rather than pass through, same reasoning as
    // resolveEffort: value reaches a shell string in AgentSpawner.ts.
    const seenKey = `${envKey}=${fromEnv}`;
    if (!_warnedUnknownServiceTier.has(seenKey)) {
      _warnedUnknownServiceTier.add(seenKey);
      console.warn(
        `[models] ${envKey}="${fromEnv}" is not a recognised Codex service tier ` +
        `(expected one of: ${[...KNOWN_SERVICE_TIERS].join(', ')}). ` +
        `Ignoring — config.toml value will be used instead.`,
      );
    }
    return null;
  }
  if (isDispatchPhase(phase) && phase in PHASE_SERVICE_TIER_DEFAULTS) {
    return PHASE_SERVICE_TIER_DEFAULTS[phase] ?? null;
  }
  return null;
}

/** Claude models available for job dispatch. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: DEFAULT_CLAUDE_FABLE_MODEL_1M, label: 'claude-fable-5[1m] — most capable, 1M context (latest)' },
  { value: DEFAULT_CLAUDE_OPUS_MODEL_1M, label: 'claude-opus-4-7[1m] — 1M context (previous)' },
  { value: 'claude-opus-4-6[1m]',        label: 'claude-opus-4-6[1m] — 1M context (older)' },
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
