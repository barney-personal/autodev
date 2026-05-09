interface TopBarProps {
  onHome: () => void;
  onNewTask: () => void;
  onSearch: () => void;
  onSettings: () => void;
  todayClaudeCost?: number;
  todayCodexCost?: number;
}

export function TopBar({ onHome, onNewTask, onSearch, onSettings, todayClaudeCost, todayCodexCost }: TopBarProps) {
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
        <button className="tb-icon" title="Settings" onClick={onSettings} aria-label="Settings">⚙</button>
        <button className="ad-btn-primary" onClick={onNewTask} type="button">＋ New Task</button>
      </div>
    </header>
  );
}
