import type { Workflow } from '@shared/types';
import { fmtDur, fmtRel, fmtCost } from './format';
import { formatWorkflowPhase } from './phases';

export function SidePanel({ workflow, totalCost, totalDuration, lastActivityTs, onResume, onWrapUp, onCancel, acting }: {
  workflow: Workflow;
  totalCost: number;
  totalDuration: number;
  lastActivityTs: number;
  onResume: () => void;
  onWrapUp: () => void;
  onCancel: () => void;
  acting: boolean;
}) {
  const isRunning = workflow.status === 'running';
  const isBlocked = workflow.status === 'blocked';
  const isComplete = workflow.status === 'complete';

  return (
    <aside className="cr-side">
      <div className="cr-side-block">
        <h3>Run state</h3>
        <dl className="kv">
          <dt>Phase</dt>
          <dd><span className="pill">{formatWorkflowPhase(workflow.current_phase)}</span></dd>
          <dt>Cycle</dt>
          <dd>{workflow.current_cycle} / {workflow.max_cycles}</dd>
          <dt>Elapsed</dt>
          <dd>{fmtDur(totalDuration)}</dd>
          <dt>Cost</dt>
          <dd>{fmtCost(totalCost)}</dd>
          <dt>Milestones</dt>
          <dd>{workflow.milestones_done} / {workflow.milestones_total}</dd>
        </dl>
      </div>
      <div className="cr-side-block">
        <h3>Configuration</h3>
        <dl className="kv">
          <dt>Repo</dt>
          <dd className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workflow.work_dir ?? '—'}</dd>
          <dt>Branch</dt>
          <dd className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workflow.worktree_branch ?? '—'}</dd>
          <dt>Implementer</dt>
          <dd>{workflow.implementer_model}</dd>
          <dt>Reviewer</dt>
          <dd>{workflow.reviewer_model}</dd>
        </dl>
      </div>
      <div className="cr-side-block">
        <h3>Activity</h3>
        <dl className="kv">
          <dt>Created</dt>
          <dd>{fmtRel(workflow.created_at)}</dd>
          <dt>Last move</dt>
          <dd>{fmtRel(lastActivityTs)}</dd>
        </dl>
      </div>
      <div className="cr-actions-row">
        {isBlocked ? (
          <>
            <button className="ad-btn-primary" onClick={onResume} disabled={acting}>Resume</button>
            <button className="ad-btn-ghost" onClick={onWrapUp} disabled={acting}>Wrap up</button>
            <button className="ad-btn-danger" onClick={onCancel} disabled={acting}>Cancel</button>
          </>
        ) : isRunning ? (
          <>
            <button className="ad-btn-ghost" onClick={onWrapUp} disabled={acting}>Wrap up & PR</button>
            <button className="ad-btn-danger" onClick={onCancel} disabled={acting}>Stop</button>
          </>
        ) : isComplete && workflow.pr_url ? (
          <a href={workflow.pr_url} target="_blank" rel="noopener noreferrer" className="ad-btn-primary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none' }}>
            Open PR ↗
          </a>
        ) : null}
      </div>
    </aside>
  );
}
