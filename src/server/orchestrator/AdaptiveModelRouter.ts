import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import { insertRouteDecision } from '../db/routeDecisionQueries.js';
import { extractCurrentMilestone } from './RoutingBrainPrompt.js';
import { getAvailableModel } from './ModelClassifier.js';
import { classifyTask, conservativeClassification, COMPLEXITY_PROMPT_VERSION, getFastDecisionStatus, type TaskClassification } from './TaskComplexity.js';
import { BALANCED_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, EFFICIENT_CODEX_MODEL } from '../../shared/models.js';
import { isCodexModel, type Workflow, type RouteDecision } from '../../shared/types.js';
import { RecoveryKeys } from './WorkflowRecovery.js';

export function getAdaptiveRoutingMode(): 'off' | 'shadow' | 'live' {
  const mode = process.env.ADAPTIVE_ROUTING_MODE;
  return mode === 'live' || mode === 'shadow' ? mode : 'off';
}

export function getAdaptiveRoutingStatus() {
  return { mode: getAdaptiveRoutingMode(), policyVersion: COMPLEXITY_PROMPT_VERSION,
    decision: getFastDecisionStatus(), preserveReview: true, preserveVerification: true,
    workflowIds: process.env.ADAPTIVE_ROUTING_WORKFLOW_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? null };
}

export function adaptiveRoutingApplies(workflowId: string): boolean {
  if (getAdaptiveRoutingMode() === 'off') return false;
  const ids = process.env.ADAPTIVE_ROUTING_WORKFLOW_IDS;
  return ids === undefined || ids.split(',').some(id => id.trim() === workflowId && id.trim() !== '');
}

/** Classifier output is advisory; policy and model availability decide execution. */
export function selectAdaptiveModel(classification: TaskClassification, baseline: string): string {
  if (classification.fallbackReason || classification.confidence !== 'high' || classification.risk !== 'low' || classification.kind === 'judgment' || classification.complexity === 'complex') return baseline;
  const codex = isCodexModel(baseline);
  if (!codex && !baseline.startsWith('claude-')) return baseline;
  const balanced = codex ? DEFAULT_CODEX_MODEL : BALANCED_CLAUDE_MODEL;
  const efficient = codex ? EFFICIENT_CODEX_MODEL : 'claude-haiku-4-5-20251001';
  const candidate = classification.complexity === 'simple' && classification.kind === 'mechanical' ? efficient : balanced;
  // Do not take a rate-limit fallback to an even weaker model. Escalate instead.
  if (getAvailableModel(candidate) === candidate) return candidate;
  if (candidate === efficient && getAvailableModel(balanced) === balanced) return balanced;
  return baseline;
}

export async function decideAdaptiveRoute(workflow: Workflow, cycle: number): Promise<RouteDecision> {
  const started = Date.now();
  const plan = queries.getNote(`workflow/${workflow.id}/plan`)?.value ?? '';
  const milestone = extractCurrentMilestone(plan);
  const jobs = queries.getJobsForWorkflow(workflow.id);
  const previousImplement = jobs.filter(j => j.workflow_phase === 'implement' && (j.workflow_cycle ?? 0) < cycle)
    .sort((a, b) => (b.workflow_cycle ?? 0) - (a.workflow_cycle ?? 0))[0];
  const feedback = queries.getNote(RecoveryKeys.reviewFeedback(workflow.id, cycle))?.value;
  const noProgress = Number(queries.getNote(RecoveryKeys.zeroProgressCount(workflow.id))?.value ?? 0) > 0;
  const priorDecision = previousImplement?.workflow_cycle == null ? null : queries.getLatestRouteDecisionForCycle(workflow.id, previousImplement.workflow_cycle, 'implement');
  const priorDone = priorDecision?.decision.signalsSent.milestonesDone;
  const unchanged = typeof priorDone === 'number' && workflow.milestones_done <= priorDone;
  let protectedReason: string | null = null;
  if (!milestone.raw || workflow.milestones_total <= 0) protectedReason = 'missing milestone evidence';
  else if (workflow.milestones_done >= workflow.milestones_total - 1) protectedReason = 'final milestone';
  else if (feedback?.trim() || noProgress || unchanged || (previousImplement && previousImplement.status !== 'done')) protectedReason = 'correction or unsuccessful previous attempt';
  // Include the complete current milestone and original request; never classify a
  // convenient excerpt that omits a risk later in the request.
  const classification = protectedReason ? conservativeClassification(protectedReason)
    : await classifyTask(JSON.stringify({ task: workflow.task, milestone: milestone.raw }));
  const selected = selectAdaptiveModel(classification, workflow.implementer_model);
  const decision: RouteDecision = {
    implementerModel: selected, reviewerModel: workflow.reviewer_model, skipReview: false,
    confidence: classification.confidence, rationale: classification.rationale,
    guardrailOverrides: selected === workflow.implementer_model ? ['retain configured implementer'] : [],
    llmRawResponse: '', promptVersion: COMPLEXITY_PROMPT_VERSION, decisionModel: classification.decisionModel,
    costEstimateUsd: classification.costEstimateUsd ?? 0, decidedAt: started,
    signalsSent: { policy: COMPLEXITY_PROMPT_VERSION, milestonesDone: workflow.milestones_done, milestone: milestone.title,
      complexity: classification.complexity, kind: classification.kind, risk: classification.risk,
      durationMs: Date.now() - started, inputTokens: classification.inputTokens, outputTokens: classification.outputTokens,
      costKnown: classification.costEstimateUsd != null, fallbackReason: classification.fallbackReason,
      baselineModel: workflow.implementer_model },
  };
  insertRouteDecision({ id: randomUUID(), workflow_id: workflow.id, cycle, phase: 'implement', decision,
    mode: getAdaptiveRoutingMode() === 'live' ? 'live' : 'shadow', prompt_version: COMPLEXITY_PROMPT_VERSION, decision_model: classification.decisionModel });
  console.log(`[adaptive-router] ${workflow.id} cycle=${cycle} model=${selected} reason=${classification.fallbackReason ?? classification.complexity}`);
  return decision;
}
