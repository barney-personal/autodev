import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { AgentCard } from './AgentCard';
import { WorkflowSummaryCard } from './WorkflowSummaryCard';
import { buildGroupedTaskItems, type TaskItem, type AgentTaskItem, type TaskGroup, type GroupedTaskItems } from '../taskFeedModel';
import type { AgentWithJob, AgentStatus, Job, Workflow } from '@shared/types';
import styles from './TaskFeed.module.css';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskFeedProps {
  workflows: Workflow[];
  agents: AgentWithJob[];
  /** All agents (unfiltered) — needed to find workflow-related agents for WorkflowSummaryCard */
  allAgents: AgentWithJob[];
  jobs: Job[];
  queuedJobs: Job[];
  now: number;
  onSelectAgent: (agent: AgentWithJob) => void;
  onSelectWorkflow: (workflow: Workflow) => void;
  onArchiveJob?: (job: Job) => void;
  onArchiveAll?: (jobs: Job[]) => void;
  selectedAgentId?: string | null;
  ptyIdleAgentIds?: Set<string>;
  isArchived?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ALL_STATUSES: AgentStatus[] = ['starting', 'running', 'waiting_user', 'done', 'failed', 'cancelled'];

const STATUS_LABELS: Record<AgentStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  waiting_user: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const GROUP_META: Record<TaskGroup, { label: string; styleClass: string }> = {
  attention: { label: 'Needs Attention', styleClass: styles.groupAttention },
  active: { label: 'Active', styleClass: styles.groupActive },
  recent: { label: 'Recently Finished', styleClass: styles.groupRecent },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/**
 * Reorder standalone agent items within a group based on customOrder (drag state),
 * while keeping workflow and queued_job items in their model-defined positions.
 * In archived mode, agents sort by updated_at descending (like AgentGrid).
 */
function applyCustomOrder(items: TaskItem[], customOrder: string[], isArchived: boolean): TaskItem[] {
  // Collect agent items and their original indices
  const agentSlots: number[] = [];
  const agentItems: TaskItem[] = [];

  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'agent') {
      agentSlots.push(i);
      agentItems.push(items[i]);
    }
  }

  if (agentItems.length <= 1) return items; // nothing to reorder

  if (isArchived) {
    // Archived view: sort agents by updated_at descending (most recent first)
    agentItems.sort((a, b) => {
      const agentA = (a as AgentTaskItem).agent;
      const agentB = (b as AgentTaskItem).agent;
      return agentB.updated_at - agentA.updated_at;
    });
  } else {
    // Active view: sort agents by customOrder position, preserving model order as fallback
    agentItems.sort((a, b) => {
      const ai = customOrder.indexOf((a as AgentTaskItem).agent.id);
      const bi = customOrder.indexOf((b as AgentTaskItem).agent.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0; // preserve model order for agents not in customOrder
    });
  }

  // Place reordered agent items back into their original slots
  const result = [...items];
  for (let i = 0; i < agentSlots.length; i++) {
    result[agentSlots[i]] = agentItems[i];
  }
  return result;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TaskFeed({
  workflows,
  agents,
  allAgents,
  jobs: _jobs,
  queuedJobs,
  now,
  onSelectAgent,
  onSelectWorkflow,
  onArchiveJob,
  onArchiveAll,
  selectedAgentId,
  ptyIdleAgentIds,
  isArchived,
}: TaskFeedProps) {
  const hasRunning = agents.some(a => a.status === 'running' || a.status === 'starting') ||
    workflows.some(w => w.status === 'running');
  const tickNow = useNowTick(hasRunning);
  const effectiveNow = hasRunning ? tickNow : now;

  // ─── Filter state (standalone jobs only) ────────────────────────────────
  const [activeFilters, setActiveFilters] = useState<Set<AgentStatus>>(new Set());
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);

  // ─── Drag-reorder state (standalone agent items) ────────────────────────
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceId = useRef<string | null>(null);

  // ─── Collapsible group state ────────────────────────────────────────────
  const [collapsed, setCollapsed] = useState<Record<TaskGroup, boolean>>({
    attention: false,
    active: false,
    recent: false,
  });

  const toggleGroup = useCallback((group: TaskGroup) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  }, []);

  // ─── Build grouped items from model ─────────────────────────────────────
  const grouped: GroupedTaskItems = useMemo(
    () => buildGroupedTaskItems(workflows, agents, queuedJobs, effectiveNow, isArchived ? Infinity : undefined),
    [workflows, agents, queuedJobs, effectiveNow, isArchived],
  );

  // ─── Apply drag-reorder to agent items within groups ────────────────────
  const orderedGroups: GroupedTaskItems = useMemo(() => ({
    attention: applyCustomOrder(grouped.attention, customOrder, !!isArchived),
    active: applyCustomOrder(grouped.active, customOrder, !!isArchived),
    recent: applyCustomOrder(grouped.recent, customOrder, !!isArchived),
  }), [grouped, customOrder, isArchived]);

  // ─── Sync custom drag order when agents change ─────────────────────────
  useEffect(() => {
    setCustomOrder(prev => {
      const agentIds = new Set(agents.map(a => a.id));
      const kept = prev.filter(id => agentIds.has(id));
      const existingSet = new Set(kept);
      const newIds = agents.filter(a => !existingSet.has(a.id)).map(a => a.id);
      if (newIds.length === 0 && kept.length === prev.length) return prev;
      return [...newIds, ...kept];
    });
  }, [agents]);

  // ─── Standalone agent filter counts ─────────────────────────────────────
  // Only count agents that are NOT workflow-owned (standalone)
  const standaloneAgents = useMemo(
    () => agents.filter(a => !a.job.workflow_id),
    [agents],
  );

  const counts = useMemo(() =>
    Object.fromEntries(
      ALL_STATUSES.map(s => [s, standaloneAgents.filter(a => a.status === s).length])
    ) as Record<AgentStatus, number>,
    [standaloneAgents],
  );

  const flaggedCount = standaloneAgents.filter(a => a.job?.flagged).length;
  const unreadIds = standaloneAgents
    .filter(a => (a.status === 'done' || a.status === 'failed') && a.output_read === 0)
    .map(a => a.id);

  const presentStatuses = ALL_STATUSES.filter(s => counts[s] > 0);
  const showFilterBar = standaloneAgents.length > 0 && (
    presentStatuses.length > 1 ||
    flaggedCount > 0 ||
    unreadIds.length > 0 ||
    standaloneAgents.some(a => a.job?.is_interactive && (a.status === 'running' || a.status === 'starting')) ||
    (onArchiveAll && standaloneAgents.some(a => a.job?.status === 'done' || a.job?.status === 'failed' || a.job?.status === 'cancelled'))
  );

  // ─── Filter + drag helpers ──────────────────────────────────────────────
  function toggleFilter(status: AgentStatus) {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function isAgentVisible(agent: AgentWithJob): boolean {
    if (activeFilters.size > 0 && !activeFilters.has(agent.status)) return false;
    if (showFlaggedOnly && !agent.job?.flagged) return false;
    return true;
  }

  function handleDragStart(id: string) {
    dragSourceId.current = id;
    setDraggingId(id);
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    if (dragSourceId.current !== id) setDragOverId(id);
  }

  function handleDragLeave(e: React.DragEvent, id: string) {
    if (dragOverId === id && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverId(null);
    }
  }

  function handleDrop(targetId: string) {
    const sourceId = dragSourceId.current;
    if (sourceId && sourceId !== targetId) {
      setCustomOrder(prev => {
        const next = [...prev];
        const si = next.indexOf(sourceId);
        const ti = next.indexOf(targetId);
        if (si === -1 || ti === -1) return prev;
        next.splice(si, 1);
        next.splice(ti, 0, sourceId);
        return next;
      });
    }
    setDragOverId(null);
    setDraggingId(null);
    dragSourceId.current = null;
  }

  function handleDragEnd() {
    setDragOverId(null);
    setDraggingId(null);
    dragSourceId.current = null;
  }

  // ─── Render a single task item ──────────────────────────────────────────
  function renderItem(item: TaskItem): React.ReactNode {
    switch (item.kind) {
      case 'workflow': {
        const wfAgents = allAgents.filter(a => a.job.workflow_id === item.workflow.id);
        return (
          <div key={item.id} className={styles.workflowWrapper}>
            <WorkflowSummaryCard
              workflow={item.workflow}
              workflowAgents={wfAgents}
              now={effectiveNow}
              onClick={() => onSelectWorkflow(item.workflow)}
            />
          </div>
        );
      }
      case 'agent': {
        if (!isAgentVisible(item.agent)) return null;
        return (
          <div
            key={item.id}
            draggable
            onDragStart={() => handleDragStart(item.agent.id)}
            onDragOver={e => handleDragOver(e, item.agent.id)}
            onDragLeave={e => handleDragLeave(e, item.agent.id)}
            onDrop={() => handleDrop(item.agent.id)}
            onDragEnd={handleDragEnd}
            className={[
              styles.dragWrapper,
              draggingId === item.agent.id ? styles.dragSource : '',
              dragOverId === item.agent.id ? styles.dragOver : '',
            ].join(' ')}
          >
            <AgentCard
              agent={item.agent}
              onClick={onSelectAgent}
              onSelectParent={(parentId) => {
                const parent = allAgents.find(a => a.id === parentId);
                if (parent) onSelectAgent(parent);
              }}
              onArchiveJob={onArchiveJob ? () => onArchiveJob(item.agent.job) : undefined}
              templateName={item.agent.template_name ?? undefined}
              isSelected={selectedAgentId === item.agent.id}
              isPtyIdle={ptyIdleAgentIds?.has(item.agent.id)}
              now={effectiveNow}
            />
          </div>
        );
      }
      case 'queued_job': {
        return (
          <div key={item.id} className={styles.queuedWrapper}>
            <div className="agent-card agent-card-queued">
              <div className="agent-card-header">
                <span className="agent-status-badge agent-status-queued">Queued</span>
                <label
                  className={`interactive-toggle${item.job.is_interactive ? ' interactive-toggle-active' : ''}`}
                  title={item.job.is_interactive ? 'Interactive (click to disable)' : 'Make interactive'}
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!!item.job.is_interactive}
                    onChange={e => {
                      fetch(`/api/jobs/${item.job.id}/interactive`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ interactive: e.target.checked }),
                      });
                    }}
                    style={{ display: 'none' }}
                  />
                  ⌨
                </label>
              </div>
              <div className="agent-card-title">{item.job.title}</div>
              <div className="agent-card-queued-hint">
                {item.job.pre_debate_id && !item.job.pre_debate_summary
                  ? 'Waiting for pre-debate to finish'
                  : 'Waiting for an available agent slot'}
              </div>
            </div>
          </div>
        );
      }
    }
  }

  // ─── Render a group section ─────────────────────────────────────────────
  function renderGroup(group: TaskGroup, items: TaskItem[]) {
    if (items.length === 0) return null;

    // For agent items, apply filter visibility
    const visibleItems = items.filter(item => {
      if (item.kind === 'agent') return isAgentVisible(item.agent);
      return true;
    });

    if (visibleItems.length === 0) return null;

    const meta = GROUP_META[group];
    const isCollapsed = collapsed[group];

    return (
      <div key={group} className={`${styles.group} ${meta.styleClass}`}>
        <div
          className={styles.groupHeader}
          onClick={() => toggleGroup(group)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group); } }}
        >
          <span className={`${styles.chevron} ${isCollapsed ? styles.chevronCollapsed : ''}`}>
            &#9660;
          </span>
          <h3 className={styles.groupTitle}>{meta.label}</h3>
          <span className={styles.groupCount}>{visibleItems.length}</span>
        </div>
        {!isCollapsed && (
          <div className={styles.cardGrid}>
            {visibleItems.map(renderItem)}
          </div>
        )}
      </div>
    );
  }

  // ─── Compute post-filter visibility ──────────────────────────────────────
  const totalItems = grouped.attention.length + grouped.active.length + grouped.recent.length;
  const filtersActive = activeFilters.size > 0 || showFlaggedOnly;

  const visibleItemCount = useMemo(() => {
    if (!filtersActive) return totalItems;
    let count = 0;
    for (const items of [grouped.attention, grouped.active, grouped.recent]) {
      for (const item of items) {
        if (item.kind === 'agent') {
          if (activeFilters.size > 0 && !activeFilters.has(item.agent.status)) continue;
          if (showFlaggedOnly && !item.agent.job?.flagged) continue;
        }
        count++;
      }
    }
    return count;
  }, [grouped, filtersActive, activeFilters, showFlaggedOnly, totalItems]);

  // ─── Main render ────────────────────────────────────────────────────────

  if (totalItems === 0 && !showFilterBar) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          <p>No tasks yet. Create a task to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Filter bar for standalone agent items */}
      {showFilterBar && (
        <div className="agent-filter-bar">
          {presentStatuses.map(status => (
            <button
              key={status}
              className={`agent-filter-btn status-filter-${status} ${activeFilters.has(status) ? 'agent-filter-btn-active' : ''}`}
              onClick={() => toggleFilter(status)}
              aria-pressed={activeFilters.has(status)}
            >
              {STATUS_LABELS[status]}
              <span className="agent-filter-count">{counts[status]}</span>
            </button>
          ))}
          {flaggedCount > 0 && (
            <button
              className={`agent-filter-btn agent-filter-flagged${showFlaggedOnly ? ' agent-filter-btn-active agent-filter-flagged-active' : ''}`}
              onClick={() => setShowFlaggedOnly(v => !v)}
              aria-pressed={showFlaggedOnly}
              aria-label={`Filter flagged agents (${flaggedCount})`}
            >
              ⚑ Flagged
              <span className="agent-filter-count">{flaggedCount}</span>
            </button>
          )}
          {(activeFilters.size > 0 || showFlaggedOnly) && (
            <button
              className="agent-filter-btn agent-filter-clear"
              onClick={() => { setActiveFilters(new Set()); setShowFlaggedOnly(false); }}
            >
              Clear
            </button>
          )}
          {unreadIds.length > 0 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => fetch('/api/agents/read-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: unreadIds }),
              })}
            >
              Mark All Read
              <span className="agent-filter-count">{unreadIds.length}</span>
            </button>
          )}
          {standaloneAgents.some(a => a.job?.is_interactive && (a.status === 'running' || a.status === 'starting')) && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => fetch('/api/agents/disconnect-all', { method: 'DELETE' })}
            >
              Disconnect All
            </button>
          )}
          {onArchiveAll && (() => {
            const finishedJobs = standaloneAgents
              .filter(a => a.job?.status === 'done' || a.job?.status === 'failed' || a.job?.status === 'cancelled')
              .map(a => a.job);
            return finishedJobs.length > 0 ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onArchiveAll(finishedJobs)}
              >
                Archive All Finished
                <span className="agent-filter-count">{finishedJobs.length}</span>
              </button>
            ) : null;
          })()}
        </div>
      )}

      {renderGroup('attention', orderedGroups.attention)}
      {renderGroup('active', orderedGroups.active)}
      {renderGroup('recent', orderedGroups.recent)}

      {/* Filtered empty state: items exist but all hidden by filters */}
      {totalItems > 0 && visibleItemCount === 0 && (
        <div className={styles.empty}>
          <p>No tasks match the current filters.</p>
        </div>
      )}
    </div>
  );
}
