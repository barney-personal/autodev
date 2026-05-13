import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import type { JobWatcher, WatcherCommentary, WatcherAction, WatcherSeverity } from '@shared/types';

interface WatcherPanelProps {
  agentId: string;
  agentStatus: string;
}

const SEVERITY_COLOR: Record<WatcherSeverity, string> = {
  info: '#64748b',
  progress: '#22c55e',
  concern: '#f59e0b',
  blocker: '#ef4444',
  resolved: '#22c55e',
};

const SEVERITY_ICON: Record<WatcherSeverity, string> = {
  info: '•',
  progress: '✓',
  concern: '!',
  blocker: '⛔',
  resolved: '✓',
};

const ACTION_COLOR: Record<string, string> = {
  nudge: '#3b82f6',
  restart: '#f59e0b',
  escalate: '#ef4444',
};

function relTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function WatcherPanel({ agentId, agentStatus }: WatcherPanelProps) {
  const watcher = useAppStore(s => s.watchersByAgent[agentId]) as JobWatcher | undefined;
  const commentary = useAppStore(s => s.commentaryByAgent[agentId]) as WatcherCommentary[] | undefined;
  const actions = useAppStore(s => s.actionsByAgent[agentId]) as WatcherAction[] | undefined;
  const setCommentary = useAppStore(s => s.setWatcherCommentary);
  const setActions = useAppStore(s => s.setWatcherActions);
  const upsertWatcher = useAppStore(s => s.upsertWatcher);

  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Banner shown when /watcher/tick comes back 429 with a Retry-After.
  // Auto-clears once the cooldown elapses.
  const [tickCooldown, setTickCooldown] = useState<{ until: number; message: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fetchedAgentId = useRef<string | null>(null);

  // One-time hydrate per agent. We catch every failure mode (network, non-OK
  // status, malformed JSON) so a single fetch error doesn't leave the panel
  // stuck in a blank loading state or surface as an unhandled rejection.
  useEffect(() => {
    if (fetchedAgentId.current === agentId) return;
    fetchedAgentId.current = agentId;
    setLoading(true);
    setFetchError(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/agents/${agentId}/watcher`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        if (data?.watcher) upsertWatcher(data.watcher);
        if (Array.isArray(data?.commentary)) setCommentary(agentId, data.commentary);
        if (Array.isArray(data?.actions)) setActions(agentId, data.actions);
      } catch (err) {
        if (cancelled) return;
        console.error('[watcher-panel] hydrate failed:', err);
        setFetchError((err as Error).message ?? 'failed to load watcher state');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, upsertWatcher, setCommentary, setActions]);

  // Live clock for "x ago" formatting
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // Auto-clear a cooldown banner once its retry window expires.
  useEffect(() => {
    if (!tickCooldown) return;
    const ms = Math.max(0, tickCooldown.until - Date.now());
    const id = setTimeout(() => setTickCooldown(null), ms);
    return () => clearTimeout(id);
  }, [tickCooldown]);

  // Auto-scroll to newest commentary
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [commentary?.length]);

  const merged = useMemo(() => mergeTimeline(commentary ?? [], actions ?? []), [commentary, actions]);

  const isRunning = ['starting', 'running', 'waiting_user'].includes(agentStatus);

  const handleTickNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/watcher/tick`, { method: 'POST' });
      if (r.status === 429) {
        // Surface the cooldown to the user so the silent flash-of-busy is replaced
        // with a clear "wait Ns" banner that auto-clears.
        let retryMs = 0;
        try { const body = await r.json(); retryMs = Number(body.retry_after_ms ?? 0); } catch { /* body may be empty */ }
        if (!retryMs) {
          const hdr = r.headers.get('Retry-After');
          retryMs = hdr ? Number(hdr) * 1000 : 5000;
        }
        const secs = Math.max(1, Math.ceil(retryMs / 1000));
        setTickCooldown({ until: Date.now() + retryMs, message: `Tick rate-limited — retry in ${secs}s` });
      } else if (!r.ok) {
        setTickCooldown({ until: Date.now() + 5000, message: `Tick failed (HTTP ${r.status})` });
      } else {
        setTickCooldown(null);
      }
    } catch (err) {
      setTickCooldown({ until: Date.now() + 5000, message: `Tick failed: ${(err as Error).message}` });
    } finally { setBusy(false); }
  };

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    try { await fetch(`/api/agents/${agentId}/watcher/start`, { method: 'POST' }); }
    finally { setBusy(false); }
  };

  const handleStop = async () => {
    if (busy) return;
    setBusy(true);
    try { await fetch(`/api/agents/${agentId}/watcher/stop`, { method: 'POST' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="watcher-panel">
      <WatcherHeader
        watcher={watcher}
        isRunning={isRunning}
        busy={busy}
        onStart={handleStart}
        onStop={handleStop}
        onTickNow={handleTickNow}
      />
      {tickCooldown && (
        <div className="watcher-cooldown-banner" role="status">
          {tickCooldown.message}
        </div>
      )}
      <div className="watcher-stream">
        {loading && merged.length === 0 && (
          <div className="watcher-empty">Loading watcher state…</div>
        )}
        {!loading && fetchError && merged.length === 0 && (
          <div className="watcher-empty watcher-error">
            Couldn't load watcher state: {fetchError}. Live updates will still arrive via socket.
          </div>
        )}
        {!loading && !fetchError && merged.length === 0 && (
          <div className="watcher-empty">
            {watcher
              ? 'No commentary yet — the watcher is observing.'
              : isRunning
                ? 'No watcher attached. Click "Start watcher" to spawn one.'
                : 'No watcher ran for this agent.'}
          </div>
        )}
        {merged.map(item => {
          if (item.kind === 'commentary') return <CommentaryItem key={`c-${item.entry.id}`} item={item.entry} now={now} />;
          return <ActionItem key={`a-${item.entry.id}`} item={item.entry} now={now} />;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function WatcherHeader({
  watcher, isRunning, busy, onStart, onStop, onTickNow,
}: {
  watcher: JobWatcher | undefined;
  isRunning: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onTickNow: () => void;
}) {
  const status = watcher?.status ?? 'inactive';
  const dotColor =
    status === 'running' ? '#22c55e' :
    status === 'starting' ? '#f59e0b' :
    status === 'error' ? '#ef4444' :
    '#64748b';

  return (
    <div className="watcher-header">
      <div className="watcher-header-left">
        <span className="watcher-status-dot" style={{ background: dotColor }} />
        <span className="watcher-title">Live watcher</span>
        <span className="watcher-status-text">{status}</span>
        {watcher && (
          <span className="watcher-stats" title={`${watcher.tick_count} ticks · $${watcher.cost_usd.toFixed(4)}`}>
            {watcher.tick_count} ticks · ${watcher.cost_usd.toFixed(4)}
          </span>
        )}
      </div>
      <div className="watcher-header-right">
        {isRunning && (watcher?.status === 'running' || watcher?.status === 'starting') && (
          <button className="btn btn-sm" onClick={onTickNow} disabled={busy} title="Re-evaluate now">↻ Re-tick</button>
        )}
        {isRunning && (!watcher || watcher.status === 'stopped' || watcher.status === 'error') && (
          <button className="btn btn-sm btn-primary" onClick={onStart} disabled={busy}>Start watcher</button>
        )}
        {isRunning && (watcher?.status === 'running' || watcher?.status === 'starting') && (
          <button className="btn btn-sm" onClick={onStop} disabled={busy}>Stop</button>
        )}
      </div>
    </div>
  );
}

function CommentaryItem({ item, now }: { item: WatcherCommentary; now: number }) {
  const color = SEVERITY_COLOR[item.severity] ?? '#64748b';
  const icon = SEVERITY_ICON[item.severity] ?? '•';
  return (
    <div className="watcher-item watcher-item-commentary" style={{ borderLeftColor: color }}>
      <div className="watcher-item-head">
        <span className="watcher-item-icon" style={{ color }}>{icon}</span>
        <span className="watcher-item-severity" style={{ color }}>{item.severity}</span>
        <span className="watcher-item-time">{relTime(item.created_at, now)}</span>
      </div>
      <div className="watcher-item-headline">{item.headline}</div>
      {item.detail && <div className="watcher-item-detail">{item.detail}</div>}
      {item.evidence && (
        <details className="watcher-item-evidence">
          <summary>Evidence</summary>
          <pre>{item.evidence}</pre>
        </details>
      )}
    </div>
  );
}

function ActionItem({ item, now }: { item: WatcherAction; now: number }) {
  const color = ACTION_COLOR[item.type] ?? '#64748b';
  const verb = item.type === 'nudge' ? 'Nudged' : item.type === 'restart' ? 'Restarted' : 'Escalated';
  const outcome = item.outcome;
  const outcomeColor = outcome === 'applied' ? '#22c55e' : outcome === 'gated' ? '#f59e0b' : outcome === 'failed' ? '#ef4444' : '#64748b';
  return (
    <div className="watcher-item watcher-item-action" style={{ borderLeftColor: color }}>
      <div className="watcher-item-head">
        <span className="watcher-item-icon" style={{ color }}>⚡</span>
        <span className="watcher-item-severity" style={{ color }}>{verb}</span>
        <span className="watcher-action-outcome" style={{ color: outcomeColor }}>{outcome}</span>
        <span className="watcher-item-time">{relTime(item.created_at, now)}</span>
      </div>
      {item.reason && <div className="watcher-item-detail">Reason: {item.reason}</div>}
      {item.payload && <div className="watcher-item-detail">Payload: {item.payload}</div>}
      {item.outcome_detail && <div className="watcher-item-detail watcher-item-detail-muted">{item.outcome_detail}</div>}
    </div>
  );
}

type MergedItem =
  | { kind: 'commentary'; entry: WatcherCommentary; at: number }
  | { kind: 'action'; entry: WatcherAction; at: number };

function mergeTimeline(commentary: WatcherCommentary[], actions: WatcherAction[]): MergedItem[] {
  // Interleave commentary (info / progress / concern / blocker / resolved)
  // with intervention actions (nudge / restart / escalate) in chronological
  // order. Both streams come from server-side timestamps.
  const out: MergedItem[] = [];
  for (const c of commentary) out.push({ kind: 'commentary', entry: c, at: c.created_at });
  for (const a of actions) out.push({ kind: 'action', entry: a, at: a.created_at });
  out.sort((x, y) => x.at - y.at);
  return out;
}
