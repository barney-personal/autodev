import { useEffect } from 'react';
import type { AgentWithJob, Job, AgentStatus } from '@shared/types';
import { fmtElapsedCompact, fmtRel } from './format';

interface LooseJobsModalProps {
  open: boolean;
  agents: AgentWithJob[];
  queuedJobs: Job[];
  onClose: () => void;
  onSelectAgent: (agent: AgentWithJob) => void;
  onCancelJob: (job: Job) => void;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  waiting_user: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  starting: 'var(--active)',
  running: 'var(--active)',
  waiting_user: 'var(--attn)',
  done: 'var(--green)',
  failed: 'var(--red)',
  cancelled: 'var(--ink-3)',
};


export function LooseJobsModal({ open, agents, queuedJobs, onClose, onSelectAgent, onCancelJob }: LooseJobsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  // Order: blocked-on-user first, running next, queued, then done/failed/cancelled
  const standaloneAgents = [...agents.filter(a => !a.job.workflow_id)].sort((a, b) => {
    const order: AgentStatus[] = ['waiting_user', 'starting', 'running', 'done', 'failed', 'cancelled'];
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return b.updated_at - a.updated_at;
  });
  const standaloneQueued = queuedJobs.filter(j => !j.workflow_id && !agents.some(a => a.job_id === j.id));

  const total = standaloneAgents.length + standaloneQueued.length;

  return (
    <div className="ad-scrim" onClick={onClose}>
      <div
        className="ad-dialog"
        style={{ width: 'min(720px, calc(100vw - 48px))' }}
        onClick={e => e.stopPropagation()}
      >
        <header style={{ padding: '18px 22px 14px', borderBottom: '0.5px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Single-shot jobs
          </h2>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' }}>{total}</span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>esc to close</span>
        </header>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {total === 0 ? (
            <div style={{ padding: '40px 22px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>
              No standalone jobs. Single-shot tasks created with iterations = 1 appear here.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {standaloneQueued.map(job => (
                <li
                  key={`q-${job.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 22px',
                    borderBottom: '0.5px solid var(--hair)',
                    fontSize: 13,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ink-4)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.title}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    queued
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums', minWidth: 60, textAlign: 'right' }}>
                    {fmtRel(job.created_at)}
                  </span>
                  <button
                    type="button"
                    className="ad-btn-danger"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Cancel queued job "${job.title}"?`)) onCancelJob(job);
                    }}
                  >
                    Cancel
                  </button>
                </li>
              ))}
              {standaloneAgents.map(agent => {
                const isRunning = agent.status === 'running' || agent.status === 'starting';
                const elapsed = isRunning
                  ? Date.now() - agent.started_at
                  : agent.duration_ms ?? (agent.finished_at ? agent.finished_at - agent.started_at : 0);
                return (
                  <li
                    key={agent.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 22px',
                      borderBottom: '0.5px solid var(--hair)',
                      cursor: 'pointer',
                      fontSize: 13,
                      transition: 'background .12s var(--spring)',
                    }}
                    onClick={() => { onSelectAgent(agent); onClose(); }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') { onSelectAgent(agent); onClose(); } }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[agent.status], flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {agent.job.title}
                    </span>
                    <span style={{ fontSize: 11, color: STATUS_COLOR[agent.status], fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: 70 }}>
                      {STATUS_LABEL[agent.status]}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums', minWidth: 60, textAlign: 'right' }}>
                      {fmtElapsedCompact(elapsed)}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums', minWidth: 60, textAlign: 'right' }}>
                      {agent.cost_usd != null && agent.cost_usd > 0 ? `$${agent.cost_usd.toFixed(2)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
