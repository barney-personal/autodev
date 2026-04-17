import { useState, useRef, useEffect } from 'react';
import type { Debate, Workflow } from '@shared/types';

interface HeaderProps {
  onNewTask: () => void;
  onTemplates: () => void;
  onBatchTemplates: () => void;
  onUsage: () => void;
  onSearch: () => void;
  onTimeline: () => void;
  onDag: () => void;
  onProjects: () => void;
  onSettings: () => void;
  onDebate: () => void;
  onDebates?: Debate[];
  onSelectDebate?: (debate: Debate) => void;
  onWorkflows?: Workflow[];
  onSelectWorkflow?: (workflow: Workflow) => void;
  onKnowledgeBase: () => void;
  onEye: () => void;
  eyeActive?: boolean;
  eyeBadgeCount?: number;
  eyeEnabled?: boolean;
  onHome: () => void;
  currentProjectName?: string | null;
  onClearProject?: () => void;
  todayClaudeCost?: number;
  todayCodexCost?: number;
  costAutoUpdate?: boolean;
  onToggleCostAutoUpdate?: () => void;
}

function AutodevLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer vortex arm */}
      <path
        d="M85 35C85 35 78 18 58 14C38 10 18 22 15 42C12 62 28 78 48 78"
        stroke="#58a6ff" strokeWidth="6" strokeLinecap="round" fill="none"
      />
      {/* Middle vortex arm */}
      <path
        d="M72 58C72 58 70 72 56 76C42 80 30 70 30 56C30 42 42 36 52 38"
        stroke="#79c0ff" strokeWidth="5" strokeLinecap="round" fill="none"
      />
      {/* Inner spiral core */}
      <path
        d="M44 50C44 50 44 42 52 42C60 42 62 50 56 54C50 58 44 54 46 48"
        stroke="#a5d6ff" strokeWidth="4" strokeLinecap="round" fill="none"
      />
      {/* Speed streaks */}
      <path d="M82 28L92 22" stroke="#58a6ff" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
      <path d="M88 40L96 38" stroke="#58a6ff" strokeWidth="2.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

export function Header({ onNewTask, onTemplates, onBatchTemplates, onUsage, onSearch, onTimeline, onDag, onProjects, onSettings, onDebate, onDebates, onSelectDebate, onWorkflows, onSelectWorkflow, onKnowledgeBase, onEye, eyeActive, eyeBadgeCount, eyeEnabled, onHome, currentProjectName, onClearProject, todayClaudeCost, todayCodexCost, costAutoUpdate, onToggleCostAutoUpdate }: HeaderProps) {
  const hasCost = (todayClaudeCost != null && todayClaudeCost > 0) || (todayCodexCost != null && todayCodexCost > 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [debateMenuOpen, setDebateMenuOpen] = useState(false);
  const debateMenuRef = useRef<HTMLDivElement>(null);
  const [workflowMenuOpen, setWorkflowMenuOpen] = useState(false);
  const workflowMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moreOpen]);
  useEffect(() => {
    if (!debateMenuOpen) return;
    const handler = (e: MouseEvent) => { if (!debateMenuRef.current?.contains(e.target as Node)) setDebateMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [debateMenuOpen]);

  return (
    <header className="header">
      <div className="header-left">
        <button className="header-logo-btn" onClick={onHome} title="Go to main page" aria-label="Go to main dashboard">
          <AutodevLogo />
          <h1 className="header-title">Autodev</h1>
        </button>
        {currentProjectName && (
          <div className="header-project-badge" title={`Active project: ${currentProjectName}`}>
            {currentProjectName}
            <button className="header-project-clear" onClick={onClearProject} aria-label={`Clear project filter: ${currentProjectName}`}>&times;</button>
          </div>
        )}
        {hasCost && (
          <div className="header-cost" title="Today's spend">
            {todayClaudeCost != null && todayClaudeCost > 0 && (
              <span title="Claude cost today">Claude ${todayClaudeCost.toFixed(4)}</span>
            )}
            {todayClaudeCost != null && todayClaudeCost > 0 && todayCodexCost != null && todayCodexCost > 0 && (
              <span style={{ opacity: 0.4, margin: '0 4px' }}>|</span>
            )}
            {todayCodexCost != null && todayCodexCost > 0 && (
              <span title="Codex cost today" style={{ color: 'var(--codex)' }}>Codex ${todayCodexCost.toFixed(4)}</span>
            )}
            <span style={{ opacity: 0.6, marginLeft: 4 }}>today</span>
            {onToggleCostAutoUpdate && (
              <label style={{ marginLeft: 8, opacity: 0.6, cursor: 'pointer', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Auto-refresh cost display every 60s">
                <input type="checkbox" checked={costAutoUpdate ?? false} onChange={onToggleCostAutoUpdate} style={{ margin: 0 }} />
                auto update
              </label>
            )}
          </div>
        )}
      </div>
      <div className="header-actions">
        <input type="text" className="search-input-header" placeholder="&#x2318; Search..." readOnly onFocus={onSearch} />
        <span className="header-divider" />
        <div className="header-btn-group" title="Management">
          <button className="header-btn" onClick={onProjects}>Projects</button>
          <button className="header-btn" onClick={onTemplates}>Templates</button>
          <button className="header-btn" onClick={onBatchTemplates}>Batches</button>
        </div>
        {eyeEnabled && (
          <button className={`header-btn ${eyeActive ? 'header-btn-active' : ''}`} onClick={onEye} style={{ position: 'relative', borderRadius: 6, border: '1px solid var(--border)' }}>
            Eye
            {(eyeBadgeCount ?? 0) > 0 && (
              <span style={{ position: 'absolute', top: -4, right: -6, background: '#f59e0b', color: '#0d1117', borderRadius: '50%', width: 16, height: 16, fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {eyeBadgeCount}
              </span>
            )}
          </button>
        )}
        {onWorkflows && onWorkflows.length > 0 && (
          <div ref={workflowMenuRef} style={{ position: 'relative' }}>
            <button className="header-btn" style={{ borderRadius: 6 }} onClick={() => setWorkflowMenuOpen(v => !v)} title="View autonomous agent runs">Autonomous Agents &#x25be;</button>
            {workflowMenuOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 200, marginTop: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: 280, maxWidth: 400, maxHeight: 360, overflowY: 'auto' }}>
                <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)' }}>Autonomous Agents</div>
                {[...onWorkflows].sort((a, b) => b.updated_at - a.updated_at).map(w => {
                  const statusColor = w.status === 'running' ? 'var(--status-running)' : w.status === 'complete' ? 'var(--status-done)' : w.status === 'blocked' ? '#f59e0b' : 'var(--status-failed)';
                  return (
                    <button key={w.id} onClick={() => { setWorkflowMenuOpen(false); onSelectWorkflow?.(w); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left', borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>C{w.current_cycle}/{w.max_cycles}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, background: 'var(--border)', borderRadius: 6, overflow: 'visible' }}>
          <button className="header-btn" onClick={onDebate} style={{ borderRadius: '6px 0 0 6px' }}>Debate</button>
          {onDebates && onDebates.length > 0 && (
            <div ref={debateMenuRef} style={{ position: 'relative' }}>
              <button className="header-btn" style={{ padding: '5px 6px', borderRadius: '0 6px 6px 0' }} onClick={() => setDebateMenuOpen(v => !v)} title="View debates">&#x25be;</button>
            {debateMenuOpen && (() => {
              const isOngoing = (d: Debate) => d.status !== 'cancelled' && d.status !== 'failed' && (d.status === 'running' || d.current_loop + 1 < d.loop_count);
              const sorted = [...onDebates].sort((a, b) => { const aOn = isOngoing(a), bOn = isOngoing(b); if (aOn !== bOn) return aOn ? -1 : 1; return b.updated_at - a.updated_at; });
              return (
                <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 200, marginTop: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: 300, maxWidth: 420, maxHeight: 360, overflowY: 'auto' }}>
                  <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)' }}>Debates</div>
                  {sorted.map(d => {
                    const ongoing = isOngoing(d);
                    const statusColor = ongoing ? 'var(--status-running)' : d.status === 'consensus' ? 'var(--status-done)' : d.status === 'cancelled' || d.status === 'failed' ? 'var(--status-failed)' : '#a78bfa';
                    return (
                      <button key={d.id} onClick={() => { setDebateMenuOpen(false); onSelectDebate?.(d); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left', borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>L{d.current_loop + 1}/{d.loop_count}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}
        </div>
        <span className="header-divider" />
        <div ref={moreRef} style={{ position: 'relative' }}>
          <button className="header-btn" style={{ borderRadius: 6, border: '1px solid var(--border)' }} onClick={() => setMoreOpen(v => !v)}>More &#x25be;</button>
          {moreOpen && (
            <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 200, marginTop: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: 140, overflow: 'hidden' }}>
              {[
                { label: 'Timeline', fn: onTimeline },
                { label: 'Graph', fn: onDag },
                { label: 'Usage', fn: onUsage },
                { label: 'Memory', fn: onKnowledgeBase },
              ].map(({ label, fn }) => (
                <button key={label} onClick={() => { setMoreOpen(false); fn(); }} style={{ display: 'block', width: '100%', padding: '8px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', color: 'inherit', textAlign: 'left', fontSize: 13, cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >{label}</button>
              ))}
            </div>
          )}
        </div>
        <button className="btn-icon" onClick={onSettings} title="Settings" aria-label="Settings">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>
        </button>
        <button className="btn btn-primary btn-sm" onClick={onNewTask}>+ New Task</button>
      </div>
    </header>
  );
}
