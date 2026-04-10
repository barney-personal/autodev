import { useState, useCallback } from 'react';
import type { Toast } from '../hooks/useToasts';

interface ToastFeedProps {
  toasts: Toast[];
  dismiss: (id: string) => void;
  onSelectAgent?: (agentId: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

export function ToastFeed({ toasts, dismiss, onSelectAgent }: ToastFeedProps) {
  // Track toasts that are animating out
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());

  const handleDismiss = useCallback((id: string) => {
    setDismissing(prev => new Set(prev).add(id));
    setTimeout(() => {
      setDismissing(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      dismiss(id);
    }, 250);
  }, [dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}${dismissing.has(toast.id) ? ' toast-out' : ''}`}
          onClick={() => {
            if (toast.agentId && onSelectAgent) onSelectAgent(toast.agentId);
            handleDismiss(toast.id);
          }}
        >
          <div className="toast-body">
            <span className="toast-message">{toast.message}</span>
            <span className="toast-time">{timeAgo(toast.timestamp)}</span>
          </div>
          <button
            className="toast-close"
            onClick={(e) => { e.stopPropagation(); handleDismiss(toast.id); }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
