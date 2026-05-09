/**
 * Shared formatters for the workflow board surfaces (cards, control room,
 * loose-jobs modal). Extracted so the same elapsed/relative/cost rendering
 * doesn't drift between components.
 */

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return ms === 0 ? '0s' : `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtRel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3.6e6) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86.4e6) return `${Math.floor(d / 3.6e6)}h ago`;
  return `${Math.floor(d / 86.4e6)}d ago`;
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Apple-style elapsed string used by the workflow card footer:
 * compact ("2h 45m" / "30m" / "12s") and never returns "0s" surprise units.
 */
export function fmtElapsedCompact(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Compact relative-time variant used in dense places (rail items, loose-jobs):
 * "now" / "5m" / "2h" / "3d" / "5w".
 */
export function fmtRelShort(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3.6e6) return `${Math.floor(d / 60_000)}m`;
  if (d < 86.4e6) return `${Math.floor(d / 3.6e6)}h`;
  if (d < 86.4e6 * 7) return `${Math.floor(d / 86.4e6)}d`;
  return `${Math.floor(d / 86.4e6 / 7)}w`;
}
