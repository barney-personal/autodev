import { memo } from 'react';
import type { Workflow, AgentWithJob, WorkflowPhase } from '@shared/types';
import { laneFor, toneFor, PHASES, type LaneTone } from './lanes';

const MODEL_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-7':         [15, 75],
  'claude-opus-4-7[1m]':     [15, 75],
  'claude-opus-4-6':         [15, 75],
  'claude-opus-4-6[1m]':     [15, 75],
  'claude-sonnet-4-6':       [3, 15],
  'claude-sonnet-4-6[1m]':   [3, 15],
  'claude-haiku-4-5-20251001': [0.80, 4],
};

function estimateCost(model: string | null, inputTokens: number, outputTokens: number): number {
  const [inp, out] = (model && MODEL_PRICING[model]) || [3, 15];
  return (inputTokens / 1_000_000) * inp + (outputTokens / 1_000_000) * out;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return '0s';
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

function shortBlockedReason(reason: string | null): string {
  if (!reason) return 'Awaiting input';
  const trimmed = reason.trim();
  const lower = trimmed.toLowerCase();
  if (lower.includes('test') && (lower.includes('fail') || lower.includes('error'))) return 'Tests failing — input needed';
  if (lower.includes('await') || lower.includes('reply')) return 'Awaiting reply';
  if (lower.includes('max cycles')) return 'Max cycles reached — review needed';
  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
}

interface MilestoneStub {
  status: 'done' | 'active' | 'todo';
  title: string;
}

function buildMilestoneStubs(done: number, total: number, isRunning: boolean): MilestoneStub[] {
  if (total === 0) return [];
  const items: MilestoneStub[] = [];
  for (let i = 0; i < total; i++) {
    if (i < done) items.push({ status: 'done', title: `Milestone ${i + 1}` });
    else if (i === done && isRunning) items.push({ status: 'active', title: `Milestone ${i + 1}` });
    else items.push({ status: 'todo', title: `Milestone ${i + 1}` });
  }
  return items;
}

interface WorkflowCardProps {
  workflow: Workflow;
  workflowAgents: AgentWithJob[];
  selected?: boolean;
  now: number;
  density?: 'comfortable' | 'compact';
  /** When provided, used as the milestone titles in the preview (parsed from plan). */
  milestoneTitles?: string[];
  onClick: () => void;
}

function WorkflowCardInner({ workflow, workflowAgents, selected, now, density = 'comfortable', milestoneTitles, onClick }: WorkflowCardProps) {
  const lane = laneFor(workflow);
  const isBlocked = workflow.status === 'blocked' || workflow.status === 'failed';
  const tone: LaneTone = toneFor(lane, isBlocked);
  const isTriage = lane === 'triage';
  const compact = density === 'compact';
  const isRunning = workflow.status === 'running';

  // Milestones: use parsed titles if provided, otherwise stubs by count
  const stones: MilestoneStub[] = milestoneTitles && milestoneTitles.length > 0
    ? milestoneTitles.map((title, i) => ({
        status: i < workflow.milestones_done ? 'done' : (i === workflow.milestones_done && isRunning ? 'active' : 'todo'),
        title,
      }))
    : buildMilestoneStubs(workflow.milestones_done, workflow.milestones_total, isRunning);

  // Visible window: prev done + active + next 1 (or last 2 if all done)
  const activeIdx = stones.findIndex(m => m.status !== 'done');
  let visible: Array<{ idx: number; m: MilestoneStub }> = [];
  if (activeIdx >= 0) {
    if (activeIdx > 0) visible.push({ idx: activeIdx - 1, m: stones[activeIdx - 1] });
    visible.push({ idx: activeIdx, m: stones[activeIdx] });
    if (activeIdx + 1 < stones.length) visible.push({ idx: activeIdx + 1, m: stones[activeIdx + 1] });
  } else if (stones.length > 0) {
    const start = Math.max(0, stones.length - 2);
    for (let i = start; i < stones.length; i++) visible.push({ idx: i, m: stones[i] });
  }

  // Cost rollup
  let totalCost = 0;
  let hasFinalCost = false;
  for (const agent of workflowAgents) {
    if (agent.cost_usd != null) { totalCost += agent.cost_usd; hasFinalCost = true; }
    else if (agent.estimated_input_tokens || agent.estimated_output_tokens) {
      totalCost += estimateCost(agent.job?.model ?? null, agent.estimated_input_tokens ?? 0, agent.estimated_output_tokens ?? 0);
    }
  }
  const costStr = totalCost > 0
    ? (hasFinalCost ? fmtCost(totalCost) : `~${fmtCost(totalCost)}`)
    : '—';

  const wallElapsed = isRunning ? now - workflow.created_at : (workflow.updated_at - workflow.created_at);

  // PR badge classification
  const prClass: '' | 'merged' | 'changes' = workflow.status === 'complete' && workflow.pr_url
    ? 'merged'
    : workflow.status === 'failed' && workflow.pr_url
      ? 'changes'
      : '';
  const prLabel: string = workflow.pr_url
    ? (workflow.status === 'complete' ? '✓ merged' : workflow.status === 'failed' ? '⟲ changes' : 'open')
    : '';
  const prNumMatch = workflow.pr_url?.match(/\/(\d+)(?:\/?$|\?)/) ?? workflow.pr_url?.match(/(\d+)$/);
  const prNum = prNumMatch ? prNumMatch[1] : '';

  const phase: WorkflowPhase = workflow.current_phase;

  return (
    <button
      type="button"
      className={`wcard${compact ? ' compact' : ''}${isTriage ? ' triage' : ''}`}
      data-tone={tone}
      onClick={onClick}
      style={selected ? { boxShadow: 'var(--shadow-focus-accent), var(--shadow-card-hover)', borderColor: 'transparent' } : undefined}
      aria-label={`Workflow ${workflow.title}, ${lane}`}
    >
      <div className="wc-head">
        <div className="wc-title">{workflow.title}</div>
        {!isTriage && <span className="wc-cycle">C{workflow.current_cycle}/{workflow.max_cycles}</span>}
      </div>

      {isBlocked && (
        <div className="wc-banner">
          <span className="dot" />
          {shortBlockedReason(workflow.blocked_reason)}
        </div>
      )}

      {!isTriage && phase !== 'idle' && (
        <div className="wc-phase" data-tone={tone}>
          {PHASES.map(p => {
            const idx = PHASES.indexOf(p);
            const cur = PHASES.indexOf(phase);
            const cls = isRunning && idx < cur ? 'done' : (isRunning && idx === cur ? 'now' : '');
            return <span key={p} className={`step ${cls}`} title={p} />;
          })}
        </div>
      )}

      {!compact && !isTriage && stones.length > 0 && (
        <div className="wc-stones">
          {visible.map(({ idx, m }) => (
            <div key={idx} className={`wc-stone ${m.status}`} data-tone={tone}>
              <span className="check" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
            </div>
          ))}
          {workflow.milestones_total > 0 && (
            <div className="wc-stone-more">
              {workflow.milestones_done}/{workflow.milestones_total} milestones · {Math.round(workflow.milestones_done / workflow.milestones_total * 100)}% complete
            </div>
          )}
        </div>
      )}

      <div className="wc-foot">
        {isTriage ? (
          <>
            <span className="meta-tag">queued</span>
            <span className="right">{fmtRel(workflow.created_at)}</span>
          </>
        ) : (
          <>
            <span title="elapsed">⏱ {fmtDur(wallElapsed)}</span>
            <span className="sep">·</span>
            <span title="cost">{costStr}</span>
            <span className="sep">·</span>
            <span title="jobs">{workflowAgents.length} jobs</span>
            <span className="right">
              {workflow.pr_url ? (
                <span className={`pr ${prClass}`}>
                  {prNum ? `#${prNum} ` : ''}{prLabel}
                </span>
              ) : fmtRel(workflow.updated_at)}
            </span>
          </>
        )}
      </div>
    </button>
  );
}

export const WorkflowCard = memo(WorkflowCardInner);
