import { useState, useEffect, useCallback } from 'react';
import socket from '../../socket';

interface EyePr {
  id: string;
  url: string;
  title: string;
  description: string | null;
  proposal_id: string | null;
  status: 'draft' | 'open' | 'merged' | 'closed';
  created_at: number;
}

type PrFilter = 'active' | 'draft' | 'open' | 'merged' | 'all';

const PR_STATUS_COLORS: Record<string, string> = {
  draft:  '#f59e0b',
  open:   '#3fb950',
  merged: '#a371f7',
  closed: '#8b949e',
};

const PR_STATUS_LABELS: Record<string, string> = {
  draft:  'Draft',
  open:   'Open',
  merged: 'Merged',
  closed: 'Closed',
};

function prSortKey(pr: EyePr): number {
  const order: Record<string, number> = { draft: 0, open: 1, merged: 2, closed: 3 };
  return (order[pr.status] ?? 9) * 1e13 + (Number.MAX_SAFE_INTEGER - pr.created_at);
}

export function PrsTab() {
  const [prs, setPrs] = useState<EyePr[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<PrFilter>('active');

  const fetchPrs = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/prs');
      if (res.ok) setPrs(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/eye/prs/refresh', { method: 'POST' });
      if (res.ok) setPrs(await res.json());
    } catch { /* ignore */ }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchPrs();
  }, [fetchPrs]);

  useEffect(() => {
    const onPrNew = ({ pr }: { pr: EyePr }) => {
      setPrs(prev => [pr, ...prev.filter(p => p.id !== pr.id)]);
    };
    socket.on('eye:pr:new', onPrNew);
    return () => { socket.off('eye:pr:new', onPrNew); };
  }, []);

  const filtered = prs
    .filter(pr => {
      if (filter === 'active') return pr.status === 'draft' || pr.status === 'open';
      if (filter === 'draft')  return pr.status === 'draft';
      if (filter === 'open')   return pr.status === 'open';
      if (filter === 'merged') return pr.status === 'merged';
      return true; // 'all'
    })
    .sort((a, b) => prSortKey(a) - prSortKey(b));

  const counts = prs.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const activeCount = (counts.draft || 0) + (counts.open || 0);

  const filterBtn = (f: PrFilter, label: string, count?: number) => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      style={{
        fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
        background: filter === f ? 'var(--accent)' : 'transparent',
        color: filter === f ? '#000' : 'var(--text-dim)',
        border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
        fontWeight: filter === f ? 600 : 400,
      }}
    >
      {label}{count !== undefined ? ` (${count})` : ''}
    </button>
  );

  if (loading) return <div className="eye-empty">Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {filterBtn('active', 'Active', activeCount)}
        {filterBtn('draft',  'Draft',  counts.draft)}
        {filterBtn('open',   'Open',   counts.open)}
        {filterBtn('merged', 'Merged', counts.merged)}
        {filterBtn('all',    'All',    prs.length)}
        <button
          onClick={refresh}
          disabled={refreshing}
          style={{
            marginLeft: 'auto', fontSize: 11, padding: '3px 9px', borderRadius: 5,
            background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
            cursor: 'pointer', opacity: refreshing ? 0.5 : 1,
          }}
        >
          {refreshing ? 'Refreshing\u2026' : '\u21bb Refresh'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="eye-empty">
          {prs.length === 0
            ? 'No PRs created yet. Eye will list PRs here when it implements approved proposals.'
            : `No ${filter === 'active' ? 'active' : filter} PRs.`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map(pr => {
            const statusColor = PR_STATUS_COLORS[pr.status] || 'var(--text-dim)';
            return (
              <div key={pr.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', background: 'var(--bg-surface)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill={statusColor} style={{ flexShrink: 0, marginTop: 2 }}>
                    <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}
                      >
                        {pr.title}
                      </a>
                      <span style={{
                        flexShrink: 0, fontSize: 10, padding: '1px 6px', borderRadius: 10,
                        background: `${statusColor}22`, color: statusColor,
                        border: `1px solid ${statusColor}55`, fontWeight: 600,
                      }}>
                        {PR_STATUS_LABELS[pr.status] ?? pr.status}
                      </span>
                    </div>
                    {pr.description && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{pr.description}</div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                      {new Date(pr.created_at).toLocaleString()}
                      {pr.proposal_id && <span style={{ marginLeft: 8 }}>&middot; linked to proposal</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
