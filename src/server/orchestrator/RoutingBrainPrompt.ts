/**
 * RoutingBrain prompt module.
 *
 * Two distinct layers:
 *  - `buildRoutingBrainContext(workflow, phase, cycle)` — impure: gathers DB +
 *    runtime signals (plan note, prior cycles, cross-workflow priors,
 *    rate-limit annotations).
 *  - `renderRoutingBrainPrompt(context)` — pure + deterministic. The snapshot
 *    test in `routing-brain-prompt.test.ts` pins its output for a fixed context
 *    fixture; touching the renderer surfaces diffs in PR review.
 */

import path from 'path';
import * as queries from '../db/queries.js';
import * as agentQueries from '../db/agentQueries.js';
import { isModelRateLimited, KNOWN_MODELS } from './ModelClassifier.js';
import type { Workflow, WorkflowPhase, Job, AgentWithJob, ReviewStatus } from '../../shared/types.js';

export const ROUTING_BRAIN_PROMPT_VERSION = 'v1';

const MODEL_MENU: ReadonlyArray<{ id: string; capability: string; cost: string }> = [
  { id: 'claude-haiku-4-5',          capability: 'fastest, lowest reasoning depth; great for trivial mechanical edits', cost: 'very cheap' },
  { id: 'claude-sonnet-4-6',          capability: 'balanced quality + speed; safe default for medium milestones',         cost: 'moderate' },
  { id: 'claude-sonnet-4-6[1m]',      capability: 'sonnet with 1M-token context; for plan/context-heavy work',           cost: 'moderate+' },
  { id: 'claude-opus-4-7',            capability: 'high single-shot reasoning depth (previous flagship)',                  cost: 'expensive' },
  { id: 'claude-opus-4-7[1m]',        capability: 'opus with 1M-token context; for large/complex milestones',             cost: 'expensive+' },
  { id: 'claude-fable-5',             capability: 'frontier reasoning depth and long-horizon autonomy; hardest problems',  cost: 'most expensive' },
  { id: 'claude-fable-5[1m]',         capability: 'fable with 1M-token context; default implementer for complex work',    cost: 'most expensive' },
  { id: 'codex-gpt-5.5',              capability: 'separate provider, useful as cross-provider fallback or for tests',     cost: 'moderate' },
];

const PLAN_TRUNCATION_CHARS = 3000;
const PRIOR_CYCLE_LIMIT = 3;
const CROSS_WORKFLOW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Context types ───────────────────────────────────────────────────────────

export interface ModelMenuEntry {
  id: string;
  capability: string;
  cost: string;
  rateLimited: boolean;
}

export interface MilestoneContext {
  raw: string;
  title: string | null;
  complexityTag: string | null;
  bodyBullets: string[];
  mentionedPaths: string[];
  mentionedTestFiles: string[];
}

export interface PriorCycleTelemetry {
  cycle: number;
  implementerModel: string | null;
  implementerWallClockMs: number | null;
  implementerTurnsUsed: number | null;
  implementerTurnCap: number | null;
  implementerProducedCommit: boolean;
  reviewerModel: string | null;
  reviewerOutcome: 'approved' | 'request_changes' | 'no_op' | 'auto_skipped' | 'unknown' | null;
  reviewerProducedMilestoneMarking: boolean;
}

export interface CrossWorkflowPriors {
  repoName: string;
  days: number;
  meanImplementWallClockMsByComplexity: Record<string, number>;
  reviewerNoOpRate: number;
  opusToSonnetDowngradeSuccessRate: number;
  sampleSize: number;
}

export interface RoutingBrainContext {
  promptVersion: typeof ROUTING_BRAIN_PROMPT_VERSION;
  workflow: {
    id: string;
    title: string;
    repoName: string;
    implementerModel: string;
    reviewerModel: string;
    planExcerpt: string;       // last PLAN_TRUNCATION_CHARS of plan (or full)
    planTruncated: boolean;
    milestonesDone: number;
    milestonesTotal: number;
  };
  phase: WorkflowPhase;
  cycle: number;
  maxCycles: number;
  models: ModelMenuEntry[];
  milestone: MilestoneContext;
  priorCycles: PriorCycleTelemetry[];
  crossWorkflowPriors: CrossWorkflowPriors;
}

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/** Truncate plan to the last N chars; prefix with a marker when truncated. */
export function truncatePlan(plan: string, maxChars = PLAN_TRUNCATION_CHARS): { text: string; truncated: boolean } {
  if (plan.length <= maxChars) return { text: plan, truncated: false };
  const marker = '...\n';
  const tailChars = Math.max(0, maxChars - marker.length);
  const tail = plan.slice(plan.length - tailChars);
  return { text: `${marker}${tail}`, truncated: true };
}

/**
 * Parse the current milestone block out of a plan. "Current" = first unchecked
 * milestone `- [ ]`. Returns an empty block (all-null) if none found.
 */
export function extractCurrentMilestone(plan: string): MilestoneContext {
  const lines = plan.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^[\t ]*[-*][\t ]+\[\s?\]/.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return { raw: '', title: null, complexityTag: null, bodyBullets: [], mentionedPaths: [], mentionedTestFiles: [] };
  }

  // Block runs until we hit the next milestone checkbox or a blank line followed
  // by a top-level heading.
  const blockLines: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[\t ]*[-*][\t ]+\[[xX\s]\]/.test(line)) break;
    if (/^#{1,3}\s/.test(line)) break;
    blockLines.push(line);
  }
  const raw = blockLines.join('\n').trimEnd();

  // Title: text after the checkbox up to a complexity tag or em-dash separator.
  const firstLine = lines[startIdx];
  const titleMatch = firstLine.match(/^[\t ]*[-*][\t ]+\[\s?\][\t ]+(.+)$/);
  let title: string | null = null;
  let complexityTag: string | null = null;
  if (titleMatch) {
    const afterCheck = titleMatch[1];
    const tagMatch = afterCheck.match(/\[([SMLX]+)\]/i);
    if (tagMatch) complexityTag = tagMatch[1].toUpperCase();
    // Strip bold markers and any trailing tag for the title
    title = afterCheck
      .replace(/\*\*/g, '')
      .replace(/\[([SMLX]+)\]/gi, '')
      .replace(/^M\d+\s*:\s*/i, '')
      .replace(/\s+—\s+.*$/, '')
      .trim();
    if (!title.length) title = null;
  }

  // Body bullets: indented `-` lines following the milestone line.
  const bodyBullets: string[] = [];
  for (let i = 1; i < blockLines.length; i++) {
    const m = blockLines[i].match(/^[\t ]+[-*][\t ]+(.+)$/);
    if (m) bodyBullets.push(m[1].trim());
  }

  // Mentioned paths: backtick-quoted tokens that look like file paths.
  const pathSet = new Set<string>();
  const pathRe = /`([^`\n]+)`/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(raw)) !== null) {
    const token = pm[1].trim();
    if (looksLikePath(token)) pathSet.add(token);
  }
  const mentionedPaths = [...pathSet].sort();
  const mentionedTestFiles = mentionedPaths.filter(p => /(^|\/)(test|tests)\//.test(p) || /\.test\.[tj]sx?$/.test(p) || /(^|\/)test_/.test(p));

  return { raw, title, complexityTag, bodyBullets, mentionedPaths, mentionedTestFiles };
}

function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (token.includes(' ')) return false;
  // Must contain a path separator or a dotted extension to qualify.
  if (token.includes('/')) return true;
  if (/\.[a-zA-Z0-9]{1,6}$/.test(token) && !/^\d+\.\d+$/.test(token)) return true;
  return false;
}

export function annotateModelMenu(): ModelMenuEntry[] {
  return MODEL_MENU.map(m => ({ ...m, rateLimited: isModelRateLimitedSafe(m.id) }));
}

function isModelRateLimitedSafe(model: string): boolean {
  try {
    const rateLimitModel = model === 'claude-haiku-4-5' ? 'claude-haiku-4-5-20251001' : model;
    if (!KNOWN_MODELS.includes(rateLimitModel)) return false;
    return isModelRateLimited(rateLimitModel);
  } catch {
    return false;
  }
}

function classifyReviewOutcome(reviewJob: Job | null, reviewAgent: AgentWithJob | null): PriorCycleTelemetry['reviewerOutcome'] {
  if (!reviewJob) return null;
  // Auto-skipped reviews are not stored as review jobs; absence is handled by caller.
  const status: ReviewStatus | null = reviewJob.review_status;
  if (status === 'approved') return 'approved';
  if (status === 'needs_revision') return 'request_changes';
  if (status === 'pending_review' && reviewAgent && reviewAgent.status === 'done') return 'no_op';
  if (!status && reviewAgent && reviewAgent.status === 'done') return 'no_op';
  return 'unknown';
}

// ─── Impure: DB-backed context builder ───────────────────────────────────────

/**
 * Gather all signals the routing brain needs to decide for `(workflow, phase,
 * cycle)`. Reads from `notes`, `jobs`, `agents`, and other workflows in the
 * same project for cross-workflow priors. All values default to safe empties
 * when the underlying tables are sparse — never throws on missing data.
 */
export function buildRoutingBrainContext(
  workflow: Workflow,
  phase: WorkflowPhase,
  cycle: number,
): RoutingBrainContext {
  const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
  const planRaw = planNote?.value ?? '';
  const { text: planExcerpt, truncated: planTruncated } = truncatePlan(planRaw);
  const milestone = extractCurrentMilestone(planRaw);

  const repoName = deriveRepoIdentity(workflow) ?? (workflow.title || workflow.id);

  const priorCycles = collectPriorCycleTelemetry(workflow, cycle);
  const crossWorkflowPriors = collectCrossWorkflowPriors(workflow, repoName);

  return {
    promptVersion: ROUTING_BRAIN_PROMPT_VERSION,
    workflow: {
      id: workflow.id,
      title: workflow.title,
      repoName,
      implementerModel: workflow.implementer_model,
      reviewerModel: workflow.reviewer_model,
      planExcerpt,
      planTruncated,
      milestonesDone: workflow.milestones_done,
      milestonesTotal: workflow.milestones_total,
    },
    phase,
    cycle,
    maxCycles: workflow.max_cycles,
    models: annotateModelMenu(),
    milestone,
    priorCycles,
    crossWorkflowPriors,
  };
}

function collectPriorCycleTelemetry(workflow: Workflow, currentCycle: number): PriorCycleTelemetry[] {
  let allJobs: Job[];
  try {
    allJobs = queries.getJobsForWorkflow(workflow.id);
  } catch {
    return [];
  }
  const cycles = new Set<number>();
  for (const j of allJobs) {
    if (j.workflow_cycle !== null && j.workflow_cycle < currentCycle) cycles.add(j.workflow_cycle);
  }
  const sortedCycles = [...cycles].sort((a, b) => b - a).slice(0, PRIOR_CYCLE_LIMIT).sort((a, b) => a - b);

  const jobIds = allJobs.map(j => j.id);
  let agentsByJob = new Map<string, AgentWithJob>();
  if (jobIds.length > 0) {
    try {
      const agents = agentQueries.getAgentsForJobIds(jobIds);
      agentsByJob = new Map(agents.map(a => [a.job_id, a]));
    } catch {
      // leave map empty
    }
  }

  const out: PriorCycleTelemetry[] = [];
  for (const c of sortedCycles) {
    const impl = allJobs.find(j => j.workflow_cycle === c && j.workflow_phase === 'implement') ?? null;
    const rev = allJobs.find(j => j.workflow_cycle === c && j.workflow_phase === 'review') ?? null;
    const implAgent = impl ? (agentsByJob.get(impl.id) ?? null) : null;
    const revAgent = rev ? (agentsByJob.get(rev.id) ?? null) : null;
    const skipNote = queries.getNote(`workflow/${workflow.id}/route/cycle-${c}/review_status`);
    const autoSkipped = (skipNote?.value === 'auto_skipped');

    out.push({
      cycle: c,
      implementerModel: impl?.model ?? null,
      implementerWallClockMs: implAgent?.duration_ms ?? null,
      implementerTurnsUsed: implAgent?.num_turns ?? null,
      implementerTurnCap: impl?.max_turns ?? null,
      implementerProducedCommit: !!(implAgent?.diff && implAgent.diff.trim().length > 0),
      reviewerModel: autoSkipped ? null : (rev?.model ?? null),
      reviewerOutcome: autoSkipped ? 'auto_skipped' : classifyReviewOutcome(rev, revAgent),
      reviewerProducedMilestoneMarking: !!(revAgent?.diff && /^[+\-].*\[[xX]\]/m.test(revAgent.diff)),
    });
  }
  return out;
}

/**
 * Derive a normalized repo identity from a workflow's worktree/work_dir.
 * Worktrees are namespaced as `.orchestrator-worktrees/<repoName>/wf-<shortId>`,
 * so prefer that segment when present. Falls back to `basename(work_dir)` for
 * non-worktree workflows. Returns null if no usable path is set.
 */
export function deriveRepoIdentity(workflow: Pick<Workflow, 'work_dir' | 'worktree_path'>): string | null {
  const candidates = [workflow.worktree_path, workflow.work_dir];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const norm = candidate.replace(/\\/g, '/');
    const wtMatch = norm.match(/\.orchestrator-worktrees\/([^/]+)\/wf-[^/]+/);
    if (wtMatch) return wtMatch[1];
  }
  if (workflow.work_dir) {
    const base = path.basename(workflow.work_dir);
    return base.length > 0 ? base : null;
  }
  return null;
}

function collectCrossWorkflowPriors(workflow: Workflow, repoName: string): CrossWorkflowPriors {
  const since = Date.now() - CROSS_WORKFLOW_WINDOW_MS;
  const selfIdentity = deriveRepoIdentity(workflow);
  let peerWorkflowIds: string[] = [];
  try {
    const all = queries.listWorkflows();
    peerWorkflowIds = all
      .filter(w => w.id !== workflow.id && w.created_at >= since)
      .filter(w => {
        if (!selfIdentity) return false;
        const peerIdentity = deriveRepoIdentity(w);
        return peerIdentity !== null && peerIdentity === selfIdentity;
      })
      .map(w => w.id);
  } catch {
    peerWorkflowIds = [];
  }

  const empty: CrossWorkflowPriors = {
    repoName,
    days: 30,
    meanImplementWallClockMsByComplexity: {},
    reviewerNoOpRate: 0,
    opusToSonnetDowngradeSuccessRate: 0,
    sampleSize: 0,
  };
  if (peerWorkflowIds.length === 0) return empty;

  let sampleSize = 0;
  let reviewerNoOpCount = 0;
  let reviewerTotal = 0;
  const byComplexity = new Map<string, { total: number; count: number }>();

  for (const wid of peerWorkflowIds) {
    let jobs: Job[] = [];
    try { jobs = queries.getJobsForWorkflow(wid); } catch { continue; }
    const ids = jobs.map(j => j.id);
    if (ids.length === 0) continue;
    let agentsByJob = new Map<string, AgentWithJob>();
    try {
      agentsByJob = new Map(agentQueries.getAgentsForJobIds(ids).map(a => [a.job_id, a]));
    } catch { /* skip */ }
    for (const j of jobs) {
      if (j.workflow_phase === 'implement' && j.status === 'done') {
        const a = agentsByJob.get(j.id);
        if (a?.duration_ms != null) {
          const tag = (j.title.match(/\[(\w{1,3})\]/)?.[1] ?? 'untagged').toUpperCase();
          const slot = byComplexity.get(tag) ?? { total: 0, count: 0 };
          slot.total += a.duration_ms;
          slot.count += 1;
          byComplexity.set(tag, slot);
          sampleSize += 1;
        }
      }
      if (j.workflow_phase === 'review' && j.status === 'done') {
        reviewerTotal += 1;
        const outcome = classifyReviewOutcome(j, agentsByJob.get(j.id) ?? null);
        if (outcome === 'no_op') reviewerNoOpCount += 1;
      }
    }
  }

  const meanByComplexity: Record<string, number> = {};
  for (const [tag, { total, count }] of byComplexity) {
    if (count > 0) meanByComplexity[tag] = Math.round(total / count);
  }

  return {
    repoName,
    days: 30,
    meanImplementWallClockMsByComplexity: meanByComplexity,
    reviewerNoOpRate: reviewerTotal > 0 ? reviewerNoOpCount / reviewerTotal : 0,
    opusToSonnetDowngradeSuccessRate: 0, // best-effort: not enough signal in v1
    sampleSize,
  };
}

// ─── Pure renderer ───────────────────────────────────────────────────────────

export interface RenderedPrompt {
  system: string;
  user: string;
  promptVersion: typeof ROUTING_BRAIN_PROMPT_VERSION;
}

/**
 * Render the routing brain prompt. Pure: same input ⇒ same output. The
 * snapshot test (`src/test/routing-brain-prompt.test.ts`) pins this exact
 * string for a fixed context fixture.
 */
export function renderRoutingBrainPrompt(ctx: RoutingBrainContext): RenderedPrompt {
  const system = renderSystem();
  const user = renderUser(ctx);
  return { system, user, promptVersion: ctx.promptVersion };
}

function renderSystem(): string {
  return [
    `You are autodev's routing brain.`,
    `Your job: for the next implement cycle of a workflow, choose:`,
    `  1. implementerModel — which model runs the implementer`,
    `  2. skipReview — whether to skip the reviewer entirely`,
    `  3. reviewerModel — if not skipping, which model reviews`,
    ``,
    `Optimise for wall-clock and cost subject to quality. Use prior-cycle`,
    `telemetry and cross-workflow priors to weigh trade-offs. Output JSON only.`,
    ``,
    `Output schema (strict):`,
    `{`,
    `  "implementerModel": string,         // one of the model ids in section 2`,
    `  "reviewerModel": string | null,     // null only if skipReview=true`,
    `  "skipReview": boolean,`,
    `  "confidence": "low" | "medium" | "high",`,
    `  "rationale": string                 // <= 3 sentences`,
    `}`,
    ``,
    `Constraints:`,
    `  - You MAY recommend skipReview=true ONLY if this is not the final`,
    `    milestone AND the milestone does not touch critical paths`,
    `    (config.yaml, package.json, DB migrations, schema files).`,
    `  - The orchestrator will OVERRIDE skipReview=false if you violate this.`,
    `  - Pick an implementerModel from the supplied menu; do not invent ids.`,
    `  - If a model is annotated "rate-limited", prefer a non-limited alternative.`,
    `  - Return JSON only. No code fences, no prose before or after.`,
  ].join('\n');
}

function renderUser(ctx: RoutingBrainContext): string {
  const parts: string[] = [];

  // 1. Role + task (echoed)
  parts.push(`## 1. Task`);
  parts.push(`Decide routing for workflow "${ctx.workflow.title}" (id ${ctx.workflow.id}),`);
  parts.push(`repo "${ctx.workflow.repoName}", upcoming phase "${ctx.phase}", cycle ${ctx.cycle} of max ${ctx.maxCycles}.`);
  parts.push(``);

  // 2. Available models
  parts.push(`## 2. Available models`);
  for (const m of ctx.models) {
    const rl = m.rateLimited ? ' [RATE-LIMITED]' : '';
    parts.push(`- ${m.id}${rl}: ${m.capability} — cost: ${m.cost}`);
  }
  parts.push(``);

  // 3. Workflow context
  parts.push(`## 3. Workflow context`);
  parts.push(`- title: ${ctx.workflow.title}`);
  parts.push(`- repo: ${ctx.workflow.repoName}`);
  parts.push(`- milestones: ${ctx.workflow.milestonesDone}/${ctx.workflow.milestonesTotal} done`);
  parts.push(`- cycle: ${ctx.cycle}/${ctx.maxCycles}`);
  parts.push(`- static implementer (fallback): ${ctx.workflow.implementerModel}`);
  parts.push(`- static reviewer (fallback): ${ctx.workflow.reviewerModel}`);
  parts.push(``);
  parts.push(`### Plan excerpt${ctx.workflow.planTruncated ? ' (truncated — last ' + PLAN_TRUNCATION_CHARS + ' chars)' : ''}`);
  parts.push('```markdown');
  parts.push(ctx.workflow.planExcerpt.trimEnd());
  parts.push('```');
  parts.push(``);

  // 4. Current milestone
  parts.push(`## 4. Current milestone`);
  if (ctx.milestone.raw) {
    parts.push(`- title: ${ctx.milestone.title ?? '(unparsed)'}`);
    parts.push(`- complexity tag: ${ctx.milestone.complexityTag ?? '(none)'}`);
    if (ctx.milestone.bodyBullets.length > 0) {
      parts.push(`- body bullets:`);
      for (const b of ctx.milestone.bodyBullets) parts.push(`    - ${b}`);
    }
    if (ctx.milestone.mentionedPaths.length > 0) {
      parts.push(`- mentioned paths: ${ctx.milestone.mentionedPaths.join(', ')}`);
    }
    if (ctx.milestone.mentionedTestFiles.length > 0) {
      parts.push(`- mentioned test files: ${ctx.milestone.mentionedTestFiles.join(', ')}`);
    }
    parts.push(``);
    parts.push(`#### Verbatim milestone block`);
    parts.push('```markdown');
    parts.push(ctx.milestone.raw);
    parts.push('```');
  } else {
    parts.push(`(no unchecked milestone in plan)`);
  }
  parts.push(``);

  // 5. Prior-cycle telemetry
  parts.push(`## 5. Prior-cycle telemetry (last ${PRIOR_CYCLE_LIMIT})`);
  if (ctx.priorCycles.length === 0) {
    parts.push(`(no prior cycles)`);
  } else {
    for (const p of ctx.priorCycles) {
      parts.push(`- cycle ${p.cycle}:`);
      parts.push(`    implementer=${p.implementerModel ?? '?'} wall_ms=${p.implementerWallClockMs ?? '?'}` +
        ` turns=${p.implementerTurnsUsed ?? '?'}/${p.implementerTurnCap ?? '?'}` +
        ` commit=${p.implementerProducedCommit ? 'yes' : 'no'}`);
      parts.push(`    reviewer=${p.reviewerModel ?? 'none'} outcome=${p.reviewerOutcome ?? 'none'}` +
        ` milestone_marked=${p.reviewerProducedMilestoneMarking ? 'yes' : 'no'}`);
    }
  }
  parts.push(``);

  // 6. Cross-workflow priors
  parts.push(`## 6. Cross-workflow priors (repo "${ctx.crossWorkflowPriors.repoName}", last ${ctx.crossWorkflowPriors.days} days)`);
  parts.push(`- sample size: ${ctx.crossWorkflowPriors.sampleSize}`);
  const meanEntries = Object.entries(ctx.crossWorkflowPriors.meanImplementWallClockMsByComplexity).sort(([a],[b]) => a.localeCompare(b));
  if (meanEntries.length === 0) {
    parts.push(`- mean implement wall-clock by complexity: (no data)`);
  } else {
    parts.push(`- mean implement wall-clock by complexity (ms):`);
    for (const [tag, ms] of meanEntries) parts.push(`    [${tag}]: ${ms}`);
  }
  parts.push(`- reviewer no-op rate: ${(ctx.crossWorkflowPriors.reviewerNoOpRate * 100).toFixed(1)}%`);
  parts.push(`- opus→sonnet downgrade success rate: ${(ctx.crossWorkflowPriors.opusToSonnetDowngradeSuccessRate * 100).toFixed(1)}%`);
  parts.push(``);

  // 7. Hard guardrails (informational)
  parts.push(`## 7. Hard guardrails (informational)`);
  parts.push(`- skipReview=true is allowed ONLY when:`);
  parts.push(`    (a) this is not the final unchecked milestone, AND`);
  parts.push(`    (b) the milestone does not touch config.yaml, package.json,`);
  parts.push(`        src/server/db/migrations/**, or any schema.ts / schema.sql.`);
  parts.push(`- The orchestrator will silently override skipReview=false if you violate this.`);
  parts.push(`- Rate-limited models will be swapped via the fallback chain.`);
  parts.push(``);

  // 8. Output schema reminder
  parts.push(`## 8. Output`);
  parts.push(`Respond with a single JSON object matching the schema in the system prompt.`);
  parts.push(`No prose, no code fences, no leading whitespace.`);
  parts.push(`promptVersion: ${ctx.promptVersion}`);

  return parts.join('\n');
}
