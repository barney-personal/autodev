import { useMemo, useEffect, useState } from 'react';
import type { Job, AgentWithJob, JobStatus } from '@shared/types';

const RANGE_OPTS = [
  { label: '1h',  ms: 3_600_000 },
  { label: '6h',  ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: 'All', ms: 0 },
] as const;

const TERMINAL_JOB = new Set(['done', 'failed', 'cancelled']);

interface DAGModalProps {
  jobs: Job[];
  agents: AgentWithJob[];
  onClose: () => void;
  onSelectAgent: (agent: AgentWithJob) => void;
}

interface DagNode {
  job: Job;
  x: number;
  y: number;
  cx: number; // center x
  cy: number; // center y
}

interface DagEdge {
  from: DagNode;
  to: DagNode;
}

const NODE_W  = 192;
const NODE_H  = 62;
const H_GAP   = 40;
const V_GAP   = 76;
const PADDING = 48;
const RADIUS  = 8;

const STATUS_COLOR: Record<JobStatus, string> = {
  queued:    '#6e7681',
  assigned:  '#d29922',
  running:   '#2ea043',
  done:      '#58a6ff',
  failed:    '#f85149',
  cancelled: '#484f58',
};

function parseDeps(job: Job): string[] {
  if (!job.depends_on) return [];
  try { return JSON.parse(job.depends_on) as string[]; } catch { return []; }
}

function computeLayout(jobs: Job[], agents: AgentWithJob[]): { nodes: DagNode[]; edges: DagEdge[]; svgW: number; svgH: number } {
  if (jobs.length === 0) return { nodes: [], edges: [], svgW: 0, svgH: 0 };

  const jobMap = new Map(jobs.map(j => [j.id, j]));

  // Map agent_id → agent (all agents, for lineage traversal)
  const agentById = new Map(agents.map(a => [a.id, a]));
  // Map job_id → most recent agent (for parent_agent_id lookup)
  const agentByJob = new Map<string, AgentWithJob>();
  for (const agent of [...agents].reverse()) agentByJob.set(agent.job_id, agent);

  // For each job, collect all parent job IDs from both depends_on and agent spawn lineage
  const allParents = new Map<string, string[]>();
  for (const job of jobs) {
    const parents: string[] = [];
    const seen = new Set<string>();

    // Explicit depends_on
    for (const depId of parseDeps(job)) {
      if (jobMap.has(depId) && !seen.has(depId)) {
        parents.push(depId);
        seen.add(depId);
      }
    }

    // Agent spawn lineage: follow parent_agent_id to find the job that spawned this one
    const agent = agentByJob.get(job.id);
    if (agent?.parent_agent_id) {
      const parentAgent = agentById.get(agent.parent_agent_id);
      if (parentAgent && jobMap.has(parentAgent.job_id) && !seen.has(parentAgent.job_id)) {
        parents.push(parentAgent.job_id);
        seen.add(parentAgent.job_id);
      }
    }

    allParents.set(job.id, parents);
  }

  // Assign layer = max layer of parents + 1 (memoized, cycle-safe)
  const layers = new Map<string, number>();
  function getLayer(id: string, stack = new Set<string>()): number {
    if (layers.has(id)) return layers.get(id)!;
    if (stack.has(id)) return 0; // cycle guard
    stack.add(id);
    const parents = allParents.get(id) ?? [];
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(pid => getLayer(pid, new Set(stack)))) + 1;
    layers.set(id, layer);
    return layer;
  }
  for (const job of jobs) getLayer(job.id);

  // Group by layer, sort within each layer by created_at
  const byLayer = new Map<number, Job[]>();
  for (const job of jobs) {
    const l = layers.get(job.id)!;
    const arr = byLayer.get(l) ?? [];
    arr.push(job);
    byLayer.set(l, arr);
  }
  for (const arr of byLayer.values()) arr.sort((a, b) => a.created_at - b.created_at);

  const numLayers = Math.max(...layers.values()) + 1;
  const maxCount  = Math.max(...[...byLayer.values()].map(a => a.length));
  const svgW = PADDING * 2 + maxCount * NODE_W + (maxCount - 1) * H_GAP;
  const svgH = PADDING * 2 + numLayers * NODE_H + (numLayers - 1) * V_GAP;

  const nodes: DagNode[] = [];
  for (const [layer, layerJobs] of byLayer) {
    const totalW = layerJobs.length * NODE_W + (layerJobs.length - 1) * H_GAP;
    const startX = PADDING + (svgW - PADDING * 2 - totalW) / 2;
    const y = PADDING + layer * (NODE_H + V_GAP);
    layerJobs.forEach((job, col) => {
      const x = startX + col * (NODE_W + H_GAP);
      nodes.push({ job, x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
    });
  }

  const nodeByJob = new Map(nodes.map(n => [n.job.id, n]));
  const edges: DagEdge[] = [];
  for (const node of nodes) {
    for (const parentId of allParents.get(node.job.id) ?? []) {
      const parent = nodeByJob.get(parentId);
      if (parent) edges.push({ from: parent, to: node });
    }
  }

  return { nodes, edges, svgW: Math.max(svgW, 300), svgH: Math.max(svgH, 150) };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function DAGModal({ jobs, agents, onClose, onSelectAgent }: DAGModalProps) {
  const [rangeMs, setRangeMs] = useState(0); // 0 = All

  const agentByJob = useMemo(() => {
    const m = new Map<string, AgentWithJob>();
    // Keep only the most recent agent per job
    for (const agent of [...agents].reverse()) m.set(agent.job_id, agent);
    return m;
  }, [agents]);

  const agentsByJob = useMemo(() => {
    const m = new Map<string, AgentWithJob[]>();
    for (const agent of agents) {
      const arr = m.get(agent.job_id) ?? [];
      arr.push(agent);
      m.set(agent.job_id, arr);
    }
    return m;
  }, [agents]);

  const filteredJobs = useMemo(() => {
    if (rangeMs === 0) return jobs;
    const cutoff = Date.now() - rangeMs;
    return jobs.filter(j => {
      const jAgents = agentsByJob.get(j.id) ?? [];
      const latest = jAgents.length
        ? Math.max(...jAgents.map(a => a.finished_at ?? a.started_at))
        : j.created_at;
      return latest >= cutoff || !TERMINAL_JOB.has(j.status);
    });
  }, [jobs, agentsByJob, rangeMs]);

  const { nodes, edges, svgW, svgH } = useMemo(() => computeLayout(filteredJobs, agents), [filteredJobs, agents]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const handleNodeClick = (job: Job) => {
    const agent = agentByJob.get(job.id);
    if (agent) { onSelectAgent(agent); onClose(); }
  };

  const isEmpty = filteredJobs.length === 0;

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal gantt-modal">
        <div className="modal-header">
          <h2>Job Graph</h2>
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

        <div className="gantt-body dag-body">
          {isEmpty ? (
            <div className="gantt-empty">No jobs to display</div>
          ) : (
            <svg width={svgW} height={svgH} className="gantt-svg dag-svg">
              <defs>
                <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0.5 L0,5.5 L7,3 z" fill="#484f58" />
                </marker>
                {nodes.map(n => (
                  <clipPath key={`clip-${n.job.id}`} id={`clip-${n.job.id}`}>
                    <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={RADIUS} />
                  </clipPath>
                ))}
              </defs>

              {/* Edges (drawn behind nodes) */}
              {edges.map((edge, i) => {
                const x1 = edge.from.cx, y1 = edge.from.y + NODE_H;
                const x2 = edge.to.cx,   y2 = edge.to.y;
                const my = (y1 + y2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                    fill="none"
                    stroke="#484f58"
                    strokeWidth={1.5}
                    markerEnd="url(#dag-arrow)"
                  />
                );
              })}

              {/* Nodes */}
              {nodes.map(n => {
                const { job, x, y } = n;
                const color = STATUS_COLOR[job.status];
                const hasAgent = agentByJob.has(job.id);
                return (
                  <g
                    key={job.id}
                    onClick={() => handleNodeClick(job)}
                    style={{ cursor: hasAgent ? 'pointer' : 'default' }}
                    className="dag-node"
                  >
                    {/* Node background */}
                    <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={RADIUS}
                      fill="#161b22" stroke={color} strokeWidth={1.5} />
                    {/* Left status strip */}
                    <rect x={x} y={y} width={6} height={NODE_H}
                      fill={color} opacity={0.8}
                      clipPath={`url(#clip-${job.id})`} />
                    {/* Title */}
                    <text x={x + 16} y={y + 25} className="gantt-label dag-title">
                      {truncate(job.title, 26)}
                    </text>
                    {/* Status */}
                    <text x={x + 16} y={y + 44} className="gantt-tick dag-status" fill={color}>
                      {job.status}
                    </text>
                    <title>{job.title}{'\n'}{job.status}</title>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <div className="gantt-legend">
          {(Object.entries(STATUS_COLOR) as [JobStatus, string][]).map(([status, color]) => (
            <div key={status} className="gantt-legend-item">
              <div className="gantt-legend-dot" style={{ background: color }} />
              {status}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
