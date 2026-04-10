import { getDb } from './database.js';
import type { Agent, AgentWithJob, ChildAgentSummary, Question, FileLock, AgentWarning, Worktree, Nudge, Job } from '../../shared/types.js';

// A raw database row before casting to a typed interface.
type DbRow = Record<string, unknown>;

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
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

export function listAgents(status?: string): Agent[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY started_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  }
  return rows.map((r: unknown) => cast<Agent>(r));
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

export function listBatchAgents(status?: string): Agent[] {
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
  return (rows as unknown[]).map((r: unknown) => cast<Agent>(r));
}

export function listRunningInteractiveAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.is_interactive = 1
      AND a.status IN ('starting', 'running', 'waiting_user')
  `).all();
  return (rows as unknown[]).map((r: unknown) => cast<Agent>(r));
}

/** All running agents regardless of is_interactive flag — used by unified watchdog/recovery. */
export function listAllRunningAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM agents
    WHERE status IN ('starting', 'running', 'waiting_user')
  `).all();
  return (rows as unknown[]).map((r: unknown) => cast<Agent>(r));
}

export function getAgentsWithJob(): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  return rows.map((r: unknown) => enrichAgent(cast<Agent>(r)));
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
  const activeIds = new Set(activeRows.map((r: DbRow) => r.id as string));

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
  const allRows = [...activeRows, ...recentRows.filter((r: DbRow) => !activeIds.has(r.id as string))];
  const agents = allRows.map((r: unknown) => cast<Agent>(r));
  if (agents.length === 0) return [];

  // Batch-enrich: one query per relation instead of N queries per agent
  const agentIds = agents.map(a => a.id);
  const jobIds = [...new Set(agents.map(a => a.job_id))];

  const ph = (n: number) => Array(n).fill('?').join(',');

  // Jobs — one query
  const jobRows = db.prepare(`SELECT * FROM jobs WHERE id IN (${ph(jobIds.length)})`).all(...jobIds);
  const jobMap = new Map<string, Job>(jobRows.map((r: unknown) => { const j = cast<Job>(r); return [j.id, j]; }));

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
  const templateIds = [...new Set(jobRows.map((r: DbRow) => r.template_id).filter(Boolean))];
  const templateMap = new Map<string, string>();
  if (templateIds.length > 0) {
    const tRows = db.prepare(`SELECT id, name FROM templates WHERE id IN (${ph(templateIds.length)})`).all(...templateIds) as Array<{ id: string; name: string }>;
    for (const t of tRows) templateMap.set(t.id, t.name);
  }

  return agents.map(agent => {
    const job = jobMap.get(agent.job_id);
    if (!job) {
      const stub: Job = { id: agent.job_id, title: '(deleted job)', description: '', context: null, status: 'failed', priority: 0, work_dir: null, max_turns: 0, stop_mode: 'turns', stop_value: null, model: null, template_id: null, depends_on: null, is_interactive: 0, use_worktree: 0, project_id: null, flagged: 0, debate_id: null, debate_loop: null, debate_round: null, debate_role: null, scheduled_at: null, repeat_interval_ms: null, retry_policy: 'none', max_retries: 0, retry_count: 0, original_job_id: null, completion_checks: null, review_config: null, review_status: null, review_parent_job_id: null, created_by_agent_id: null, pre_debate_id: null, pre_debate_summary: null, workflow_id: null, workflow_cycle: null, workflow_phase: null, pr_url: null, archived_at: null, created_at: 0, updated_at: 0 };
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

  const latestByJob = new Map<string, DbRow>();
  for (const r of rows as DbRow[]) {
    if (!latestByJob.has(r.job_id as string)) latestByJob.set(r.job_id as string, r);
  }

  const agents = [...latestByJob.values()].map((r: unknown) => cast<Agent>(r));
  if (agents.length === 0) return [];

  // Enrich with job data (same pattern as getAgentsWithJobForSnapshot)
  const agentJobIds = [...new Set(agents.map(a => a.job_id))];
  const jobRows = db.prepare(`SELECT * FROM jobs WHERE id IN (${ph(agentJobIds.length)})`).all(...agentJobIds);
  const jobMap = new Map<string, Job>(jobRows.map((r: unknown) => { const j = cast<Job>(r); return [j.id, j]; }));

  const templateIds = [...new Set(jobRows.map((r: DbRow) => r.template_id).filter(Boolean))];
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
  return (rows as unknown[]).map((r: unknown) => enrichAgent(cast<Agent>(r)));
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
  return rows.map((r: unknown) => cast<ChildAgentSummary>(r));
}

function enrichAgent(agent: Agent): AgentWithJob {
  const db = getDb();
  const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(agent.job_id);
  if (!jobRow) {
    // Job was deleted while agent still references it — return a stub
    const stub: Job = { id: agent.job_id, title: '(deleted job)', description: '', context: null, status: 'failed', priority: 0, work_dir: null, max_turns: 0, stop_mode: 'turns', stop_value: null, model: null, template_id: null, depends_on: null, is_interactive: 0, use_worktree: 0, project_id: null, flagged: 0, debate_id: null, debate_loop: null, debate_round: null, debate_role: null, scheduled_at: null, repeat_interval_ms: null, retry_policy: 'none', max_retries: 0, retry_count: 0, original_job_id: null, completion_checks: null, review_config: null, review_status: null, review_parent_job_id: null, created_by_agent_id: null, pre_debate_id: null, pre_debate_summary: null, workflow_id: null, workflow_cycle: null, workflow_phase: null, pr_url: null, archived_at: null, created_at: 0, updated_at: 0 };
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
  const active_locks = lockRows.map((r: unknown) => cast<FileLock>(r));
  const child_agents = getChildAgentSummaries(agent.id);
  const warningRows = db.prepare(`
    SELECT * FROM agent_warnings WHERE agent_id = ? AND dismissed = 0 ORDER BY created_at DESC
  `).all(agent.id);
  const warnings = warningRows.map((r: unknown) => cast<AgentWarning>(r));
  let template_name: string | null = null;
  if (job.template_id) {
    const tRow = db.prepare('SELECT name FROM templates WHERE id = ?').get(job.template_id) as { name: string } | undefined;
    template_name = tRow?.name ?? null;
  }
  return { ...agent, job, template_name, pending_question, active_locks, child_agents, warnings };
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
  return rows.map((r: unknown) => cast<AgentWarning>(r));
}

export function getAllActiveWarnings(): AgentWarning[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_warnings WHERE dismissed = 0 ORDER BY created_at DESC').all();
  return rows.map((r: unknown) => cast<AgentWarning>(r));
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
  return rows.map((r: unknown) => cast<Worktree>(r));
}

export function markWorktreeCleaned(id: string): void {
  const db = getDb();
  db.prepare('UPDATE worktrees SET cleaned_at = ? WHERE id = ?').run(Date.now(), id);
}

export function getWorktreeStats(): { active: number; cleaned: number } {
  const db = getDb();
  const active = (db.prepare('SELECT COUNT(*) as c FROM worktrees WHERE cleaned_at IS NULL').get() as { c: number } | undefined)?.c ?? 0;
  const cleaned = (db.prepare('SELECT COUNT(*) as c FROM worktrees WHERE cleaned_at IS NOT NULL').get() as { c: number } | undefined)?.c ?? 0;
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
  return rows.map((r: unknown) => cast<Nudge>(r));
}

export function markNudgeDelivered(id: string): void {
  const db = getDb();
  db.prepare('UPDATE nudges SET delivered = 1, delivered_at = ? WHERE id = ?').run(Date.now(), id);
}
