import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import { insertRouteDecision } from '../db/routeDecisionQueries.js';
import { buildRoutingBrainContext, renderRoutingBrainPrompt } from './RoutingBrainPrompt.js';
import type { MilestoneContext } from './RoutingBrainPrompt.js';
import { estimateCostUsd } from './CostEstimator.js';
import { getAvailableModel, KNOWN_MODELS } from './ModelClassifier.js';
import type { Workflow, WorkflowPhase, RouteDecision, RouteDecisionMode } from '../../shared/types.js';

const DEFAULT_DECISION_MODEL = 'claude-sonnet-4-6[1m]';
const DECISION_TIMEOUT_MS = 30_000;
const DECISION_MAX_TOKENS = 512;

// ─── Settings helpers ────────────────────────────────────────────────────────

export function getRoutingBrainMode(): 'off' | 'shadow' | 'live' {
  const dbNote = queries.getNote('setting:routing_brain_mode');
  if (dbNote?.value && ['off', 'shadow', 'live'].includes(dbNote.value)) {
    return dbNote.value as 'off' | 'shadow' | 'live';
  }
  const env = process.env.ROUTING_BRAIN_MODE;
  if (env && ['off', 'shadow', 'live'].includes(env)) {
    return env as 'off' | 'shadow' | 'live';
  }
  return 'off';
}

export function getRoutingBrainDecisionModel(): string {
  const dbNote = queries.getNote('setting:routing_brain_decision_model');
  if (dbNote?.value && dbNote.value.trim().length > 0) {
    return dbNote.value.trim();
  }
  const env = process.env.ROUTING_BRAIN_DECISION_MODEL;
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return DEFAULT_DECISION_MODEL;
}

// ─── LLM response parsing ───────────────────────────────────────────────────

interface LlmDecisionFields {
  implementerModel: string;
  reviewerModel: string | null;
  skipReview: boolean;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

function extractJsonFromResponse(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) return fencedMatch[1].trim();
  return trimmed;
}

function parseDecisionResponse(raw: string): LlmDecisionFields {
  const jsonStr = extractJsonFromResponse(raw);
  const parsed = JSON.parse(jsonStr);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('response is not a JSON object');
  }
  if (typeof parsed.implementerModel !== 'string' || !parsed.implementerModel) {
    throw new Error('missing or invalid implementerModel');
  }
  if (parsed.reviewerModel !== null && typeof parsed.reviewerModel !== 'string') {
    throw new Error('reviewerModel must be string or null');
  }
  if (typeof parsed.skipReview !== 'boolean') {
    throw new Error('missing or invalid skipReview');
  }
  if (!['low', 'medium', 'high'].includes(parsed.confidence)) {
    throw new Error('confidence must be low|medium|high');
  }
  if (typeof parsed.rationale !== 'string') {
    throw new Error('missing or invalid rationale');
  }

  return {
    implementerModel: parsed.implementerModel,
    reviewerModel: parsed.reviewerModel ?? null,
    skipReview: parsed.skipReview,
    confidence: parsed.confidence as 'low' | 'medium' | 'high',
    rationale: parsed.rationale.slice(0, 500),
  };
}

// ─── Guardrails ─────────────────────────────────────────────────────────────

const CRITICAL_PATH_PATTERNS = [
  /(^|\/)config\.yaml$/i,
  /(^|\/)package\.json$/i,
  /src\/server\/db\/migrations\//i,
  /(^|\/)schema\.ts$/i,
  /(^|\/)schema\.sql$/i,
];

// Map friendly/prompt-menu model aliases to their canonical dispatchable forms
const MODEL_ALIAS_TO_CANONICAL: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

const ROUTING_BRAIN_MODEL_IDS = new Set<string>([
  ...KNOWN_MODELS,
  'claude-haiku-4-5',
  'codex-gpt-5.5',
]);

function isFinalMilestone(workflow: Workflow): boolean {
  return workflow.milestones_done >= workflow.milestones_total - 1;
}

/**
 * Canonicalize a model ID from the LLM response to a dispatchable form.
 * Maps aliases like 'claude-haiku-4-5' to their canonical IDs.
 */
function canonicalizeModelId(model: string): string {
  return MODEL_ALIAS_TO_CANONICAL[model] ?? model;
}

function normalizePathToken(token: string): string {
  return token
    .trim()
    .replace(/^[`"'([{<]+/, '')
    .replace(/[`"'\])}>.,:;]+$/, '');
}

function tokenizeMilestoneText(milestone: MilestoneContext): string[] {
  const sources = [
    milestone.raw,
    ...milestone.bodyBullets,
    ...milestone.mentionedPaths,
  ];
  const tokens = new Set<string>();
  for (const source of sources) {
    for (const token of source.split(/\s+/)) {
      const normalized = normalizePathToken(token);
      if (normalized) tokens.add(normalized);
    }
  }
  return [...tokens];
}

/**
 * Check if a milestone mentions any critical files.
 * Matches both backtick-quoted paths and embedded text mentions.
 */
function milestoneMatchesCriticalPath(milestone: MilestoneContext): boolean {
  for (const token of tokenizeMilestoneText(milestone)) {
    for (const pattern of CRITICAL_PATH_PATTERNS) {
      if (pattern.test(token)) return true;
    }
  }
  return false;
}

function isKnownModel(model: string): boolean {
  return ROUTING_BRAIN_MODEL_IDS.has(model);
}

export function applyGuardrails(
  decision: RouteDecision,
  workflow: Workflow,
  milestone: MilestoneContext,
): RouteDecision {
  const overrides: string[] = [...decision.guardrailOverrides];
  let { implementerModel, reviewerModel, skipReview } = decision;

  // 1. Force skipReview=false on final milestone
  if (skipReview && isFinalMilestone(workflow)) {
    skipReview = false;
    overrides.push('skipReview forced false: final milestone');
  }

  // 2. Force skipReview=false on critical-path files
  if (skipReview && milestoneMatchesCriticalPath(milestone)) {
    skipReview = false;
    overrides.push('skipReview forced false: critical-path files detected');
  }

  // 3. If skipReview=true, null the reviewer
  if (skipReview) {
    reviewerModel = null;
  }

  // 4. Canonicalize and check implementer model
  const canonicalImpl = canonicalizeModelId(implementerModel);
  if (!isKnownModel(implementerModel)) {
    const fallback = getAvailableModel(workflow.implementer_model) ?? workflow.implementer_model;
    overrides.push(`implementerModel swapped: unknown model "${implementerModel}" -> ${fallback}`);
    implementerModel = fallback;
  } else {
    // Check availability using canonical form
    const available = getAvailableModel(canonicalImpl);
    if (available !== canonicalImpl) {
      const resolved = available ?? workflow.implementer_model;
      overrides.push(`implementerModel swapped: rate-limited "${implementerModel}" (canonical: ${canonicalImpl}) -> ${resolved}`);
      implementerModel = resolved;
    } else {
      // Canonical form is available; use it in the returned decision
      implementerModel = canonicalImpl;
    }
  }

  // 5. Canonicalize and check reviewer model (when not skipping)
  if (!skipReview) {
    if (reviewerModel === null || reviewerModel === undefined) {
      const fallback = getAvailableModel(workflow.reviewer_model) ?? workflow.reviewer_model;
      overrides.push(`reviewerModel fallback: missing -> ${fallback}`);
      reviewerModel = fallback;
    } else if (!isKnownModel(reviewerModel)) {
      const fallback = getAvailableModel(workflow.reviewer_model) ?? workflow.reviewer_model;
      overrides.push(`reviewerModel swapped: unknown model "${reviewerModel}" -> ${fallback}`);
      reviewerModel = fallback;
    } else {
      // Check availability using canonical form
      const canonicalReviewer = canonicalizeModelId(reviewerModel);
      const available = getAvailableModel(canonicalReviewer);
      if (available !== canonicalReviewer) {
        const resolved = available ?? workflow.reviewer_model;
        overrides.push(`reviewerModel swapped: rate-limited "${reviewerModel}" (canonical: ${canonicalReviewer}) -> ${resolved}`);
        reviewerModel = resolved;
      } else {
        // Canonical form is available; use it in the returned decision
        reviewerModel = canonicalReviewer;
      }
    }
  }

  if (overrides.length > decision.guardrailOverrides.length) {
    console.log(`[routing-brain] guardrail overrides for ${workflow.id}: ${overrides.slice(decision.guardrailOverrides.length).join('; ')}`);
  }

  return {
    ...decision,
    implementerModel,
    reviewerModel,
    skipReview,
    guardrailOverrides: overrides,
  };
}

// ─── Core decision function ──────────────────────────────────────────────────

export async function decideRouteForCycle(
  workflow: Workflow,
  phase: WorkflowPhase,
  cycle: number,
): Promise<RouteDecision> {
  const mode = getRoutingBrainMode();
  const decisionModel = getRoutingBrainDecisionModel();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const decidedAt = Date.now();

  const ctx = buildRoutingBrainContext(workflow, phase, cycle);
  const { system, user, promptVersion } = renderRoutingBrainPrompt(ctx);

  const signalsSent: Record<string, unknown> = {
    milestonesDone: ctx.workflow.milestonesDone,
    milestonesTotal: ctx.workflow.milestonesTotal,
    cycle: ctx.cycle,
    maxCycles: ctx.maxCycles,
    priorCycleCount: ctx.priorCycles.length,
    crossWorkflowSampleSize: ctx.crossWorkflowPriors.sampleSize,
  };

  if (!apiKey) {
    return persistFallback(workflow, phase, cycle, promptVersion, decisionModel, decidedAt, signalsSent, 'ANTHROPIC_API_KEY not set');
  }

  let llmRawResponse = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: decisionModel.replace(/\[1m\]$/, ''),
        max_tokens: DECISION_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as { content?: Array<{ text?: string }> };
    llmRawResponse = data.content?.[0]?.text ?? '';

    const fields = parseDecisionResponse(llmRawResponse);

    const inputTokenEstimate = Math.ceil((system.length + user.length) / 4);
    const outputTokenEstimate = Math.ceil(llmRawResponse.length / 4);
    const costEstimateUsd = estimateCostUsd(decisionModel, inputTokenEstimate, outputTokenEstimate);

    const rawDecision: RouteDecision = {
      implementerModel: fields.implementerModel,
      reviewerModel: fields.reviewerModel,
      skipReview: fields.skipReview,
      confidence: fields.confidence,
      rationale: fields.rationale,
      guardrailOverrides: [],
      llmRawResponse,
      signalsSent,
      promptVersion,
      decisionModel,
      costEstimateUsd,
      decidedAt,
    };

    const decision = applyGuardrails(rawDecision, workflow, ctx.milestone);

    const persistMode: RouteDecisionMode = mode === 'off' ? 'shadow' : mode;
    insertRouteDecision({
      id: randomUUID(),
      workflow_id: workflow.id,
      cycle,
      phase,
      decision,
      mode: persistMode,
      prompt_version: promptVersion,
      decision_model: decisionModel,
    });

    console.log(`[routing-brain] decided for ${workflow.id} cycle=${cycle} phase=${phase}: impl=${decision.implementerModel} skip=${decision.skipReview} conf=${decision.confidence} (${persistMode})${decision.guardrailOverrides.length ? ` overrides=${decision.guardrailOverrides.length}` : ''}`);
    return decision;
  } catch (err) {
    const reason = err instanceof Error
      ? (err.name === 'AbortError' ? 'timeout (30s)' : err.message.slice(0, 200))
      : String(err).slice(0, 200);
    return persistFallback(workflow, phase, cycle, promptVersion, decisionModel, decidedAt, signalsSent, reason, llmRawResponse);
  }
}

function persistFallback(
  workflow: Workflow,
  phase: WorkflowPhase,
  cycle: number,
  promptVersion: string,
  decisionModel: string,
  decidedAt: number,
  signalsSent: Record<string, unknown>,
  reason: string,
  llmRawResponse = '',
): RouteDecision {
  const decision: RouteDecision = {
    implementerModel: workflow.implementer_model,
    reviewerModel: workflow.reviewer_model,
    skipReview: false,
    confidence: 'low',
    rationale: `fallback: ${reason}`,
    guardrailOverrides: [],
    llmRawResponse,
    signalsSent,
    promptVersion,
    decisionModel,
    costEstimateUsd: 0,
    decidedAt,
  };

  insertRouteDecision({
    id: randomUUID(),
    workflow_id: workflow.id,
    cycle,
    phase,
    decision,
    mode: 'fallback',
    prompt_version: promptVersion,
    decision_model: decisionModel,
  });

  console.log(`[routing-brain] fallback for ${workflow.id} cycle=${cycle}: ${reason}`);
  return decision;
}
