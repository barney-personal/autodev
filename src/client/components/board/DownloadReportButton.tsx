import { useEffect, useRef, useState } from 'react';
import { workflowReportFilename } from '@shared/workflowReport';

/** Let the browser start its attachment download before removing the anchor. */
export const REPORT_CLEANUP_DELAY_MS = 1000;

type Message = { kind: 'status' | 'alert'; text: string } | null;

function describeHttpError(res: Response): string {
  if (res.status === 404) return 'Report unavailable: this workflow was not found.';
  if (res.status === 401) return 'Report unavailable: sign in again to download it.';
  return `Could not download report (HTTP ${res.status}).`;
}

export function DownloadReportButton({ workflowId }: { workflowId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  // The active request; cleared on unmount/workflow change so stale responses are discarded.
  const activeRef = useRef<{ controller: AbortController } | null>(null);

  useEffect(() => {
    setPending(false);
    setMessage(null);
    return () => {
      activeRef.current?.controller.abort();
      activeRef.current = null;
    };
  }, [workflowId]);

  const handleClick = async () => {
    if (activeRef.current) return;
    const request = { controller: new AbortController() };
    activeRef.current = request;
    const isCurrent = () => activeRef.current === request && !request.controller.signal.aborted;
    setPending(true);
    setMessage(null);

    let anchor: HTMLAnchorElement | null = null;
    try {
      const reportUrl = `/api/workflows/${encodeURIComponent(workflowId)}/report`;
      // Check availability for accessible errors, then let the browser handle
      // Content-Disposition. Embedded browsers may not save blob: downloads.
      const res = await fetch(reportUrl, {
        method: 'HEAD',
        signal: request.controller.signal,
        credentials: 'same-origin',
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        setMessage({ kind: 'alert', text: describeHttpError(res) });
        return;
      }
      anchor = document.createElement('a');
      anchor.href = reportUrl;
      anchor.download = workflowReportFilename(workflowId);
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      setMessage({ kind: 'status', text: 'Report download started.' });
    } catch {
      if (isCurrent()) {
        setMessage({ kind: 'alert', text: 'Could not download report. Check your connection and try again.' });
      }
    } finally {
      if (anchor) {
        const link = anchor;
        setTimeout(() => {
          link.remove();
        }, REPORT_CLEANUP_DELAY_MS);
      }
      if (activeRef.current === request) {
        activeRef.current = null;
        setPending(false);
      }
    }
  };

  return (
    <div className="cr-report">
      <button
        type="button"
        className="ad-btn-ghost"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? 'Preparing report…' : 'Download report'}
      </button>
      <p className="cr-report-msg" role="status">{message?.kind === 'status' ? message.text : ''}</p>
      {message?.kind === 'alert' && <p className="cr-report-msg cr-report-error" role="alert">{message.text}</p>}
    </div>
  );
}
