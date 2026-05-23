/**
 * PtyCleanupService — periodic reclamation for leaked orchestrator tmux/PTY sessions.
 *
 * The work queue checks PTY capacity before dispatching, but a leaked tmux
 * session can keep the host at capacity while no new jobs are being spawned.
 * This service runs independently of dispatch so idle systems still reclaim
 * unused `orchestrator-*` sessions.
 */

import { captureWithContext } from '../instrument.js';
import { cleanupStaleTmuxSessions } from './PtyManager.js';
import type { PtyCleanupStats } from './PtyManager.js';

const DEFAULT_CLEANUP_INTERVAL_MS = 30_000;

let _timer: NodeJS.Timeout | null = null;
let _tickInProgress = false;
let _retickRequested = false;
let _lastStats: PtyCleanupStats | null = null;
let _lastRunAt: number | null = null;

function configuredIntervalMs(): number {
  const parsed = Number(process.env.PTY_CLEANUP_INTERVAL_MS ?? DEFAULT_CLEANUP_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CLEANUP_INTERVAL_MS;
  return Math.round(parsed);
}

export function runPtyCleanupNow(): PtyCleanupStats | null {
  if (_tickInProgress) {
    _retickRequested = true;
    return null;
  }

  _tickInProgress = true;
  try {
    const stats = cleanupStaleTmuxSessions();
    _lastStats = stats;
    _lastRunAt = Date.now();
    if (stats.killed > 0 || stats.errors > 0) {
      console.log(`[pty-cleanup] scanned=${stats.scanned} killed=${stats.killed} skipped=${stats.skipped} errors=${stats.errors}`);
    }
    return stats;
  } catch (err) {
    console.warn('[pty-cleanup] cleanup tick failed:', err);
    captureWithContext(err, { component: 'PtyCleanupService' });
    return null;
  } finally {
    _tickInProgress = false;
    if (_retickRequested) {
      _retickRequested = false;
      setImmediate(() => {
        try { runPtyCleanupNow(); } catch { /* runPtyCleanupNow handles its own errors */ }
      });
    }
  }
}

export function startPtyCleanupService(intervalMs = configuredIntervalMs()): void {
  if (_timer) return;
  const normalizedIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.round(intervalMs)
    : DEFAULT_CLEANUP_INTERVAL_MS;
  console.log(`[pty-cleanup] started (interval: ${Math.round(normalizedIntervalMs / 1000)}s)`);
  runPtyCleanupNow();
  _timer = setInterval(() => {
    runPtyCleanupNow();
  }, normalizedIntervalMs);
  _timer.unref();
}

export function stopPtyCleanupService(): void {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}

export function _getPtyCleanupServiceStateForTest(): {
  running: boolean;
  tickInProgress: boolean;
  retickRequested: boolean;
  lastStats: PtyCleanupStats | null;
  lastRunAt: number | null;
} {
  return {
    running: _timer !== null,
    tickInProgress: _tickInProgress,
    retickRequested: _retickRequested,
    lastStats: _lastStats,
    lastRunAt: _lastRunAt,
  };
}

export function _resetPtyCleanupServiceForTest(): void {
  stopPtyCleanupService();
  _tickInProgress = false;
  _retickRequested = false;
  _lastStats = null;
  _lastRunAt = null;
}
