import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { Job, Agent, AgentWithJob, ChildAgentSummary, Question, FileLock, AgentOutput, AgentOutputSegment, Template, Note, Project, BatchTemplate, Debate, DebateStatus, DebateRole, RetryPolicy, JobStatus, AgentStatus, SearchResult, AgentWarning, Worktree, Nudge, KBEntry, Review, TemplateModelStat, ReviewStatus, Discussion, DiscussionMessage, DiscussionStatus, DiscussionCategory, DiscussionPriority, Proposal, ProposalMessage, ProposalStatus, ProposalCategory, ProposalComplexity, Workflow, WorkflowStatus, WorkflowPhase, StopMode } from '../../shared/types.js';

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: any): T {
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

/** Slim version for snapshot — truncates description to keep payload small. */
export function listJobsSlim(status?: JobStatus): Job[] {
  const jobs = listJobs(status);
  for (const j of jobs) {
    if (j.description && j.description.length > 300) {
      j.description = j.description.slice(0, 300) + '…';
    }
  }
  return jobs;
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
  return rows.map((r: any) => {
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
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
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
    work_dir: (job as any).work_dir ?? null,
    max_turns: (job as any).max_turns ?? 50,
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

// ─── Agents ───────────────────────────────────────────────────────────────────

export function insertAgent(agent: { id: string; job_id: string } & Partial<Agent>): Agent {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (id, job_id, status, pid, session_id, parent_agent_id, exit_code, error_message, status_message, output_read, started_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id, agent.job_id,
    agent.status ?? 'starting',
    agent.pid ?? null, agent.session_id ?? null,
    agent.parent_agent_id ?? null,
    agent.exit_code ?? null, agent.error_message ?? null,
    agent.status_message ?? null,
    agent.output_read ?? 0,
    agent.started_at ?? now, agent.updated_at ?? now,
    agent.finished_at ?? null
  );
  return getAgentById(agent.id)!;
}

export function getAgentById(id: string): Agent | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? cast<Agent>(row) : null;
}

export function listAgents(status?: AgentStatus): Agent[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY started_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  }
  return rows.map((r: any) => cast<Agent>(r));
}

export function updateAgent(id: string, fields: Partial<Pick<Agent, 'status' | 'pid' | 'session_id' | 'exit_code' | 'error_message' | 'status_message' | 'output_read' | 'base_sha' | 'diff' | 'cost_usd' | 'duration_ms' | 'num_turns' | 'estimated_input_tokens' | 'estimated_output_tokens' | 'finished_at' | 'pending_wait_ids'>>): void {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Atomically add token counts to an agent's running totals. */
export function accumulateAgentTokens(agentId: string, inputTokens: number, outputTokens: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE agents SET
      estimated_input_tokens = COALESCE(estimated_input_tokens, 0) + ?,
      estimated_output_tokens = COALESCE(estimated_output_tokens, 0) + ?,
      updated_at = ?
    WHERE id = ?
  `).run(inputTokens, outputTokens, Date.now(), agentId);
}

export function listBatchAgents(status?: AgentStatus): Agent[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare(`
      SELECT a.* FROM agents a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = ? AND COALESCE(j.is_interactive, 0) = 0
      ORDER BY a.started_at DESC
    `).all(status);
  } else {
    rows = db.prepare(`
      SELECT a.* FROM agents a
      JOIN jobs j ON j.id = a.job_id
      WHERE COALESCE(j.is_interactive, 0) = 0
      ORDER BY a.started_at DESC
    `).all();
  }
  return (rows as unknown[]).map((r: any) => cast<Agent>(r));
}

export function listRunningInteractiveAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.is_interactive = 1
      AND a.status IN ('starting', 'running', 'waiting_user')
  `).all();
  return (rows as unknown[]).map((r: any) => cast<Agent>(r));
}

/** All running agents regardless of is_interactive flag — used by unified watchdog/recovery. */
export function listAllRunningAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM agents
    WHERE status IN ('starting', 'running', 'waiting_user')
  `).all();
  return (rows as unknown[]).map((r: any) => cast<Agent>(r));
}

export function getAgentsWithJob(): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  return rows.map((r: any) => enrichAgent(cast<Agent>(r)));
}

/**
 * Lightweight version for the snapshot/API: all active agents plus the
 * most recent finished agents (non-archived). Strips diff to keep payload small.
 */
export function getAgentsWithJobForSnapshot(): AgentWithJob[] {
  const db = getDb();
  // Active agents — always include all of these
  const activeRows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('starting', 'running', 'waiting_user')
      AND j.archived_at IS NULL
  `).all();
  const activeIds = new Set(activeRows.map((r: any) => r.id));

  // Most recent finished agents (capped) — fills the grid
  const recentRows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('done', 'failed', 'cancelled')
      AND j.archived_at IS NULL
    ORDER BY a.finished_at DESC
    LIMIT 50
  `).all();

  // Merge and dedup
  const allRows = [...activeRows, ...recentRows.filter((r: any) => !activeIds.has(r.id))];
  const agents = allRows.map(r => cast<Agent>(r));
  if (agents.length === 0) return [];

  // Batch-enrich: one query per relation instead of N queries per agent
  const agentIds = agents.map(a => a.id);
  const jobIds = [...new Set(agents.map(a => a.job_id))];

  const ph = (n: number) => Array(n).fill('?').join(',');

  // Jobs — one query
  const jobRows = db.prepare(`SELECT * FROM jobs WHERE id IN (${ph(jobIds.length)})`).all(...jobIds);
  const jobMap = new Map<string, Job>(jobRows.map((r: any) => { const j = cast<Job>(r); return [j.id, j]; }));

  // Pending questions — one query
  const qRows = db.prepare(`SELECT * FROM questions WHERE agent_id IN (${ph(agentIds.length)}) AND status = 'pending'`).all(...agentIds);
  const questionMap = new Map<string, Question>();
  for (const r of qRows) {
    const q = cast<Question>(r);
    if (!questionMap.has(q.agent_id)) questionMap.set(q.agent_id, q);
  }

  // Active locks — one query
  const lockRows = db.prepare(`SELECT * FROM file_locks WHERE agent_id IN (${ph(agentIds.length)}) AND released_at IS NULL`).all(...agentIds);
  const lockMap = new Map<string, FileLock[]>();
  for (const r of lockRows) {
    const l = cast<FileLock>(r);
    if (!lockMap.has(l.agent_id)) lockMap.set(l.agent_id, []);
    lockMap.get(l.agent_id)!.push(l);
  }

  // Child agents — one query
  const childRows = db.prepare(`
    SELECT a.id, a.status, a.parent_agent_id, j.title as job_title, j.description as job_description
    FROM agents a JOIN jobs j ON j.id = a.job_id
    WHERE a.parent_agent_id IN (${ph(agentIds.length)})
    ORDER BY a.started_at ASC
  `).all(...agentIds);
  const childMap = new Map<string, ChildAgentSummary[]>();
  for (const r of childRows) {
    const c = cast<ChildAgentSummary & { parent_agent_id: string }>(r);
    if (!childMap.has(c.parent_agent_id)) childMap.set(c.parent_agent_id, []);
    childMap.get(c.parent_agent_id)!.push({ id: c.id, status: c.status, job_title: c.job_title, job_description: c.job_description });
  }

  // Warnings — one query
  const warnRows = db.prepare(`SELECT * FROM agent_warnings WHERE agent_id IN (${ph(agentIds.length)}) AND dismissed = 0`).all(...agentIds);
  const warnMap = new Map<string, AgentWarning[]>();
  for (const r of warnRows) {
    const w = cast<AgentWarning>(r);
    if (!warnMap.has(w.agent_id)) warnMap.set(w.agent_id, []);
    warnMap.get(w.agent_id)!.push(w);
  }

  // Template names — one query
  const templateIds = [...new Set(jobRows.map((r: any) => r.template_id).filter(Boolean))];
  const templateMap = new Map<string, string>();
  if (templateIds.length > 0) {
    const tRows = db.prepare(`SELECT id, name FROM templates WHERE id IN (${ph(templateIds.length)})`).all(...templateIds) as Array<{ id: string; name: string }>;
    for (const t of tRows) templateMap.set(t.id, t.name);
  }

  return agents.map(agent => {
    const job = jobMap.get(agent.job_id);
    if (!job) {
      const stub: Job = { id: agent.job_id, title: '(deleted job)', description: '', context: null, status: 'failed', priority: 0, work_dir: null, max_turns: 0, stop_mode: 'turns', stop_value: null, model: null, template_id: null, depends_on: null, is_interactive: 0, use_worktree: 0, project_id: null, flagged: 0, debate_id: null, debate_loop: null, debate_round: null, debate_role: null, scheduled_at: null, repeat_interval_ms: null, retry_policy: 'none', max_retries: 0, retry_count: 0, original_job_id: null, completion_checks: null, review_config: null, review_status: null, review_parent_job_id: null, created_by_agent_id: null, pre_debate_id: null, pre_debate_summary: null, workflow_id: null, workflow_cycle: null, workflow_phase: null, archived_at: null, created_at: 0, updated_at: 0 };
      return { ...agent, diff: null, job: stub, template_name: null, pending_question: null, active_locks: [], child_agents: [], warnings: [] } as AgentWithJob;
    }
    return {
      ...agent,
      diff: null,
      job,
      template_name: job.template_id ? (templateMap.get(job.template_id) ?? null) : null,
      pending_question: questionMap.get(agent.id) ?? null,
      active_locks: lockMap.get(agent.id) ?? [],
      child_agents: childMap.get(agent.id) ?? [],
      warnings: warnMap.get(agent.id) ?? [],
    } as AgentWithJob;
  });
}

/**
 * Get the most recent agent per job for a list of job IDs.
 * Used by the archived view to populate agent cards.
 */
export function getAgentsForJobIds(jobIds: string[]): AgentWithJob[] {
  if (jobIds.length === 0) return [];
  const db = getDb();
  const ph = (n: number) => Array(n).fill('?').join(',');

  // Get all agents for these jobs, then pick the most recent per job
  const rows = db.prepare(`
    SELECT a.* FROM agents a
    WHERE a.job_id IN (${ph(jobIds.length)})
    ORDER BY a.started_at DESC
  `).all(...jobIds);

  const latestByJob = new Map<string, any>();
  for (const r of rows as any[]) {
    if (!latestByJob.has(r.job_id)) latestByJob.set(r.job_id, r);
  }

  const agents = [...latestByJob.values()].map(r => cast<Agent>(r));
  if (agents.length === 0) return [];

  // Enrich with job data (same pattern as getAgentsWithJobForSnapshot)
  const agentJobIds = [...new Set(agents.map(a => a.job_id))];
  const jobRows = db.prepare(`SELECT * FROM jobs WHERE id IN (${ph(agentJobIds.length)})`).all(...agentJobIds);
  const jobMap = new Map<string, Job>(jobRows.map((r: any) => { const j = cast<Job>(r); return [j.id, j]; }));

  const templateIds = [...new Set(jobRows.map((r: any) => r.template_id).filter(Boolean))];
  const templateMap = new Map<string, string>();
  if (templateIds.length > 0) {
    const tRows = db.prepare(`SELECT id, name FROM templates WHERE id IN (${ph(templateIds.length)})`).all(...templateIds) as Array<{ id: string; name: string }>;
    for (const t of tRows) templateMap.set(t.id, t.name);
  }

  return agents.map(agent => {
    const job = jobMap.get(agent.job_id);
    if (!job) return null;
    return {
      ...agent,
      diff: null,
      job,
      template_name: job.template_id ? (templateMap.get(job.template_id) ?? null) : null,
      pending_question: null,
      active_locks: [],
      child_agents: [],
      warnings: [],
    } as AgentWithJob;
  }).filter(Boolean) as AgentWithJob[];
}

export function getAgentsWithJobByJobId(jobId: string): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents WHERE job_id = ? ORDER BY started_at DESC').all(jobId);
  return (rows as unknown[]).map((r: any) => enrichAgent(cast<Agent>(r)));
}

export function getAgentWithJob(id: string): AgentWithJob | null {
  const agent = getAgentById(id);
  if (!agent) return null;
  return enrichAgent(agent);
}

function getChildAgentSummaries(agentId: string): ChildAgentSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.id, a.status, j.title as job_title, j.description as job_description
    FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE a.parent_agent_id = ?
    ORDER BY a.started_at ASC
  `).all(agentId);
  return rows.map((r: any) => cast<ChildAgentSummary>(r));
}

function enrichAgent(agent: Agent): AgentWithJob {
  const db = getDb();
  const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(agent.job_id);
  if (!jobRow) {
    // Job was deleted while agent still references it — return a stub
    const stub: Job = { id: agent.job_id, title: '(deleted job)', description: '', context: null, status: 'failed', priority: 0, work_dir: null, max_turns: 0, stop_mode: 'turns', stop_value: null, model: null, template_id: null, depends_on: null, is_interactive: 0, use_worktree: 0, project_id: null, flagged: 0, debate_id: null, debate_loop: null, debate_round: null, debate_role: null, scheduled_at: null, repeat_interval_ms: null, retry_policy: 'none', max_retries: 0, retry_count: 0, original_job_id: null, completion_checks: null, review_config: null, review_status: null, review_parent_job_id: null, created_by_agent_id: null, pre_debate_id: null, pre_debate_summary: null, workflow_id: null, workflow_cycle: null, workflow_phase: null, archived_at: null, created_at: 0, updated_at: 0 };
    return { ...agent, job: stub, template_name: null, pending_question: null, active_locks: [], child_agents: [], warnings: [] };
  }
  const job = cast<Job>(jobRow);
  const qRow = db.prepare(`
    SELECT * FROM questions WHERE agent_id = ? AND status = 'pending' ORDER BY asked_at DESC LIMIT 1
  `).get(agent.id);
  const pending_question = qRow ? cast<Question>(qRow) : null;
  const lockRows = db.prepare(`
    SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL
  `).all(agent.id);
  const active_locks = lockRows.map((r: any) => cast<FileLock>(r));
  const child_agents = getChildAgentSummaries(agent.id);
  const warningRows = db.prepare(`
    SELECT * FROM agent_warnings WHERE agent_id = ? AND dismissed = 0 ORDER BY created_at DESC
  `).all(agent.id);
  const warnings = warningRows.map((r: any) => cast<AgentWarning>(r));
  let template_name: string | null = null;
  if (job.template_id) {
    const tRow = db.prepare('SELECT name FROM templates WHERE id = ?').get(job.template_id) as { name: string } | undefined;
    template_name = tRow?.name ?? null;
  }
  return { ...agent, job, template_name, pending_question, active_locks, child_agents, warnings };
}

// ─── Agent Output ─────────────────────────────────────────────────────────────

function extractSearchText(content: string): string {
  try {
    const ev = JSON.parse(content);
    // Claude events
    if (ev.type === 'assistant' && ev.message?.content) {
      return (ev.message.content as any[])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join(' ');
    }
    if (ev.type === 'result') return ev.result ?? '';
    if (ev.type === 'error') return ev.error?.message ?? '';
    // Codex events
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && ev.item.text) return ev.item.text;
      if (ev.item.type === 'reasoning' && ev.item.text) return ev.item.text;
      if (ev.item.type === 'command_execution') {
        return [ev.item.command, ev.item.aggregated_output].filter(Boolean).join(' ');
      }
    }
    return '';
  } catch { return ''; }
}

export function insertAgentOutput(output: Omit<AgentOutput, 'id'>): void {
  const db = getDb();
  // INSERT OR IGNORE for idempotency — if recovery replays a log file we may
  // encounter duplicate (agent_id, seq) pairs. The unique index on
  // (agent_id, seq) prevents double-inserts without erroring.
  const result = db.prepare(`
    INSERT OR IGNORE INTO agent_output (agent_id, seq, event_type, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(output.agent_id, output.seq, output.event_type, output.content, output.created_at);

  // Only index in FTS if a row was actually inserted (changes > 0 means not a duplicate)
  if (result.changes > 0) {
    const text = extractSearchText(output.content);
    if (text.trim()) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(result.lastInsertRowid, text, output.agent_id);
    }
  }
}

export function rebuildFts(): void {
  const db = getDb();
  // Repopulate FTS for any rows not yet indexed (rowid lookup in FTS5 is O(1))
  const rows = db.prepare('SELECT id, agent_id, content FROM agent_output').all() as Array<{ id: number; agent_id: string; content: string }>;
  let added = 0;
  for (const row of rows) {
    const text = extractSearchText(row.content);
    if (!text.trim()) continue;
    const exists = db.prepare('SELECT rowid FROM output_fts WHERE rowid = ?').get(row.id);
    if (!exists) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(row.id, text, row.agent_id);
      added++;
    }
  }
  if (added > 0) console.log(`[fts] indexed ${added} new output rows`);
}

export function searchOutputs(query: string, limit = 50): SearchResult[] {
  const db = getDb();
  const sql = `
    SELECT
      f.agent_id,
      snippet(output_fts, 0, '<mark>', '</mark>', '…', 20) as excerpt,
      ao.seq, ao.event_type,
      a.status as agent_status,
      j.id as job_id, j.title as job_title
    FROM output_fts f
    JOIN agent_output ao ON ao.id = f.rowid
    JOIN agents a ON a.id = f.agent_id
    JOIN jobs j ON j.id = a.job_id
    WHERE output_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const rows = db.prepare(sql).all(query, limit) as any[];
    return rows.map((r: any) => cast<SearchResult>({ ...r }));
  } catch {
    // Invalid FTS query — try as quoted phrase
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const rows = db.prepare(sql).all(escaped, limit) as any[];
      return rows.map((r: any) => cast<SearchResult>({ ...r }));
    } catch { return []; }
  }
}

export function getAgentOutput(agentId: string, tail?: number): AgentOutput[] {
  const db = getDb();
  if (tail) {
    // Fetch the last `tail` rows then re-order ascending
    const rows = db.prepare(
      'SELECT * FROM (SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC'
    ).all(agentId, tail);
    return rows.map((r: any) => cast<AgentOutput>(r));
  }
  const rows = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq ASC').all(agentId);
  return rows.map((r: any) => cast<AgentOutput>(r));
}

export function getLatestAgentOutput(agentId: string): AgentOutput | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT 1').get(agentId);
  return row ? cast<AgentOutput>(row) : null;
}

export function getAgentFullOutput(agentId: string, tailLines?: number): AgentOutputSegment[] {
  const db = getDb();
  // Walk the parent chain to build oldest-first list of agents
  const chain: Agent[] = [];
  let current = getAgentById(agentId);
  while (current) {
    chain.unshift(current);
    if (!current.parent_agent_id) break;
    // MCP sub-agents have parent_agent_id set to the spawning agent, but their
    // job was created via create_job (created_by_agent_id is set). Their output
    // is independent — don't prepend the parent's transcript.
    const currentJob = getJobById(current.job_id);
    if (currentJob?.created_by_agent_id) break;
    current = getAgentById(current.parent_agent_id);
  }

  return chain.map(agent => {
    const job = getJobById(agent.job_id);
    const output = getAgentOutput(agent.id, tailLines);
    let truncated = false;
    if (tailLines) {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_output WHERE agent_id = ?').get(agent.id);
      const total = cast<{ cnt: number }>(row).cnt;
      truncated = total > tailLines;
    }
    return { agent_id: agent.id, job_title: job?.title ?? '(unknown)', job_description: job?.description ?? '', output, truncated };
  });
}

/**
 * Trim a raw stream-json content string for terminal display.
 * The terminal renderer only displays: assistant text blocks, tool names
 * (with a 120-char input preview), system/result/error messages.
 * Everything else (user/tool_result events, large tool inputs) is invisible
 * but can account for 90%+ of the payload. Strip it server-side.
 */
function trimContentForDisplay(content: string): string {
  // Fast path: short strings never need trimming
  if (content.length < 512) return content;
  try {
    const ev = JSON.parse(content);
    // 'user' events render to empty string in the terminal — gut them entirely.
    // Keep just the type so the client's JSON.parse still works.
    if (ev.type === 'user') {
      return '{"type":"user"}';
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      let changed = false;
      for (const block of ev.message.content) {
        if (block.type === 'tool_use' && block.input != null) {
          const str = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
          if (str.length > 200) {
            block.input = str.slice(0, 200);
            changed = true;
          }
        }
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string' && block.content.length > 200) {
            block.content = block.content.slice(0, 200) + '…';
            changed = true;
          } else if (Array.isArray(block.content)) {
            block.content = [{ type: 'text', text: '(trimmed)' }];
            changed = true;
          }
        }
        // Extended thinking blocks are not rendered in the terminal.
        // Strip the large cryptographic signature and trim the thinking text.
        if (block.type === 'thinking') {
          if (block.signature) { delete block.signature; changed = true; }
          if (typeof block.thinking === 'string' && block.thinking.length > 100) {
            block.thinking = block.thinking.slice(0, 100) + '…';
            changed = true;
          }
        }
      }
      if (changed) return JSON.stringify(ev);
    }
    if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.length > 2000) {
      ev.result = ev.result.slice(0, 2000) + '…';
      return JSON.stringify(ev);
    }
    // Codex: item.completed with command_execution — client caps aggregated_output at 500 chars
    if (ev.type === 'item.completed' && ev.item) {
      let changed = false;
      if (ev.item.type === 'command_execution' && typeof ev.item.aggregated_output === 'string' && ev.item.aggregated_output.length > 600) {
        ev.item.aggregated_output = ev.item.aggregated_output.slice(0, 600);
        changed = true;
      }
      if (changed) return JSON.stringify(ev);
    }
    // Codex: item.started events can be large but render nothing
    if (ev.type === 'item.started' && ev.item) {
      return JSON.stringify({ type: ev.type, item: { type: ev.item.type, id: ev.item.id } });
    }
    return content;
  } catch {
    return content;
  }
}

/** Like getAgentFullOutput but trims content payloads for terminal display. */
export function getAgentFullOutputSlim(agentId: string, tailLines?: number): AgentOutputSegment[] {
  const segments = getAgentFullOutput(agentId, tailLines);
  for (const seg of segments) {
    for (const row of seg.output) {
      row.content = trimContentForDisplay(row.content);
    }
  }
  return segments;
}

// ── Server-side terminal rendering ────────────────────────────────────────────
// Mirrors the client's renderEvent/renderCodexEvent logic so the client can
// just term.write() a single string instead of JSON.parse-ing each row.

function renderEventServer(content: string): string {
  try {
    const ev = JSON.parse(content);
    // Codex events have dotted type names
    if (typeof ev.type === 'string' && ev.type.includes('.')) {
      return renderCodexEventServer(ev);
    }
    return renderClaudeEventServer(ev);
  } catch {
    return content + '\r\n';
  }
}

function renderClaudeEventServer(ev: any): string {
  switch (ev.type) {
    case 'system': {
      const modelInfo = ev.model ? ` | ${ev.model}` : '';
      return `\x1b[36m[${ev.subtype ?? 'system'}${modelInfo}]\x1b[0m\r\n`;
    }
    case 'assistant': {
      const blocks = ev.message?.content ?? [];
      let out = '';
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          out += `\r\n${block.text}\r\n`;
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? (typeof block.input === 'string' ? block.input : JSON.stringify(block.input)) : '';
          const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
          out += `\r\n\x1b[2m⚙ ${block.name}`;
          if (preview && preview !== '{}') out += `(${preview})`;
          out += `\x1b[0m\r\n`;
        }
      }
      return out;
    }
    case 'result': {
      if (ev.is_error) {
        return `\r\n\x1b[31m✗ ${ev.result || 'error'}\x1b[0m\r\n`;
      }
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    }
    case 'error':
      return `\x1b[31m✗ ${ev.error?.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

function renderCodexEventServer(ev: any): string {
  switch (ev.type) {
    case 'thread.started':
      return `\x1b[36m[codex thread ${ev.thread_id ?? ''}]\x1b[0m\r\n`;
    case 'item.completed': {
      const item = ev.item;
      if (!item) return '';
      if (item.type === 'reasoning' && item.text) {
        return `\r\n\x1b[2m\x1b[3m${item.text}\x1b[0m\r\n`;
      }
      if (item.type === 'agent_message' && item.text) {
        return `\r\n${item.text}\r\n`;
      }
      if (item.type === 'command_execution') {
        let out = `\r\n\x1b[2m⚙ ${item.command ?? 'command'}\x1b[0m\r\n`;
        if (item.aggregated_output) {
          const preview = item.aggregated_output.length > 500
            ? item.aggregated_output.slice(0, 500) + '…'
            : item.aggregated_output;
          out += `\x1b[2m${preview}\x1b[0m\r\n`;
        }
        if (item.exit_code != null && item.exit_code !== 0) {
          out += `\x1b[31m(exit ${item.exit_code})\x1b[0m\r\n`;
        }
        return out;
      }
      return '';
    }
    case 'turn.completed':
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    case 'turn.failed':
      return `\r\n\x1b[31m✗ Turn failed${ev.message ? ': ' + ev.message : ''}\x1b[0m\r\n`;
    case 'error':
      return `\x1b[31m✗ ${ev.error?.message ?? ev.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

export interface PrerenderedOutput {
  text: string;
  truncated: boolean;
}

/** Pre-render agent output to terminal ANSI text server-side. */
export function getAgentPrerenderedOutput(agentId: string, tailLines?: number): PrerenderedOutput {
  const segments = getAgentFullOutput(agentId, tailLines);
  let text = '';
  let truncated = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.truncated) truncated = true;
    if (i > 0) {
      text += `\r\n\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n`;
      text += `\x1b[2m↩ ${seg.job_description}\x1b[0m\r\n`;
      text += `\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n\r\n`;
    }
    for (const row of seg.output) {
      text += renderEventServer(row.content);
    }
  }
  return { text, truncated };
}

export function getAgentLastSeq(agentId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT MAX(seq) as last_seq FROM agent_output WHERE agent_id = ?').get(agentId);
  const v = cast<{ last_seq: number | null }>(row);
  return v.last_seq ?? -1;
}

/**
 * Prune output rows for agents that have been in a terminal state for a while.
 * Keeps the last `keepTail` rows per agent and deletes the rest, preventing
 * unbounded growth of the agent_output table for long-running orchestrator
 * instances with many completed agents.
 *
 * Returns the total number of rows deleted.
 */
export function pruneOldAgentOutput(maxAgeMs: number = 24 * 60 * 60 * 1000, keepTail: number = 200): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;

  // Find agents that finished before the cutoff and have output rows beyond keepTail
  const candidates = db.prepare(`
    SELECT a.id as agent_id, COUNT(o.id) as output_count
    FROM agents a
    JOIN agent_output o ON o.agent_id = a.id
    WHERE a.status IN ('done', 'failed', 'cancelled')
      AND a.finished_at IS NOT NULL
      AND a.finished_at < ?
    GROUP BY a.id
    HAVING output_count > ?
  `).all(cutoff, keepTail) as Array<{ agent_id: string; output_count: number }>;

  let totalDeleted = 0;
  for (const { agent_id, output_count } of candidates) {
    const deleteCount = output_count - keepTail;
    // Delete the oldest rows (lowest seq values) beyond the tail
    const result = db.prepare(`
      DELETE FROM agent_output
      WHERE id IN (
        SELECT id FROM agent_output
        WHERE agent_id = ?
        ORDER BY seq ASC
        LIMIT ?
      )
    `).run(agent_id, deleteCount);
    totalDeleted += result.changes;
  }

  return totalDeleted;
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

export function updateQuestion(id: string, fields: Partial<Pick<Question, 'answer' | 'status' | 'answered_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
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

// ─── File Locks ───────────────────────────────────────────────────────────────

export function insertFileLock(lock: FileLock): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_locks (id, agent_id, file_path, reason, acquired_at, expires_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(lock.id, lock.agent_id, lock.file_path, lock.reason, lock.acquired_at, lock.expires_at, lock.released_at);
}

export function getFileLockById(id: string): FileLock | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM file_locks WHERE id = ?').get(id);
  return row ? cast<FileLock>(row) : null;
}

export function getActiveLocksForFile(filePath: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path = ? AND released_at IS NULL AND expires_at > ?
  `).all(filePath, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getActiveLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL AND expires_at > ?
  `).all(agentId, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getAllActiveLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND expires_at > ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function releaseLock(id: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE id = ?').run(Date.now(), id);
}

export function releaseLocksForAgent(agentId: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE agent_id = ? AND released_at IS NULL').run(Date.now(), agentId);
}

// Returns active (not released, not expired) locks held by agents in terminal
// states (done/failed/cancelled). Used by the watchdog orphan-lock sweep.
export function getActiveLocksForTerminalAgents(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT fl.* FROM file_locks fl
    JOIN agents a ON fl.agent_id = a.id
    WHERE fl.released_at IS NULL
      AND fl.expires_at > ?
      AND a.status IN ('done', 'failed', 'cancelled')
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns unreleased locks whose TTL has expired. These are stale rows that
// no longer block anything (getAllActiveLocks filters by expires_at > now)
// but should be cleaned up to prevent DB bloat.
export function getExpiredUnreleasedLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND expires_at <= ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all unreleased locks for an agent regardless of TTL expiry.
// Used by releaseAll so that expired-but-unreleased locks still emit lock:released events.
export function getAllUnreleasedLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL'
  ).all(agentId);
  return rows.map((r: any) => cast<FileLock>(r));
}

export function getActiveLocksForFiles(filePaths: string[]): FileLock[] {
  if (filePaths.length === 0) return [];
  const db = getDb();
  const now = Date.now();
  const placeholders = filePaths.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path IN (${placeholders}) AND released_at IS NULL AND expires_at > ?
  `).all(...filePaths, now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all active checkout:: locks. Used to find checkout locks that might
// conflict with a file lock (the caller filters by prefix).
export function getAllActiveCheckoutLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks
    WHERE file_path LIKE 'checkout::%' AND released_at IS NULL AND expires_at > ?
  `).all(now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// Returns all active non-checkout file locks whose path starts with dirPath + '/'.
// Used when acquiring a checkout lock to find blocking file locks under that directory.
export function getActiveFileLocksUnderPath(dirPath: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks
    WHERE file_path LIKE ? AND file_path NOT LIKE 'checkout::%'
      AND released_at IS NULL AND expires_at > ?
  `).all(dirPath + '/%', now);
  return rows.map((r: any) => cast<FileLock>(r));
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function insertTemplate(template: Template): Template {
  const db = getDb();
  db.prepare(`
    INSERT INTO templates (id, name, content, work_dir, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(template.id, template.name, template.content, template.work_dir ?? null, template.model ?? null, template.created_at, template.updated_at);
  return getTemplateById(template.id)!;
}

export function getTemplateById(id: string): Template | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  return row ? cast<Template>(row) : null;
}

export function listTemplates(): Template[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
  return rows.map((r: any) => cast<Template>(r));
}

export function updateTemplate(id: string, fields: Partial<Pick<Template, 'name' | 'content' | 'work_dir' | 'model'>>): Template | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTemplateById(id);
}

export function deleteTemplate(id: string): void {
  const db = getDb();
  // Null out any jobs that referenced this template before deleting
  db.prepare('UPDATE jobs SET template_id = NULL WHERE template_id = ?').run(id);
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

// ─── Notes (shared scratchpad) ────────────────────────────────────────────────

export function upsertNote(key: string, value: string, agentId: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO notes (key, value, agent_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(key, value, agentId, Date.now());
}

export function getNote(key: string): Note | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM notes WHERE key = ?').get(key);
  return row ? cast<Note>(row) : null;
}

export function listNotes(prefix?: string): Note[] {
  const db = getDb();
  let rows: unknown[];
  if (prefix) {
    rows = db.prepare("SELECT * FROM notes WHERE key LIKE ? ORDER BY key ASC").all(prefix.replace(/%/g, '\\%') + '%');
  } else {
    rows = db.prepare('SELECT * FROM notes ORDER BY key ASC').all();
  }
  return rows.map((r: any) => cast<Note>(r));
}

export function deleteNote(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM notes WHERE key = ?').run(key);
}

/**
 * Clean up stale scratchpad notes that haven't been updated in a while.
 * Excludes system notes (setting:*, recovery:*, workflow/*, eye:*) which
 * are managed by specific subsystems.
 * Returns number of notes deleted.
 */
export function pruneStaleNotes(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(`
    DELETE FROM notes
    WHERE updated_at < ?
      AND key NOT LIKE 'setting:%'
      AND key NOT LIKE 'recovery:%'
      AND key NOT LIKE 'workflow/%'
      AND key NOT LIKE 'eye:%'
      AND key NOT LIKE 'job-resume:%'
  `).run(cutoff);
  return result.changes;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function insertProject(project: Project): Project {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(project.id, project.name, project.description, project.created_at, project.updated_at);
  return getProjectById(project.id)!;
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? cast<Project>(row) : null;
}

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY name ASC').all();
  return rows.map((r: any) => cast<Project>(r));
}

export function updateProject(id: string, fields: Partial<Pick<Project, 'name' | 'description'>>): Project | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

export function deleteProject(id: string): void {
  const db = getDb();
  const now = Date.now();
  // Archive all jobs in this project and unlink them from it
  db.prepare('UPDATE jobs SET archived_at = ?, project_id = NULL, updated_at = ? WHERE project_id = ? AND archived_at IS NULL').run(now, now, id);
  db.prepare('UPDATE jobs SET project_id = NULL, updated_at = ? WHERE project_id = ?').run(now, id);
  // Unlink debate jobs before deleting debates (debates.project_id is NOT NULL w/ FK constraint)
  db.prepare('UPDATE jobs SET debate_id = NULL WHERE debate_id IN (SELECT id FROM debates WHERE project_id = ?)').run(id);
  db.prepare('DELETE FROM debates WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ─── Batch Templates ──────────────────────────────────────────────────────────

interface BatchTemplateRow {
  id: string;
  name: string;
  items: string; // JSON string
  created_at: number;
  updated_at: number;
}

function rowToBatchTemplate(row: BatchTemplateRow): BatchTemplate {
  return { ...row, items: JSON.parse(row.items) };
}

export function insertBatchTemplate(bt: { id: string; name: string; items: string[]; created_at: number; updated_at: number }): BatchTemplate {
  const db = getDb();
  db.prepare(`
    INSERT INTO batch_templates (id, name, items, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bt.id, bt.name, JSON.stringify(bt.items), bt.created_at, bt.updated_at);
  return getBatchTemplateById(bt.id)!;
}

export function getBatchTemplateById(id: string): BatchTemplate | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM batch_templates WHERE id = ?').get(id);
  return row ? rowToBatchTemplate(cast<BatchTemplateRow>(row)) : null;
}

export function listBatchTemplates(): BatchTemplate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM batch_templates ORDER BY name ASC').all();
  return rows.map((r: any) => rowToBatchTemplate(cast<BatchTemplateRow>(r)));
}

export function updateBatchTemplate(id: string, fields: Partial<Pick<BatchTemplate, 'name' | 'items'>>): BatchTemplate | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    values.push(fields.name);
  }
  if (fields.items !== undefined) {
    sets.push('items = ?');
    values.push(JSON.stringify(fields.items));
  }
  values.push(id);
  db.prepare(`UPDATE batch_templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getBatchTemplateById(id);
}

export function deleteBatchTemplate(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM batch_templates WHERE id = ?').run(id);
}

// ─── Debates ──────────────────────────────────────────────────────────────────

export function insertDebate(debate: Debate): Debate {
  const db = getDb();
  db.prepare(`
    INSERT INTO debates (id, title, task, claude_model, codex_model, max_rounds, current_round, status, consensus, project_id, work_dir, max_turns, template_id, post_action_prompt, post_action_role, post_action_job_id, post_action_verification, verification_review_job_id, verification_response_job_id, verification_round, loop_count, current_loop, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    debate.id, debate.title, debate.task, debate.claude_model, debate.codex_model,
    debate.max_rounds, debate.current_round, debate.status, debate.consensus,
    debate.project_id, debate.work_dir, debate.max_turns, debate.template_id,
    debate.post_action_prompt ?? null, debate.post_action_role ?? null, debate.post_action_job_id ?? null,
    debate.post_action_verification ?? 0,
    debate.verification_review_job_id ?? null, debate.verification_response_job_id ?? null,
    debate.verification_round ?? 0,
    debate.loop_count ?? 1, debate.current_loop ?? 0,
    debate.created_at, debate.updated_at
  );
  return getDebateById(debate.id)!;
}

export function getDebateById(id: string): Debate | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM debates WHERE id = ?').get(id);
  return row ? cast<Debate>(row) : null;
}

export function listDebates(): Debate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM debates ORDER BY created_at DESC').all();
  return rows.map((r: any) => cast<Debate>(r));
}

export function updateDebate(id: string, fields: Partial<Pick<Debate, 'current_round' | 'status' | 'consensus' | 'post_action_job_id' | 'verification_review_job_id' | 'verification_response_job_id' | 'verification_round' | 'current_loop'>>): Debate | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE debates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getDebateById(id);
}

export function getJobsForDebate(debateId: string): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE debate_id = ? ORDER BY debate_loop ASC, debate_round ASC, created_at ASC').all(debateId);
  return rows.map((r: any) => cast<Job>(r));
}

export function getJobsForDebateRound(debateId: string, loop: number, round: number): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE debate_id = ? AND debate_loop = ? AND debate_round = ?').all(debateId, loop, round);
  return rows.map((r: any) => cast<Job>(r));
}

// ─── Agent result text ────────────────────────────────────────────────────────

export function getAgentResultText(agentId: string): string | null {
  const db = getDb();
  // Walk agent output in reverse to find the last result event
  const rows = db.prepare(`
    SELECT content FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT 50
  `).all(agentId) as Array<{ content: string }>;
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.content);
      // Claude result event
      if (ev.type === 'result' && typeof ev.result === 'string') {
        return ev.result;
      }
      // Codex: last agent_message before turn.completed
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        return ev.item.text;
      }
    } catch { /* skip */ }
  }
  return null;
}

// ─── Agent Warnings (Feature 6) ──────────────────────────────────────────────

export function insertWarning(warning: { id: string; agent_id: string; type: string; message: string }): AgentWarning {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO agent_warnings (id, agent_id, type, message, dismissed, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(warning.id, warning.agent_id, warning.type, warning.message, now);
  return cast<AgentWarning>(db.prepare('SELECT * FROM agent_warnings WHERE id = ?').get(warning.id));
}

export function getActiveWarningsForAgent(agentId: string): AgentWarning[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_warnings WHERE agent_id = ? AND dismissed = 0 ORDER BY created_at DESC').all(agentId);
  return rows.map((r: any) => cast<AgentWarning>(r));
}

export function getAllActiveWarnings(): AgentWarning[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_warnings WHERE dismissed = 0 ORDER BY created_at DESC').all();
  return rows.map((r: any) => cast<AgentWarning>(r));
}

export function dismissWarningsForAgent(agentId: string): void {
  const db = getDb();
  db.prepare('UPDATE agent_warnings SET dismissed = 1 WHERE agent_id = ? AND dismissed = 0').run(agentId);
}

export function dismissWarningsByType(agentId: string, type: string): void {
  const db = getDb();
  db.prepare('UPDATE agent_warnings SET dismissed = 1 WHERE agent_id = ? AND type = ? AND dismissed = 0').run(agentId, type);
}

export function hasUndismissedWarning(agentId: string, type: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM agent_warnings WHERE agent_id = ? AND type = ? AND dismissed = 0 LIMIT 1').get(agentId, type);
  return !!row;
}

// ─── Worktrees (Feature 4) ──────────────────────────────────────────────────

export function insertWorktree(wt: { id: string; agent_id: string; job_id: string; path: string; branch: string }): Worktree {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO worktrees (id, agent_id, job_id, path, branch, created_at, cleaned_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(wt.id, wt.agent_id, wt.job_id, wt.path, wt.branch, now);
  return cast<Worktree>(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(wt.id));
}

export function listActiveWorktrees(): Worktree[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM worktrees WHERE cleaned_at IS NULL ORDER BY created_at DESC').all();
  return rows.map((r: any) => cast<Worktree>(r));
}

export function markWorktreeCleaned(id: string): void {
  const db = getDb();
  db.prepare('UPDATE worktrees SET cleaned_at = ? WHERE id = ?').run(Date.now(), id);
}

export function getWorktreeStats(): { active: number; cleaned: number } {
  const db = getDb();
  const active = (db.prepare('SELECT COUNT(*) as c FROM worktrees WHERE cleaned_at IS NULL').get() as any).c;
  const cleaned = (db.prepare('SELECT COUNT(*) as c FROM worktrees WHERE cleaned_at IS NOT NULL').get() as any).c;
  return { active, cleaned };
}

// ─── Nudges (Feature 1) ─────────────────────────────────────────────────────

export function insertNudge(nudge: { id: string; agent_id: string; message: string }): Nudge {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO nudges (id, agent_id, message, delivered, created_at, delivered_at)
    VALUES (?, ?, ?, 0, ?, NULL)
  `).run(nudge.id, nudge.agent_id, nudge.message, now);
  return cast<Nudge>(db.prepare('SELECT * FROM nudges WHERE id = ?').get(nudge.id));
}

export function getUndeliveredNudges(agentId: string): Nudge[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM nudges WHERE agent_id = ? AND delivered = 0 ORDER BY created_at ASC').all(agentId);
  return rows.map((r: any) => cast<Nudge>(r));
}

export function markNudgeDelivered(id: string): void {
  const db = getDb();
  db.prepare('UPDATE nudges SET delivered = 1, delivered_at = ? WHERE id = ?').run(Date.now(), id);
}

// ─── Knowledge Base (Feature 5) ──────────────────────────────────────────────

export function insertKBEntry(entry: { id: string; title: string; content: string; tags?: string | null; source?: string | null; agent_id?: string | null; project_id?: string | null }): KBEntry {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO knowledge_base (id, title, content, tags, source, agent_id, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.id, entry.title, entry.content, entry.tags ?? null, entry.source ?? null, entry.agent_id ?? null, entry.project_id ?? null, now, now);
  // Index in FTS
  const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(entry.id) as { rowid: number } | undefined;
  if (row) {
    db.prepare('INSERT INTO kb_fts(rowid, title, content, kb_id) VALUES (?, ?, ?, ?)').run(row.rowid, entry.title, entry.content, entry.id);
  }
  return getKBEntryById(entry.id)!;
}

export function getKBEntryById(id: string): KBEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(id);
  return row ? cast<KBEntry>(row) : null;
}

export function listKBEntries(projectId?: string): KBEntry[] {
  const db = getDb();
  let rows: unknown[];
  if (projectId) {
    rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
  } else {
    rows = db.prepare('SELECT * FROM knowledge_base ORDER BY updated_at DESC').all();
  }
  return rows.map((r: any) => cast<KBEntry>(r));
}

export function searchKB(query: string, projectId?: string, limit = 20): Array<KBEntry & { excerpt: string }> {
  const db = getDb();
  const sql = `
    SELECT kb.*, snippet(kb_fts, 1, '<mark>', '</mark>', '…', 30) as excerpt
    FROM kb_fts f
    JOIN knowledge_base kb ON kb.id = f.kb_id
    WHERE kb_fts MATCH ?
    ${projectId ? 'AND kb.project_id = ?' : ''}
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const args = projectId ? [query, projectId, limit] : [query, limit];
    const rows = db.prepare(sql).all(...args) as any[];
    const results = rows.map((r: any) => cast<KBEntry & { excerpt: string }>(r));
    if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
    return results;
  } catch {
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const args = projectId ? [escaped, projectId, limit] : [escaped, limit];
      const rows = db.prepare(sql).all(...args) as any[];
      const results = rows.map((r: any) => cast<KBEntry & { excerpt: string }>(r));
      if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
      return results;
    } catch { return []; }
  }
}

export function updateKBEntry(id: string, fields: Partial<Pick<KBEntry, 'title' | 'content' | 'tags'>>): KBEntry | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  // Update FTS
  const entry = getKBEntryById(id);
  if (entry) {
    const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (row) {
      db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
      db.prepare('INSERT INTO kb_fts(rowid, title, content, kb_id) VALUES (?, ?, ?, ?)').run(row.rowid, entry.title, entry.content, entry.id);
    }
  }
  return entry;
}

export function deleteKBEntry(id: string): void {
  const db = getDb();
  const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
  }
  db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
}

/** Update last_hit_at timestamp for entries that were matched/used. */
export function touchKBEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE knowledge_base SET last_hit_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'also', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'why', 'if', 'then', 'else', 'about',
  'up', 'out', 'use', 'using', 'used', 'make', 'made', 'new', 'get',
  'set', 'add', 'run', 'file', 'code', 'task', 'job', 'agent', 'work',
]);

/** Extract keywords from text, skip stopwords, return top N words. */
function extractKeywords(text: string, maxWords = 8): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w); }
  }
  return unique.slice(0, maxWords);
}

/**
 * Search KB using keywords extracted from a query string.
 * Builds an OR query from extracted keywords, handles FTS syntax errors with fallback.
 */
export function searchKBForMemory(query: string, projectId: string | null, limit = 10): KBEntry[] {
  const db = getDb();
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Build FTS5 OR query from keywords
  const ftsQuery = keywords.join(' OR ');

  // Project-scoped entries ranked first via sort_group
  const sql = projectId
    ? `SELECT kb.*, CASE WHEN kb.project_id = ? THEN 0 ELSE 1 END AS sort_group
       FROM kb_fts f
       JOIN knowledge_base kb ON kb.id = f.kb_id
       WHERE kb_fts MATCH ?
         AND (kb.project_id = ? OR kb.project_id IS NULL)
       ORDER BY sort_group ASC, rank
       LIMIT ?`
    : `SELECT kb.*
       FROM kb_fts f
       JOIN knowledge_base kb ON kb.id = f.kb_id
       WHERE kb_fts MATCH ?
         AND kb.project_id IS NULL
       ORDER BY rank
       LIMIT ?`;

  try {
    const args = projectId
      ? [projectId, ftsQuery, projectId, limit]
      : [ftsQuery, limit];
    const rows = db.prepare(sql).all(...args) as any[];
    const results = rows.map((r: any) => cast<KBEntry>(r));
    if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
    return results;
  } catch {
    // FTS syntax error — try as quoted phrase of the first keyword
    try {
      const escaped = `"${keywords[0]}"`;
      const args = projectId
        ? [projectId, escaped, projectId, limit]
        : [escaped, limit];
      const rows = db.prepare(sql).all(...args) as any[];
      const results = rows.map((r: any) => cast<KBEntry>(r));
      if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
      return results;
    } catch { return []; }
  }
}

/**
 * Get relevant KB entries for a job based on its title and description.
 * Uses FTS keyword search for relevance, falls back to recency if FTS returns nothing.
 */
export function getMemoryForJob(projectId: string | null, jobTitle?: string, jobDescription?: string, limit = 10): KBEntry[] {
  // Try relevance-based search first
  const searchText = [jobTitle, jobDescription].filter(Boolean).join(' ');
  if (searchText.trim()) {
    const results = searchKBForMemory(searchText, projectId, limit);
    if (results.length > 0) return results;
  }

  // Fallback: recency-based (original behavior)
  const db = getDb();
  if (projectId) {
    const rows = db.prepare(`
      SELECT *, CASE WHEN project_id = ? THEN 0 ELSE 1 END AS sort_group
      FROM knowledge_base
      WHERE project_id = ? OR project_id IS NULL
      ORDER BY sort_group ASC, updated_at DESC
      LIMIT ?
    `).all(projectId, projectId, limit);
    const results = rows.map((r: any) => cast<KBEntry>(r));
    if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
    return results;
  }
  const rows = db.prepare(`
    SELECT * FROM knowledge_base
    WHERE project_id IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
  const results = rows.map((r: any) => cast<KBEntry>(r));
  if (results.length > 0) touchKBEntries(results.map((r: any) => r.id));
  return results;
}

/** Delete stale KB entries older than maxAge that have never been hit. */
export function pruneStaleKBEntries(maxAgeMs: number): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  // Get IDs to delete so we can clean up FTS
  const rows = db.prepare(`
    SELECT id, rowid FROM knowledge_base
    WHERE last_hit_at IS NULL AND created_at < ?
  `).all(cutoff) as Array<{ id: string; rowid: number }>;
  for (const row of rows) {
    db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
    db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(row.id);
  }
  return rows.length;
}

/** List KB entries for a project grouped by FTS similarity for consolidation. */
export function getKBEntriesForProject(projectId: string | null): KBEntry[] {
  const db = getDb();
  if (projectId) {
    const rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    return rows.map((r: any) => cast<KBEntry>(r));
  }
  const rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id IS NULL ORDER BY updated_at DESC').all();
  return rows.map((r: any) => cast<KBEntry>(r));
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

export function updateReview(id: string, fields: Partial<Pick<Review, 'reviewer_job_id' | 'verdict' | 'summary' | 'completed_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
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

// ─── Discussions ──────────────────────────────────────────────────────────────

export function insertDiscussion(disc: { id: string; agent_id: string; topic: string; category: DiscussionCategory; priority: DiscussionPriority; context?: string | null }): Discussion {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO discussions (id, agent_id, topic, category, priority, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?, ?)').run(disc.id, disc.agent_id, disc.topic, disc.category, disc.priority, disc.context ?? null, now, now);
  return getDiscussionById(disc.id)!;
}

export function getDiscussionById(id: string): Discussion | null {
  const row = getDb().prepare(`
    SELECT d.*,
      CASE WHEN d.status = 'open' AND (
        (SELECT role FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        AND (SELECT requires_reply FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 1
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM discussions d WHERE d.id = ?
  `).get(id) as any;
  if (!row) return null;
  const d = cast<Discussion>(row); d.needs_reply = !!row.needs_reply; return d;
}

export function listDiscussions(status?: DiscussionStatus): Discussion[] {
  const db = getDb();
  const sql = `
    SELECT d.*,
      CASE WHEN d.status = 'open' AND (
        (SELECT role FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        AND (SELECT requires_reply FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 1
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM discussions d
    ${status ? 'WHERE d.status = ?' : ''}
    ORDER BY d.updated_at DESC
  `;
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  return rows.map((r: any) => { const d = cast<Discussion>(r); d.needs_reply = !!r.needs_reply; return d; });
}

export function updateDiscussion(id: string, updates: Partial<Pick<Discussion, 'status' | 'topic' | 'priority'>>): void {
  const sets: string[] = ['updated_at = ?']; const vals: any[] = [Date.now()];
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.topic !== undefined) { sets.push('topic = ?'); vals.push(updates.topic); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); vals.push(updates.priority); }
  vals.push(id);
  getDb().prepare(`UPDATE discussions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertDiscussionMessage(msg: { id: string; discussion_id: string; role: 'eye' | 'user'; content: string; requires_reply?: boolean }): DiscussionMessage {
  const db = getDb(); const now = Date.now();
  const requiresReply = msg.requires_reply !== false ? 1 : 0;
  db.prepare('INSERT INTO discussion_messages (id, discussion_id, role, content, requires_reply, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(msg.id, msg.discussion_id, msg.role, msg.content, requiresReply, now);
  db.prepare('UPDATE discussions SET updated_at = ? WHERE id = ?').run(now, msg.discussion_id);
  const row = cast<any>(db.prepare('SELECT * FROM discussion_messages WHERE id = ?').get(msg.id)!);
  row.requires_reply = !!row.requires_reply;
  return row as DiscussionMessage;
}

export function getDiscussionMessages(discussionId: string): DiscussionMessage[] {
  return getDb().prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC').all(discussionId).map((r: any) => {
    const m = cast<any>(r); m.requires_reply = !!m.requires_reply; return m as DiscussionMessage;
  });
}

export function getDiscussionsWithNewUserReplies(_agentId: string): Discussion[] {
  // Return open discussions where:
  // (a) the last message is from the user (new unread reply), OR
  // (b) the user has replied within the last 24h and Eye acknowledged but hasn't resolved
  //     (Eye said "I'll look into it" but then the discussion was left open)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getDb().prepare(`
    SELECT d.* FROM discussions d
    WHERE d.status = 'open'
      AND EXISTS (
        SELECT 1 FROM discussion_messages dm
        WHERE dm.discussion_id = d.id
          AND dm.role = 'user'
          AND dm.created_at > ?
      )
    ORDER BY d.updated_at DESC
  `).all(cutoff).map((r: any) => cast<Discussion>(r));
}

// ─── Proposals ────────────────────────────────────────────────────────────────

export function insertProposal(prop: { id: string; agent_id: string; title: string; summary: string; rationale: string; confidence: number; estimated_complexity: ProposalComplexity; category: ProposalCategory; evidence?: string | null; implementation_plan?: string | null; codex_confirmed?: boolean | null; codex_confidence?: number | null; codex_reasoning?: string | null }): Proposal {
  const db = getDb(); const now = Date.now();
  const codexConfirmedVal = prop.codex_confirmed == null ? null : (prop.codex_confirmed ? 1 : 0);
  db.prepare('INSERT INTO proposals (id, agent_id, title, summary, rationale, confidence, estimated_complexity, category, evidence, implementation_plan, status, execution_job_id, codex_confirmed, codex_confidence, codex_reasoning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', NULL, ?, ?, ?, ?, ?)').run(prop.id, prop.agent_id, prop.title, prop.summary, prop.rationale, prop.confidence, prop.estimated_complexity, prop.category, prop.evidence ?? null, prop.implementation_plan ?? null, codexConfirmedVal, prop.codex_confidence ?? null, prop.codex_reasoning ?? null, now, now);
  return getProposalById(prop.id)!;
}

export function getProposalById(id: string): Proposal | null {
  const row = getDb().prepare(`
    SELECT p.*,
      CASE
        WHEN p.status IN ('pending', 'failed') THEN 1
        WHEN p.status = 'discussing' AND (
          NOT EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p.id)
          OR (SELECT role FROM proposal_messages WHERE proposal_id = p.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        ) THEN 1
        ELSE 0
      END AS needs_reply
    FROM proposals p WHERE p.id = ?
  `).get(id) as any;
  if (!row) return null;
  const p = cast<Proposal>(row); p.needs_reply = !!row.needs_reply; return p;
}

export function listProposals(status?: ProposalStatus): Proposal[] {
  const db = getDb();
  const needsReplySql = `
    CASE
      WHEN p.status IN ('pending', 'failed') THEN 1
      WHEN p.status = 'discussing' AND (
        NOT EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p.id)
        OR (SELECT role FROM proposal_messages WHERE proposal_id = p.id ORDER BY created_at DESC LIMIT 1) = 'eye'
      ) THEN 1
      ELSE 0
    END AS needs_reply
  `;
  if (status) {
    const rows = db.prepare(`SELECT p.*, ${needsReplySql} FROM proposals p WHERE p.status = ? ORDER BY p.confidence DESC, p.updated_at DESC`).all(status);
    return rows.map((r: any) => { const p = cast<Proposal>(r); p.needs_reply = !!r.needs_reply; return p; });
  }
  const rows = db.prepare(`SELECT p.*, ${needsReplySql} FROM proposals p ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'discussing' THEN 1 WHEN 'approved' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'failed' THEN 4 WHEN 'done' THEN 5 WHEN 'rejected' THEN 6 END, p.confidence DESC, p.updated_at DESC`).all();
  return rows.map((r: any) => { const p = cast<Proposal>(r); p.needs_reply = !!r.needs_reply; return p; });
}

export function updateProposal(id: string, updates: Partial<Pick<Proposal, 'status' | 'execution_job_id' | 'title' | 'summary' | 'rationale' | 'implementation_plan'>>): void {
  const sets: string[] = ['updated_at = ?']; const vals: any[] = [Date.now()];
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.execution_job_id !== undefined) { sets.push('execution_job_id = ?'); vals.push(updates.execution_job_id); }
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.summary !== undefined) { sets.push('summary = ?'); vals.push(updates.summary); }
  if (updates.rationale !== undefined) { sets.push('rationale = ?'); vals.push(updates.rationale); }
  if (updates.implementation_plan !== undefined) { sets.push('implementation_plan = ?'); vals.push(updates.implementation_plan); }
  vals.push(id);
  getDb().prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertProposalMessage(msg: { id: string; proposal_id: string; role: 'eye' | 'user'; content: string }): ProposalMessage {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO proposal_messages (id, proposal_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(msg.id, msg.proposal_id, msg.role, msg.content, now);
  const proposal = getProposalById(msg.proposal_id);
  if (proposal && msg.role === 'user' && proposal.status === 'pending') {
    db.prepare("UPDATE proposals SET status = 'discussing', updated_at = ? WHERE id = ?").run(now, msg.proposal_id);
  } else {
    db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(now, msg.proposal_id);
  }
  return cast<ProposalMessage>(db.prepare('SELECT * FROM proposal_messages WHERE id = ?').get(msg.id)!);
}

export function getProposalMessages(proposalId: string): ProposalMessage[] {
  return getDb().prepare('SELECT * FROM proposal_messages WHERE proposal_id = ? ORDER BY created_at ASC').all(proposalId).map((r: any) => cast<ProposalMessage>(r));
}

export function getProposalsWithNewUserReplies(agentId: string): Proposal[] {
  return getDb().prepare(`SELECT p.* FROM proposals p WHERE p.status IN ('pending', 'discussing') AND p.agent_id = ? AND EXISTS (SELECT 1 FROM proposal_messages pm WHERE pm.proposal_id = p.id AND pm.role = 'user' AND pm.created_at = (SELECT MAX(created_at) FROM proposal_messages WHERE proposal_id = p.id)) ORDER BY p.updated_at DESC`).all(agentId).map((r: any) => cast<Proposal>(r));
}

// ─── PR Reviews ───────────────────────────────────────────────────────────────

export function insertPrReview(review: {
  id: string; pr_number: number; pr_url: string; pr_title: string;
  pr_author: string | null; repo: string; summary: string;
  comments: string; status?: string; github_review_id?: string | null;
}): any {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO pr_reviews (id, pr_number, pr_url, pr_title, pr_author, repo, summary, comments, status, github_review_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(review.id, review.pr_number, review.pr_url, review.pr_title, review.pr_author, review.repo, review.summary, review.comments, review.status ?? 'draft', review.github_review_id ?? null, now, now);
  return getPrReviewById(review.id)!;
}

export function listPrReviews(): any[] {
  const rows = getDb().prepare(`
    SELECT pr.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM pr_review_messages m
        WHERE m.review_id = pr.id AND m.role = 'user'
          AND m.created_at = (SELECT MAX(created_at) FROM pr_review_messages WHERE review_id = pr.id)
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM pr_reviews pr WHERE pr.status != 'dismissed' ORDER BY pr.created_at DESC
  `).all();
  return rows.map((r: any) => { const p = cast<any>(r); p.needs_reply = !!r.needs_reply; return p; });
}

export function getPrReviewById(id: string): any | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id) as any;
  return row ? cast<any>(row) : null;
}

export function getPrReviewByPrNumber(prNumber: number, repo: string): any | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE pr_number = ? AND repo = ? ORDER BY created_at DESC LIMIT 1').get(prNumber, repo) as any;
  return row ? cast<any>(row) : null;
}

export function updatePrReview(id: string, updates: Partial<{ summary: string; comments: string; status: string; github_review_id: string | null }>): void {
  const sets: string[] = ['updated_at = ?']; const vals: any[] = [Date.now()];
  if (updates.summary !== undefined) { sets.push('summary = ?'); vals.push(updates.summary); }
  if (updates.comments !== undefined) { sets.push('comments = ?'); vals.push(updates.comments); }
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.github_review_id !== undefined) { sets.push('github_review_id = ?'); vals.push(updates.github_review_id); }
  vals.push(id);
  getDb().prepare(`UPDATE pr_reviews SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertPrReviewMessage(msg: { id: string; review_id: string; role: 'eye' | 'user'; content: string }): any {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO pr_review_messages (id, review_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(msg.id, msg.review_id, msg.role, msg.content, now);
  db.prepare('UPDATE pr_reviews SET updated_at = ? WHERE id = ?').run(now, msg.review_id);
  return cast<any>(db.prepare('SELECT * FROM pr_review_messages WHERE id = ?').get(msg.id)!);
}

export function getPrReviewMessages(reviewId: string): any[] {
  return getDb().prepare('SELECT * FROM pr_review_messages WHERE review_id = ? ORDER BY created_at ASC').all(reviewId).map((r: any) => cast<any>(r));
}

export function getPrReviewsWithNewUserReplies(): any[] {
  return getDb().prepare(`
    SELECT pr.* FROM pr_reviews pr WHERE pr.status = 'draft' AND EXISTS (
      SELECT 1 FROM pr_review_messages m WHERE m.review_id = pr.id AND m.role = 'user'
        AND m.created_at = (SELECT MAX(created_at) FROM pr_review_messages WHERE review_id = pr.id)
    ) ORDER BY pr.updated_at DESC
  `).all().map((r: any) => cast<any>(r));
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export function insertWorkflow(workflow: Workflow): Workflow {
  const db = getDb();
  db.prepare(`
    INSERT INTO workflows (id, title, task, work_dir, implementer_model, reviewer_model, max_cycles, current_cycle, current_phase, status, milestones_total, milestones_done, project_id, max_turns_assess, max_turns_review, max_turns_implement, stop_mode_assess, stop_value_assess, stop_mode_review, stop_value_review, stop_mode_implement, stop_value_implement, template_id, use_worktree, worktree_path, worktree_branch, pr_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    workflow.worktree_path ?? null, workflow.worktree_branch ?? null, workflow.pr_url ?? null,
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

export function updateWorkflow(id: string, fields: Partial<Pick<Workflow, 'current_cycle' | 'current_phase' | 'status' | 'milestones_total' | 'milestones_done' | 'worktree_path' | 'worktree_branch' | 'pr_url' | 'stop_mode_assess' | 'stop_value_assess' | 'stop_mode_review' | 'stop_value_review' | 'stop_mode_implement' | 'stop_value_implement'>>): Workflow | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
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

/** Check if any non-terminal job has work_dir set to the given path. */
export function isWorkDirInUse(dirPath: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM jobs WHERE work_dir = ? AND status NOT IN ('done', 'failed', 'cancelled') LIMIT 1"
  ).get(dirPath);
  return !!row;
}
