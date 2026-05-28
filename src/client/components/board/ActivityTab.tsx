import type { Job, AgentWithJob, WorkflowPhase } from '@shared/types';
import { fmtRel } from './format';
import type { ParsedWorklog } from '../../utils/workflowParsing';

export function ActivityTab({ jobs, agents, worklogs }: { jobs: Job[]; agents: AgentWithJob[]; worklogs: ParsedWorklog[] }) {
  type Entry = { t: number; who: 'implementer' | 'reviewer' | 'system'; kind: 'tool' | 'thought' | 'milestone' | 'review' | 'phase'; text: string };

  const entries: Entry[] = [];
  for (const job of jobs) {
    if (job.status === 'cancelled') continue;
    const phase = (job.workflow_phase ?? '') as WorkflowPhase | '';
    const who: Entry['who'] = phase === 'review' ? 'reviewer' : phase === 'implement' || phase === 'assess' ? 'implementer' : 'system';
    const agent = agents.find(a => a.job_id === job.id);
    const t = agent?.finished_at ?? agent?.started_at ?? job.created_at;
    const status = job.status === 'running' || job.status === 'assigned' ? 'started' : job.status;
    entries.push({
      t,
      who,
      kind: phase === 'review' ? 'review' : 'phase',
      text: `Cycle ${job.workflow_cycle ?? '-'} ${phase} · ${status}`,
    });
  }
  for (const wl of worklogs) {
    if (wl.milestone) {
      entries.push({ t: wl.updatedAt, who: 'implementer', kind: 'milestone', text: `✓ ${wl.milestone}` });
    }
    for (const c of wl.commits) {
      entries.push({ t: wl.updatedAt, who: 'implementer', kind: 'tool', text: `Commit · ${c}` });
    }
  }

  entries.sort((a, b) => b.t - a.t);

  if (entries.length === 0) {
    return <div className="cr-tab-body" style={{ color: 'var(--ink-3)', textAlign: 'center', paddingTop: 40 }}>No activity yet.</div>;
  }

  return (
    <div className="cr-tab-body">
      <div className="acts">
        {entries.slice(0, 80).map((e, i) => (
          <div key={i} className={`act ${e.kind}`}>
            <div className="when">{fmtRel(e.t)}</div>
            <div className={`who ${e.who}`}>{e.who === 'implementer' ? '◆ impl' : e.who === 'reviewer' ? '◇ rev' : '· sys'}</div>
            <div className="text">{e.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
