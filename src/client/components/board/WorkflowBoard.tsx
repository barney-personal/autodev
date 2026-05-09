import { useEffect, useMemo, useState } from 'react';
import type { Workflow, AgentWithJob } from '@shared/types';
import { WorkflowCard } from './WorkflowCard';
import { LANES, laneFor, isLaneVisible, type LaneId } from './lanes';

interface WorkflowBoardProps {
  workflows: Workflow[];
  allAgents: AgentWithJob[];
  selectedWorkflowId: string | null;
  now: number;
  density?: 'comfortable' | 'compact';
  columnModel?: 'five' | 'four';
  onSelectWorkflow: (workflow: Workflow) => void;
}

function useTick(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function WorkflowBoard({
  workflows,
  allAgents,
  selectedWorkflowId,
  now,
  density = 'comfortable',
  columnModel = 'five',
  onSelectWorkflow,
}: WorkflowBoardProps) {
  const hasRunning = workflows.some(w => w.status === 'running');
  const tick = useTick(hasRunning);
  const effectiveNow = hasRunning ? tick : now;

  const agentsByWorkflow = useMemo(() => {
    const map = new Map<string, AgentWithJob[]>();
    for (const agent of allAgents) {
      const wfId = agent.job.workflow_id;
      if (!wfId) continue;
      const bucket = map.get(wfId);
      if (bucket) bucket.push(agent);
      else map.set(wfId, [agent]);
    }
    return map;
  }, [allAgents]);

  // Compute per-lane workflow lists
  const lanes = useMemo(() => {
    const visibleLanes: LaneId[] = columnModel === 'four'
      ? (['triage', 'flight', 'pr', 'done'] as LaneId[])
      : (['triage', 'flight', 'attn', 'pr', 'done'] as LaneId[]);

    return visibleLanes.map(laneId => {
      const def = LANES.find(l => l.id === laneId)!;
      const items = workflows
        .filter(w => {
          const lane = laneFor(w);
          if (columnModel === 'four' && lane === 'attn') {
            return laneId === 'flight';
          }
          return lane === laneId;
        })
        .filter(w => isLaneVisible(w, laneId, effectiveNow))
        .sort((a, b) => {
          if (laneId === 'flight' || laneId === 'attn') return a.created_at - b.created_at;
          return b.updated_at - a.updated_at;
        });
      return { def, items };
    });
  }, [workflows, columnModel, effectiveNow]);

  if (workflows.length === 0) {
    return (
      <div style={{
        margin: '60px auto',
        maxWidth: 480,
        textAlign: 'center',
        padding: '36px 24px',
        background: 'rgba(255,255,255,0.6)',
        border: '0.5px dashed var(--hair)',
        borderRadius: 'var(--r-lg)',
        color: 'var(--ink-3)',
        fontSize: 14,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 6, fontSize: 16, letterSpacing: '-0.01em' }}>
          No autonomous runs yet.
        </div>
        Create a task with the Autonomous preset to populate the board.
      </div>
    );
  }

  return (
    <div className={`board${columnModel === 'four' ? ' cols-4' : ''}`}>
      {lanes.map(({ def, items }) => (
        <section key={def.id} className="lane" data-tone={def.tone} aria-label={def.label}>
          <header className="lane-head">
            <span>{def.label}</span>
            <span className="count">{items.length}</span>
          </header>
          <div className="lane-body">
            {items.length === 0 ? (
              <div className="lane-empty">{def.emptyText}</div>
            ) : (
              items.map(w => (
                <WorkflowCard
                  key={w.id}
                  workflow={w}
                  workflowAgents={agentsByWorkflow.get(w.id) ?? []}
                  selected={selectedWorkflowId === w.id}
                  now={effectiveNow}
                  density={density}
                  onClick={() => onSelectWorkflow(w)}
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
