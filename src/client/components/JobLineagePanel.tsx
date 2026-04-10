import { useMemo } from 'react';
import type { AgentStatus, AgentWithJob } from '@shared/types';

interface Props {
  selectedAgent: AgentWithJob;
  allAgents: AgentWithJob[];
  onSelectAgent: (agent: AgentWithJob) => void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  starting:     '#d29922',
  running:      '#2ea043',
  waiting_user: '#ef4444',
  done:         '#58a6ff',
  failed:       '#f85149',
  cancelled:    '#484f58',
};

// Node dimensions (narrower than DAGModal to fit sidebar)
const NW = 172; // node width
const NH = 42;  // node height
const HG = 8;   // horizontal gap between siblings
const VG = 28;  // vertical gap between layers
const PX = 14;  // x padding
const PY = 12;  // y padding
const R  = 6;   // corner radius

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

/**
 * Collect all agent IDs relevant to the lineage of `selectedAgent`:
 *  - the agent itself
 *  - all ancestors via parent_agent_id (recursive)
 *  - all siblings (agents sharing the same parent_agent_id)
 */
function buildLineageSet(selectedAgent: AgentWithJob, allAgents: AgentWithJob[]): Set<string> {
  const agentMap = new Map(allAgents.map(a => [a.id, a]));
  const relevant = new Set<string>([selectedAgent.id]);

  function addParents(agentId: string, seen = new Set<string>()) {
    if (seen.has(agentId)) return;
    seen.add(agentId);
    const agent = agentMap.get(agentId);
    if (!agent || !agent.parent_agent_id || !agentMap.has(agent.parent_agent_id)) return;
    relevant.add(agent.parent_agent_id);
    addParents(agent.parent_agent_id, seen);
  }
  addParents(selectedAgent.id);

  // Siblings share the same parent_agent_id
  if (selectedAgent.parent_agent_id) {
    for (const a of allAgents) {
      if (a.id !== selectedAgent.id && a.parent_agent_id === selectedAgent.parent_agent_id) {
        relevant.add(a.id);
      }
    }
  }

  // Descendants: recursively add all children, grandchildren, etc.
  function addDescendants(agentId: string, seen = new Set<string>()) {
    if (seen.has(agentId)) return;
    seen.add(agentId);
    for (const a of allAgents) {
      if (a.parent_agent_id === agentId) {
        relevant.add(a.id);
        addDescendants(a.id, seen);
      }
    }
  }
  addDescendants(selectedAgent.id);

  return relevant;
}

interface LNode { agent: AgentWithJob; x: number; y: number; cx: number; cy: number }
interface LEdge  { from: LNode; to: LNode }

function computeLayout(_selectedId: string, agents: AgentWithJob[]) {
  if (agents.length === 0) return { nodes: [] as LNode[], edges: [] as LEdge[], w: 0, h: 0 };

  const agentMap = new Map(agents.map(a => [a.id, a]));

  // Returns the parent agent ID if it's in the relevant set, otherwise null
  const parentOf = (id: string): string | null => {
    const a = agentMap.get(id);
    if (!a || !a.parent_agent_id || !agentMap.has(a.parent_agent_id)) return null;
    return a.parent_agent_id;
  };

  // Assign topological layers
  const layerOf = new Map<string, number>();
  function lay(id: string, stack = new Set<string>()): number {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const p = parentOf(id);
    const l = p ? lay(p, new Set(stack)) + 1 : 0;
    layerOf.set(id, l);
    return l;
  }
  agents.forEach(a => lay(a.id));

  // Group by layer, sort by started_at within each layer
  const byLayer = new Map<number, AgentWithJob[]>();
  for (const a of agents) {
    const l = layerOf.get(a.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(a);
  }
  for (const arr of byLayer.values()) {
    arr.sort((a, b) => a.started_at - b.started_at);
  }

  const numLayers = Math.max(...layerOf.values()) + 1;
  const maxCols   = Math.max(...[...byLayer.values()].map(a => a.length));
  const w = PX * 2 + maxCols * NW + Math.max(0, maxCols - 1) * HG;
  const h = PY * 2 + numLayers * NH + Math.max(0, numLayers - 1) * VG;

  const nodes: LNode[] = [];
  for (const [layer, arr] of byLayer) {
    const rowW   = arr.length * NW + Math.max(0, arr.length - 1) * HG;
    const availW = Math.max(w - PX * 2, rowW);
    const startX = PX + (availW - rowW) / 2;
    const y      = PY + layer * (NH + VG);
    arr.forEach((agent, i) => {
      const x = startX + i * (NW + HG);
      nodes.push({ agent, x, y, cx: x + NW / 2, cy: y + NH / 2 });
    });
  }

  const byId  = new Map(nodes.map(n => [n.agent.id, n]));
  const edges: LEdge[] = [];
  for (const node of nodes) {
    const p = parentOf(node.agent.id);
    if (p) {
      const parentNode = byId.get(p);
      if (parentNode) edges.push({ from: parentNode, to: node });
    }
  }

  return { nodes, edges, w: Math.max(w, NW + PX * 2), h: Math.max(h, NH + PY * 2) };
}

export function JobLineagePanel({ selectedAgent, allAgents, onSelectAgent }: Props) {
  const lineageIds  = useMemo(() => buildLineageSet(selectedAgent, allAgents), [selectedAgent, allAgents]);
  const lineageAgents = useMemo(() => allAgents.filter(a => lineageIds.has(a.id)), [allAgents, lineageIds]);
  const { nodes, edges, w, h } = useMemo(
    () => computeLayout(selectedAgent.id, lineageAgents),
    [selectedAgent.id, lineageAgents],
  );

  const hasRelations = lineageAgents.length > 1;

  return (
    <aside className="sidebar lineage-panel">
      <h2 className="sidebar-title">Lineage</h2>

      {!hasRelations ? (
        <p className="sidebar-empty">No related agents</p>
      ) : (
        <div className="lineage-scroll">
          <svg width={w} height={h}>
            <defs>
              <marker id="ln-arr" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
                <path d="M0,0.5 L0,4.5 L5,2.5 z" fill="#484f58" />
              </marker>
              {nodes.map(n => (
                <clipPath key={n.agent.id} id={`lnc-${n.agent.id}`}>
                  <rect x={n.x} y={n.y} width={NW} height={NH} rx={R} />
                </clipPath>
              ))}
            </defs>

            {/* Edges (behind nodes) */}
            {edges.map((e, i) => {
              const x1 = e.from.cx, y1 = e.from.y + NH;
              const x2 = e.to.cx,   y2 = e.to.y;
              const my = (y1 + y2) / 2;
              return (
                <path
                  key={i}
                  d={`M${x1} ${y1}C${x1} ${my},${x2} ${my},${x2} ${y2}`}
                  fill="none"
                  stroke="#484f58"
                  strokeWidth={1.5}
                  markerEnd="url(#ln-arr)"
                />
              );
            })}

            {/* Nodes */}
            {nodes.map(({ agent, x, y }) => {
              const color = STATUS_COLOR[agent.status];
              const isSel = agent.id === selectedAgent.id;
              return (
                <g
                  key={agent.id}
                  onClick={() => onSelectAgent(agent)}
                  style={{ cursor: 'pointer' }}
                  className="dag-node"
                >
                  {/* Background */}
                  <rect
                    x={x} y={y} width={NW} height={NH} rx={R}
                    fill={isSel ? '#1c2d3e' : '#0d1117'}
                    stroke={isSel ? '#388bfd' : color}
                    strokeWidth={isSel ? 2 : 1}
                  />
                  {/* Status strip */}
                  <rect
                    x={x} y={y} width={5} height={NH}
                    fill={color}
                    clipPath={`url(#lnc-${agent.id})`}
                  />
                  {/* Job title */}
                  <text
                    x={x + 12} y={y + 16}
                    fill={isSel ? '#e6edf3' : '#c9d1d9'}
                    fontSize={11}
                    fontWeight={isSel ? 600 : 400}
                    fontFamily="inherit"
                  >
                    {trunc(agent.job.title, 22)}
                  </text>
                  {/* Agent status */}
                  <text
                    x={x + 12} y={y + 32}
                    fill={color}
                    fontSize={10}
                    fontFamily="'IBM Plex Mono','Menlo','Monaco','Courier New',monospace"
                  >
                    {agent.status}
                  </text>
                  <title>{agent.job.title} \u2014 {agent.status}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </aside>
  );
}
