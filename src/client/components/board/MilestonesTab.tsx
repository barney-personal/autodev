import type { Workflow } from '@shared/types';
import type { ParsedMilestone, ParsedWorklog } from '../../utils/workflowParsing';

export function MilestonesTab({ workflow, milestones, worklogs }: { workflow: Workflow; milestones: ParsedMilestone[]; worklogs: ParsedWorklog[]; }) {
  if (milestones.length === 0) {
    return (
      <div className="cr-tab-body">
        <div className="stones">
          <div className="stone todo" style={{ paddingLeft: 28 }}>
            <div className="stitle">No milestones yet</div>
            <div className="swork">
              {workflow.status === 'running' && workflow.current_phase === 'assess'
                ? 'Drafting plan… milestones will appear here once the assess phase finishes.'
                : 'Milestones are defined during the Assess phase. Once Cycle 0 completes, they\'ll appear here.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Map worklogs to milestone index by cycle (best-effort)
  const worklogByMilestone = new Map<number, ParsedWorklog>();
  for (const wl of worklogs) {
    if (wl.milestone) {
      const matchIdx = milestones.findIndex(m => wl.milestone && (wl.milestone.toLowerCase().includes(m.title.toLowerCase().slice(0, 20)) || m.title.toLowerCase().includes(wl.milestone.toLowerCase().slice(0, 20))));
      if (matchIdx >= 0 && !worklogByMilestone.has(matchIdx)) worklogByMilestone.set(matchIdx, wl);
    }
  }

  return (
    <div className="cr-tab-body">
      <div className="stones">
        {milestones.map((m, i) => {
          const status: 'done' | 'active' | 'todo' = i < workflow.milestones_done
            ? 'done'
            : (i === workflow.milestones_done && workflow.status === 'running' ? 'active' : 'todo');
          const wl = worklogByMilestone.get(i);
          // Prefer the actual cycle pulled from the matched worklog; only fall
          // back to the index-based approximation when no worklog matched.
          const doneTag = wl?.cycle != null
            ? `Cycle ${wl.cycle}`
            : `Cycle ${Math.min(i + 1, workflow.current_cycle)}`;
          return (
            <div key={i} className={`stone ${status}`}>
              <div className="stitle">
                <span title={m.full}>{m.title}</span>
                <span className="tag">
                  {status === 'done' ? doneTag : status === 'active' ? 'In progress' : 'Pending'}
                </span>
              </div>
              {wl && (wl.commits.length > 0 || wl.tests.length > 0 || wl.nextStep) && (
                <div className="swork">
                  {wl.commits.length > 0 && <div>Committed: {wl.commits.slice(0, 2).join('; ')}</div>}
                  {wl.tests.length > 0 && <div>Tests: {wl.tests.slice(0, 1).join('; ')}</div>}
                  {wl.nextStep && status === 'active' && <div>Next: {wl.nextStep}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
