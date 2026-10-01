import type { WorkflowPhase } from './types.js';

/**
 * Model option descriptor shared between server and client.
 */
export interface ModelOption {
  value: string;
  label: string;
}

// Retain legacy IDs for pinned jobs and rate-limit fallbacks.
export const DEFAULT_CLAUDE_OPUS_48_MODEL = 'claude-opus-4-8';
export const DEFAULT_CLAUDE_OPUS_48_MODEL_1M = 'claude-opus-4-8[1m]';
export const DEFAULT_CLAUDE_OPUS_MODEL = 'claude-opus-4-7';
export const DEFAULT_CLAUDE_OPUS_MODEL_1M = 'claude-opus-4-7[1m]';
export const DEFAULT_CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CLAUDE_SONNET_MODEL_1M = 'claude-sonnet-4-6[1m]';
// Verified against the provider catalogs on 2026-10-01. Keep explicit IDs:
// provider aliases and the CLI's configured default can change independently.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const BALANCED_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_CODEX_MODEL = 'codex-gpt-6.1-sol';
export const FRONTIER_CODEX_MODEL = 'codex-gpt-6-astra';
export const EFFICIENT_CODEX_MODEL = 'codex-gpt-6-luna';
// Use independent providers for implementation and review.
export const DEFAULT_WORKFLOW_IMPLEMENTER_MODEL = DEFAULT_CLAUDE_MODEL;
export const DEFAULT_WORKFLOW_REVIEWER_MODEL = FRONTIER_CODEX_MODEL;
export const DEFAULT_DEBATE_CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export const DEFAULT_DEBATE_CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_VERIFY_MODEL = DEFAULT_CLAUDE_MODEL;
export const DEFAULT_EYE_MODEL = DEFAULT_CLAUDE_MODEL;
export const DEFAULT_CLAUDE_EFFORT = 'xhigh';

/** Phases with dedicated effort/thinking-budget defaults. */
export type EffortPhase = 'assess' | 'review' | 'implement' | 'verify';

/**
 * Effort defaults by workflow phase. Tuned so judgment-heavy phases keep
 * max thinking budget and execution-heavy phases drop down. Reviewers run
 * at `high` rather than `xhigh`. Inference speed is configured separately
 * and does not alter these reasoning budgets. Non-workflow
 * jobs and phases not listed here fall back to `DEFAULT_CLAUDE_EFFORT`.
 */
const PHASE_EFFORT_DEFAULTS: Record<EffortPhase, string> = {
  assess: 'xhigh',
  review: 'high',
  implement: 'medium',
  verify: 'xhigh',
};

/**
 * Frontier-model phase defaults. Same shape as
 * `PHASE_EFFORT_DEFAULTS`, but implement runs at `high` instead of `medium`:
 * on the frontier tier effort matters more than on prior Opus tiers, and
 * higher effort up front tends to reduce turn count (and therefore total
 * cost) on agentic execution. EFFORT_* env vars override both tables
 * uniformly. Opus 4.7 stays on the standard table as the fallback tier.
 */
const FRONTIER_PHASE_EFFORT_DEFAULTS: Record<EffortPhase, string> = {
  assess: 'xhigh',
  review: 'high',
  implement: 'high',
  verify: 'xhigh',
};

// Leave tier selection to the CLI unless the operator explicitly overrides it.
// In particular, a review must not downgrade a configured Ultrafast preference.
const KNOWN_SERVICE_TIERS = new Set(['default', 'flex', 'priority', 'fast', 'ultrafast', 'auto']);
const _warnedUnknownServiceTier = new Set<string>();
const _warnedUnknownFastMode = new Set<string>();

/**
 * Effort levels accepted by Claude `--effort` and Codex `model_reasoning_effort`.
 * Used to surface a typo warning when an env-var override doesn't match —
 * the CLIs would otherwise reject the value at spawn time with a confusing
 * downstream error. The array form is the single source of truth; the MCP
 * create_job schema derives its enum from it so the tool layer can never
 * accept a value the spawn-time allowlist would then drop.
 */
export const KNOWN_EFFORT_LEVEL_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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
  _warnedUnknownFastMode.clear();
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
const FRONTIER_EFFORT_MODELS = new Set([DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_OPUS_48_MODEL, DEFAULT_CLAUDE_OPUS_48_MODEL_1M]);
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
  const isFrontier = FRONTIER_EFFORT_MODELS.has(model);
  if (!isFrontier && !OPUS_EFFORT_MODELS.has(model) && model !== BALANCED_CLAUDE_MODEL) return null;
  const effort = jobEffort != null && KNOWN_EFFORT_LEVELS.has(jobEffort) ? jobEffort : resolveEffort(phase, isFrontier ? FRONTIER_PHASE_EFFORT_DEFAULTS : PHASE_EFFORT_DEFAULTS);
  if (model === DEFAULT_CLAUDE_MODEL || model === BALANCED_CLAUDE_MODEL) return effort === 'minimal' ? 'low' : effort;
  return effort === 'max' ? 'xhigh' : effort;
}

export function getCodexReasoningEffort(model: string | null, phase?: WorkflowPhase | null, jobEffort?: string | null): string | null {
  if (model === 'codex' || (model != null && model.startsWith('codex-'))) {
    const effort = jobEffort && KNOWN_EFFORT_LEVELS.has(jobEffort) ? jobEffort : resolveEffort(phase);
    // Current Codex models start at low. Older models do not accept max.
    if (effort === 'minimal') return 'low';
    if (effort === 'max' && !/^codex-gpt-(6|5\.6)/.test(model ?? '')) return 'xhigh';
    return effort;
  }
  return null;
}

/**
 * Resolve Codex `service_tier` for a phase. Returns `null` when no override
 * should be passed (the user's `~/.codex/config.toml` value takes effect).
 *
 * Env-var overrides: `CODEX_SERVICE_TIER_ASSESS`, `_REVIEW`, `_IMPLEMENT`,
 * `_VERIFY`, and `_DEFAULT` (for non-workflow jobs). Empty or unset values
 * leave tier selection to the CLI, including its model/account eligibility.
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
  return null;
}

/**
 * Opt-in Claude Fast trial for implementation jobs. Null preserves the CLI's
 * existing settings. An optional workflow allowlist limits the trial without
 * changing models, effort, or personal Claude settings. Unknown models must
 * not receive fastMode:true: the CLI can otherwise switch them to Opus.
 */
export function getClaudeFastMode(
  model: string | null,
  phase?: WorkflowPhase | null,
  workflowId?: string | null,
): boolean | null {
  if (phase !== 'implement') return null;
  const configured = process.env.CLAUDE_FAST_MODE_IMPLEMENT;
  if (configured === undefined || configured === '') return null;
  if (configured !== 'true' && configured !== 'false') {
    if (!_warnedUnknownFastMode.has(configured)) {
      _warnedUnknownFastMode.add(configured);
      console.warn('[models] CLAUDE_FAST_MODE_IMPLEMENT must be true or false; ignoring invalid value.');
    }
    return null;
  }
  const workflowIds = process.env.CLAUDE_FAST_MODE_WORKFLOW_IDS;
  // A present but empty allowlist matches nothing, so a typo cannot broaden a trial.
  if (workflowIds !== undefined && !workflowIds.split(',').some(id => id.trim() !== '' && id.trim() === workflowId)) {
    return null;
  }
  if (!model || !/^(claude-opus-(5-5|5|4-8))(\[1m\])?$/.test(model)) return null;
  return configured === 'true';
}

/** Claude models available for job dispatch. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: DEFAULT_CLAUDE_MODEL, label: 'Claude Opus 5.5 — complex work, 1M context' },
  { value: BALANCED_CLAUDE_MODEL, label: 'Claude Sonnet 5.5 — balanced, 1M context' },
  { value: DEFAULT_CLAUDE_OPUS_48_MODEL_1M, label: 'claude-opus-4-8[1m] — 1M context (legacy)' },
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
  { value: 'codex', label: 'Codex — configured CLI default' },
  { value: DEFAULT_CODEX_MODEL, label: 'GPT-6.1 Sol — balanced coding' },
  { value: FRONTIER_CODEX_MODEL, label: 'GPT-6 Astra — demanding reasoning and review' },
  { value: EFFICIENT_CODEX_MODEL, label: 'GPT-6 Luna — fast, focused tasks' },
  { value: 'codex-gpt-5.5', label: 'GPT-5.5 — legacy' },
  { value: 'codex-gpt-5.4', label: 'GPT-5.4 — legacy' },
  { value: 'codex-gpt-5.3-codex', label: 'GPT-5.3 Codex — legacy' },
];
