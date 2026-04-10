import { useState, useEffect, useRef } from 'react';
import type { SearchResult } from '@shared/types';

interface SearchModalProps {
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
}

export function SearchModal({ onClose, onSelectAgent }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
        const data = await res.json();
        setResults(data.results ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [query]);

  const handleSelect = (result: SearchResult) => {
    onSelectAgent(result.agent_id);
    onClose();
  };

  const statusClass = (s: string) => {
    if (s === 'running' || s === 'starting') return 'status-running';
    if (s === 'done') return 'status-done';
    if (s === 'failed') return 'status-failed';
    if (s === 'cancelled') return 'status-cancelled';
    if (s === 'waiting_user') return 'status-waiting_user';
    return '';
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal search-modal">
        <div className="search-modal-input-row">
          <span className="search-icon">⌕</span>
          <input
            ref={inputRef}
            className="search-modal-input"
            type="text"
            placeholder="Search agent output…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {loading && <span className="spinner spinner-sm" />}
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        {results.length > 0 && (
          <ul className="search-results">
            {results.map((r, i) => (
              <li key={i} className="search-result-item" onClick={() => handleSelect(r)}>
                <div className="search-result-header">
                  <span className={`agent-status-badge ${statusClass(r.agent_status)}`}>{r.agent_status}</span>
                  <span className="search-result-title">{r.job_title}</span>
                  <span className="search-result-id">{r.agent_id.slice(0, 6)}</span>
                </div>
                <div
                  className="search-result-excerpt"
                  dangerouslySetInnerHTML={{ __html: r.excerpt }}
                />
              </li>
            ))}
          </ul>
        )}

        {query.trim() && !loading && results.length === 0 && (
          <div className="search-empty">No results for "{query}"</div>
        )}
      </div>
    </div>
  );
}
