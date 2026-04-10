import { useState, useEffect, useCallback } from 'react';
import type { Discussion, Proposal } from '@shared/types';
import { formatNextCycle } from './eye/utils';
import { DailySummary } from './eye/DailySummary';
import { EyeConfigPanel } from './eye/EyeConfigPanel';
import { PRReviewList } from './eye/PRReviewList';
import { DiscussionList } from './eye/DiscussionList';
import { ProposalList } from './eye/ProposalList';
import { ActivityTab } from './eye/ActivityTab';
import { PrsTab } from './eye/PrsTab';

interface EyeStatus {
  running: boolean;
  active: boolean;
  scheduledAt: number | null;
  jobId: string | null;
  cycleCount: number;
  failed?: boolean;
}

interface EyePanelProps {
  discussions: Discussion[];
  proposals: Proposal[];
  onClose: () => void;
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function EyePanel({ discussions, proposals, onClose }: EyePanelProps) {
  const [activeTab, setActiveTab] = useState<'interact' | 'activity' | 'prs' | 'reviews' | 'summary' | 'configure'>('interact');

  // Eye lifecycle
  const [eyeStatus, setEyeStatus] = useState<EyeStatus>({ running: false, active: false, scheduledAt: null, jobId: null, cycleCount: 0 });
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/status');
      if (res.ok) setEyeStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    const id = setInterval(fetchStatus, 10_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/eye/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) await fetchStatus();
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      const res = await fetch('/api/eye/stop', { method: 'POST' });
      if (res.ok) await fetchStatus();
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="eye-panel">
      {/* Header */}
      <div className="eye-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 className="eye-panel-title">Eye</h2>
          <span
            className="eye-status-dot"
            style={{
              background: eyeStatus.active ? 'var(--status-running)' :
                eyeStatus.running ? 'var(--status-waiting)' :
                'var(--text-muted)'
            }}
            title={eyeStatus.active ? 'Active' : eyeStatus.running ? 'Sleeping' : 'Stopped'}
          />
          <span style={{ fontSize: 12, color: eyeStatus.failed ? 'var(--status-failed)' : 'var(--text-muted)' }}>
            {eyeStatus.active
              ? `Running (cycle ${eyeStatus.cycleCount})`
              : eyeStatus.failed
                ? `Last cycle failed — retrying`
                : eyeStatus.running
                  ? eyeStatus.scheduledAt
                    ? `Sleeping — next cycle ${formatNextCycle(eyeStatus.scheduledAt)}`
                    : `Sleeping (cycle ${eyeStatus.cycleCount})`
                  : 'Stopped'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {eyeStatus.running ? (
            <button className="btn btn-sm eye-btn-reject" onClick={handleStop} disabled={stopping}>
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          ) : (
            <button className="btn btn-sm eye-btn-approve" onClick={handleStart} disabled={starting}>
              {starting ? 'Starting...' : 'Start'}
            </button>
          )}
          <button className="btn-icon" onClick={onClose} title="Close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="eye-tab-bar">
        <button className={`eye-tab ${activeTab === 'interact' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('interact')}>
          Discussions & Proposals
        </button>
        <button className={`eye-tab ${activeTab === 'activity' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('activity')}>
          Activity
        </button>
        <button className={`eye-tab ${activeTab === 'prs' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('prs')}>
          PRs
        </button>
        <button className={`eye-tab ${activeTab === 'reviews' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('reviews')}>
          Reviews
        </button>
        <button className={`eye-tab ${activeTab === 'summary' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('summary')}>
          Summary
        </button>
        <button className={`eye-tab ${activeTab === 'configure' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('configure')}>
          Configure
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'interact' ? (
        <div className="eye-columns">
          <DiscussionList discussions={discussions} />
          <ProposalList proposals={proposals} />
        </div>
      ) : activeTab === 'activity' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <ActivityTab />
        </div>
      ) : activeTab === 'prs' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <PrsTab />
        </div>
      ) : activeTab === 'reviews' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <PRReviewList />
        </div>
      ) : activeTab === 'summary' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <DailySummary />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EyeConfigPanel />
        </div>
      )}
    </div>
  );
}
