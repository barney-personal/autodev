/**
 * ResolverFingerprint — normalize a workflow's blocked_reason into a stable
 * hash so the dispatcher can answer "is this the same problem as last time?"
 *
 * Pure module: no DB, no IO. Easy to test, easy to tune.
 *
 * Two outputs:
 * - fingerprint(reason): a 16-char hex digest of the normalized form. Used as
 *   the idempotency key and the circuit-breaker key.
 * - classifyHeuristic(reason): a coarse first-guess classification used by
 *   the dispatcher to pick a starting confidence threshold. The Resolver LLM
 *   may override this — the heuristic only seeds the policy.
 */
import { createHash } from 'crypto';
import type { ResolverClassification } from '../../shared/types.js';

const HEX8_RE = /\b[0-9a-f]{8,40}\b/gi;             // job IDs, agent IDs, SHAs
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}t\d{2}[-:]\d{2}[-:]\d{2}[.\dz-]*/gi;
const UNIX_MS_RE = /\b1[6-9]\d{11}\b/g;             // 13-digit Unix ms timestamps
const ABS_PATH_RE = /\/(?:users|home|var|tmp|opt|workspace|orchestrator-worktrees)\/[^\s'"`]+/gi;
const NUMBER_RE = /\b\d+\b/g;                       // any run of digits (turn counts, costs, etc.)
const WHITESPACE_RE = /\s+/g;

/**
 * Normalize a blocked_reason to a canonical form for fingerprinting.
 * Strips identifiers (hex IDs, timestamps, absolute paths, counts) and
 * collapses whitespace so semantically-equivalent reasons hash the same.
 *
 * Order matters: ABS_PATH and ISO_DATE must run BEFORE the generic NUMBER
 * replacement, otherwise their digit components get rewritten to `<N>` and
 * the more specific regexes never match.
 */
export function normalizeReason(reason: string | null | undefined): string {
  if (!reason) return '';
  return reason
    .toLowerCase()
    .replace(ABS_PATH_RE, (match) => {
      // Keep filename so "missing src/foo.ts" and "missing src/bar.ts" stay distinct.
      const segs = match.split('/').filter(Boolean);
      const last = segs[segs.length - 1] ?? '';
      return last ? `<PATH>/${last}` : '<PATH>';
    })
    .replace(ISO_DATE_RE, '<TS>')
    .replace(UNIX_MS_RE, '<TS>')
    .replace(HEX8_RE, '<ID>')
    .replace(NUMBER_RE, '<N>')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/** 16-char hex fingerprint. Short enough to log, long enough to dedup. */
export function fingerprint(reason: string | null | undefined): string {
  return createHash('sha256').update(normalizeReason(reason)).digest('hex').slice(0, 16);
}

/**
 * Coarse classification from string matching. The Resolver LLM is expected
 * to refine this — but we want a sensible starting point so the dispatcher
 * can pick a confidence threshold and the dashboard can show "we think this
 * is a transient infra issue" even before the LLM ticks.
 */
export function classifyHeuristic(reason: string | null | undefined): ResolverClassification {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();

  // Transient infra — PTY/network/process death.
  if (/\b(pty|fork failed|device not configured|tmux|process not found|killed|sigkill|enomem|eagain)\b/.test(r)) {
    return 'transient_infra';
  }
  if (/infrastructure failure|0 turns/.test(r)) return 'transient_infra';

  // Config drift — worktree/branch/work_dir hygiene.
  if (/work_dir|worktree|missing worktree|branch.*missing|cannot find branch/.test(r)) {
    return 'config_drift';
  }

  // Model capability — model exhausted retries / no fallback / context full.
  if (/model.*fallback|alt.?provider|context.*(window|exhausted|too long)|max.tokens/.test(r)) {
    return 'model_capability';
  }
  if (/rate.?limit|429|overload|provider.*unavailable/.test(r)) {
    return 'external_service';
  }

  // External service — push/PR/network to GitHub.
  if (/gh.*pr|github.*api|push failed|remote.*rejected|gh: command|gh auth/.test(r)) {
    return 'external_service';
  }

  // Code bug — actual test/lint/compile failure surfacing.
  if (/test.*fail|assertion|lint|typecheck|compile|syntax error|exit code [1-9]/.test(r)) {
    return 'code_bug';
  }

  // Diminishing returns / zero progress — model isn't capable of this task.
  if (/diminishing returns|zero[- ]progress|max cycles/.test(r)) {
    return 'model_capability';
  }

  return 'unknown';
}

/** Confidence threshold required for the dispatcher to auto-resume given a
 *  classification. Below threshold → escalate to human regardless. */
export function autoResumeConfidenceThreshold(classification: ResolverClassification): number {
  switch (classification) {
    case 'transient_infra': return 0.6;
    case 'config_drift':    return 0.7;
    case 'model_capability': return 0.7;
    case 'external_service': return 0.5;
    case 'code_bug':         return 0.85;
    case 'unknown':          return 1.01; // unreachable — always escalate
  }
}
