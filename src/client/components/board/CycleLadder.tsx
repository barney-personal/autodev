import { useMemo } from 'react';
import type { Workflow, Job, WorkflowPhase } from '@shared/types';
import { PHASES, PHASE_SHORT } from './lanes';

export function CycleLadder({ workflow, jobs }: { workflow: Workflow; jobs: Job[] }) {
  const status = useMemo(() => {
    const map = new Map<number, Record<WorkflowPhase, 'todo' | 'now' | 'done'>>();
    const total = Math.max(workflow.max_cycles, workflow.current_cycle + 1);
    for (let i = 0; i < total; i++) {
      map.set(i, { idle: 'todo', assess: 'todo', review: 'todo', implement: 'todo', verify: 'todo' });
    }
    for (const job of jobs) {
      const phase = (job.workflow_phase ?? null) as WorkflowPhase | null;
      if (!phase || !PHASES.includes(phase)) continue;
      // Clamp the cycle into the expected range. A stray off-by-one in
      // `workflow_cycle` (e.g. mid-cycle transition writing the next cycle
      // before the workflow's `current_cycle` ticks) used to spawn a phantom
      // cycle row beyond `total - 1`.
      const rawCycle = job.workflow_cycle ?? 0;
      const c = Math.max(0, Math.min(rawCycle, total - 1));
      const bucket = map.get(c) ?? { idle: 'todo', assess: 'todo', review: 'todo', implement: 'todo', verify: 'todo' };
      const isRunning = job.status === 'running' || job.status === 'assigned';
      const isDone = job.status === 'done';
      if (isRunning) bucket[phase] = 'now';
      else if (isDone && bucket[phase] !== 'now') bucket[phase] = 'done';
      map.set(c, bucket);
    }
    return map;
  }, [jobs, workflow.max_cycles, workflow.current_cycle]);

  const cycleEntries = [...status.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="cr-cycles">
      <div className="cr-cycles-inner">
        {cycleEntries.map(([cycleNum, phases]) => {
          const isNow = Object.values(phases).some(s => s === 'now');
          return (
            <div key={cycleNum} className={`cycle ${isNow ? 'is-now' : ''}`}>
              <div className="lbl">Cycle {cycleNum}</div>
              <div className="phases">
                {PHASES.map(p => (
                  <div key={p} className={`ph ${phases[p] === 'done' ? 'done' : phases[p] === 'now' ? 'now' : ''}`}>
                    {PHASE_SHORT[p]}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
