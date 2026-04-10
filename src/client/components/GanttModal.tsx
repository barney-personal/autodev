import { useMemo, useEffect, useState, useRef } from 'react';
import type { Job, AgentWithJob } from '@shared/types';

interface GanttModalProps {
  jobs: Job[];
  agents: AgentWithJob[];
  onClose: () => void;
  onSelectAgent: (agent: AgentWithJob) => void;
}

// ── Layout ────────────────────────────────────────────────────────────────────
const LEFT   = 188; // label column width
const RIGHT  = 16;  // right padding
const ROW_H  = 28;  // row height
const BAR_H  = 14;  // bar height
const BAR_Y  = (ROW_H - BAR_H) / 2;
const AXIS_H = 30;  // time-axis header height

// ── Colours ───────────────────────────────────────────────────────────────────
const BAR_COLOR: Record<string, string> = {
  starting:     '#f59e0b',
  running:      '#f59e0b',
  waiting_user: '#ef4444',
  done:         '#22c55e',
  failed:       '#6b7280',
  cancelled:    '#484f58',
};
const QUEUED_COLOR = '#30363d';

// ── Time helpers ──────────────────────────────────────────────────────────────
function tickInterval(ms: number): number {
  if (ms <=   2 * 60_000) return        15_000; //  15s
  if (ms <=  10 * 60_000) return        60_000; //   1m
  if (ms <=  60 * 60_000) return   5 * 60_000;  //   5m
  if (ms <=  6 * 3600_000) return 30 * 60_000;  //  30m
  if (ms <= 24 * 3600_000) return     3600_000;  //   1h
  if (ms <= 7 * 86400_000) return 6 * 3600_000;  //   6h
  return                       24 * 3600_000;    //  24h
}

function fmtTick(t: number, totalMs: number): string {
  const d = new Date(t);
  if (totalMs <= 60 * 60_000) {
    return d.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit',
      second: totalMs <= 2 * 60_000 ? '2-digit' : undefined,
    });
  }
  if (totalMs <= 24 * 3600_000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDur(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

const TERMINAL_JOB = new Set(['done', 'failed', 'cancelled']);

const RANGE_OPTS = [
  { label: '1h',  ms: 3_600_000 },
  { label: '6h',  ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: 'All', ms: 0 },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────
export function GanttModal({ jobs, agents, onClose, onSelectAgent }: GanttModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth] = useState(900);
  const [now, setNow] = useState(Date.now());
  const [rangeMs, setRangeMs] = useState(0); // 0 = All

  // Responsive width via ResizeObserver
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSvgWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live-update ticker while agents are running
  const hasLive = agents.some(a => a.status === 'running' || a.status === 'starting');
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

  // Escape key
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Group agents by job_id, sorted by started_at ascending
  const agentsByJob = useMemo(() => {
    const map = new Map<string, AgentWithJob[]>();
    for (const a of agents) {
      const arr = map.get(a.job_id) ?? [];
      arr.push(a);
      map.set(a.job_id, arr);
    }
    for (const [, arr] of map) arr.sort((a, b) => a.started_at - b.started_at);
    return map;
  }, [agents]);

  // Filter + sort jobs
  const cutoff = rangeMs > 0 ? now - rangeMs : 0;
  const visibleJobs = useMemo(() => {
    return [...jobs]
      .filter(j => {
        if (cutoff === 0) return true;
        const jAgents = agentsByJob.get(j.id) ?? [];
        const latest = jAgents.length
          ? Math.max(...jAgents.map(a => a.finished_at ?? a.started_at))
          : j.created_at;
        return latest >= cutoff || !TERMINAL_JOB.has(j.status);
      })
      .sort((a, b) => a.created_at - b.created_at);
  }, [jobs, agentsByJob, cutoff]);

  // Compute visible time bounds
  const { tStart, tEnd } = useMemo(() => {
    if (visibleJobs.length === 0) return { tStart: now - 60_000, tEnd: now + 1000 };
    const times: number[] = [now];
    for (const j of visibleJobs) {
      times.push(j.created_at);
      for (const a of agentsByJob.get(j.id) ?? []) {
        times.push(a.started_at);
        if (a.finished_at) times.push(a.finished_at);
      }
    }
    const rawStart = rangeMs > 0 ? now - rangeMs : Math.min(...times);
    const rawEnd = Math.max(now, ...times);
    const pad = Math.max((rawEnd - rawStart) * 0.015, 1000);
    return { tStart: rawStart - pad, tEnd: rawEnd + pad };
  }, [visibleJobs, agentsByJob, now, rangeMs]);

  const totalMs = tEnd - tStart;
  const chartW = svgWidth - LEFT - RIGHT;
  const svgH = AXIS_H + ROW_H * visibleJobs.length;

  const tx = (t: number) => LEFT + Math.max(0, Math.min(1, (t - tStart) / totalMs)) * chartW;

  const ticks = useMemo(() => {
    const interval = tickInterval(totalMs);
    const first = Math.ceil(tStart / interval) * interval;
    const result: number[] = [];
    for (let t = first; t <= tEnd; t += interval) result.push(t);
    return result;
  }, [tStart, tEnd, totalMs]);

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal gantt-modal">
        <div className="modal-header">
          <h2>Timeline</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="gantt-range-btns">
              {RANGE_OPTS.map(opt => (
                <button
                  key={opt.label}
                  className={`gantt-range-btn${rangeMs === opt.ms ? ' gantt-range-btn-active' : ''}`}
                  onClick={() => setRangeMs(opt.ms)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button className="btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="gantt-body" ref={bodyRef}>
          {visibleJobs.length === 0 ? (
            <div className="gantt-empty">No jobs in this time range.</div>
          ) : (
            <svg width={svgWidth} height={svgH} className="gantt-svg">
              {/* Alternating row backgrounds */}
              {visibleJobs.map((_, i) => (
                <rect
                  key={i}
                  x={0} y={AXIS_H + i * ROW_H}
                  width={svgWidth} height={ROW_H}
                  fill={i % 2 === 0 ? '#0d1117' : '#0f1319'}
                />
              ))}

              {/* Vertical grid lines */}
              {ticks.map(t => (
                <line key={t} x1={tx(t)} y1={AXIS_H} x2={tx(t)} y2={svgH}
                  stroke="#21262d" strokeWidth={1} />
              ))}

              {/* Time axis */}
              {ticks.map(t => (
                <g key={`axis-${t}`}>
                  <line x1={tx(t)} y1={AXIS_H - 4} x2={tx(t)} y2={AXIS_H}
                    stroke="#484f58" strokeWidth={1} />
                  <text x={tx(t)} y={AXIS_H - 9} textAnchor="middle" className="gantt-tick">
                    {fmtTick(t, totalMs)}
                  </text>
                </g>
              ))}

              {/* Job rows */}
              {visibleJobs.map((job, i) => {
                const rowY = AXIS_H + i * ROW_H;
                const jobAgents = agentsByJob.get(job.id) ?? [];
                const firstAgent = jobAgents[0];

                // Queued/wait bar: job.created_at → first agent start (or updated_at for terminal jobs)
                const qEnd = firstAgent
                  ? firstAgent.started_at
                  : TERMINAL_JOB.has(job.status) ? job.updated_at : now;

                return (
                  <g key={job.id}>
                    {/* Job label */}
                    <text
                      x={LEFT - 8} y={rowY + ROW_H / 2 + 5}
                      textAnchor="end" className="gantt-label"
                      style={{ cursor: jobAgents.length ? 'pointer' : 'default' }}
                      onClick={() => {
                        const last = jobAgents.at(-1);
                        if (last) onSelectAgent(last);
                      }}
                    >
                      {job.title.length > 28 ? job.title.slice(0, 26) + '…' : job.title}
                    </text>

                    {/* Queued bar */}
                    {(() => {
                      const x1 = tx(job.created_at);
                      const x2 = tx(qEnd);
                      if (x2 - x1 < 1) return null;
                      return (
                        <rect x={x1} y={rowY + BAR_Y} width={x2 - x1} height={BAR_H}
                          rx={3} fill={QUEUED_COLOR} opacity={0.7}>
                          <title>Queued · {fmtDur(qEnd - job.created_at)}</title>
                        </rect>
                      );
                    })()}

                    {/* Agent run bars */}
                    {jobAgents.map(agent => {
                      const x1 = tx(agent.started_at);
                      const aEnd = agent.finished_at ?? now;
                      const x2 = tx(aEnd);
                      const w = Math.max(2, x2 - x1);
                      const color = BAR_COLOR[agent.status] ?? '#58a6ff';
                      return (
                        <rect
                          key={agent.id}
                          x={x1} y={rowY + BAR_Y} width={w} height={BAR_H}
                          rx={3} fill={color} style={{ cursor: 'pointer' }}
                          onClick={() => onSelectAgent(agent)}
                        >
                          <title>{job.title} · {agent.status} · {fmtDur(aEnd - agent.started_at)}</title>
                        </rect>
                      );
                    })}
                  </g>
                );
              })}

              {/* Label column divider */}
              <line x1={LEFT} y1={0} x2={LEFT} y2={svgH} stroke="#30363d" strokeWidth={1} />

              {/* "Now" marker */}
              {now >= tStart && now <= tEnd && (
                <line x1={tx(now)} y1={AXIS_H} x2={tx(now)} y2={svgH}
                  stroke="#58a6ff" strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
              )}
            </svg>
          )}
        </div>

        {/* Legend */}
        <div className="gantt-legend">
          <span className="gantt-legend-item"><span className="gantt-legend-dot" style={{ background: QUEUED_COLOR }} />Queued</span>
          <span className="gantt-legend-item"><span className="gantt-legend-dot" style={{ background: BAR_COLOR.running }} />Running</span>
          <span className="gantt-legend-item"><span className="gantt-legend-dot" style={{ background: BAR_COLOR.waiting_user }} />Waiting</span>
          <span className="gantt-legend-item"><span className="gantt-legend-dot" style={{ background: BAR_COLOR.done }} />Done</span>
          <span className="gantt-legend-item"><span className="gantt-legend-dot" style={{ background: BAR_COLOR.failed }} />Failed</span>
          <span className="gantt-legend-item">
            <svg width={24} height={10} style={{ verticalAlign: 'middle' }}>
              <line x1={0} y1={5} x2={24} y2={5} stroke="#58a6ff" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
            </svg>
            Now
          </span>
        </div>
      </div>
    </div>
  );
}
