import { execFileSync } from 'child_process';
import * as fs from 'fs';

const TMUX = process.env.TMUX_BIN ?? 'tmux';

export const MAX_PTY_SESSIONS = Number(process.env.MAX_PTY_SESSIONS ?? 20);

// Resource exhaustion backoff — escalates exponentially on repeated PTY failures
let _resourceBackoffMs = 0;
let _lastResourceErrorTime = 0;
const RESOURCE_BACKOFF_BASE = 30_000;
const RESOURCE_BACKOFF_MAX = 300_000; // 5 minutes max

export function getBackoffMs(): number {
  return _resourceBackoffMs;
}

export function escalateBackoff(): void {
  _resourceBackoffMs = _resourceBackoffMs === 0
    ? RESOURCE_BACKOFF_BASE
    : Math.min(_resourceBackoffMs * 2, RESOURCE_BACKOFF_MAX);
}

export function resetBackoff(): void {
  _resourceBackoffMs = 0;
}

export function setLastResourceErrorTime(time: number): void {
  _lastResourceErrorTime = time;
}

export function getLastResourceErrorTime(): number {
  return _lastResourceErrorTime;
}

/**
 * Pure resource availability check. Takes attached and spawning counts as
 * parameters so callers don't need to expose their internal maps.
 *
 * Checks (in order):
 * 1. In-memory concurrency cap (attached + spawning >= MAX_PTY_SESSIONS)
 * 2. Resource backoff cooldown (recent failure → exponential backoff)
 * 3. tmux ground-truth session count (catches leaked sessions)
 * 4. System PTY probe (/dev/ptmx availability)
 */
export function checkResources(attachedCount: number, spawningCount: number): { ok: boolean; reason?: string } {
  const active = attachedCount + spawningCount;
  if (active >= MAX_PTY_SESSIONS) {
    return { ok: false, reason: `Active PTY sessions (${attachedCount} attached + ${spawningCount} spawning = ${active}) at limit (${MAX_PTY_SESSIONS})` };
  }

  // Backoff check — don't spawn if we recently hit resource exhaustion
  if (_resourceBackoffMs > 0 && Date.now() - _lastResourceErrorTime < _resourceBackoffMs) {
    return { ok: false, reason: `Resource backoff active (${Math.ceil((_resourceBackoffMs - (Date.now() - _lastResourceErrorTime)) / 1000)}s remaining)` };
  }

  // Ground-truth check: count actual tmux sessions to catch leaked sessions
  // not tracked in _ptys or agentStates
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], {
      stdio: 'pipe', timeout: 3000,
    }).toString();
    const tmuxCount = out.trim().split('\n').filter(s => s.startsWith('orchestrator-')).length;
    if (tmuxCount >= MAX_PTY_SESSIONS) {
      return { ok: false, reason: `Live tmux sessions (${tmuxCount}) at limit (${MAX_PTY_SESSIONS}) — possible session leak` };
    }
  } catch {
    // tmux not running or no sessions — that's fine, proceed
  }

  // System-level PTY probe — try to open a PTY to verify the system can allocate one
  try {
    const fd = fs.openSync('/dev/ptmx', 'r');
    fs.closeSync(fd);
  } catch {
    return { ok: false, reason: 'System PTY exhaustion detected (/dev/ptmx unavailable)' };
  }

  return { ok: true };
}

console.log(`[pty] MAX_PTY_SESSIONS=${MAX_PTY_SESSIONS} (env MAX_PTY_SESSIONS=${process.env.MAX_PTY_SESSIONS ?? 'unset, using default'})`);
