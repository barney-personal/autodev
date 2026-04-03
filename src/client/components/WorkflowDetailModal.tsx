import React, { useState, useEffect, useCallback } from 'react';
import type { Workflow, Job, AgentWithJob, WorkflowMetrics } from '@shared/types';

function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

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

interface ParsedWorklog {
  milestone: string | null;
  timestamp: string | null;
  commits: string[];
  tests: string[];
  blockers: string[];
  nextStep: string | null;
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

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function WorkflowDetailModal({ workflow, agents, onClose, onWorkflowUpdate }: WorkflowDetailModalProps) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [metrics, setMetrics] = useState<WorkflowMetrics | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'progress' | 'plan' | 'worklog' | 'jobs' | 'metrics'>(
    ['complete', 'blocked', 'failed', 'cancelled'].includes(workflow.status) ? 'summary' : 'progress'
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const now = useNowTick(workflow.status === 'running');

  const fetchDetail = useCallback(async () => {
    try {
      const [detailRes, jobsRes, metricsRes] = await Promise.all([
        fetch(`/api/autonomous-agent-runs/${workflow.id}`),
        fetch(`/api/autonomous-agent-runs/${workflow.id}/jobs`),
        fetch(`/api/autonomous-agent-runs/${workflow.id}/metrics`),
      ]);
      if (detailRes.ok) setDetail(await detailRes.json());
      if (jobsRes.ok) setJobs(await jobsRes.json());
      if (metricsRes.ok) setMetrics(await metricsRes.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [workflow.id]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);
  useEffect(() => {
    if (['complete', 'blocked', 'failed', 'cancelled'].includes(workflow.status)) {
      setActiveTab(current => (current === 'progress' ? 'summary' : current));
    }
  }, [workflow.status]);

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

  const handleWrapUp = async () => {
    if (!confirm('Wrap up this workflow? This will stop all work and create a draft PR with what\'s been done so far.')) return;
    setActing(true);
    try {
      const res = await fetch(`/api/autonomous-agent-runs/${workflow.id}/wrap-up`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        onWorkflowUpdate(data.workflow);
        await fetchDetail();
      } else if (res.status === 409) {
        const data = await res.json();
        if (data.workflow) onWorkflowUpdate(data.workflow);
        alert(`Draft PR creation failed. ${data.outcome === 'missing_worktree_with_progress' ? 'The worktree is missing but publishable commits exist — see blocked reason for details.' : 'The worktree has been preserved — see blocked reason for details.'}`);
        await fetchDetail();
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
  const orderedWorklogs = [...(detail?.worklogs ?? [])].sort((a, b) => b.updated_at - a.updated_at);
  const latestWorklog = orderedWorklogs[0] ?? null;
  const relevantJobs = jobs.filter(job => job.status !== 'cancelled');
  const latestJob = relevantJobs[relevantJobs.length - 1] ?? jobs[jobs.length - 1] ?? null;
  const lastFailedJob = [...jobs].reverse().find(j => j.status === 'failed') ?? null;
  const lastFailedAgent = lastFailedJob ? agents.find(a => a.job_id === lastFailedJob.id) ?? null : null;
  const totalCost = relevantJobs.reduce((sum, job) => {
    const agent = agents.find(a => a.job_id === job.id);
    return sum + (agent?.cost_usd ?? 0);
  }, 0);
  const totalDurationMs = relevantJobs.reduce((sum, job) => {
    const agent = agents.find(a => a.job_id === job.id);
    return sum + (agent?.duration_ms ?? 0);
  }, 0);
  const completionSummary = summarizeOutcome(workflow.status, latestJob);
  const parsedLatestWorklog = latestWorklog ? parseWorklog(latestWorklog.value) : null;
  const hasSummary = !!(latestWorklog || workflow.pr_url || jobs.length > 0);

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
              <button className="btn" style={{ background: '#b45309', color: '#fff', border: 'none' }} onClick={handleWrapUp} disabled={acting}>
                Wrap Up &amp; PR
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
          {(['summary', 'progress', 'plan', 'worklog', 'jobs', 'metrics'] as const).map(tab => (
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
          {/* Blocked reason banner */}
          {workflow.status === 'blocked' && workflow.blocked_reason && (
            <div style={{
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 16,
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>Blocked Reason</div>
              <div style={{ color: '#e5e5e5', lineHeight: 1.5 }}>{workflow.blocked_reason}</div>
              {lastFailedJob && (
                <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
                  Last failed job: <span style={{ color: '#ccc' }}>{lastFailedJob.title}</span>
                  {lastFailedAgent?.error_message && (
                    <div style={{ marginTop: 4, fontFamily: 'monospace', color: '#f87171', fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                      {lastFailedAgent.error_message.slice(0, 500)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {loading ? (
            <div style={{ color: '#888', textAlign: 'center', padding: 40 }}>Loading...</div>
          ) : (
            <>
              {activeTab === 'summary' && (
                <div style={{ display: 'grid', gap: 16 }}>
                  <div style={{ background: '#171717', border: '1px solid #2e2e2e', borderRadius: 8, padding: 16 }}>
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Run Outcome</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: statusColor, marginBottom: 8 }}>
                      {completionSummary.title}
                    </div>
                    <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.5 }}>
                      {completionSummary.body}
                    </div>
                    {!hasSummary && (
                      <div style={{ marginTop: 12, fontSize: 13, color: '#888' }}>
                        This run has not produced a plan, worklog, or PR yet.
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <SummaryCard label="PR" value={workflow.pr_url ? 'Open pull request' : 'No PR'} href={workflow.pr_url ?? undefined} />
                    <SummaryCard label="Branch" value={detail?.worktree_branch ?? workflow.worktree_branch ?? 'Not recorded'} mono />
                    <SummaryCard label="Jobs" value={`${jobs.length}`} />
                    <SummaryCard label="Milestones" value={`${workflow.milestones_done}/${workflow.milestones_total}`} />
                    <SummaryCard label="Total Cost" value={totalCost > 0 ? `$${totalCost.toFixed(4)}` : 'Not recorded'} />
                    <SummaryCard label="Total Runtime" value={formatDuration(totalDurationMs)} />
                  </div>

                  {/* Per-cycle cost/duration rollup */}
                  {relevantJobs.length > 0 && (() => {
                    const cycles = new Map<number, { phase: string; cost: number; durationMs: number; status: string }[]>();
                    for (const job of relevantJobs) {
                      const cycle = job.workflow_cycle ?? 0;
                      if (!cycles.has(cycle)) cycles.set(cycle, []);
                      const agent = agents.find(a => a.job_id === job.id);
                      const isRunning = job.status === 'running' || job.status === 'assigned';
                      const dMs = agent
                        ? (isRunning ? now - agent.started_at : (agent.duration_ms ?? (agent.finished_at ? agent.finished_at - agent.started_at : 0)))
                        : 0;
                      cycles.get(cycle)!.push({
                        phase: job.workflow_phase ?? '?',
                        cost: agent?.cost_usd ?? 0,
                        durationMs: dMs,
                        status: job.status,
                      });
                    }
                    const sortedCycles = [...cycles.entries()].sort((a, b) => a[0] - b[0]);
                    return (
                      <div style={{ background: '#171717', border: '1px solid #2e2e2e', borderRadius: 8, padding: 16 }}>
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>Cycle Breakdown</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {sortedCycles.map(([cycleNum, phases]) => {
                            const cycleCost = phases.reduce((s, p) => s + p.cost, 0);
                            return (
                              <div key={cycleNum} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                <span style={{ color: '#aaa', fontWeight: 600, minWidth: 55 }}>Cycle {cycleNum}</span>
                                <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
                                  {phases.map((p, i) => {
                                    const isRunning = p.status === 'running' || p.status === 'assigned';
                                    return (
                                      <span key={i} style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 4,
                                        padding: '2px 8px', borderRadius: 4, fontSize: 11,
                                        background: isRunning ? 'rgba(59,130,246,0.15)' : '#222',
                                        border: `1px solid ${isRunning ? '#3b82f6' : '#333'}`,
                                        color: isRunning ? '#60a5fa' : '#ccc',
                                      }}>
                                        <span style={{ textTransform: 'capitalize' }}>{p.phase}</span>
                                        <span style={{ color: '#888', fontFamily: 'var(--font-mono)' }}>{formatDuration(p.durationMs)}</span>
                                        {p.cost > 0 && <span style={{ color: '#888', fontFamily: 'var(--font-mono)' }}>(${p.cost.toFixed(2)})</span>}
                                        {isRunning && <span style={{ fontSize: 9 }}>LIVE</span>}
                                      </span>
                                    );
                                  })}
                                </div>
                                {cycleCost > 0 && (
                                  <span style={{ color: '#888', fontFamily: 'var(--font-mono)', fontSize: 11 }}>${cycleCost.toFixed(2)}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {parsedLatestWorklog && (
                    <div style={{ background: '#171717', border: '1px solid #2e2e2e', borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Latest Worklog</div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 10 }}>
                        {parsedLatestWorklog.milestone ?? 'Latest cycle update'}
                      </div>
                      <div style={{ display: 'grid', gap: 10 }}>
                        {parsedLatestWorklog.commits.length > 0 && (
                          <SummaryList title="Commits" items={parsedLatestWorklog.commits} mono />
                        )}
                        {parsedLatestWorklog.tests.length > 0 && (
                          <SummaryList title="Tests" items={parsedLatestWorklog.tests} />
                        )}
                        {parsedLatestWorklog.blockers.length > 0 && (
                          <SummaryList title="Blockers" items={parsedLatestWorklog.blockers} />
                        )}
                        {parsedLatestWorklog.nextStep && (
                          <div>
                            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Next Step</div>
                            <div style={{ fontSize: 13, color: '#ddd', lineHeight: 1.5 }}>{parsedLatestWorklog.nextStep}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {latestJob && (
                    <div style={{ background: '#171717', border: '1px solid #2e2e2e', borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Latest Phase</div>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: '#ddd' }}>
                        <strong>{latestJob.title}</strong>
                        <span style={{ color: STATUS_COLORS[latestJob.status] ?? '#aaa' }}>{latestJob.status}</span>
                        <span>{latestJob.model ?? 'auto'}</span>
                        <span>Cycle {latestJob.workflow_cycle ?? '-'}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

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
                      const isRunning = job.status === 'running' || job.status === 'assigned';
                      const jobDurationMs = agent
                        ? (isRunning ? now - agent.started_at : (agent.duration_ms ?? (agent.finished_at ? agent.finished_at - agent.started_at : 0)))
                        : 0;
                      return (
                        <div key={job.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 10px', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 4, fontSize: 12 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot[job.status] ?? '#6b7280', flexShrink: 0 }} />
                          <span style={{ fontWeight: 600, minWidth: 180 }}>{job.title}</span>
                          <span style={{ color: '#888', minWidth: 50 }}>{job.status}</span>
                          <span style={{ color: '#666', minWidth: 80 }}>{job.model ?? 'auto'}</span>
                          <span style={{ color: isRunning ? '#3b82f6' : '#888', minWidth: 70, fontFamily: 'var(--font-mono)' }}>
                            {jobDurationMs > 0 ? formatDuration(jobDurationMs) : '--'}
                          </span>
                          <span style={{ color: '#888', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
                            {agent?.cost_usd != null ? `$${agent.cost_usd.toFixed(4)}` : '--'}
                          </span>
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
                        <th style={{ padding: '4px 8px' }}>Duration</th>
                        <th style={{ padding: '4px 8px' }}>Cost</th>
                        <th style={{ padding: '4px 8px' }}>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map(job => {
                        const agent = agents.find(a => a.job_id === job.id);
                        const isRunning = job.status === 'running' || job.status === 'assigned';
                        const jobDurationMs = agent
                          ? (isRunning ? now - agent.started_at : (agent.duration_ms ?? (agent.finished_at ? agent.finished_at - agent.started_at : 0)))
                          : 0;
                        return (
                          <tr key={job.id} style={{ borderTop: '1px solid #2a2a2a' }}>
                            <td style={{ padding: '6px 8px' }}>{job.title}</td>
                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{job.workflow_phase ?? '-'}</td>
                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{job.workflow_cycle ?? '-'}</td>
                            <td style={{ padding: '6px 8px', color: STATUS_COLORS[job.status] ?? '#aaa' }}>{job.status}</td>
                            <td style={{ padding: '6px 8px', color: '#888' }}>{job.model ?? 'auto'}</td>
                            <td style={{ padding: '6px 8px', color: isRunning ? '#3b82f6' : '#888', fontFamily: 'var(--font-mono)' }}>{jobDurationMs > 0 ? formatDuration(jobDurationMs) : '-'}</td>
                            <td style={{ padding: '6px 8px', color: '#888', fontFamily: 'var(--font-mono)' }}>{agent?.cost_usd != null ? `$${agent.cost_usd.toFixed(4)}` : '-'}</td>
                            <td style={{ padding: '6px 8px', color: '#666', fontSize: 11 }}>{agent ? new Date(agent.started_at).toLocaleTimeString() : '-'}</td>
                          </tr>
                        );
                      })}
                      {jobs.length === 0 && (
                        <tr><td colSpan={8} style={{ padding: 20, color: '#888', textAlign: 'center' }}>No jobs yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === 'metrics' && (
                <div>
                  {metrics ? (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                        {[
                          { label: 'Wall Clock', value: formatDuration(metrics.summary.total_wall_clock_ms) },
                          { label: 'Agent Time', value: formatDuration(metrics.summary.total_agent_ms) },
                          { label: 'Avg Queue Wait', value: formatDuration(metrics.summary.avg_queue_wait_ms) },
                          { label: 'Avg Handoff', value: formatDuration(metrics.summary.avg_handoff_ms) },
                        ].map(({ label, value }) => (
                          <div key={label} style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 12, textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
                            <div style={{ fontSize: 18, fontWeight: 600, color: '#ddd' }}>{value}</div>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                        {[
                          { label: 'Total Queue Wait', value: formatDuration(metrics.summary.total_queue_wait_ms) },
                          { label: 'Total Handoff', value: formatDuration(metrics.summary.total_handoff_ms) },
                          { label: 'Total Cost', value: `$${metrics.summary.total_cost_usd.toFixed(4)}` },
                        ].map(({ label, value }) => (
                          <div key={label} style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 12, textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
                            <div style={{ fontSize: 16, fontWeight: 600, color: '#ddd' }}>{value}</div>
                          </div>
                        ))}
                      </div>

                      <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#aaa' }}>Per-Phase Breakdown</h3>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ color: '#888', textAlign: 'left' }}>
                            <th style={{ padding: '4px 8px' }}>Cycle</th>
                            <th style={{ padding: '4px 8px' }}>Phase</th>
                            <th style={{ padding: '4px 8px' }}>Queue Wait</th>
                            <th style={{ padding: '4px 8px' }}>Agent Duration</th>
                            <th style={{ padding: '4px 8px' }}>Handoff</th>
                            <th style={{ padding: '4px 8px' }}>Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.phases.map(p => (
                            <tr key={p.job_id} style={{ borderTop: '1px solid #2a2a2a' }}>
                              <td style={{ padding: '6px 8px' }}>{p.cycle}</td>
                              <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{p.phase}</td>
                              <td style={{ padding: '6px 8px', color: '#aaa' }}>{formatDuration(p.queue_wait_ms)}</td>
                              <td style={{ padding: '6px 8px', color: '#aaa' }}>{formatDuration(p.agent_duration_ms)}</td>
                              <td style={{ padding: '6px 8px', color: '#aaa' }}>{formatDuration(p.handoff_ms)}</td>
                              <td style={{ padding: '6px 8px', color: '#888' }}>{p.agent_cost_usd != null ? `$${p.agent_cost_usd.toFixed(4)}` : '-'}</td>
                            </tr>
                          ))}
                          {metrics.phases.length === 0 && (
                            <tr><td colSpan={6} style={{ padding: 20, color: '#888', textAlign: 'center' }}>No phase data yet</td></tr>
                          )}
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <div style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 40 }}>
                      No metrics available yet.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function summarizeOutcome(status: Workflow['status'], latestJob: Job | null): { title: string; body: string } {
  if (status === 'complete') {
    return {
      title: 'Run Completed',
      body: latestJob
        ? `The run finished successfully. The last phase was ${latestJob.workflow_phase ?? 'unknown'} on cycle ${latestJob.workflow_cycle ?? '-'}.`
        : 'The run finished successfully.',
    };
  }
  if (status === 'blocked') {
    return {
      title: 'Run Blocked',
      body: latestJob
        ? `The run stopped progressing after ${latestJob.title}. Review the latest worklog and resume the run if the state looks recoverable.`
        : 'The run is blocked and needs attention before it can continue.',
    };
  }
  // Note: blocked_reason is shown separately in the blocked banner below
  if (status === 'failed') {
    return {
      title: 'Run Failed',
      body: latestJob
        ? `The run failed during ${latestJob.title}. Check the jobs tab and latest worklog to see what broke before retrying.`
        : 'The run failed before completion.',
    };
  }
  if (status === 'cancelled') {
    return {
      title: 'Run Cancelled',
      body: 'The run was cancelled before it completed.',
    };
  }
  return {
    title: 'Run In Progress',
    body: latestJob
      ? `The run is currently in ${latestJob.workflow_phase ?? 'an active'} phase on cycle ${latestJob.workflow_cycle ?? '-'}.`
      : 'The run is currently active.',
  };
}

function parseWorklog(value: string): ParsedWorklog {
  const milestoneMatch = value.match(/^##\s+Cycle\s+\d+\s+—\s+(.+)$/m);
  const timestampMatch = value.match(/\*\*Timestamp:\*\*\s+(.+)$/m);
  const commits = extractBulletLines(value, '### Commits');
  const tests = extractBulletLines(value, '### Test results');
  const blockers = extractBulletLines(value, '### Blockers');
  const nextStep = extractSectionText(value, '### Next step');
  return {
    milestone: milestoneMatch?.[1]?.trim() ?? null,
    timestamp: timestampMatch?.[1]?.trim() ?? null,
    commits,
    tests,
    blockers,
    nextStep,
  };
}

function extractBulletLines(text: string, heading: string): string[] {
  const section = extractSectionText(text, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

function extractSectionText(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n### |$)`));
  return match?.[1]?.trim() || null;
}

function SummaryCard({ label, value, href, mono = false }: { label: string; value: string; href?: string; mono?: boolean }) {
  const content = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'none' }}>
      {value} ↗
    </a>
  ) : (
    <span style={{ fontFamily: mono ? 'monospace' : undefined }}>{value}</span>
  );
  return (
    <div style={{ background: '#171717', border: '1px solid #2e2e2e', borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#eee', wordBreak: 'break-word' }}>{content}</div>
    </div>
  );
}

function SummaryList({ title, items, mono = false }: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'grid', gap: 4 }}>
        {items.map((item, index) => (
          <div key={`${title}-${index}`} style={{ fontSize: 13, color: '#ddd', fontFamily: mono ? 'monospace' : undefined }}>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
