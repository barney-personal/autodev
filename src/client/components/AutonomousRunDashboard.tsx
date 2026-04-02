import React from 'react';
import type { AgentWithJob, Workflow, Job } from '@shared/types';

const ACTIVE_JOB_STATUSES = new Set(['assigned', 'running']);
const ACTIVE_AGENT_STATUSES = new Set(['starting', 'running', 'waiting_user']);

type RunDisplayState =
  | 'blocked'
  | 'active'
  | 'queued'
  | 'waiting'
  | 'complete'
  | 'failed'
  | 'cancelled';

interface Props {
  workflows: Workflow[];
  jobs: Job[];
  agents: AgentWithJob[];
  now: number;
  onSelectWorkflow: (workflow: Workflow) => void;
}

interface RunViewModel {
  workflow: Workflow;
  displayState: RunDisplayState;
  stateLabel: string;
  statusDetail: string;
  latestLabel: string;
  activeJobCount: number;
  queuedJobCount: number;
  relatedJobCount: number;
  activeAgentCount: number;
  elapsedMs: number;
}

const STATE_META: Record<RunDisplayState, { label: string; tone: string }> = {
  blocked: { label: 'Blocked', tone: 'blocked' },
  active: { label: 'Active', tone: 'active' },
  queued: { label: 'Queued', tone: 'queued' },
  waiting: { label: 'Waiting', tone: 'waiting' },
  complete: { label: 'Complete', tone: 'complete' },
  failed: { label: 'Failed', tone: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'cancelled' },
};

function formatElapsed(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function phaseLabel(phase: string | null | undefined): string {
  if (!phase || phase === 'idle') return 'Idle';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function modelLabel(model: string | null | undefined): string {
  return model ?? 'auto';
}

function buildRunViewModel(workflow: Workflow, jobs: Job[], agents: AgentWithJob[], now: number): RunViewModel {
  const relatedJobs = jobs
    .filter(job => job.workflow_id === workflow.id)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

  const relatedAgents = agents
    .filter(agent => agent.job.workflow_id === workflow.id)
    .sort((a, b) => b.started_at - a.started_at);

  const activeJobs = relatedJobs.filter(job => ACTIVE_JOB_STATUSES.has(job.status));
  const queuedJobs = relatedJobs.filter(job => job.status === 'queued');
  const activeAgents = relatedAgents.filter(agent => ACTIVE_AGENT_STATUSES.has(agent.status));
  const focusJob = activeJobs[0] ?? queuedJobs[0] ?? relatedJobs[0] ?? null;

  let displayState: RunDisplayState;
  if (workflow.status === 'blocked') displayState = 'blocked';
  else if (workflow.status === 'complete') displayState = 'complete';
  else if (workflow.status === 'failed') displayState = 'failed';
  else if (workflow.status === 'cancelled') displayState = 'cancelled';
  else if (activeJobs.length > 0 || activeAgents.length > 0) displayState = 'active';
  else if (queuedJobs.length > 0) displayState = 'queued';
  else displayState = 'waiting';

  const stateLabel = STATE_META[displayState].label;
  const statusDetail = workflow.blocked_reason
    ? workflow.blocked_reason
    : focusJob
      ? `${phaseLabel(focusJob.workflow_phase)} ${focusJob.status} on ${modelLabel(focusJob.model)}`
      : `${phaseLabel(workflow.current_phase)} cycle ${workflow.current_cycle}`;

  const latestLabel = focusJob
    ? `${phaseLabel(focusJob.workflow_phase)} · C${focusJob.workflow_cycle ?? workflow.current_cycle} · ${focusJob.status}`
    : `${phaseLabel(workflow.current_phase)} · C${workflow.current_cycle}`;

  const elapsedMs = (workflow.status === 'running' ? now : workflow.updated_at) - workflow.created_at;

  return {
    workflow,
    displayState,
    stateLabel,
    statusDetail,
    latestLabel,
    activeJobCount: activeJobs.length,
    queuedJobCount: queuedJobs.length,
    relatedJobCount: relatedJobs.length,
    activeAgentCount: activeAgents.length,
    elapsedMs,
  };
}

function Section({
  title,
  subtitle,
  runs,
  onSelectWorkflow,
}: {
  title: string;
  subtitle: string;
  runs: RunViewModel[];
  onSelectWorkflow: (workflow: Workflow) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <section className="run-section">
      <div className="run-section-header">
        <div>
          <h2 className="run-section-title">{title}</h2>
          <p className="run-section-subtitle">{subtitle}</p>
        </div>
        <span className="run-section-count">{runs.length}</span>
      </div>
      <div className="run-card-grid">
        {runs.map(({ workflow, displayState, stateLabel, statusDetail, latestLabel, activeJobCount, queuedJobCount, relatedJobCount, activeAgentCount, elapsedMs }) => (
          <div
            key={workflow.id}
            className={`run-card run-card-${STATE_META[displayState].tone}`}
            onClick={() => onSelectWorkflow(workflow)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectWorkflow(workflow);
              }
            }}
          >
            <div className="run-card-top">
              <span className={`run-state-badge run-state-${STATE_META[displayState].tone}`}>{stateLabel}</span>
              <span className="run-card-cycle">C{workflow.current_cycle}/{workflow.max_cycles}</span>
            </div>
            <div className="run-card-title">{workflow.title}</div>
            <div className="run-card-phase">{latestLabel}</div>
            <div className="run-card-detail">{statusDetail}</div>
            <div className="run-card-progress">
              <div className="run-card-progress-track">
                <div
                  className="run-card-progress-fill"
                  style={{
                    width: `${workflow.milestones_total > 0 ? Math.round((workflow.milestones_done / workflow.milestones_total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="run-card-progress-label">
                {workflow.milestones_done}/{workflow.milestones_total || 0} milestones
              </span>
            </div>
            <div className="run-card-stats">
              <span>{activeJobCount} active</span>
              <span>{queuedJobCount} queued</span>
              <span>{activeAgentCount} agents</span>
              <span>{relatedJobCount} jobs</span>
              <span>{formatElapsed(elapsedMs)}</span>
            </div>
            {workflow.pr_url && (
              <a
                href={workflow.pr_url}
                target="_blank"
                rel="noreferrer"
                className="run-card-pr"
                onClick={e => e.stopPropagation()}
              >
                Open PR
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function AutonomousRunDashboard({ workflows, jobs, agents, now, onSelectWorkflow }: Props) {
  const runViewModels = React.useMemo(
    () => workflows.map(workflow => buildRunViewModel(workflow, jobs, agents, now)),
    [workflows, jobs, agents, now],
  );

  const attentionRuns = runViewModels.filter(run => run.displayState === 'blocked' || run.displayState === 'failed');
  const inProgressRuns = runViewModels.filter(run => run.displayState === 'active');
  const queuedRuns = runViewModels.filter(run => run.displayState === 'queued' || run.displayState === 'waiting');
  const completedRuns = runViewModels.filter(run => run.displayState === 'complete' || run.displayState === 'cancelled');

  const runningCount = runViewModels.filter(run => run.workflow.status === 'running').length;
  const blockedCount = runViewModels.filter(run => run.workflow.status === 'blocked').length;
  const queuedCount = queuedRuns.length;
  const activeJobCount = runViewModels.reduce((sum, run) => sum + run.activeJobCount, 0);
  const queuedJobCount = runViewModels.reduce((sum, run) => sum + run.queuedJobCount, 0);

  return (
    <div className="autonomous-run-dashboard">
      <section className="run-overview-strip">
        <div className="run-overview-card">
          <span className="run-overview-label">Runs Running</span>
          <span className="run-overview-value">{runningCount}</span>
        </div>
        <div className="run-overview-card">
          <span className="run-overview-label">Needs Attention</span>
          <span className="run-overview-value">{blockedCount}</span>
        </div>
        <div className="run-overview-card">
          <span className="run-overview-label">Waiting</span>
          <span className="run-overview-value">{queuedCount}</span>
        </div>
        <div className="run-overview-card">
          <span className="run-overview-label">Active Child Jobs</span>
          <span className="run-overview-value">{activeJobCount}</span>
        </div>
        <div className="run-overview-card">
          <span className="run-overview-label">Queued Child Jobs</span>
          <span className="run-overview-value">{queuedJobCount}</span>
        </div>
      </section>

      {runViewModels.length === 0 ? (
        <div className="run-dashboard-empty">
          <p>No autonomous runs in this view yet.</p>
        </div>
      ) : (
        <>
          <Section
            title="Needs Attention"
            subtitle="Blocked or failed runs that need intervention."
            runs={attentionRuns}
            onSelectWorkflow={onSelectWorkflow}
          />
          <Section
            title="In Progress"
            subtitle="Runs with active assess, review, or implement work."
            runs={inProgressRuns}
            onSelectWorkflow={onSelectWorkflow}
          />
          <Section
            title="Waiting"
            subtitle="Runs that are queued, cooling down, or between phases."
            runs={queuedRuns}
            onSelectWorkflow={onSelectWorkflow}
          />
          <Section
            title="Recently Finished"
            subtitle="Completed or cancelled runs in this project view."
            runs={completedRuns.slice(0, 6)}
            onSelectWorkflow={onSelectWorkflow}
          />
        </>
      )}
    </div>
  );
}
