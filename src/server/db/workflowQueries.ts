import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { Job, Review, TemplateModelStat, ReviewStatus, VerifyRun, Workflow, WorkflowMetrics, WorkflowPhaseMetric } from '../../shared/types.js';

// A raw database row before casting to a typed interface.

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── Reviews (Feature 3) ────────────────────────────────────────────────────

export function insertReview(review: { id: string; parent_job_id: string; model: string; reviewer_job_id?: string | null }): Review {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO reviews (id, parent_job_id, reviewer_job_id, model, verdict, summary, created_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(review.id, review.parent_job_id, review.reviewer_job_id ?? null, review.model, now);
  return cast<Review>(db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id));
}

export function getReviewsForJob(parentJobId: string): Review[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reviews WHERE parent_job_id = ? ORDER BY created_at ASC').all(parentJobId);
  return rows.map((r: any) => cast<Review>(r));
}

const REVIEW_UPDATE_ALLOWED_FIELDS = new Set(['reviewer_job_id', 'verdict', 'summary', 'completed_at']);

export function updateReview(id: string, fields: Partial<Pick<Review, 'reviewer_job_id' | 'verdict' | 'summary' | 'completed_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!REVIEW_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateReview`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getReviewByReviewerJob(reviewerJobId: string): Review | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM reviews WHERE reviewer_job_id = ?').get(reviewerJobId);
  return row ? cast<Review>(row) : null;
}

export function updateJobReviewStatus(id: string, reviewStatus: ReviewStatus | null): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET review_status = ?, updated_at = ? WHERE id = ?').run(reviewStatus, Date.now(), id);
}

// ─── Template Model Stats (Feature 2) ────────────────────────────────────────

export function getTemplateModelStats(): TemplateModelStat[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT j.template_id, t.name as template_name, j.model,
      COUNT(*) as total,
      SUM(CASE WHEN j.status='done' THEN 1 ELSE 0 END) as succeeded,
      CAST(SUM(CASE WHEN j.status='done' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(COUNT(*), 0) as success_rate,
      AVG(a.cost_usd) as avg_cost,
      AVG(a.duration_ms) as avg_duration_ms,
      AVG(a.num_turns) as avg_turns
    FROM jobs j
    LEFT JOIN templates t ON t.id = j.template_id
    LEFT JOIN agents a ON a.job_id = j.id AND a.status IN ('done','failed')
    WHERE j.status IN ('done','failed') AND j.debate_id IS NULL AND j.original_job_id IS NULL AND j.review_parent_job_id IS NULL
    GROUP BY j.template_id, j.model HAVING total >= 1
  `).all();
  return rows.map((r: any) => cast<TemplateModelStat>(r));
}

// ─── Budget ───────────────────────────────────────────────────────────────────

export function getTodaySpendUsd(): number {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM agents WHERE started_at >= ? AND cost_usd IS NOT NULL').get(startOfDay) as { total: number };
  return row.total;
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export function insertWorkflow(workflow: Workflow): Workflow {
  const db = getDb();
  db.prepare(`
    INSERT INTO workflows (id, title, task, work_dir, implementer_model, reviewer_model, max_cycles, current_cycle, current_phase, status, milestones_total, milestones_done, project_id, max_turns_assess, max_turns_review, max_turns_implement, stop_mode_assess, stop_value_assess, stop_mode_review, stop_value_review, stop_mode_implement, stop_value_implement, template_id, use_worktree, worktree_path, worktree_branch, blocked_reason, pr_url, completion_threshold, start_command, max_verify_retries, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflow.id, workflow.title, workflow.task, workflow.work_dir,
    workflow.implementer_model, workflow.reviewer_model,
    workflow.max_cycles, workflow.current_cycle, workflow.current_phase, workflow.status,
    workflow.milestones_total, workflow.milestones_done,
    workflow.project_id,
    workflow.max_turns_assess, workflow.max_turns_review, workflow.max_turns_implement,
    workflow.stop_mode_assess, workflow.stop_value_assess ?? null,
    workflow.stop_mode_review, workflow.stop_value_review ?? null,
    workflow.stop_mode_implement, workflow.stop_value_implement ?? null,
    workflow.template_id, workflow.use_worktree,
    workflow.worktree_path ?? null, workflow.worktree_branch ?? null,
    workflow.blocked_reason ?? null, workflow.pr_url ?? null,
    workflow.completion_threshold ?? 1.0,
    workflow.start_command ?? null, workflow.max_verify_retries ?? 2,
    workflow.created_at, workflow.updated_at
  );
  return getWorkflowById(workflow.id)!;
}

export function getWorkflowById(id: string): Workflow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  return row ? cast<Workflow>(row) : null;
}

export function listWorkflows(): Workflow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all();
  return rows.map((r: any) => cast<Workflow>(r));
}

const WORKFLOW_UPDATE_ALLOWED_FIELDS = new Set(['title', 'task', 'work_dir', 'implementer_model', 'reviewer_model', 'max_cycles', 'current_cycle', 'current_phase', 'status', 'milestones_total', 'milestones_done', 'project_id', 'max_turns_assess', 'max_turns_review', 'max_turns_implement', 'stop_mode_assess', 'stop_value_assess', 'stop_mode_review', 'stop_value_review', 'stop_mode_implement', 'stop_value_implement', 'template_id', 'use_worktree', 'worktree_path', 'worktree_branch', 'blocked_reason', 'pr_url', 'completion_threshold', 'start_command', 'max_verify_retries']);

export function updateWorkflow(id: string, fields: Partial<Pick<Workflow, 'title' | 'task' | 'work_dir' | 'implementer_model' | 'reviewer_model' | 'max_cycles' | 'current_cycle' | 'current_phase' | 'status' | 'milestones_total' | 'milestones_done' | 'project_id' | 'max_turns_assess' | 'max_turns_review' | 'max_turns_implement' | 'stop_mode_assess' | 'stop_value_assess' | 'stop_mode_review' | 'stop_value_review' | 'stop_mode_implement' | 'stop_value_implement' | 'template_id' | 'use_worktree' | 'worktree_path' | 'worktree_branch' | 'blocked_reason' | 'pr_url' | 'completion_threshold' | 'start_command' | 'max_verify_retries'>>): Workflow | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    if (!WORKFLOW_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateWorkflow`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getWorkflowById(id);
}

export function getJobsForWorkflow(workflowId: string): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE workflow_id = ? ORDER BY workflow_cycle ASC, created_at ASC').all(workflowId);
  return rows.map((r: any) => cast<Job>(r));
}

/**
 * Get the diff from the most recent completed implement-phase agent for a workflow.
 * Used to inject recent-change context into review prompts.
 */
export function getLastImplementDiff(workflowId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.diff FROM agents a
    JOIN jobs j ON a.job_id = j.id
    WHERE j.workflow_id = ? AND j.workflow_phase = 'implement' AND j.status = 'done' AND a.diff IS NOT NULL
    ORDER BY j.workflow_cycle DESC, a.finished_at DESC
    LIMIT 1
  `).get(workflowId) as { diff: string } | undefined;
  return row?.diff ?? null;
}

// ─── Verify Runs ─────────────────────────────────────────────────────────────

export function insertVerifyRun(run: VerifyRun): VerifyRun {
  const db = getDb();
  db.prepare(`
    INSERT INTO verify_runs (id, workflow_id, cycle, attempt, command, exit_code, stdout, stderr, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id, run.workflow_id, run.cycle, run.attempt, run.command,
    run.exit_code, run.stdout ?? null, run.stderr ?? null,
    run.duration_ms ?? null, run.created_at,
  );
  return cast<VerifyRun>(db.prepare('SELECT * FROM verify_runs WHERE id = ?').get(run.id));
}

export function getVerifyRunsForWorkflow(workflowId: string): VerifyRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM verify_runs WHERE workflow_id = ? ORDER BY cycle ASC, attempt ASC'
  ).all(workflowId);
  return rows.map((r: any) => cast<VerifyRun>(r));
}

export function getVerifyRunsForCycle(workflowId: string, cycle: number): VerifyRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM verify_runs WHERE workflow_id = ? AND cycle = ? ORDER BY attempt ASC'
  ).all(workflowId, cycle);
  return rows.map((r: any) => cast<VerifyRun>(r));
}

export function getLatestVerifyRun(workflowId: string, cycle: number): VerifyRun | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM verify_runs WHERE workflow_id = ? AND cycle = ? ORDER BY attempt DESC LIMIT 1'
  ).get(workflowId, cycle);
  return row ? cast<VerifyRun>(row) : null;
}

/**
 * Compute latency metrics for a workflow by joining jobs and agents.
 * Returns per-phase timing plus aggregated summary.
 */
export function getWorkflowMetrics(workflowId: string): WorkflowMetrics | null {
  const workflow = getWorkflowById(workflowId);
  if (!workflow) return null;

  const db = getDb();
  // Get all workflow phase jobs with their agent timing, ordered by cycle + creation
  const rows = db.prepare(`
    SELECT
      j.id AS job_id,
      j.workflow_cycle AS cycle,
      j.workflow_phase AS phase,
      j.created_at AS job_created_at,
      a.started_at AS agent_started_at,
      a.finished_at AS agent_finished_at,
      a.cost_usd AS agent_cost_usd
    FROM jobs j
    LEFT JOIN agents a ON a.job_id = j.id
    WHERE j.workflow_id = ?
    ORDER BY j.workflow_cycle ASC, j.created_at ASC
  `).all(workflowId) as Array<{
    job_id: string;
    cycle: number;
    phase: string;
    job_created_at: number;
    agent_started_at: number | null;
    agent_finished_at: number | null;
    agent_cost_usd: number | null;
  }>;

  const phases: WorkflowPhaseMetric[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const queueWait = r.agent_started_at != null ? r.agent_started_at - r.job_created_at : null;
    const agentDuration = (r.agent_started_at != null && r.agent_finished_at != null)
      ? r.agent_finished_at - r.agent_started_at : null;
    // Handoff = next phase's job_created_at - this agent's finished_at
    const next = rows[i + 1];
    const handoff = (r.agent_finished_at != null && next)
      ? next.job_created_at - r.agent_finished_at : null;

    phases.push({
      cycle: r.cycle,
      phase: r.phase,
      job_id: r.job_id,
      job_created_at: r.job_created_at,
      agent_started_at: r.agent_started_at,
      agent_finished_at: r.agent_finished_at,
      agent_cost_usd: r.agent_cost_usd,
      queue_wait_ms: queueWait,
      agent_duration_ms: agentDuration,
      handoff_ms: handoff,
    });
  }

  // Summary
  const queueWaits = phases.map(p => p.queue_wait_ms).filter((v): v is number => v != null);
  const handoffs = phases.map(p => p.handoff_ms).filter((v): v is number => v != null);
  const agentDurations = phases.map(p => p.agent_duration_ms).filter((v): v is number => v != null);
  const costs = phases.map(p => p.agent_cost_usd).filter((v): v is number => v != null);

  const firstCreated = phases.length > 0 ? phases[0].job_created_at : workflow.created_at;
  const lastFinished = phases.length > 0
    ? phases.reduce((max, p) => {
        const t = p.agent_finished_at ?? 0;
        return t > max ? t : max;
      }, 0)
    : 0;
  const now = Date.now();
  const endTime = (workflow.status === 'running' || workflow.status === 'blocked') ? now : (lastFinished || now);

  return {
    workflow_id: workflowId,
    phases,
    summary: {
      total_wall_clock_ms: endTime - firstCreated,
      total_agent_ms: agentDurations.reduce((s, v) => s + v, 0),
      total_queue_wait_ms: queueWaits.reduce((s, v) => s + v, 0),
      total_handoff_ms: handoffs.reduce((s, v) => s + v, 0),
      avg_queue_wait_ms: queueWaits.length > 0 ? Math.round(queueWaits.reduce((s, v) => s + v, 0) / queueWaits.length) : null,
      avg_handoff_ms: handoffs.length > 0 ? Math.round(handoffs.reduce((s, v) => s + v, 0) / handoffs.length) : null,
      total_cost_usd: costs.reduce((s, v) => s + v, 0),
      phase_count: phases.length,
    },
  };
}

// ─── Resilience Events ──────────────────────────────────────────────────────

export interface ResilienceEvent {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  details: string | null;
  created_at: number;
}

export function insertResilienceEvent(event: {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  details?: string | null;
  created_at: number;
}): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO resilience_events (id, event_type, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(event.id, event.event_type, event.entity_type, event.entity_id, event.details ?? null, event.created_at);
}

export function listResilienceEvents(opts?: { type?: string; limit?: number }): ResilienceEvent[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  if (opts?.type) {
    return db.prepare(
      'SELECT * FROM resilience_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.type, limit).map((r: any) => cast<ResilienceEvent>(r));
  }
  return db.prepare(
    'SELECT * FROM resilience_events ORDER BY created_at DESC LIMIT ?'
  ).all(limit).map((r: any) => cast<ResilienceEvent>(r));
}

/** Check if any non-terminal job has work_dir set to the given path. */
export function isWorkDirInUse(dirPath: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM jobs WHERE work_dir = ? AND status NOT IN ('done', 'failed', 'cancelled') LIMIT 1"
  ).get(dirPath);
  return !!row;
}

// ─── Workflow File Claims (M13/6B) ──────────────────────────────────────────

export interface FileClaim {
  id: string;
  workflow_id: string;
  file_path: string;
  claimed_at: number;
  released_at: number | null;
}

/** Claim files for a workflow. Returns any conflicting active claims from other workflows. */
export function claimFiles(workflowId: string, filePaths: string[]): FileClaim[] {
  const db = getDb();
  const now = Date.now();
  const conflicts: FileClaim[] = [];

  for (const fp of filePaths) {
    // Check for active claims from other workflows
    const existing = db.prepare(
      'SELECT * FROM workflow_file_claims WHERE file_path = ? AND workflow_id != ? AND released_at IS NULL'
    ).get(fp, workflowId);
    if (existing) {
      conflicts.push(cast<FileClaim>(existing));
    }
    // Upsert our claim (idempotent — skip if already claimed by this workflow)
    const alreadyClaimed = db.prepare(
      'SELECT 1 FROM workflow_file_claims WHERE file_path = ? AND workflow_id = ? AND released_at IS NULL'
    ).get(fp, workflowId);
    if (!alreadyClaimed) {
      db.prepare(
        'INSERT INTO workflow_file_claims (id, workflow_id, file_path, claimed_at) VALUES (?, ?, ?, ?)'
      ).run(randomUUID(), workflowId, fp, now);
    }
  }
  return conflicts;
}

/** Release all active claims for a workflow. */
export function releaseWorkflowClaims(workflowId: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE workflow_file_claims SET released_at = ? WHERE workflow_id = ? AND released_at IS NULL'
  ).run(Date.now(), workflowId);
}

/** Get all active claims for a workflow. */
export function getActiveClaimsForWorkflow(workflowId: string): FileClaim[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM workflow_file_claims WHERE workflow_id = ? AND released_at IS NULL'
  ).all(workflowId).map((r: any) => cast<FileClaim>(r));
}
