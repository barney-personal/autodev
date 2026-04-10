import type { FileLock } from '@shared/types';

interface FileLockMapProps {
  locks: FileLock[];
}

function timeUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return 'expired';
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function FileLockMap({ locks }: FileLockMapProps) {
  return (
    <aside className="sidebar sidebar-right">
      <h2 className="sidebar-title">File Locks</h2>
      {locks.length === 0 ? (
        <p className="sidebar-empty">No active locks</p>
      ) : (
        <div className="lock-list">
          {locks.map(lock => (
            <div key={lock.id} className="lock-item">
              <div className="lock-file">{lock.file_path}</div>
              <div className="lock-meta">
                <span className="lock-agent">→ Agent {lock.agent_id.slice(0, 6)}</span>
                <span className="lock-expires">exp: {timeUntil(lock.expires_at)}</span>
              </div>
              {lock.reason && <div className="lock-reason">{lock.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
