import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Workflow, Job, AgentWithJob, VerifyRun, WorkflowPhase, WorkflowStatus } from '@shared/types';
import { laneFor, toneFor, PHASES, PHASE_SHORT, type LaneTone } from './lanes';

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

interface ParsedMilestone {
  title: string;
  full: string;
}

interface ParsedWorklog {
  cycle: number | null;
  milestone: string | null;
  commits: string[];
  tests: string[];
  blockers: string[];
  nextStep: string | null;
  /** Original `updated_at` from the raw worklog row, preserved so activity entries don't all collapse to `Date.now()`. */
  updatedAt: number;
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

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtRel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3.6e6) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86.4e6) return `${Math.floor(d / 3.6e6)}h ago`;
  return `${Math.floor(d / 86.4e6)}d ago`;
}

function fmtCost(n: number): string { return `$${n.toFixed(2)}`; }

function shortenMilestoneTitle(raw: string): { title: string; full: string } {
  const stripped = raw
    .replace(/^\*\*/, '')
    .replace(/\*\*$/, '')
    .replace(/^`+|`+$/g, '')
    .trim();
  const dashSplit = stripped.split(/\s+[—–-]\s+/);
  const head = dashSplit[0] && dashSplit[0].length < 140 ? dashSplit[0] : stripped;
  let title = head;
  if (title.length > 140) {
    const sentenceMatch = title.match(/^(.{0,140}[.!?])(\s|$)/);
    if (sentenceMatch) title = sentenceMatch[1];
    else title = title.slice(0, 137) + '…';
  }
  title = title.replace(/\*\*/g, '').trim();
  return { title, full: stripped };
}

function parsePlanMilestones(plan: string | null): ParsedMilestone[] {
  if (!plan) return [];
  const lines = plan.split('\n');
  const out: ParsedMilestone[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s*\[([ xX])\]\s+(.+)$/);
    if (m) {
      const { title, full } = shortenMilestoneTitle(m[2]);
      if (title) out.push({ title, full });
    }
  }
  return out;
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n### |\\n## |$)`));
  return match?.[1]?.trim() || null;
}

function extractBullets(text: string, heading: string): string[] {
  const section = extractSection(text, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim());
}

function parseWorklog(entry: { value: string; updated_at: number }): ParsedWorklog {
  const value = entry.value;
  const cycleMatch = value.match(/##\s+Cycle\s+(\d+)/);
  const titleMatch = value.match(/^##\s+Cycle\s+\d+\s+[—–-]\s+(.+)$/m);
  return {
    cycle: cycleMatch ? Number(cycleMatch[1]) : null,
    milestone: titleMatch?.[1]?.trim() ?? null,
    commits: extractBullets(value, '### Commits'),
    tests: extractBullets(value, '### Test results'),
    blockers: extractBullets(value, '### Blockers'),
    nextStep: extractSection(value, '### Next step'),
    updatedAt: entry.updated_at,
  };
}

const PHASE_LABEL: Record<WorkflowPhase, string> = {
  idle: 'Idle',
  assess: 'Assess',
  review: 'Review',
  implement: 'Implement',
  verify: 'Verify',
};

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
  if (w.status === 'running') return `Running · ${PHASE_LABEL[w.current_phase] ?? w.current_phase}`;
  return 'Idle';
}

// ─── Cycle ladder ─────────────────────────────────────────

function CycleLadder({ workflow, jobs }: { workflow: Workflow; jobs: Job[] }) {
  // Build a per-cycle, per-phase status from the jobs list.
  const status = useMemo(() => {
    const map = new Map<number, Record<WorkflowPhase, 'todo' | 'now' | 'done'>>();
    const total = Math.max(workflow.max_cycles, workflow.current_cycle + 1);
    for (let i = 0; i < total; i++) {
      map.set(i, { idle: 'todo', assess: 'todo', review: 'todo', implement: 'todo', verify: 'todo' });
    }
    for (const job of jobs) {
      const c = job.workflow_cycle ?? 0;
      const phase = (job.workflow_phase ?? null) as WorkflowPhase | null;
      if (!phase || !PHASES.includes(phase)) continue;
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

// ─── Milestones tab ───────────────────────────────────────

function MilestonesTab({ workflow, milestones, worklogs }: { workflow: Workflow; milestones: ParsedMilestone[]; worklogs: ParsedWorklog[]; }) {
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
          return (
            <div key={i} className={`stone ${status}`}>
              <div className="stitle">
                <span title={m.full}>{m.title}</span>
                <span className="tag">
                  {status === 'done' ? `Cycle ${Math.min(i + 1, workflow.current_cycle)}` : status === 'active' ? 'In progress' : 'Pending'}
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

// ─── Activity tab ─────────────────────────────────────────

function ActivityTab({ jobs, agents, worklogs }: { jobs: Job[]; agents: AgentWithJob[]; worklogs: ParsedWorklog[] }) {
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

// ─── Diff tab ─────────────────────────────────────────────

function DiffTab({ workflow }: { workflow: Workflow }) {
  return (
    <div className="cr-tab-body">
      <div className="diffcard">
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>
          <span style={{ color: 'var(--ink-3)' }}>branch <b style={{ color: 'var(--ink-2)' }}>{workflow.worktree_branch ?? '—'}</b></span>
          {workflow.pr_url && (
            <a
              href={workflow.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 'auto', color: 'var(--active)', textDecoration: 'none', fontWeight: 600 }}
            >
              Open PR ↗
            </a>
          )}
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '8px 0', textAlign: 'center' }}>
          Diff & file list aren't wired yet for this workflow. Open the PR for the full review.
        </div>
      </div>
    </div>
  );
}

// ─── Side panel ───────────────────────────────────────────

function SidePanel({ workflow, totalCost, totalDuration, lastActivityTs, onResume, onWrapUp, onCancel, acting }: {
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
          <dd><span className="pill">{PHASE_LABEL[workflow.current_phase] ?? workflow.current_phase}</span></dd>
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

// ─── Control Room ─────────────────────────────────────────

export function ControlRoom({ workflow, agents, onBack, onWorkflowUpdate }: ControlRoomProps) {
  const [tab, setTab] = useState<'milestones' | 'activity' | 'diff'>('milestones');
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [acting, setActing] = useState(false);
  useNowTick(workflow.status === 'running');

  const fetchDetail = useCallback(async () => {
    try {
      const [detailRes, jobsRes] = await Promise.all([
        fetch(`/api/autonomous-agent-runs/${workflow.id}`),
        fetch(`/api/autonomous-agent-runs/${workflow.id}/jobs`),
      ]);
      if (detailRes.ok) setDetail(await detailRes.json());
      if (jobsRes.ok) setJobs(await jobsRes.json());
    } catch { /* ignore */ }
  }, [workflow.id]);

  useEffect(() => {
    setDetail(null);
    setJobs([]);
    fetchDetail();
  }, [workflow.id, fetchDetail]);

  useEffect(() => {
    fetchDetail();
  }, [workflow.status, workflow.current_phase, workflow.current_cycle, workflow.milestones_done, fetchDetail]);

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

  const lane = laneFor(workflow);
  const tone = toneFor(lane, workflow.status === 'blocked' || workflow.status === 'failed');
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
        <div style={{ marginLeft: 'auto', color: 'var(--ink-3)' }}>
          tone <b style={{ color: tone === 'active' ? 'var(--active)' : tone === 'attn' ? 'var(--attn-2)' : tone === 'pr' ? '#6e1f96' : 'var(--ink-2)' }}>{tone}</b>
        </div>
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
