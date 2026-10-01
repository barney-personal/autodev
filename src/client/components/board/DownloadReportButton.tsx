import { useEffect, useRef, useState } from 'react';
import { workflowReportFilename } from '@shared/workflowReport';

/** Delay before removing the temporary anchor / revoking the object URL, so the browser can start the download first. */
export const REPORT_CLEANUP_DELAY_MS = 1000;
const MAX_ERROR_CHARS = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;

type Message = { kind: 'status' | 'alert'; text: string } | null;

async function describeHttpError(res: Response): Promise<string> {
  if (res.status === 404) return 'Report unavailable: this workflow was not found.';
  if (res.status === 401) return 'Report unavailable: sign in again to download it.';
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(await res.text());
    const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    if (typeof error === 'string') {
      detail = error.replace(CONTROL_CHARS, ' ').trim();
      if (detail.length > MAX_ERROR_CHARS) detail = `${detail.slice(0, MAX_ERROR_CHARS)}…`;
    }
  } catch {
    // Empty, HTML or malformed bodies fall back to the HTTP status.
  }
  return detail
    ? `Could not download report: ${detail} (HTTP ${res.status}).`
    : `Could not download report (HTTP ${res.status}).`;
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

    let objectUrl: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/report`, {
        signal: request.controller.signal,
        credentials: 'same-origin',
      });
      if (!isCurrent()) return;
      if (!res.ok) {
        const text = await describeHttpError(res);
        if (isCurrent()) setMessage({ kind: 'alert', text });
        return;
      }
      const blob = await res.blob();
      if (!isCurrent()) return;
      objectUrl = URL.createObjectURL(blob);
      anchor = document.createElement('a');
      anchor.href = objectUrl;
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
      if (objectUrl || anchor) {
        const url = objectUrl;
        const link = anchor;
        setTimeout(() => {
          link?.remove();
          if (url) URL.revokeObjectURL(url);
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
