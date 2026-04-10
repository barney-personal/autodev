import { useState, useEffect, useCallback } from 'react';
import type { AgentWithJob } from '@shared/types';
import { InlineOutput, StatusDot, formatDuration, formatTime } from './utils';

export function ActivityTab() {
  const [agents, setAgents] = useState<AgentWithJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/agents');
      if (res.ok) setAgents(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);
  useEffect(() => {
    const id = setInterval(fetchAgents, 15_000);
    return () => clearInterval(id);
  }, [fetchAgents]);

  const visibleAgents = agents.filter(a => a.status !== 'failed' && a.status !== 'cancelled');

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (visibleAgents.length === 0) return <div className="eye-empty">No Eye activity yet. Start Eye to begin.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {visibleAgents.map(agent => {
        const isExpanded = expandedId === agent.id;
        const canExpand = ['done', 'failed', 'running', 'cancelled'].includes(agent.status);
        const cost = agent.cost_usd != null ? `$${agent.cost_usd.toFixed(2)}` : null;
        const duration = agent.duration_ms != null ? formatDuration(agent.duration_ms) : null;

        return (
          <div key={agent.id} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                cursor: canExpand ? 'pointer' : 'default',
                background: isExpanded ? 'var(--bg-elevated)' : 'transparent',
              }}
              onClick={() => canExpand && setExpandedId(isExpanded ? null : agent.id)}
              onMouseEnter={e => { if (canExpand && !isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-interactive)'; }}
              onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              <StatusDot status={agent.status} />
              <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.job.title}
              </span>
              {agent.status_message && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.status_message}
                </span>
              )}
              {cost && <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{cost}</span>}
              {duration && <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{duration}</span>}
              <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{formatTime(agent.started_at)}</span>
              {canExpand && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{isExpanded ? '\u25b4' : '\u25be'}</span>}
            </div>
            {isExpanded && <InlineOutput agentId={agent.id} jobStatus={agent.status} />}
          </div>
        );
      })}
    </div>
  );
}
