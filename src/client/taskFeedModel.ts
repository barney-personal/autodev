/**
 * Unified task-feed data model.
 *
 * Merges workflows, standalone agents, and queued standalone jobs into one
 * deduplicated list of renderable TaskItem objects, grouped by urgency.
 *
 * Pure functions only — no React, no hooks, no side-effects.
 */

import type { Workflow, AgentWithJob, Job, AgentStatus, WorkflowStatus } from '@shared/types';

// ─── Task-item model ────────────────────────────────────────────────────────

export type TaskGroup = 'attention' | 'active' | 'recent';
export type TaskItemKind = 'workflow' | 'agent' | 'queued_job';

interface TaskItemBase {
  id: string;
  kind: TaskItemKind;
  group: TaskGroup;
  title: string;
  /** Unix-ms timestamp used for sorting within a group. */
  sortKey: number;
}

export interface WorkflowTaskItem extends TaskItemBase {
  kind: 'workflow';
  workflow: Workflow;
}

export interface AgentTaskItem extends TaskItemBase {
  kind: 'agent';
  agent: AgentWithJob;
}

export interface QueuedJobTaskItem extends TaskItemBase {
  kind: 'queued_job';
  job: Job;
}

export type TaskItem = WorkflowTaskItem | AgentTaskItem | QueuedJobTaskItem;

export interface GroupedTaskItems {
  attention: TaskItem[];
  active: TaskItem[];
  recent: TaskItem[];
}

// ─── Status → group mapping ─────────────────────────────────────────────────

const WORKFLOW_GROUP: Record<WorkflowStatus, TaskGroup> = {
  blocked: 'attention',
  failed: 'attention',
  running: 'active',
  complete: 'recent',
  cancelled: 'recent',
};

const AGENT_GROUP: Record<AgentStatus, TaskGroup> = {
  waiting_user: 'attention',
  failed: 'attention',
  starting: 'active',
  running: 'active',
  done: 'recent',
  cancelled: 'recent',
};

const QUEUED_JOB_GROUP: TaskGroup = 'active'; // queued standalone jobs always go to active

// ─── Severity ordering within attention group (lower = more severe) ─────────

const WORKFLOW_ATTENTION_SEVERITY: Partial<Record<WorkflowStatus, number>> = {
  failed: 0,
  blocked: 1,
};

const AGENT_ATTENTION_SEVERITY: Partial<Record<AgentStatus, number>> = {
  failed: 0,
  waiting_user: 1,
};

// ─── Classification ─────────────────────────────────────────────────────────

const RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function classifyWorkflow(workflow: Workflow): TaskGroup {
  return WORKFLOW_GROUP[workflow.status];
}

function classifyAgent(agent: AgentWithJob): TaskGroup {
  return AGENT_GROUP[agent.status];
}

/**
 * Build the unified, deduplicated, grouped, and sorted task-item list.
 *
 * Callers may pass ALL agents and ALL queued jobs — the function itself
 * filters out workflow-owned entries and collapses overlapping agent/queued-job
 * inputs so that each underlying work unit appears at most once.
 *
 * @param workflows      All workflows visible in the current project view
 * @param agents         All agents (workflow-owned ones are filtered out internally)
 * @param queuedJobs     All queued jobs without an agent (workflow-owned ones filtered out internally)
 * @param now            Current dashboard timestamp (for recent-window cutoff)
 * @param recentWindowMs How long completed items stay in "recent" (default 1h)
 */
export function buildGroupedTaskItems(
  workflows: Workflow[],
  agents: AgentWithJob[],
  queuedJobs: Job[],
  now: number,
  recentWindowMs: number = RECENT_WINDOW_MS,
): GroupedTaskItems {
  const attention: TaskItem[] = [];
  const active: TaskItem[] = [];
  const recent: TaskItem[] = [];

  function push(item: TaskItem) {
    switch (item.group) {
      case 'attention': attention.push(item); break;
      case 'active': active.push(item); break;
      case 'recent': recent.push(item); break;
    }
  }

  // ── Build lookup sets for deduplication ────────────────────────────────────

  // Set of workflow IDs to exclude workflow-owned agents and queued jobs
  // const workflowIds = new Set(workflows.map(w => w.id));

  // Set of job IDs that already have an agent, to avoid duplicate queued_job items
  const agentJobIds = new Set(agents.map(a => a.job_id));

  // ── Workflows ──────────────────────────────────────────────────────────────

  for (const workflow of workflows) {
    const group = classifyWorkflow(workflow);

    // For "recent" items, apply the time window cutoff
    if (group === 'recent') {
      const completedAt = workflow.updated_at;
      if (now - completedAt > recentWindowMs) continue;
    }

    let sortKey: number;
    if (group === 'attention') {
      // Severity first (lower = higher priority), then freshest update
      const severity = WORKFLOW_ATTENTION_SEVERITY[workflow.status] ?? 99;
      sortKey = severity * 1e15 - workflow.updated_at;
    } else if (group === 'active') {
      // Active: sort by creation time ascending (oldest first = started earliest)
      sortKey = workflow.created_at;
    } else {
      // Recent: most recently completed first
      sortKey = -workflow.updated_at;
    }

    push({
      id: `wf-${workflow.id}`,
      kind: 'workflow',
      group,
      title: workflow.title,
      sortKey,
      workflow,
    });
  }

  // ── Standalone agents (exclude workflow-owned) ─────────────────────────────

  for (const agent of agents) {
    // Skip agents whose jobs belong to ANY workflow — not just ones in the
    // current workflow list. This prevents workflow child agents from appearing
    // as standalone cards in views where their parent workflow is absent (e.g. archived).
    if (agent.job.workflow_id) continue;

    const group = classifyAgent(agent);

    // In archived mode (recentWindowMs === Infinity), keep all completed items.
    // In normal mode, drop completed items older than the recent window.
    if (group === 'recent' && recentWindowMs !== Infinity) {
      const completedAt = agent.finished_at ?? agent.updated_at;
      if (now - completedAt > recentWindowMs) continue;
    }

    let sortKey: number;
    if (group === 'attention') {
      const severity = AGENT_ATTENTION_SEVERITY[agent.status] ?? 99;
      sortKey = severity * 1e15 - agent.updated_at;
    } else if (group === 'active') {
      sortKey = agent.started_at;
    } else {
      sortKey = -(agent.finished_at ?? agent.updated_at);
    }

    push({
      id: `agent-${agent.id}`,
      kind: 'agent',
      group,
      title: agent.job.title,
      sortKey,
      agent,
    });
  }

  // ── Queued jobs (exclude workflow-owned and already-has-agent) ─────────────

  for (const job of queuedJobs) {
    // Skip jobs belonging to a workflow
    if (job.workflow_id) continue;
    // Skip jobs that already have a running agent (avoid duplicate cards)
    if (agentJobIds.has(job.id)) continue;

    push({
      id: `job-${job.id}`,
      kind: 'queued_job',
      group: QUEUED_JOB_GROUP,
      title: job.title,
      sortKey: job.created_at,
      job,
    });
  }

  // ── Sort each group ────────────────────────────────────────────────────────

  attention.sort((a, b) => a.sortKey - b.sortKey);
  active.sort((a, b) => a.sortKey - b.sortKey);
  recent.sort((a, b) => a.sortKey - b.sortKey);

  return { attention, active, recent };
}
