import * as queries from '../db/queries.js';
import { getRouteDecisionsSince } from '../db/routeDecisionQueries.js';
import { estimateCostUsd } from './CostEstimator.js';
import { RecoveryKeys } from './WorkflowRecovery.js';
import type { AgentWithJob, Job, RouteDecisionMode, RouteDecisionRow } from '../../shared/types.js';

interface JoinedRow {
  row: RouteDecisionRow;
  implementJob: Job | null;
  implementAgent: AgentWithJob | null;
  reviewJob: Job | null;
  reviewAgent: AgentWithJob | null;
}

function joinDecisionsWithJobs(rows: RouteDecisionRow[]): JoinedRow[] {
  const byWorkflow = new Map<string, { jobs: Job[]; agents: Map<string, AgentWithJob> }>();
  const out: JoinedRow[] = [];
  for (const row of rows) {
    let entry = byWorkflow.get(row.workflow_id);
    if (!entry) {
      let jobs: Job[] = [];
      try { jobs = queries.getJobsForWorkflow(row.workflow_id); } catch { jobs = []; }
      let agents = new Map<string, AgentWithJob>();
      try {
        const list = queries.getAgentsForJobIds(jobs.map(j => j.id));
        agents = new Map(list.map(a => [a.job_id, a]));
      } catch { /* empty */ }
      entry = { jobs, agents };
      byWorkflow.set(row.workflow_id, entry);
    }
    const implementJob = entry.jobs.find(j => j.workflow_cycle === row.cycle && j.workflow_phase === 'implement') ?? null;
    const reviewJob = entry.jobs.find(j => j.workflow_cycle === row.cycle && j.workflow_phase === 'review') ?? null;
    out.push({
      row,
      implementJob,
      implementAgent: implementJob ? entry.agents.get(implementJob.id) ?? null : null,
      reviewJob,
      reviewAgent: reviewJob ? entry.agents.get(reviewJob.id) ?? null : null,
    });
  }
  return out;
}

function reviewerOutcome(joined: JoinedRow): 'tp' | 'fp' | null {
  // Reviewer skipReview FP/TP is only meaningful when the brain recommended
  // skip AND an actual review job ran. In live mode, skipped reviews have no
  // ground-truth reviewer outcome.
  if (joined.row.decision.skipReview !== true) return null;
  const reviewJob = joined.reviewJob;
  if (!reviewJob) return null;
  // Manually-set review_status (used by some integrations/tests) wins.
  if (reviewJob.review_status === 'needs_revision') return 'fp';
  if (reviewJob.review_status === 'approved') return 'tp';
  // Normal workflow review jobs never set review_status. Infer outcome from
  // the workflow's review-feedback note for this cycle: WorkflowManager writes
  // it whenever the reviewer added `- [ ] **Fix...` milestones, which is the
  // ground-truth signal that the reviewer found real issues.
  const reviewComplete =
    reviewJob.status === 'done' ||
    reviewJob.review_status === 'pending_review' ||
    joined.reviewAgent?.status === 'done';
  if (!reviewComplete) return null;
  try {
    const note = queries.getNote(RecoveryKeys.reviewFeedback(joined.row.workflow_id, joined.row.cycle));
    if (note?.value && note.value.trim().length > 0) return 'fp';
  } catch { /* treat as no feedback */ }
  return 'tp';
}

function counterfactualCostDeltaUsd(joined: JoinedRow): number | null {
  const agent = joined.implementAgent;
  if (!agent || agent.estimated_input_tokens == null || agent.estimated_output_tokens == null) return null;
  const actualModel = joined.implementJob?.model ?? null;
  const recommendedModel = joined.row.decision.implementerModel;
  const actualCost = estimateCostUsd(actualModel, agent.estimated_input_tokens, agent.estimated_output_tokens);
  const recommendedCost = estimateCostUsd(recommendedModel, agent.estimated_input_tokens, agent.estimated_output_tokens);
  // Positive delta means the recommended model is cheaper than the actual model.
  return actualCost - recommendedCost;
}

export function getRoutingBrainShadowReport(days: number) {
  const since = Date.now() - days * 86_400_000;
  const rows = getRouteDecisionsSince(since).filter(r => r.mode === 'shadow' && r.phase === 'implement');
  const joined = joinDecisionsWithJobs(rows);

  const perWorkflow = new Map<string, {
    workflow_id: string;
    decisions: number;
    skip_recommended: number;
    skip_tp: number;
    skip_fp: number;
    guardrail_overrides: number;
    cost_delta_usd_sum: number;
    cost_delta_samples: number;
    cycles: Array<{
      cycle: number;
      recommended_implementer: string;
      actual_implementer: string | null;
      skip_review: boolean;
      guardrail_overrides: string[];
      reviewer_outcome: 'tp' | 'fp' | null;
      cost_delta_usd: number | null;
    }>;
  }>();

  let aggSkipRecommended = 0;
  let aggSkipTp = 0;
  let aggSkipFp = 0;
  let aggGuardrailOverrides = 0;
  let aggCostDeltaSum = 0;
  let aggCostDeltaSamples = 0;

  for (const joinedRow of joined) {
    let workflowReport = perWorkflow.get(joinedRow.row.workflow_id);
    if (!workflowReport) {
      workflowReport = {
        workflow_id: joinedRow.row.workflow_id,
        decisions: 0,
        skip_recommended: 0,
        skip_tp: 0,
        skip_fp: 0,
        guardrail_overrides: 0,
        cost_delta_usd_sum: 0,
        cost_delta_samples: 0,
        cycles: [],
      };
      perWorkflow.set(joinedRow.row.workflow_id, workflowReport);
    }

    workflowReport.decisions += 1;
    const outcome = reviewerOutcome(joinedRow);
    const skipRecommended = joinedRow.row.decision.skipReview === true;
    if (skipRecommended) {
      workflowReport.skip_recommended += 1;
      aggSkipRecommended += 1;
    }
    if (outcome === 'tp') { workflowReport.skip_tp += 1; aggSkipTp += 1; }
    if (outcome === 'fp') { workflowReport.skip_fp += 1; aggSkipFp += 1; }
    if (joinedRow.row.decision.guardrailOverrides.length > 0) {
      workflowReport.guardrail_overrides += 1;
      aggGuardrailOverrides += 1;
    }

    const delta = counterfactualCostDeltaUsd(joinedRow);
    if (delta !== null) {
      workflowReport.cost_delta_usd_sum += delta;
      workflowReport.cost_delta_samples += 1;
      aggCostDeltaSum += delta;
      aggCostDeltaSamples += 1;
    }

    workflowReport.cycles.push({
      cycle: joinedRow.row.cycle,
      recommended_implementer: joinedRow.row.decision.implementerModel,
      actual_implementer: joinedRow.implementJob?.model ?? null,
      skip_review: skipRecommended,
      guardrail_overrides: joinedRow.row.decision.guardrailOverrides,
      reviewer_outcome: outcome,
      cost_delta_usd: delta,
    });
  }

  return {
    window_days: days,
    note: 'cost_delta_usd values are CostEstimator estimates (not measured spend); positive = recommended cheaper than actual.',
    aggregate: {
      decisions: joined.length,
      skip_recommended: aggSkipRecommended,
      skip_tp: aggSkipTp,
      skip_fp: aggSkipFp,
      skip_fp_rate: (aggSkipTp + aggSkipFp) > 0 ? aggSkipFp / (aggSkipTp + aggSkipFp) : 0,
      guardrail_override_rate: joined.length > 0 ? aggGuardrailOverrides / joined.length : 0,
      mean_cost_delta_usd: aggCostDeltaSamples > 0 ? aggCostDeltaSum / aggCostDeltaSamples : 0,
      cost_delta_samples: aggCostDeltaSamples,
    },
    workflows: [...perWorkflow.values()].map(workflowReport => ({
      workflow_id: workflowReport.workflow_id,
      decisions: workflowReport.decisions,
      skip_recommended: workflowReport.skip_recommended,
      skip_tp: workflowReport.skip_tp,
      skip_fp: workflowReport.skip_fp,
      skip_fp_rate: (workflowReport.skip_tp + workflowReport.skip_fp) > 0
        ? workflowReport.skip_fp / (workflowReport.skip_tp + workflowReport.skip_fp)
        : 0,
      guardrail_overrides: workflowReport.guardrail_overrides,
      mean_cost_delta_usd: workflowReport.cost_delta_samples > 0
        ? workflowReport.cost_delta_usd_sum / workflowReport.cost_delta_samples
        : 0,
      cost_delta_samples: workflowReport.cost_delta_samples,
      cycles: workflowReport.cycles,
    })),
  };
}

export function getRoutingBrainStats(days: number) {
  const since = Date.now() - days * 86_400_000;
  const rows = getRouteDecisionsSince(since);

  const byMode: Record<RouteDecisionMode, number> = { shadow: 0, live: 0, fallback: 0 };
  const byDecisionModel = new Map<string, { total: number; fallback: number }>();
  let totalDecisions = 0;
  let guardrailOverrideCount = 0;

  for (const row of rows) {
    totalDecisions += 1;
    byMode[row.mode] = (byMode[row.mode] ?? 0) + 1;
    if (row.decision.guardrailOverrides.length > 0) guardrailOverrideCount += 1;
    const slot = byDecisionModel.get(row.decision_model) ?? { total: 0, fallback: 0 };
    slot.total += 1;
    if (row.mode === 'fallback') slot.fallback += 1;
    byDecisionModel.set(row.decision_model, slot);
  }

  const shadowJoined = joinDecisionsWithJobs(
    rows.filter(row => row.mode === 'shadow' && row.phase === 'implement'),
  );
  let skipRecommended = 0;
  let skipTp = 0;
  let skipFp = 0;
  let costDeltaSum = 0;
  let costDeltaSamples = 0;

  for (const joinedRow of shadowJoined) {
    if (joinedRow.row.decision.skipReview === true) skipRecommended += 1;
    const outcome = reviewerOutcome(joinedRow);
    if (outcome === 'tp') skipTp += 1;
    if (outcome === 'fp') skipFp += 1;
    const delta = counterfactualCostDeltaUsd(joinedRow);
    if (delta !== null) {
      costDeltaSum += delta;
      costDeltaSamples += 1;
    }
  }

  return {
    window_days: days,
    note: 'mean_cost_delta_usd and reviewer-skip TP/FP are computed from shadow-mode rows only; live skips do not run review, so live FP is unobservable.',
    total_decisions: totalDecisions,
    by_mode: byMode,
    llm_call_failure_rate: totalDecisions > 0 ? byMode.fallback / totalDecisions : 0,
    guardrail_override_rate: totalDecisions > 0 ? guardrailOverrideCount / totalDecisions : 0,
    shadow: {
      decisions: shadowJoined.length,
      skip_recommended: skipRecommended,
      skip_tp: skipTp,
      skip_fp: skipFp,
      skip_fp_rate: (skipTp + skipFp) > 0 ? skipFp / (skipTp + skipFp) : 0,
      mean_cost_delta_usd: costDeltaSamples > 0 ? costDeltaSum / costDeltaSamples : 0,
      cost_delta_samples: costDeltaSamples,
    },
    by_decision_model: [...byDecisionModel.entries()].map(([model, stats]) => ({
      decision_model: model,
      total: stats.total,
      fallback: stats.fallback,
      fallback_rate: stats.total > 0 ? stats.fallback / stats.total : 0,
    })),
  };
}
