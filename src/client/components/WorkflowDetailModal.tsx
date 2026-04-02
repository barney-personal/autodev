import React, { useState, useEffect, useCallback } from 'react';
import type { Workflow, Job, AgentWithJob } from '@shared/types';

interface WorkflowDetail extends Workflow {
  plan: string | null;
  contract: string | null;
  worklogs: Array<{ key: string; value: string; updated_at: number }>;
}

interface WorkflowDetailModalProps {
  workflow: Workflow;
  agents: AgentWithJob[];
  onClose: () => void;
  onWorkflowUpdate: (workflow: Workflow) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  complete: '#3b82f6',
  blocked: '#f59e0b',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  assess: 'Assess',
  review: 'Review',
  implement: 'Implement',
};

export function WorkflowDetailModal({ workflow, agents, onClose, onWorkflowUpdate }: WorkflowDetailModalProps) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeTab, setActiveTab] = useState<'progress' | 'plan' | 'worklog' | 'jobs'>('progress');
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const fetchDetail = useCallback(async () => {
    try {
      const [detailRes, jobsRes] = await Promise.all([
        fetch(`/api/autonomous-agent-runs/${workflow.id}`),
        fetch(`/api/autonomous-agent-runs/${workflow.id}/jobs`),
      ]);
      if (detailRes.ok) setDetail(await detailRes.json());
      if (jobsRes.ok) setJobs(await jobsRes.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [workflow.id]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleCancel = async () => {
    if (!confirm('Cancel this autonomous agent run?')) return;
    setActing(true);
    try {
      const res = await fetch(`/api/autonomous-agent-runs/${workflow.id}/cancel`, { method: 'POST' });
      if (res.ok) {
        const updated = await res.json();
        onWorkflowUpdate(updated);
        onClose();
      }
    } finally { setActing(false); }
  };

  const handleResume = async () => {
    setActing(true);
    try {
      const res = await fetch(`/api/autonomous-agent-runs/${workflow.id}/resume`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        onWorkflowUpdate(data.workflow);
        await fetchDetail();
      }
    } finally { setActing(false); }
  };

  const milestonePercent = workflow.milestones_total > 0
    ? Math.round((workflow.milestones_done / workflow.milestones_total) * 100)
    : 0;

  const statusColor = STATUS_COLORS[workflow.status] ?? '#6b7280';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: '80vw', maxWidth: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>{workflow.title}</h2>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6, fontSize: 13, color: '#aaa' }}>
              <span style={{ color: statusColor, fontWeight: 600 }}>{workflow.status.toUpperCase()}</span>
              <span>Cycle {workflow.current_cycle}/{workflow.max_cycles}</span>
              <span style={{ color: '#888' }}>Phase: {PHASE_LABELS[workflow.current_phase] ?? workflow.current_phase}</span>
              <span style={{ color: '#888' }}>{workflow.implementer_model} + {workflow.reviewer_model}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {workflow.pr_url && (
              <a href={workflow.pr_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ textDecoration: 'none' }}>
                View PR ↗
              </a>
            )}
            {workflow.status === 'blocked' && (
              <button className="btn btn-primary" onClick={handleResume} disabled={acting}>
                Resume Run
              </button>
            )}
            {(workflow.status === 'running' || workflow.status === 'blocked') && (
              <button className="btn btn-secondary" onClick={handleCancel} disabled={acting}>
                Cancel Run
              </button>
            )}
            <button className="btn-icon" onClick={onClose}>&#x2715;</button>
          </div>
        </div>

        {/* Milestone progress bar */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #333' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#aaa', marginBottom: 6 }}>
            <span>Milestones: {workflow.milestones_done}/{workflow.milestones_total}</span>
            <span>{milestonePercent}%</span>
          </div>
          <div style={{ height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${milestonePercent}%`, background: statusColor, borderRadius: 3, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #333' }}>
          {(['progress', 'plan', 'worklog', 'jobs'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
                color: activeTab === tab ? '#fff' : '#888',
                borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                fontSize: 13, fontWeight: activeTab === tab ? 600 : 400,
                textTransform: 'capitalize',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {loading ? (
            <div style={{ color: '#888', textAlign: 'center', padding: 40 }}>Loading...</div>
          ) : (
            <>
              {activeTab === 'progress' && (
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#aaa' }}>Task</h3>
                    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 12, fontSize: 13, whiteSpace: 'pre-wrap' }}>
                      {workflow.task}
                    </div>
                  </div>

                  <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#aaa' }}>Phase Timeline</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {jobs.map(job => {
                      const agent = agents.find(a => a.job_id === job.id);
                      const statusDot: Record<string, string> = { done: '#22c55e', failed: '#ef4444', running: '#3b82f6', queued: '#6b7280', assigned: '#f59e0b', cancelled: '#6b7280' };
                      return (
                        <div key={job.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 10px', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 4, fontSize: 12 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot[job.status] ?? '#6b7280', flexShrink: 0 }} />
                          <span style={{ fontWeight: 600, minWidth: 180 }}>{job.title}</span>
                          <span style={{ color: '#888' }}>{job.status}</span>
                          {agent?.cost_usd != null && <span style={{ color: '#888', marginLeft: 'auto' }}>${agent.cost_usd.toFixed(4)}</span>}
                        </div>
                      );
                    })}
                    {jobs.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>No jobs yet.</div>}
                  </div>
                </div>
              )}

              {activeTab === 'plan' && (
                <div>
                  {detail?.plan ? (
                    <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', color: '#ddd' }}>
                      {detail.plan}
                    </pre>
                  ) : (
                    <div style={{ color: '#888', fontSize: 13 }}>
                      No plan written yet. The assess phase will create it.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'worklog' && (
                <div>
                  {detail?.worklogs && detail.worklogs.length > 0 ? (
                    detail.worklogs.map(entry => (
                      <div key={entry.key} style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>
                          {entry.key.split('/').pop()} — {new Date(entry.updated_at).toLocaleString()}
                        </div>
                        <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', color: '#ccc', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 12 }}>
                          {entry.value}
                        </pre>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: '#888', fontSize: 13 }}>
                      No worklog entries yet. The implement phase will write them.
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'jobs' && (
                <div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#888', textAlign: 'left' }}>
                        <th style={{ padding: '4px 8px' }}>Job</th>
                        <th style={{ padding: '4px 8px' }}>Phase</th>
                        <th style={{ padding: '4px 8px' }}>Cycle</th>
                        <th style={{ padding: '4px 8px' }}>Status</th>
                        <th style={{ padding: '4px 8px' }}>Model</th>
                        <th style={{ padding: '4px 8px' }}>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map(job => {
                        const agent = agents.find(a => a.job_id === job.id);
                        return (
                          <tr key={job.id} style={{ borderTop: '1px solid #2a2a2a' }}>
                            <td style={{ padding: '6px 8px' }}>{job.title}</td>
                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{job.workflow_phase ?? '-'}</td>
                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{job.workflow_cycle ?? '-'}</td>
                            <td style={{ padding: '6px 8px', color: STATUS_COLORS[job.status] ?? '#aaa' }}>{job.status}</td>
                            <td style={{ padding: '6px 8px', color: '#888' }}>{job.model ?? 'auto'}</td>
                            <td style={{ padding: '6px 8px', color: '#888' }}>{agent?.cost_usd != null ? `$${agent.cost_usd.toFixed(4)}` : '-'}</td>
                          </tr>
                        );
                      })}
                      {jobs.length === 0 && (
                        <tr><td colSpan={6} style={{ padding: 20, color: '#888', textAlign: 'center' }}>No jobs yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
