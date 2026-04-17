import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { notifyJobTerminal } from '../orchestrator/JobCompletionNotifier.js';
import { validateTransition } from '../orchestrator/StateTransitions.js';
import type { Job, Agent, AgentWithJob, Question, DebateRole, RetryPolicy, JobStatus, StopMode, WorkflowPhase, ReviewStatus } from '../../shared/types.js';

// A raw database row before casting to a typed interface.
type DbRow = Record<string, unknown>;

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export function insertJob(job: {
  id: string;
  title: string;
  description: string;
  context: string | null;
  priority: number;
  status?: JobStatus;
  work_dir?: string | null;
  max_turns?: number;
  stop_mode?: StopMode;
  stop_value?: number | null;
  model?: string | null;
  template_id?: string | null;
  depends_on?: string | null;
  is_interactive?: number;
  use_worktree?: number;
  project_id?: string | null;
  debate_id?: string | null;
  debate_loop?: number | null;
  debate_round?: number | null;
  debate_role?: DebateRole | null;
  scheduled_at?: number | null;
  repeat_interval_ms?: number | null;
  retry_policy?: RetryPolicy;
  max_retries?: number;
  retry_count?: number;
  original_job_id?: string | null;
  completion_checks?: string | null;
  review_config?: string | null;
  review_status?: ReviewStatus | null;
  review_parent_job_id?: string | null;
  created_by_agent_id?: string | null;
  pre_debate_id?: string | null;
  pre_debate_summary?: string | null;
  workflow_id?: string | null;
  workflow_cycle?: number | null;
  workflow_phase?: WorkflowPhase | null;
}): Job {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO jobs (id, title, description, context, status, priority, work_dir, max_turns, stop_mode, stop_value, model, template_id, depends_on, is_interactive, use_worktree, project_id, debate_id, debate_loop, debate_round, debate_role, scheduled_at, repeat_interval_ms, retry_policy, max_retries, retry_count, original_job_id, completion_checks, review_config, review_status, review_parent_job_id, created_by_agent_id, pre_debate_id, pre_debate_summary, workflow_id, workflow_cycle, workflow_phase, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id, job.title, job.description, job.context,
    job.status ?? 'queued', job.priority,
    job.work_dir ?? null, job.max_turns ?? 50,
    job.stop_mode ?? 'turns',
    job.stop_value ?? null,
    job.model ?? null,
    job.template_id ?? null,
    job.depends_on ?? null,
    job.is_interactive ?? 0,
    job.use_worktree ?? 0,
    job.project_id ?? null,
    job.debate_id ?? null,
    job.debate_loop ?? null,
    job.debate_round ?? null,
    job.debate_role ?? null,
    job.scheduled_at ?? null,
    job.repeat_interval_ms ?? null,
    job.retry_policy ?? 'none',
    job.max_retries ?? 0,
    job.retry_count ?? 0,
    job.original_job_id ?? null,
    job.completion_checks ?? null,
    job.review_config ?? null,
    job.review_status ?? null,
    job.review_parent_job_id ?? null,
    job.created_by_agent_id ?? null,
    job.pre_debate_id ?? null,
    job.pre_debate_summary ?? null,
    job.workflow_id ?? null,
    job.workflow_cycle ?? null,
    job.workflow_phase ?? null,
    now, now
  );
  return getJobById(job.id)!;
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? cast<Job>(row) : null;
}

export function listJobs(status?: JobStatus): Job[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare('SELECT * FROM jobs WHERE status = ? AND archived_at IS NULL ORDER BY priority DESC, created_at ASC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM jobs WHERE archived_at IS NULL ORDER BY priority DESC, created_at ASC').all();
  }
  return rows.map((r: any) => cast<Job>(r));
}

export function countJobsByStatus(status: JobStatus): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM jobs WHERE status = ? AND archived_at IS NULL',
  ).get(status);
  return cast<{ cnt: number }>(row).cnt;
}

export function countRunningWorkflowPhaseJobs(excludeJobId?: string): number {
  const db = getDb();
  const row = excludeJobId
    ? db.prepare(`
        SELECT COUNT(*) as cnt
        FROM jobs
        WHERE status IN ('assigned', 'running')
          AND workflow_id IS NOT NULL
          AND workflow_phase IS NOT NULL
          AND id != ?
      `).get(excludeJobId)
    : db.prepare(`
        SELECT COUNT(*) as cnt
        FROM jobs
        WHERE status IN ('assigned', 'running')
          AND workflow_id IS NOT NULL
          AND workflow_phase IS NOT NULL
      `).get();
  return cast<{ cnt: number }>(row).cnt;
}

/** Slim version for snapshot — truncates description to keep payload small.
 * Excludes terminal jobs (done/failed/cancelled) older than SLIM_TERMINAL_WINDOW_MS
 * so the dashboard snapshot stays bounded even with years of history. Tightened
 * from 3d to 1d after observing 2,336 rows / ~6MB snapshots on a server with
 * 4.5k unarchived failed jobs. */
const SLIM_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day

export function listJobsSlim(status?: JobStatus): Job[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare(
      'SELECT * FROM jobs WHERE status = ? AND archived_at IS NULL ORDER BY priority DESC, created_at ASC'
    ).all(status);
  } else {
    const cutoff = Date.now() - SLIM_TERMINAL_WINDOW_MS;
    rows = db.prepare(
      `SELECT * FROM jobs
       WHERE archived_at IS NULL
         AND (status NOT IN ('done','failed','cancelled') OR updated_at >= ?)
       ORDER BY priority DESC, created_at ASC`
    ).all(cutoff);
  }
  const jobs = rows.map((r: any) => cast<Job>(r));
  for (const j of jobs) {
    if (j.description && j.description.length > 300) {
      j.description = j.description.slice(0, 300) + '…';
    }
  }
  return jobs;
}

/**
 * Archive terminal jobs older than the given cutoffs. Failed/cancelled runs
 * don't need to stay in the active set for long — they're effectively noise
 * after a couple of days. Successful runs linger longer since they're more
 * likely to be reviewed. Leaves updated_at untouched so it continues to mean
 * "last status change" and archived jobs sort by their original completion
 * time. Returns total number archived.
 */
export function archiveStaleTerminalJobs(
  failedCutoffMs: number,
  doneCutoffMs: number = failedCutoffMs,
): number {
  const db = getDb();
  const now = Date.now();
  const failed = db.prepare(
    `UPDATE jobs SET archived_at = ?
     WHERE archived_at IS NULL
       AND status IN ('failed','cancelled')
       AND updated_at < ?`
  ).run(now, now - failedCutoffMs);
  const done = db.prepare(
    `UPDATE jobs SET archived_at = ?
     WHERE archived_at IS NULL
       AND status = 'done'
       AND updated_at < ?`
  ).run(now, now - doneCutoffMs);
  return Number((failed as any).changes ?? 0) + Number((done as any).changes ?? 0);
}

export function listArchivedJobs(limit?: number, offset?: number): Job[] {
  const db = getDb();
  let sql = 'SELECT * FROM jobs WHERE archived_at IS NOT NULL ORDER BY updated_at DESC';
  const args: number[] = [];
  if (limit != null) {
    sql += ' LIMIT ?';
    args.push(limit);
    if (offset != null) {
      sql += ' OFFSET ?';
      args.push(offset);
    }
  }
  const rows = db.prepare(sql).all(...args);
  return rows.map((r: any) => cast<Job>(r));
}

export function listArchivedJobsSlim(limit?: number, offset?: number): Job[] {
  const jobs = listArchivedJobs(limit, offset);
  for (const j of jobs) {
    if (j.description && j.description.length > 300) {
      j.description = j.description.slice(0, 300) + '…';
    }
  }
  return jobs;
}

export function countArchivedJobs(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM jobs WHERE archived_at IS NOT NULL').get();
  return cast<{ cnt: number }>(row).cnt;
}

/** Count Eye Cycle jobs (done/running/assigned) across active + archived. */
export function countEyeCycles(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM jobs
    WHERE title = 'Eye Cycle'
      AND status IN ('done', 'running', 'assigned')
      AND context IS NOT NULL AND json_extract(context, '$.eye') = 1
  `).get();
  return cast<{ cnt: number }>(row).cnt;
}

/** List eye-tagged jobs (active + archived), newest first. Truncates descriptions. */
export function listEyeJobs(): Job[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, SUBSTR(description, 1, 300) AS description,
           context, status, priority, work_dir, max_turns, created_at, updated_at,
           model, template_id, flagged, depends_on, is_interactive, use_worktree,
           project_id, debate_id, debate_round, debate_role, scheduled_at,
           repeat_interval_ms, retry_policy, max_retries, retry_count,
           original_job_id, completion_checks, review_config, review_status,
           review_parent_job_id, archived_at, debate_loop, created_by_agent_id,
           pre_debate_id, pre_debate_summary
    FROM jobs
    WHERE context IS NOT NULL AND json_extract(context, '$.eye') = 1
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  return rows.map((r: any) => cast<Job>(r));
}

/**
 * Efficient Eye agent list for the Activity tab.
 * Single JOIN query, no N+1, description truncated to avoid huge payloads.
 */
export function getEyeAgentsSlim(): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      a.id, a.job_id, a.status, a.pid, a.session_id, a.exit_code, a.error_message,
      a.status_message, a.output_read, a.started_at, a.updated_at, a.finished_at,
      a.parent_agent_id, a.cost_usd, a.duration_ms, a.num_turns, a.pending_wait_ids,
      j.id         AS j_id,
      j.title      AS j_title,
      CASE WHEN length(j.description) > 300
           THEN substr(j.description, 1, 300) || '…'
           ELSE j.description END AS j_description,
      j.context    AS j_context,
      j.status     AS j_status,
      j.priority   AS j_priority,
      j.model      AS j_model,
      j.project_id AS j_project_id,
      j.created_at AS j_created_at,
      j.updated_at AS j_updated_at
    FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.context IS NOT NULL
      AND json_extract(j.context, '$.eye') = 1
    ORDER BY a.started_at DESC
    LIMIT 100
  `).all();
  return rows.map((r: DbRow) => {
    const agent: Agent = {
      id: r.id, job_id: r.job_id, status: r.status, pid: r.pid, session_id: r.session_id,
      exit_code: r.exit_code, error_message: r.error_message, status_message: r.status_message,
      output_read: r.output_read, started_at: r.started_at, updated_at: r.updated_at,
      finished_at: r.finished_at, parent_agent_id: r.parent_agent_id,
      base_sha: null, diff: null,
      cost_usd: r.cost_usd, duration_ms: r.duration_ms, num_turns: r.num_turns,
      pending_wait_ids: r.pending_wait_ids,
    } as unknown as Agent;
    const job: Job = {
      id: r.j_id, title: r.j_title, description: r.j_description,
      context: r.j_context, status: r.j_status, priority: r.j_priority,
      model: r.j_model, project_id: r.j_project_id,
      created_at: r.j_created_at, updated_at: r.j_updated_at,
    } as unknown as Job;
    return { ...agent, job, template_name: null, pending_question: null, active_locks: [], child_agents: [], warnings: [] };
  });
}

export function archiveJob(id: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
}

export function updateJobStatus(id: string, status: JobStatus): void {
  const db = getDb();
  const current = getJobById(id);
  try {
    validateTransition('job', current?.status, status, id);
  } catch (err) {
    console.warn((err as Error).message);
  }
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  notifyJobTerminal(id, status);
}

export function clearJobRepeat(id: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET repeat_interval_ms = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function updateJobRepeatInterval(id: string, ms: number): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET repeat_interval_ms = ?, updated_at = ? WHERE id = ?').run(ms, Date.now(), id);
}

export function updateJobModel(id: string, model: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), id);
}

export function updateJobTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
}

export function updateJobPrUrl(id: string, prUrl: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET pr_url = ?, updated_at = ? WHERE id = ?').run(prUrl, Date.now(), id);
}

export function updateJobFlagged(id: string, flagged: number): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET flagged = ?, updated_at = ? WHERE id = ?').run(flagged, Date.now(), id);
}

export function updateJobInteractive(id: string, interactive: number): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET is_interactive = ?, updated_at = ? WHERE id = ?').run(interactive, Date.now(), id);
}

export function updateJobScheduledAt(id: string, scheduledAt: number | null): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET scheduled_at = ?, updated_at = ? WHERE id = ?').run(scheduledAt, Date.now(), id);
}

export function updateJobWorkDir(id: string, workDir: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET work_dir = ?, updated_at = ? WHERE id = ?').run(workDir, Date.now(), id);
}

export function getNextQueuedJob(): Job | null {
  const db = getDb();
  // Skip jobs whose dependencies have not all completed successfully
  // Skip jobs scheduled in the future
  // Skip jobs whose pre-debate hasn't reached a terminal state
  const row = db.prepare(`
    SELECT * FROM jobs j
    WHERE j.status = 'queued'
      AND (j.scheduled_at IS NULL OR j.scheduled_at <= unixepoch() * 1000)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(j.depends_on, '[]')) dep
        JOIN jobs d ON d.id = dep.value
        WHERE d.status != 'done'
      )
      AND (j.pre_debate_id IS NULL
        OR EXISTS (SELECT 1 FROM debates d WHERE d.id = j.pre_debate_id
                   AND d.status IN ('consensus','disagreement','failed','cancelled')))
    ORDER BY j.priority DESC, j.created_at ASC LIMIT 1
  `).get();
  return row ? cast<Job>(row) : null;
}

export function getJobsByPreDebateId(debateId: string): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE pre_debate_id = ?').all(debateId);
  return rows.map((r: any) => cast<Job>(r));
}

export function updateJobDescription(id: string, description: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET description = ?, updated_at = ? WHERE id = ?').run(description, Date.now(), id);
}

export function updateJobPreDebateSummary(id: string, summary: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET pre_debate_summary = ?, updated_at = ? WHERE id = ?').run(summary, Date.now(), id);
}

export function scheduleRepeatJob(job: Job, descriptionOverride?: string, intervalOverride?: number): Job {
  const repeatIntervalMs = intervalOverride ?? job.repeat_interval_ms!;
  return insertJob({
    id: randomUUID(),
    title: job.title,
    description: descriptionOverride ?? job.description,
    context: job.context,
    priority: job.priority,
    work_dir: job.work_dir ?? null,
    max_turns: job.max_turns ?? 50,
    model: job.model ?? null,
    template_id: job.template_id ?? null,
    depends_on: null,
    is_interactive: job.is_interactive,
    use_worktree: job.use_worktree,
    project_id: job.project_id ?? null,
    scheduled_at: Date.now() + repeatIntervalMs,
    repeat_interval_ms: repeatIntervalMs,
    retry_policy: job.retry_policy ?? 'none',
    max_retries: job.max_retries ?? 0,
    retry_count: 0,
    original_job_id: null,
    completion_checks: job.completion_checks ?? null,
  });
}

export function getJobsWithFailedDeps(): Job[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT j.* FROM jobs j, json_each(COALESCE(j.depends_on, '[]')) dep
    JOIN jobs d ON d.id = dep.value
    WHERE j.status = 'queued'
      AND d.status IN ('failed', 'cancelled')
  `).all();
  return rows.map((r: any) => cast<Job>(r));
}

export function getFailedDepsForJob(jobId: string): Array<{ id: string; title: string; status: string }> {
  const db = getDb();
  const job = getJobById(jobId);
  if (!job || !job.depends_on) return [];
  const rows = db.prepare(`
    SELECT d.id, d.title, d.status FROM json_each(?) dep
    JOIN jobs d ON d.id = dep.value
    WHERE d.status IN ('failed', 'cancelled')
  `).all(job.depends_on);
  return rows.map((r: any) => cast<{ id: string; title: string; status: string }>(r));
}

// ─── Questions ────────────────────────────────────────────────────────────────

export function insertQuestion(question: Question): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO questions (id, agent_id, question, answer, status, asked_at, answered_at, timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    question.id, question.agent_id, question.question,
    question.answer, question.status,
    question.asked_at, question.answered_at, question.timeout_ms
  );
}

export function getQuestionById(id: string): Question | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? cast<Question>(row) : null;
}

const QUESTION_UPDATE_ALLOWED_FIELDS = new Set(['answer', 'status', 'answered_at']);

export function updateQuestion(id: string, fields: Partial<Pick<Question, 'answer' | 'status' | 'answered_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!QUESTION_UPDATE_ALLOWED_FIELDS.has(k)) {
      throw new Error(`Field '${k}' is not allowed for updateQuestion`);
    }
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getPendingQuestion(agentId: string): Question | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM questions WHERE agent_id = ? AND status = 'pending' ORDER BY asked_at DESC LIMIT 1
  `).get(agentId);
  return row ? cast<Question>(row) : null;
}
