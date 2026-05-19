/**
 * ResolverPanel — workflow-scoped panel showing Auto Resolver activity.
 *
 * Renders inside ControlRoom for any workflow that has had a Resolver dispatch
 * (resolver_attempt_count > 0) or is currently blocked. Lists runs, classification,
 * resume outcome, and lets the operator reset the circuit / re-dispatch.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Workflow,
  ResolverRun,
  ResolverAction,
  ResolverClassification,
  ResolverStatus,
} from '@shared/types';
import { useAppStore } from '../store';

interface Props { workflow: Workflow }

const STATUS_LABEL: Record<ResolverStatus, string> = {
  running: 'Running',
  resolved: 'Resolved',
  escalated: 'Escalated',
  failed: 'Failed',
  aborted: 'Aborted',
  skipped: 'Skipped',
};

const STATUS_COLOR: Record<ResolverStatus, string> = {
  running: '#3b82f6',
  resolved: '#22c55e',
  escalated: '#f59e0b',
  failed: '#ef4444',
  aborted: '#94a3b8',
  skipped: '#94a3b8',
};

const CLASS_LABEL: Record<ResolverClassification, string> = {
  transient_infra: 'Transient infra',
  config_drift: 'Config drift',
  code_bug: 'Code bug',
  model_capability: 'Model capability',
  external_service: 'External service',
  unknown: 'Unknown',
};

function relTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function ResolverPanel({ workflow }: Props) {
  const runs = useAppStore(s => s.resolverRunsByWorkflow[workflow.id]) as ResolverRun[] | undefined;
  const setRuns = useAppStore(s => s.setResolverRuns);
  const [actionsByRun, setActionsByRun] = useState<Record<string, ResolverAction[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const fetched = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (fetched.current === workflow.id) return;
    fetched.current = workflow.id;
    setLoading(true);
    fetch(`/api/workflows/${workflow.id}/resolver/runs`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: ResolverRun[]) => setRuns(workflow.id, data))
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [workflow.id, setRuns]);

  const sortedRuns = useMemo(() => (runs ?? []).slice().sort((a, b) => b.started_at - a.started_at), [runs]);

  const expand = async (runId: string) => {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    if (actionsByRun[runId]) return;
    try {
      const res = await fetch(`/api/resolver/runs/${runId}/actions`);
      if (res.ok) {
        const actions: ResolverAction[] = await res.json();
        setActionsByRun(prev => ({ ...prev, [runId]: actions }));
      }
    } catch { /* swallow */ }
  };

  const resetCircuit = async () => {
    if (!confirm('Reset Resolver state for this workflow? Circuit breaker will rearm and lifetime attempt count resets to 0.')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/resolver/reset`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? `Reset failed (HTTP ${res.status})`);
      }
    } finally { setBusy(false); }
  };

  const dispatchNow = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/resolver/dispatch`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? `Dispatch failed (HTTP ${res.status})`);
      }
    } finally { setBusy(false); }
  };

  // Don't render the panel at all if there's no activity and the workflow isn't blocked.
  const isBlocked = workflow.status === 'blocked';
  const hasActivity = sortedRuns.length > 0 || (workflow.resolver_attempt_count ?? 0) > 0;
  if (!isBlocked && !hasActivity) return null;

  return (
    <section className="resolver-panel" style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 16,
      marginTop: 16,
      background: 'var(--surface-1, #0f172a08)',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, letterSpacing: 0.4, textTransform: 'uppercase' }}>
          Auto Resolver
        </h3>
        <span style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 4,
          background: workflow.resolver_circuit_state === 'tripped' ? '#ef4444' : '#22c55e',
          color: 'white',
        }}>
          {workflow.resolver_circuit_state === 'tripped' ? 'CIRCUIT TRIPPED' : 'CIRCUIT ARMED'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          attempts {workflow.resolver_attempt_count ?? 0}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {isBlocked && (
            <button
              type="button"
              className="ad-btn-ghost"
              onClick={dispatchNow}
              disabled={busy || workflow.resolver_circuit_state === 'tripped'}
              title={workflow.resolver_circuit_state === 'tripped' ? 'Circuit is tripped — reset first' : 'Manually dispatch the Resolver now'}
              style={{ fontSize: 12 }}
            >
              Dispatch
            </button>
          )}
          <button
            type="button"
            className="ad-btn-ghost"
            onClick={resetCircuit}
            disabled={busy}
            style={{ fontSize: 12 }}
          >
            Reset
          </button>
        </div>
      </header>

      {loading && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Loading…</div>}
      {error && <div style={{ fontSize: 12, color: '#ef4444' }}>Error: {error}</div>}
      {!loading && sortedRuns.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          No Resolver runs yet. {isBlocked ? 'The Resolver will fire automatically when conditions allow.' : ''}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortedRuns.map(run => (
          <RunRow
            key={run.id}
            run={run}
            now={now}
            expanded={expanded === run.id}
            actions={actionsByRun[run.id]}
            onToggle={() => expand(run.id)}
          />
        ))}
      </div>
    </section>
  );
}

function RunRow({ run, now, expanded, actions, onToggle }: {
  run: ResolverRun;
  now: number;
  expanded: boolean;
  actions: ResolverAction[] | undefined;
  onToggle: () => void;
}) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: 10,
      background: 'var(--surface-2, transparent)',
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 3,
              background: STATUS_COLOR[run.status],
              color: 'white',
              fontWeight: 600,
            }}
          >
            {STATUS_LABEL[run.status]}
          </span>
          <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
            attempt {run.attempt}
          </span>
          <span style={{ fontSize: 12 }}>
            {run.classification ? CLASS_LABEL[run.classification] : 'unclassified'}
          </span>
          {run.resume_outcome && (
            <span style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              background: run.resume_outcome === 'resumed_running' ? '#0891b2' :
                          run.resume_outcome === 'resumed_re_blocked' ? '#ef4444' : '#94a3b8',
              color: 'white',
            }}>
              {run.resume_outcome.replace(/_/g, ' ')}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {run.turn_count} turns · ${run.cost_usd.toFixed(4)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 'auto' }}>
            {relTime(run.started_at, now)}
          </span>
        </div>
        {run.diagnosis && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4 }}>
            {run.diagnosis.length > 240 && !expanded ? `${run.diagnosis.slice(0, 240)}…` : run.diagnosis}
          </div>
        )}
        {!run.diagnosis && run.error_message && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#ef4444' }}>
            {run.error_message}
          </div>
        )}
      </button>

      {expanded && actions && (
        <div style={{ marginTop: 10, fontSize: 11, fontFamily: 'var(--mono)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {actions.length === 0 ? (
            <div style={{ color: 'var(--ink-3)' }}>(no actions recorded)</div>
          ) : (
            actions.map(a => (
              <div key={a.id} style={{
                display: 'flex',
                gap: 8,
                padding: '4px 8px',
                background: a.outcome === 'applied' ? '#22c55e10' :
                            a.outcome === 'rejected' ? '#f59e0b10' :
                            a.outcome === 'error' ? '#ef444410' : 'transparent',
                borderRadius: 3,
              }}>
                <span style={{ minWidth: 130, color: 'var(--ink-2)' }}>{a.type}</span>
                <span style={{ minWidth: 60 }}>{a.outcome}</span>
                <span style={{ flex: 1, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.outcome_detail ?? a.payload.slice(0, 120)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
