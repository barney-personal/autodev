import React, { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import socket from '../socket';
import { QuestionBubble } from './QuestionBubble';
import { DiffViewer } from './DiffViewer';
import { RetryButton, CancelButton, ContinueInput } from './AgentActions';
import { WatcherPanel } from './WatcherPanel';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';
import type { AgentWithJob, ChildAgentSummary } from '@shared/types';

interface AgentTerminalProps {
  agent: AgentWithJob;
  onClose: () => void;
  onContinued?: (newAgent: AgentWithJob) => void;
  onRenameJob?: (jobId: string, newTitle: string) => void;
}

export function AgentTerminal({ agent, onClose, onContinued, onRenameJob }: AgentTerminalProps) {
  const viewStartRef = useRef<number>(Date.now());
  const [childAgents, setChildAgents] = useState<ChildAgentSummary[]>(agent.child_agents ?? []);
  const [activeTab, setActiveTab] = useState<'output' | 'changes' | 'watcher'>('output');
  const [diff, setDiff] = useState<string | null>(agent.diff ?? null);
  const [baseSha, setBaseSha] = useState<string | null>(agent.base_sha ?? null);
  const [diffFetched, setDiffFetched] = useState(false);
  const [fullDescription, setFullDescription] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const isInteractive = !!agent.job.is_interactive;
  const [tmuxCopied, setTmuxCopied] = useState(false);

  // Delegate all xterm.js lifecycle to the useTerminal hook
  const { containerRef, isTruncated, ptySnapshotMode, loadFullHistory, jumpToLive } = useTerminal(
    agent.id,
    agent.status,
    isInteractive,
  );

  const startTitleEdit = () => {
    setTitleDraft(agent.job.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitTitleEdit = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== agent.job.title) {
      onRenameJob?.(agent.job.id, trimmed);
    }
    setEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitTitleEdit();
    if (e.key === 'Escape') setEditingTitle(false);
  };

  const copyTmuxCommand = () => {
    const cmd = `tmux attach-session -t orchestrator-${agent.id}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setTmuxCopied(true);
      setTimeout(() => setTmuxCopied(false), 2000);
    });
  };

  // Reset per-agent state when switching agents
  useEffect(() => {
    viewStartRef.current = Date.now();
    setChildAgents(agent.child_agents ?? []);
    setActiveTab('output');
    setDiff(agent.diff ?? null);
    setBaseSha(agent.base_sha ?? null);
    setDiffFetched(false);
    setFullDescription(null);
  }, [agent.id]);

  // Fetch full description if it was truncated in the snapshot
  useEffect(() => {
    if (!agent.job.description?.endsWith('\u2026')) return;
    fetch(`/api/agents/${agent.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.job?.description) setFullDescription(data.job.description); })
      .catch(() => {});
  }, [agent.id, agent.job.description]);

  // Keep child agents up-to-date via socket events
  useEffect(() => {
    const newHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      if (a.parent_agent_id === agent.id) {
        setChildAgents(prev => {
          if (prev.some(c => c.id === a.id)) return prev;
          return [...prev, { id: a.id, status: a.status, job_title: a.job.title, job_description: a.job.description }];
        });
      }
    };
    const updateHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      setChildAgents(prev => prev.map(c => c.id === a.id ? { ...c, status: a.status } : c));
    };
    socket.on('agent:new', newHandler);
    socket.on('agent:update', updateHandler);
    return () => {
      socket.off('agent:new', newHandler);
      socket.off('agent:update', updateHandler);
    };
  }, [agent.id]);

  // Mark as read after terminal state + 2s delay
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status) || agent.output_read !== 0) return;
    const delay = Math.max(0, 2000 - (Date.now() - viewStartRef.current));
    const timer = setTimeout(() => {
      fetch(`/api/agents/${agent.id}/read`, { method: 'POST' }).catch(console.error);
    }, delay);
    return () => clearTimeout(timer);
  }, [agent.id, agent.status, agent.output_read]);

  // Fetch diff when agent completes
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status)) return;
    if (diffFetched) return;
    setDiffFetched(true);
    fetch(`/api/agents/${agent.id}/diff`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setBaseSha(d.base_sha ?? null);
        setDiff(d.diff ?? null);
      })
      .catch(() => {});
  }, [agent.id, agent.status]);

  const contextEntries: [string, string][] = (() => {
    try {
      const parsed = agent.job.context ? JSON.parse(agent.job.context) : null;
      return parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
    } catch { return []; }
  })();

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-header-info">
          <span className="terminal-agent-id">Agent {agent.id.slice(0, 6)}</span>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="terminal-job-title-input"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={handleTitleKeyDown}
            />
          ) : (
            <span className="terminal-job-title">
              {agent.job.title}
              <button className="btn-icon rename-title-btn" title="Rename job" onClick={startTitleEdit}>
                ✎
              </button>
            </span>
          )}
        </div>
        <div className="terminal-header-actions">
          <button
            className="btn btn-sm"
            onClick={copyTmuxCommand}
            title={`tmux attach-session -t orchestrator-${agent.id}`}
          >
            {tmuxCopied ? 'Copied!' : 'Copy tmux'}
          </button>
          {isInteractive && (agent.status === 'running' || agent.status === 'starting') && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => fetch(`/api/agents/${agent.id}/disconnect`, { method: 'DELETE' })}
            >
              Disconnect
            </button>
          )}
          {isInteractive && agent.status === 'failed' && (
            <button
              className="btn btn-sm"
              onClick={() => fetch(`/api/agents/${agent.id}/reconnect`, { method: 'POST' })}
              title="Re-attach to the tmux session if it is still alive"
            >
              Reconnect
            </button>
          )}
          {!isInteractive && ['starting', 'running', 'waiting_user'].includes(agent.status) && (
            <CancelButton agentId={agent.id} onCancelled={onClose} />
          )}
          <button
            className={`flag-btn${agent.job.flagged ? ' flag-btn-active' : ''}`}
            onClick={() => fetch(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' })}
            title={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
            aria-label={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
            aria-pressed={!!agent.job.flagged}
            style={{ fontSize: '16px' }}
          >
            ⚑
          </button>
          <button className="btn-icon" onClick={onClose} aria-label="Close terminal panel">✕</button>
        </div>
      </div>

      <div className="job-request-section">
        <div className="job-request-header">
          <div className="job-request-label">Request</div>
          {agent.job.model && (
            <span className="agent-stat agent-stat-model" title={agent.job.model}>
              {agent.job.model.replace('claude-', '')}
            </span>
          )}
        </div>
        <div className="job-request-description">{fullDescription ?? agent.job.description}</div>
        {(agent.cost_usd != null || agent.duration_ms != null || agent.num_turns != null) && (
          <div className="agent-run-stats">
            {agent.cost_usd != null && (
              <span className="agent-stat" title="Total cost">
                💰 ${agent.cost_usd.toFixed(4)}
              </span>
            )}
            {agent.duration_ms != null && (
              <span className="agent-stat" title="Runtime">
                ⏱ {agent.duration_ms >= 60000
                  ? `${Math.floor(agent.duration_ms / 60000)}m ${Math.round((agent.duration_ms % 60000) / 1000)}s`
                  : `${(agent.duration_ms / 1000).toFixed(1)}s`}
              </span>
            )}
            {agent.num_turns != null && (
              <span className="agent-stat" title="Number of turns">
                ↩ {agent.num_turns} turns
              </span>
            )}
          </div>
        )}
        {contextEntries.length > 0 && (
          <div className="job-request-context">
            {contextEntries.map(([k, v]) => (
              <div key={k} className="job-context-row">
                <span className="job-context-key">{k}:</span>
                <span className="job-context-value">{v}</span>
              </div>
            ))}
          </div>
        )}
        {childAgents.length > 0 && (
          <div className="job-followups">
            <div className="job-followups-label">Follow-ups</div>
            {childAgents.map(child => (
              <button
                key={child.id}
                className="followup-link"
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/agents/${child.id}`);
                    if (res.ok && onContinued) onContinued(await res.json());
                  } catch (err) {
                    console.error('Failed to load child agent:', err);
                  }
                }}
              >
                <span className={`followup-status-dot followup-status-${child.status}`} />
                <span className="followup-description">{child.job_description}</span>
                <span className="followup-id">{child.id.slice(0, 6)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {agent.pending_question && agent.status === 'waiting_user' && (
        <QuestionBubble question={agent.pending_question} />
      )}

      <div className="terminal-tabs">
        <button
          className={`terminal-tab${activeTab === 'output' ? ' terminal-tab-active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>
        {(['done', 'failed', 'cancelled'].includes(agent.status)) && (
          <button
            className={`terminal-tab${activeTab === 'changes' ? ' terminal-tab-active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            Changes{diff ? ` (${diff.split('\n').filter(l => l.startsWith('+')).length - diff.split('\n').filter(l => l.startsWith('--- ')).length}+)` : ''}
          </button>
        )}
        <WatcherTabButton agentId={agent.id} active={activeTab === 'watcher'} onClick={() => setActiveTab('watcher')} />
      </div>

      {isTruncated && activeTab === 'output' && (
        <div className="output-truncated-bar">
          <span>Showing last 5000 lines.</span>
          <button className="btn btn-sm" onClick={loadFullHistory}>Load full history</button>
        </div>
      )}
      {ptySnapshotMode && activeTab === 'output' && (
        <div className="output-truncated-bar">
          <span>Viewing history snapshot — scroll to bottom to resume live</span>
          <button className="btn btn-sm btn-primary" onClick={jumpToLive}>Jump to live</button>
        </div>
      )}
      <div ref={containerRef} className={`xterm-container${activeTab !== 'output' ? ' xterm-hidden' : ''}`} />

      {activeTab === 'changes' && (
        <div className="diff-panel">
          {diff
            ? <DiffViewer diff={diff} />
            : baseSha
              ? <div className="diff-empty">No file changes detected.</div>
              : <div className="diff-empty">No changes captured — the working directory is not a git repository.<br />Initialize git in the work directory to enable diff tracking.</div>
          }
        </div>
      )}

      {activeTab === 'watcher' && (
        <WatcherPanel agentId={agent.id} agentStatus={agent.status} />
      )}

      {agent.status === 'failed' && agent.error_message && (
        <div className="agent-error-banner">
          <div className="agent-error-label">Error output</div>
          <pre className="agent-error-text">{agent.error_message}</pre>
        </div>
      )}

      {agent.status === 'failed' && !agent.session_id && onContinued && (
        <RetryButton agentId={agent.id} onRetried={onContinued} />
      )}

      {(agent.status === 'done' || (agent.status === 'failed' && agent.session_id)) && onContinued && (
        <ContinueInput agentId={agent.id} onContinued={onContinued} />
      )}
    </div>
  );
}

function WatcherTabButton({ agentId, active, onClick }: { agentId: string; active: boolean; onClick: () => void }) {
  const watcher = useAppStore(s => s.watchersByAgent[agentId]);
  const commentary = useAppStore(s => s.commentaryByAgent[agentId]);
  const count = commentary?.length ?? 0;
  const sev = watcher?.next_severity;
  const dot =
    sev === 'blocker' ? '#ef4444' :
    sev === 'concern' ? '#f59e0b' :
    sev === 'progress' ? '#22c55e' :
    sev === 'resolved' ? '#22c55e' :
    watcher?.status === 'running' ? '#3b82f6' :
    'transparent';
  return (
    <button
      className={`terminal-tab${active ? ' terminal-tab-active' : ''}`}
      onClick={onClick}
      title="Live watcher commentary"
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dot,
          marginRight: 6,
          verticalAlign: 'middle',
        }}
      />
      Watcher{count > 0 ? ` (${count})` : ''}
    </button>
  );
}
