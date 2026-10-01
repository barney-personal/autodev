/**
 * Shared helpers for the downloadable workflow report.
 * Pure — imported by the server route and the dashboard download button.
 */

const MAX_FILENAME_ID_CHARS = 80;

/** Attachment filename for a workflow report: `autodev-workflow-<safe-id>-report.md`. */
export function workflowReportFilename(workflowId: unknown): string {
  const raw = typeof workflowId === 'string' ? workflowId : '';
  const safe = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_ID_CHARS)
    .replace(/-+$/g, '');
  return `autodev-workflow-${safe || 'unknown'}-report.md`;
}
