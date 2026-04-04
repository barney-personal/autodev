import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';

interface RecoveryState {
  attempts: number;
  window_started_at: number;
  lock_until: number;
  last_claim_at: number;
  last_reason: string;
}

interface ClaimOptions {
  maxAttempts?: number;
  windowMs?: number;
  lockMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_MS = 2 * 60 * 1000;

function familyId(job: Job): string {
  return job.original_job_id ?? job.id;
}

function noteKey(job: Job): string {
  return `recovery:${familyId(job)}`;
}

function readState(job: Job): RecoveryState | null {
  const raw = queries.getNote(noteKey(job))?.value ?? null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecoveryState;
  } catch (err) {
    // Malformed recovery note — treat as missing state so the caller resets cleanly
    console.debug('[recovery-ledger] malformed recovery state JSON, treating as no state:', err);
    return null;
  }
}

function writeState(job: Job, state: RecoveryState): void {
  queries.upsertNote(noteKey(job), JSON.stringify(state), null);
}

export function claimRecovery(job: Job, reason: string, options: ClaimOptions = {}): boolean {
  const now = Date.now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
  const current = readState(job);

  if (current && current.lock_until > now) {
    console.log(`[recovery-ledger] deny ${reason} for job family ${familyId(job)}: active lock for ${Math.ceil((current.lock_until - now) / 1000)}s`);
    return false;
  }

  const base: RecoveryState = (!current || now - current.window_started_at > windowMs)
    ? {
        attempts: 0,
        window_started_at: now,
        lock_until: 0,
        last_claim_at: 0,
        last_reason: '',
      }
    : current;

  if (base.attempts >= maxAttempts) {
    console.log(`[recovery-ledger] deny ${reason} for job family ${familyId(job)}: ${base.attempts}/${maxAttempts} attempts used in window`);
    return false;
  }

  const next: RecoveryState = {
    attempts: base.attempts + 1,
    window_started_at: base.window_started_at,
    lock_until: now + lockMs,
    last_claim_at: now,
    last_reason: reason,
  };
  writeState(job, next);
  console.log(`[recovery-ledger] claim ${reason} for job family ${familyId(job)} (${next.attempts}/${maxAttempts})`);
  return true;
}

export function clearRecoveryState(job: Job): void {
  queries.deleteNote(noteKey(job));
}

/**
 * Check if a job family has exhausted its recovery budget.
 * Useful for deciding whether to block a workflow or keep retrying.
 */
export function isRecoveryExhausted(job: Job, options: ClaimOptions = {}): boolean {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const current = readState(job);
  if (!current) return false;

  const now = Date.now();
  // If the window has expired, the budget is reset — not exhausted
  if (now - current.window_started_at > windowMs) return false;

  return current.attempts >= maxAttempts;
}

/**
 * Get a summary of the recovery state for a job family.
 * Used by the health endpoint and debugging.
 */
export function getRecoverySummary(job: Job): {
  attempts: number;
  maxAttempts: number;
  windowStartedAt: number;
  lockUntil: number;
  lastReason: string;
  exhausted: boolean;
} | null {
  const current = readState(job);
  if (!current) return null;

  return {
    attempts: current.attempts,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    windowStartedAt: current.window_started_at,
    lockUntil: current.lock_until,
    lastReason: current.last_reason,
    exhausted: isRecoveryExhausted(job),
  };
}

export function _resetForTest(): void {
  for (const note of queries.listNotes('recovery:')) {
    queries.deleteNote(note.key);
  }
}
