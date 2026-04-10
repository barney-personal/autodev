import type { AgentWithJob } from '@shared/types';
import type { Project } from '@shared/types';

interface Props {
  agents: AgentWithJob[];
  projects: Project[];
  onSelectAgent: (agent: AgentWithJob) => void;
  ptyIdleAgentIds?: Set<string>;
}

const STATUS_DOT_COLOR: Partial<Record<string, string>> = {
  starting:     '#f59e0b',
  running:      '#f59e0b',
  waiting_user: '#ef4444',
};

export function RunningJobsPanel({ agents, projects, onSelectAgent, ptyIdleAgentIds }: Props) {
  const projectMap = new Map(projects.map(p => [p.id, p.name]));

  const activeAgents = agents.filter(
    a => a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user',
  );

  return (
    <div className="running-jobs-panel">
      <div className="running-jobs-header">
        <span className="sidebar-title" style={{ margin: 0 }}>All Running</span>
        {activeAgents.length > 0 && (
          <span className="running-jobs-count">{activeAgents.length}</span>
        )}
      </div>
      {activeAgents.length === 0 ? (
        <p className="sidebar-empty">No active jobs</p>
      ) : (
        <div className="running-jobs-list">
          {activeAgents.map(agent => {
            const projectName = agent.job.project_id ? projectMap.get(agent.job.project_id) : null;
            const isIdle = ptyIdleAgentIds?.has(agent.id) && agent.status === 'running';
            const dotColor = isIdle ? '#3b82f6' : (STATUS_DOT_COLOR[agent.status] ?? '#6e7681');
            return (
              <div
                key={agent.id}
                className="running-job-item"
                onClick={() => onSelectAgent(agent)}
              >
                <span className="running-job-dot" style={{ background: dotColor }} />
                <span className="running-job-title">{agent.job.title}</span>
                {projectName && (
                  <span className="running-job-project">{projectName}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
