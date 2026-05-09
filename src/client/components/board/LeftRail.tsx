import { useState } from 'react';
import type { Workflow } from '@shared/types';
import type { RepoGroup } from './lanes';

interface LeftRailProps {
  repoGroups: RepoGroup[];
  activeRepo: string | null;
  onSelectRepo: (repo: string | null) => void;
  onSelectWorkflow: (w: Workflow) => void;
  liveCount: number;
  looseJobsCount: number;
  fileLocksCount: number;
  totalWorkflowCount: number;
  onUsage?: () => void;
  onMemory?: () => void;
  onProjects?: () => void;
  onLooseJobs?: () => void;
}

const FOLDER_DEFAULT_LIMIT = 5;

function fmtRel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3.6e6) return `${Math.floor(d / 60_000)}m`;
  if (d < 86.4e6) return `${Math.floor(d / 3.6e6)}h`;
  if (d < 86.4e6 * 7) return `${Math.floor(d / 86.4e6)}d`;
  return `${Math.floor(d / 86.4e6 / 7)}w`;
}

export function LeftRail({
  repoGroups,
  activeRepo,
  onSelectRepo,
  onSelectWorkflow,
  liveCount,
  looseJobsCount,
  fileLocksCount,
  totalWorkflowCount,
  onUsage,
  onMemory,
  onProjects,
  onLooseJobs,
}: LeftRailProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <nav className="rail">
      <div className="rail-section">
        <div className="rail-label">Workspace</div>
        <div className="rail-item active" aria-current="page">
          <span className="ico">▦</span>
          <span>Board</span>
          <span className="count">{liveCount} live</span>
        </div>
        <button className="rail-item" onClick={onProjects} type="button">
          <span className="ico">◆</span>
          <span>Projects</span>
        </button>
        <button className="rail-item" onClick={onUsage} type="button">
          <span className="ico">$</span>
          <span>Usage</span>
        </button>
      </div>

      <div className="rail-section">
        <div className="rail-label">Repos</div>
        <button
          className={`rail-item ${activeRepo == null ? 'active' : ''}`}
          onClick={() => onSelectRepo(null)}
          type="button"
        >
          <span className="ico" style={{ opacity: 0.4 }}>◇</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>All repos</span>
          <span className="count">{totalWorkflowCount}</span>
        </button>

        {repoGroups.map(group => {
          const isActive = activeRepo === group.repo;
          const isExpanded = expanded[group.repo] ?? false;
          const visible = isExpanded ? group.items : group.items.slice(0, FOLDER_DEFAULT_LIMIT);
          const hidden = group.items.length - visible.length;

          return (
            <div key={group.repo} className="rail-group">
              <button
                className={`rail-folder ${isActive ? 'active' : ''}`}
                onClick={() => onSelectRepo(isActive ? null : group.repo)}
                type="button"
                title={`Filter to ${group.repo}`}
              >
                <span className="ico folder" aria-hidden>
                  <FolderIcon />
                </span>
                <span className="name">{group.repo}</span>
                <span className="count">{group.items.length}</span>
              </button>
              {visible.map(w => (
                <button
                  key={w.id}
                  className="rail-subitem"
                  onClick={() => onSelectWorkflow(w)}
                  type="button"
                  title={w.title}
                >
                  <span className="title">{w.title}</span>
                  <span className="when">{fmtRel(w.updated_at)}</span>
                </button>
              ))}
              {hidden > 0 && (
                <button
                  className="rail-subitem rail-show-more"
                  onClick={() => setExpanded(prev => ({ ...prev, [group.repo]: true }))}
                  type="button"
                >
                  Show {hidden} more
                </button>
              )}
              {isExpanded && group.items.length > FOLDER_DEFAULT_LIMIT && (
                <button
                  className="rail-subitem rail-show-more"
                  onClick={() => setExpanded(prev => ({ ...prev, [group.repo]: false }))}
                  type="button"
                >
                  Show less
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="rail-section" style={{ marginTop: 'auto' }}>
        <div className="rail-label">Activity</div>
        <button className="rail-item" onClick={onLooseJobs} type="button">
          <span className="ico">⌖</span>
          <span>Loose jobs</span>
          <span className="count">{looseJobsCount}</span>
        </button>
        <div className="rail-item rail-item-static" aria-label={`${fileLocksCount} file locks`}>
          <span className="ico">⊙</span>
          <span>File locks</span>
          <span className="count">{fileLocksCount}</span>
        </div>
        <button className="rail-item" onClick={onMemory} type="button">
          <span className="ico">⚿</span>
          <span>Memory</span>
        </button>
      </div>
    </nav>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.75 4.5C1.75 3.81 2.31 3.25 3 3.25h3.07c.27 0 .53.1.74.27l1.04.83c.21.17.47.27.74.27h3.62c.69 0 1.25.56 1.25 1.25v6.13c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
