import { useState, useEffect } from 'react';

// ─── Shared constants ─────────────────────────────────────────────────────────

export const SUMMARY_LIMIT = 500;

// ─── Inline Output ────────────────────────────────────────────────────────────

export function InlineOutput({ agentId, jobStatus }: { agentId: string; jobStatus: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(`/api/agents/${agentId}/result-text`)
      .then(r => r.ok ? r.json() : { text: null })
      .then((data: { text: string | null }) => setText(data.text))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)' }}>Loading...</div>;
  if (!text) {
    const msg = jobStatus === 'done' || jobStatus === 'failed' ? 'No summary available.' : 'Agent is still working...';
    return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>{msg}</div>;
  }

  const truncated = !expanded && text.length > SUMMARY_LIMIT;
  const display = truncated ? text.slice(0, SUMMARY_LIMIT).replace(/\s+\S*$/, '') + '…' : text;

  return (
    <div style={{
      padding: '10px 14px', fontSize: 12, lineHeight: 1.65,
      color: 'var(--text-primary)', background: 'var(--bg-surface)',
      borderTop: '1px solid var(--border)',
    }}>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{display}</div>
      {text.length > SUMMARY_LIMIT && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            marginTop: 6, background: 'none', border: 'none', padding: 0,
            fontSize: 11, color: 'var(--accent)', cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : 'Show full output'}
        </button>
      )}
    </div>
  );
}

// ─── Status Dot ───────────────────────────────────────────────────────────────

export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'done' ? 'var(--status-done)' :
    status === 'failed' ? 'var(--status-failed)' :
    status === 'cancelled' ? 'var(--status-failed)' :
    status === 'running' || status === 'assigned' ? 'var(--status-running)' :
    'var(--text-dim)';
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, marginRight: 6, flexShrink: 0 }} />;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatNextCycle(scheduledAt: number): string {
  const diffMs = scheduledAt - Date.now();
  if (diffMs <= 0) return 'soon';
  if (diffMs < 60_000) return `in ${Math.round(diffMs / 1000)}s`;
  return `in ${Math.round(diffMs / 60_000)}m`;
}
