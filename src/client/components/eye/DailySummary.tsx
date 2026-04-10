import { useState, useEffect, useCallback } from 'react';
import styles from './DailySummary.module.css';

interface DailySummaryItem { timestamp: number; text: string }
interface DailySummaryData { date: string; items: DailySummaryItem[] }

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function DailySummary(): JSX.Element {
  const [summaries, setSummaries] = useState<DailySummaryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  const fetchSummaries = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/summaries');
      if (res.ok) {
        const data: DailySummaryData[] = await res.json();
        setSummaries(data);
        const today = new Date().toISOString().slice(0, 10);
        setExpandedDates(prev => {
          const next = new Set(prev);
          if (data.some(s => s.date === today)) next.add(today);
          return next;
        });
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSummaries(); }, [fetchSummaries]);
  useEffect(() => {
    const id = setInterval(fetchSummaries, 30_000);
    return () => clearInterval(id);
  }, [fetchSummaries]);

  const toggleDate = (date: string) => setExpandedDates(prev => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (summaries.length === 0) return (
    <div className="eye-empty" style={{ padding: 24 }}>
      No summary yet. Eye will populate this as it works.<br />
      <span className={styles.emptyHint}>
        Eye uses <code>update_daily_summary</code> to record key findings each cycle.
      </span>
    </div>
  );

  return (
    <div className={styles.container}>
      {summaries.map(summary => {
        const isExpanded = expandedDates.has(summary.date);
        return (
          <div key={summary.date} className={styles.summaryGroup}>
            <div
              className={`${styles.summaryHeader} ${isExpanded ? styles.summaryHeaderExpanded : ''}`}
              onClick={() => toggleDate(summary.date)}
            >
              <span className={styles.summaryDate}>{formatDate(summary.date)}</span>
              <span className={styles.summaryCount}>
                {summary.items.length} item{summary.items.length !== 1 ? 's' : ''}
              </span>
              <span className={styles.summaryChevron}>{isExpanded ? '▴' : '▾'}</span>
            </div>
            {isExpanded && (
              <div className={styles.summaryBody}>
                {summary.items.length === 0 ? (
                  <div className={styles.emptyBody}>No items.</div>
                ) : (
                  <ul className={styles.itemList}>
                    {summary.items.map((item, idx) => (
                      <li key={idx} className={styles.item}>
                        <span className={styles.itemTime}>
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className={styles.itemText}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
