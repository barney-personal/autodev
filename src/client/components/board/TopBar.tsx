interface TopBarProps {
  onHome: () => void;
  onNewTask: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onEye?: () => void;
  /** Show the eye button at all (gated by the eye feature flag in settings). */
  eyeEnabled?: boolean;
  /** True while the EyePanel modal is open — gives the button a pressed state. */
  eyeActive?: boolean;
  /** Number of unread Eye discussions/proposals — renders a small badge. */
  eyeBadgeCount?: number;
  todayClaudeCost?: number;
  todayCodexCost?: number;
}

export function TopBar({
  onHome,
  onNewTask,
  onSearch,
  onSettings,
  onEye,
  eyeEnabled,
  eyeActive,
  eyeBadgeCount,
  todayClaudeCost,
  todayCodexCost,
}: TopBarProps) {
  const hasCost = (todayClaudeCost != null && todayClaudeCost > 0) || (todayCodexCost != null && todayCodexCost > 0);
  return (
    <header className="tb">
      <button className="tb-brand" onClick={onHome} type="button">
        <span className="logo">A</span>
        <span className="name">Autodev</span>
      </button>
      {hasCost && (
        <div className="tb-cost">
          {todayClaudeCost != null && todayClaudeCost > 0 && (
            <>
              <b>Claude</b> ${todayClaudeCost.toFixed(2)}
            </>
          )}
          {todayClaudeCost != null && todayCodexCost != null && todayClaudeCost > 0 && todayCodexCost > 0 && (
            <span style={{ color: 'var(--ink-4)' }}>·</span>
          )}
          {todayCodexCost != null && todayCodexCost > 0 && (
            <>
              <b>Codex</b> ${todayCodexCost.toFixed(2)}
            </>
          )}
          <span style={{ color: 'var(--ink-4)' }}>today</span>
        </div>
      )}
      <button className="tb-search" type="button" onClick={onSearch}>
        <span>⌘</span>
        <span>Search tasks, files, milestones…</span>
        <kbd>K</kbd>
      </button>
      <div className="tb-actions">
        {eyeEnabled && onEye && (
          <button
            className="tb-icon"
            title={`Eye${eyeBadgeCount ? ` · ${eyeBadgeCount} pending` : ''}`}
            onClick={onEye}
            aria-label="Eye"
            aria-pressed={eyeActive}
            style={{
              position: 'relative',
              background: eyeActive ? 'var(--active-bg)' : undefined,
              color: eyeActive ? 'var(--active-2)' : undefined,
            }}
          >
            <span aria-hidden>◉</span>
            {(eyeBadgeCount ?? 0) > 0 && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 999,
                  background: 'var(--attn)',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {eyeBadgeCount}
              </span>
            )}
          </button>
        )}
        <button className="tb-icon" title="Settings" onClick={onSettings} aria-label="Settings">⚙</button>
        <button className="ad-btn-primary" onClick={onNewTask} type="button">＋ New Task</button>
      </div>
    </header>
  );
}
