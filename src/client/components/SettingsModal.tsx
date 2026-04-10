import { useState, useEffect } from 'react';

interface SettingsModalProps {
  onClose: () => void;
  eyeEnabled?: boolean;
  onEyeEnabledChange?: (enabled: boolean) => void;
}

export function SettingsModal({ onClose, eyeEnabled = false, onEyeEnabledChange }: SettingsModalProps) {
  const [maxConcurrent, setMaxConcurrent] = useState<number>(20);
  const [saving, setSaving] = useState(false);
  const [worktreeStats, setWorktreeStats] = useState<{ active: number; cleaned: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [togglingEye, setTogglingEye] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => setMaxConcurrent(data.maxConcurrentAgents))
      .catch(() => {});
    fetch('/api/worktrees/stats')
      .then(r => r.json())
      .then(setWorktreeStats)
      .catch(() => {});
  }, []);

  const handleToggleEye = async (enabled: boolean) => {
    setTogglingEye(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eyeEnabled: enabled }),
      });
      if (res.ok) onEyeEnabledChange?.(enabled);
    } finally {
      setTogglingEye(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentAgents: maxConcurrent }),
      });
      if (res.ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const res = await fetch('/api/worktrees/cleanup', { method: 'POST' });
      if (res.ok) {
// const data = await res.json();
        // Refresh stats
        const statsRes = await fetch('/api/worktrees/stats');
        if (statsRes.ok) setWorktreeStats(await statsRes.json());
      }
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Max Concurrent Agents</label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxConcurrent}
              onChange={e => setMaxConcurrent(Number(e.target.value))}
              style={{ width: 80 }}
            />
          </div>

          {worktreeStats && (
            <div className="form-group" style={{ marginTop: 16 }}>
              <label>Worktrees</label>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Active: {worktreeStats.active} | Cleaned: {worktreeStats.cleaned}
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCleanup}
                disabled={cleaning || worktreeStats.active === 0}
              >
                {cleaning ? 'Cleaning…' : 'Clean up now'}
              </button>
            </div>
          )}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>
              Experimental
            </div>
            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <label style={{ margin: 0 }}>Eye</label>
                <button
                  onClick={() => handleToggleEye(!eyeEnabled)}
                  disabled={togglingEye}
                  aria-label={eyeEnabled ? 'Disable Eye' : 'Enable Eye'}
                  style={{
                    position: 'relative',
                    width: 40,
                    height: 22,
                    borderRadius: 11,
                    border: 'none',
                    cursor: togglingEye ? 'wait' : 'pointer',
                    background: eyeEnabled ? 'var(--accent, #58a6ff)' : 'var(--border, #30363d)',
                    transition: 'background 0.2s',
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  <span style={{
                    position: 'absolute',
                    top: 2,
                    left: eyeEnabled ? 20 : 2,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }} />
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Autonomous agent that continuously monitors and improves the codebase
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
