import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Workflow, Job, AgentWithJob, VerifyRun, WorkflowStatus } from '@shared/types';
import { type LaneTone } from './lanes';
import { fmtDur, fmtRel, fmtCost } from './format';
import { ResolverPanel } from '../ResolverPanel';
import { parsePlanMilestones, parseWorklog } from '../../utils/workflowParsing';
import { CycleLadder } from './CycleLadder';
import { MilestonesTab } from './MilestonesTab';
import { ActivityTab } from './ActivityTab';
import { DiffTab } from './DiffTab';
import { SidePanel } from './SidePanel';
import { formatWorkflowPhase } from './phases';

interface WorkflowDetail extends Workflow {
  plan: string | null;
  contract: string | null;
  worklogs: Array<{ key: string; value: string; updated_at: number }>;
  verify_runs: VerifyRun[];
}

interface ControlRoomProps {
  workflow: Workflow;
  agents: AgentWithJob[];
  onBack: () => void;
  onWorkflowUpdate: (w: Workflow) => void;
}

function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

const STATUS_BADGE_TONE: Record<WorkflowStatus, LaneTone> = {
  running: 'active',
  blocked: 'attn',
  failed: 'attn',
  complete: 'done',
  cancelled: 'done',
};

function statusLabel(w: Workflow): string {
  if (w.status === 'blocked') return 'Awaiting input';
  if (w.status === 'failed') return 'Run failed';
  if (w.status === 'complete') return w.pr_url ? 'Merged' : 'Complete';
  if (w.status === 'cancelled') return 'Cancelled';
  if (w.status === 'running') return `Running · ${formatWorkflowPhase(w.current_phase)}`;
  return 'Idle';
}

export function ControlRoom({ workflow, agents, onBack, onWorkflowUpdate }: ControlRoomProps) {
  const [tab, setTab] = useState<'milestones' | 'activity' | 'diff'>('milestones');
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [acting, setActing] = useState(false);
  useNowTick(workflow.status === 'running');

  const fetchDetail = useCallback(async (signal?: AbortSignal) => {
    try {
      const [detailRes, jobsRes] = await Promise.all([
        fetch(`/api/autonomous-agent-runs/${workflow.id}`, { signal }),
        fetch(`/api/autonomous-agent-runs/${workflow.id}/jobs`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (detailRes.ok) setDetail(await detailRes.json());
      if (jobsRes.ok) setJobs(await jobsRes.json());
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.error('ControlRoom fetchDetail failed:', err);
    }
  }, [workflow.id]);

  // Single effect drives both initial load (on workflow.id change — clears
  // stale state and refetches) and live refetches (when status/phase/cycle/
  // milestones tick on the workflow). The `lastWorkflowId` ref distinguishes
  // the two so we don't flicker the panel on every status change. An
  // AbortController on each pass cancels the in-flight pair if a newer change
  // races it — fixes the prior double-fetch race.
  const lastWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (lastWorkflowId.current !== workflow.id) {
      setDetail(null);
      setJobs([]);
      lastWorkflowId.current = workflow.id;
    }
    const ac = new AbortController();
    fetchDetail(ac.signal);
    return () => ac.abort();
  }, [
    workflow.id,
    workflow.status,
    workflow.current_phase,
    workflow.current_cycle,
    workflow.milestones_done,
    fetchDetail,
  ]);

  // Esc to go back
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onBack]);

  const milestones = useMemo(() => parsePlanMilestones(detail?.plan ?? null), [detail?.plan]);
  const worklogs = useMemo(() => (detail?.worklogs ?? []).map(parseWorklog), [detail?.worklogs]);

  const totalCost = useMemo(() => {
    return jobs.reduce((sum, job) => {
      const a = agents.find(ag => ag.job_id === job.id);
      return sum + (a?.cost_usd ?? 0);
    }, 0);
  }, [jobs, agents]);
  const totalDuration = useMemo(() => {
    return jobs.reduce((sum, job) => {
      const a = agents.find(ag => ag.job_id === job.id);
      return sum + (a?.duration_ms ?? 0);
    }, 0);
  }, [jobs, agents]);
  const lastActivityTs = useMemo(() => {
    let max = workflow.updated_at;
    for (const j of jobs) {
      const a = agents.find(ag => ag.job_id === j.id);
      const ts = a?.finished_at ?? a?.started_at ?? j.created_at;
      if (ts > max) max = ts;
    }
    return max;
  }, [jobs, agents, workflow.updated_at]);

  const handleCancel = async () => {
    if (!confirm('Cancel this autonomous agent run?')) return;
    setActing(true);
    try {
      const res = await fetch(`/api/autonomous-agent-runs/${workflow.id}/cancel`, { method: 'POST' });
      if (res.ok) {
        onWorkflowUpdate(await res.json());
        onBack();
      } else {
        const data = await res.json().catch(() => ({ error: 'Cancel failed' }));
        alert(data.error || `Cancel failed (HTTP ${res.status}).`);
      }
    } finally { setActing(false); }
  };

  const handleWrapUp = async () => {
    if (!confirm("Wrap up this workflow? This will stop all work and create a draft PR with what's been done so far.")) return;
    setActing(true);
    try {
      const res = await fetch(`/api/autonomous-agent-runs/${workflow.id}/wrap-up`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        onWorkflowUpdate(data.workflow);
        await fetchDetail();
      } else if (res.status === 409) {
        // Recoverable: PR creation failed but the run transitioned to a blocked state.
        const data = await res.json().catch(() => ({}));
        if (data.workflow) onWorkflowUpdate(data.workflow);
        alert(
          data.outcome === 'missing_worktree_with_progress'
            ? 'Draft PR creation failed. The worktree is missing but publishable commits exist — see the blocked reason for details.'
            : 'Draft PR creation failed. The worktree has been preserved — see the blocked reason for details.',
        );
        await fetchDetail();
      } else {
        const data = await res.json().catch(() => ({ error: 'Wrap-up failed' }));
        alert(data.error || `Wrap-up failed (HTTP ${res.status}).`);
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
      } else {
        const data = await res.json().catch(() => ({ error: 'Resume failed' }));
        alert(data.error || `Resume failed (HTTP ${res.status}).`);
      }
    } finally { setActing(false); }
  };

  const badgeTone = STATUS_BADGE_TONE[workflow.status];
  const showPulse = workflow.status === 'running' || workflow.status === 'blocked';

  return (
    <div className="cr">
      <div className="cr-head">
        <button className="back" onClick={onBack} type="button">← Board</button>
        <div className="titleblk">
          <h1>{workflow.title}</h1>
          <div className="crumbs">
            {workflow.work_dir && <span>{workflow.work_dir.split('/').slice(-2).join('/')}</span>}
            {workflow.worktree_branch && (
              <>
                <span className="sep">›</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{workflow.worktree_branch}</span>
              </>
            )}
            <span className="sep">·</span>
            <span>created {fmtRel(workflow.created_at)}</span>
            <span className="sep">·</span>
            <span>last move {fmtRel(lastActivityTs)}</span>
          </div>
        </div>
        <div className="actions">
          {workflow.pr_url && (
            <a href={workflow.pr_url} target="_blank" rel="noopener noreferrer" className="ad-btn-ghost" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
              PR ↗
            </a>
          )}
        </div>
      </div>

      <div className="cr-statline">
        <div className="badge" data-tone={badgeTone}>
          {showPulse && <span className="pulse" />}
          {statusLabel(workflow)}
        </div>
        <div className="stat">cycle <b>{workflow.current_cycle} / {workflow.max_cycles}</b></div>
        <div className="stat">elapsed <b>{fmtDur(totalDuration)}</b></div>
        <div className="stat">cost <b>{fmtCost(totalCost)}</b></div>
        <div className="stat">milestones <b>{workflow.milestones_done} / {workflow.milestones_total}</b></div>
      </div>

      <CycleLadder workflow={workflow} jobs={jobs} />

      <div className="cr-main">
        <div className="cr-tabs">
          <button className={`cr-tab ${tab === 'milestones' ? 'active' : ''}`} onClick={() => setTab('milestones')} type="button">
            Milestones <span className="ct">{workflow.milestones_done}/{workflow.milestones_total}</span>
          </button>
          <button className={`cr-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')} type="button">
            Activity <span className="ct">{jobs.length}</span>
          </button>
          <button className={`cr-tab ${tab === 'diff' ? 'active' : ''}`} onClick={() => setTab('diff')} type="button">
            Diff &amp; PR
          </button>
        </div>
        {tab === 'milestones' && <MilestonesTab workflow={workflow} milestones={milestones} worklogs={worklogs} />}
        {tab === 'activity'   && <ActivityTab   jobs={jobs} agents={agents} worklogs={worklogs} />}
        {tab === 'diff'       && <DiffTab       workflow={workflow} />}
      </div>

      {/* Resolver panel sits outside cr-main so it's not visually nested inside
          any one tab's content. It's intentionally always-visible while the
          workflow has Resolver state — it's a supervisor surface, not a tab. */}
      <ResolverPanel workflow={workflow} />

      <SidePanel
        workflow={workflow}
        totalCost={totalCost}
        totalDuration={totalDuration}
        lastActivityTs={lastActivityTs}
        onResume={handleResume}
        onWrapUp={handleWrapUp}
        onCancel={handleCancel}
        acting={acting}
      />
    </div>
  );
}
