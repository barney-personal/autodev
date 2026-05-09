import type { Workflow, WorkflowPhase } from '@shared/types';

export type LaneId = 'triage' | 'flight' | 'attn' | 'pr' | 'done';
export type LaneTone = 'idle' | 'active' | 'attn' | 'pr' | 'done';

export interface LaneDef {
  id: LaneId;
  label: string;
  tone: LaneTone;
  emptyText: string;
}

export const LANES: LaneDef[] = [
  { id: 'triage', label: 'Triage',    tone: 'idle',   emptyText: 'No queued tasks' },
  { id: 'flight', label: 'In Flight', tone: 'active', emptyText: 'No active runs' },
  { id: 'attn',   label: 'Needs You', tone: 'attn',   emptyText: 'Nothing waiting on you' },
  { id: 'pr',     label: 'In Review', tone: 'pr',     emptyText: 'No PRs open' },
  { id: 'done',   label: 'Done',      tone: 'done',   emptyText: 'No completions' },
];

export const PHASES: WorkflowPhase[] = ['assess', 'review', 'implement', 'verify'];
export const PHASE_SHORT: Record<WorkflowPhase, string> = {
  idle: '·',
  assess: 'A',
  review: 'R',
  implement: 'I',
  verify: 'V',
};


/** Classify a workflow into one of the five board lanes. */
export function laneFor(w: Workflow): LaneId {
  if (w.status === 'blocked' || w.status === 'failed') return 'attn';
  if (w.status === 'complete') {
    return w.pr_url ? 'pr' : 'done';
  }
  if (w.status === 'cancelled') return 'done';
  if (w.status === 'running' && w.pr_url) return 'pr';
  if (
    w.status === 'running' &&
    w.current_cycle === 0 &&
    w.milestones_total === 0 &&
    (w.current_phase === 'idle' || w.current_phase === 'assess')
  ) return 'triage';
  return 'flight';
}

/** Tone for the card status indicator (dot + accent tint). */
export function toneFor(lane: LaneId, blocked: boolean): LaneTone {
  if (blocked) return 'attn';
  if (lane === 'flight') return 'active';
  if (lane === 'attn') return 'attn';
  if (lane === 'pr') return 'pr';
  if (lane === 'done') return 'done';
  return 'idle';
}

/** Per-lane visibility hook (kept for future per-lane filters; currently a no-op). */
export function isLaneVisible(_w: Workflow, _lane: LaneId, _now: number): boolean {
  return true;
}

/** Derive a short repo name from the workflow's work_dir. */
export function repoFor(w: Workflow): string {
  if (!w.work_dir) return 'unknown';
  const parts = w.work_dir.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

export interface RepoGroup {
  repo: string;
  items: Workflow[];
  /** Most recent updated_at across items, for sorting groups. */
  latest: number;
}

/** Group workflows by repo (work_dir basename). Sorted by recency. */
export function buildRepoTree(workflows: Workflow[]): RepoGroup[] {
  const map = new Map<string, Workflow[]>();
  for (const w of workflows) {
    const repo = repoFor(w);
    const bucket = map.get(repo);
    if (bucket) bucket.push(w);
    else map.set(repo, [w]);
  }
  return [...map.entries()]
    .map(([repo, items]) => {
      const sorted = [...items].sort((a, b) => b.updated_at - a.updated_at);
      return { repo, items: sorted, latest: sorted[0]?.updated_at ?? 0 };
    })
    .sort((a, b) => b.latest - a.latest);
}
