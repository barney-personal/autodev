import * as queries from '../db/queries.js';

export type FailureKind =
  | 'rate_limit'
  | 'provider_overload'
  | 'provider_capability'
  | 'provider_billing'
  | 'launch_environment'
  | 'mcp_disconnect'
  | 'timeout'
  | 'out_of_memory'
  | 'disk_full'
  | 'auth_failure'
  | 'context_overflow'
  | 'codex_cli_crash'
  | 'task_failure'
  | 'unknown';

const RATE_LIMIT_PATTERNS = [
  /\brate[_ -]?limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\bretry[_ -]?after\b/i,
];

const PROVIDER_OVERLOAD_PATTERNS = [
  /\boverloaded_error\b/i,
  /\boverloaded\b/i,
  /\b529\b/,
  /\bservice[_ -]?unavailable\b/i,
  /\b503\b/,
];

const PROVIDER_CAPABILITY_PATTERNS = [
  /\bextra usage is required\b/i,
  /\brequires extra usage\b/i,
  /\b1m context\b/i,
  /\bunsupported model\b/i,
  /\bmodel not available\b/i,
  /\bnot available on your plan\b/i,
  /\bdoes not support\b.*\bcontext\b/i,
];

const PROVIDER_BILLING_PATTERNS = [
  /\binsufficient credits?\b/i,
  /\binsufficient balance\b/i,
  /\bbilling\b/i,
  /\bpayment required\b/i,
  /\bcredit balance\b/i,
];

const LAUNCH_ENVIRONMENT_PATTERNS = [
  /\bagent launch failed\b/i,
  /\bspawn\s+\S+\s+ENOENT\b/i,
  /\bspawn nice ENOENT\b/i,
  /\bposix_spawnp failed\b/i,
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
];

const MCP_DISCONNECT_PATTERNS = [
  /\bmcp connection (?:dropped|lost|closed)\b/i,
  /\bsession not found\b/i,
  /\btransport\b/i,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bsocket hang up\b/i,
];

const TIMEOUT_PATTERNS = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bdeadline exceeded\b/i,
  /\bETIMEDOUT\b/,
];

const OOM_PATTERNS = [
  /\bout of memory\b/i,
  /\bheap out of memory\b/i,
  /\bENOMEM\b/,
  /\bkilled by oom\b/i,
  /\bJavaScript heap\b/i,
];

const DISK_FULL_PATTERNS = [
  /\bENOSPC\b/,
  /\bno space left\b/i,
  /\bdisk full\b/i,
  /\bdisk quota\b/i,
];

const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binvalid[_ -]?api[_ -]?key\b/i,
  /\bauthentication[_ -]?error\b/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext[_ -]?(?:length|window|limit)\b/i,
  /\btoo many tokens\b/i,
  /\bmax[_ -]?tokens\b/i,
  /\bcontext overflow\b/i,
];

const CODEX_CLI_CRASH_PATTERNS = [
  /\breading (?:additional )?input from stdin\b/i,
  /\breading prompt from stdin\b/i,
];

const SESSIONSTART_EVENT_PATTERN = /"hook_event"\s*:\s*"SessionStart"/i;
const SESSIONSTART_HOOK_NAME_PATTERN = /"hook_name"\s*:\s*"SessionStart:startup"/i;
const STARTUP_TOOL_IDENTIFIER_PATTERN = /\bmcp__[\w:-]+\b/g;
const STARTUP_FAILURE_SIGNAL_PATTERN = /\b(error|errors|failed|failure|exception|timed out|timeout|deadline exceeded|unauthorized|forbidden|overloaded|unavailable|insufficient|billing|payment|invalid|refused|reset|hang up|disconnect|spawn|enoent|enospc|enomem|oom)\b/i;

// Dedup set for unclassified failure warnings — keyed on first 200 chars, capped at 100 entries
const _warnedUnclassified = new Set<string>();
const WARN_DEDUP_CAP = 100;

function isSessionStartLifecycleNoise(text: string): boolean {
  const hasSessionStartEvent = SESSIONSTART_EVENT_PATTERN.test(text);
  const hasSessionStartHookName = SESSIONSTART_HOOK_NAME_PATTERN.test(text);

  // Match only when we can confirm this is a SessionStart lifecycle event.
  // Requires explicit "hook_name":"SessionStart:startup" or "hook_event":"SessionStart" —
  // never match on generic "type":"system" + "subtype":"hook_started" alone,
  // which would hide failures from non-SessionStart hooks.
  return hasSessionStartHookName || hasSessionStartEvent;
}

function isStartupToolListNoise(text: string): boolean {
  const toolIdentifiers = text.match(STARTUP_TOOL_IDENTIFIER_PATTERN) ?? [];
  if (toolIdentifiers.length < 3) return false;
  if (STARTUP_FAILURE_SIGNAL_PATTERN.test(text)) return false;

  const identifierChars = toolIdentifiers.reduce((sum, match) => sum + match.length, 0);
  return identifierChars / text.length >= 0.35;
}

export function classifyFailureText(text: string | null | undefined): FailureKind {
  if (!text) return 'unknown';
  const normalized = text.trim();
  if (!normalized) return 'unknown';

  // Check patterns in order of specificity / priority
  if (LAUNCH_ENVIRONMENT_PATTERNS.some(pattern => pattern.test(normalized))) return 'launch_environment';
  if (RATE_LIMIT_PATTERNS.some(pattern => pattern.test(normalized))) return 'rate_limit';
  if (PROVIDER_OVERLOAD_PATTERNS.some(pattern => pattern.test(normalized))) return 'provider_overload';
  if (PROVIDER_CAPABILITY_PATTERNS.some(pattern => pattern.test(normalized))) return 'provider_capability';
  if (PROVIDER_BILLING_PATTERNS.some(pattern => pattern.test(normalized))) return 'provider_billing';
  if (AUTH_PATTERNS.some(pattern => pattern.test(normalized))) return 'auth_failure';
  if (OOM_PATTERNS.some(pattern => pattern.test(normalized))) return 'out_of_memory';
  if (DISK_FULL_PATTERNS.some(pattern => pattern.test(normalized))) return 'disk_full';
  if (CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(normalized))) return 'context_overflow';
  if (MCP_DISCONNECT_PATTERNS.some(pattern => pattern.test(normalized))) return 'mcp_disconnect';
  if (TIMEOUT_PATTERNS.some(pattern => pattern.test(normalized))) return 'timeout';
  if (CODEX_CLI_CRASH_PATTERNS.some(pattern => pattern.test(normalized))) return 'codex_cli_crash';

  if (isSessionStartLifecycleNoise(normalized) || isStartupToolListNoise(normalized)) {
    return 'unknown';
  }

  // Warn about unclassified failure text so operators can identify new patterns
  const dedupKey = normalized.slice(0, 200);
  if (!_warnedUnclassified.has(dedupKey)) {
    if (_warnedUnclassified.size >= WARN_DEDUP_CAP) {
      _warnedUnclassified.clear();
    }
    _warnedUnclassified.add(dedupKey);
    console.warn(`[FailureClassifier] Unclassified failure text (falling back to task_failure): ${dedupKey}`);
  }

  return 'task_failure';
}

/** Reset the dedup set — for tests only */
export function _resetWarnedUnclassifiedForTest(): void {
  _warnedUnclassified.clear();
}

export function classifyJobFailure(jobId: string): FailureKind {
  const latestAgent = queries.getAgentsWithJobByJobId(jobId)[0] ?? null;
  if (!latestAgent) return 'unknown';

  const tail = queries.getAgentOutput(latestAgent.id, 50);
  const transcript = tail.map(row => row.content).join('\n');
  const combined = [latestAgent.error_message, transcript].filter(Boolean).join('\n');

  return classifyFailureText(combined);
}

export function isFallbackEligibleFailure(kind: FailureKind): boolean {
  return kind === 'launch_environment'
    || kind === 'rate_limit'
    || kind === 'provider_overload'
    || kind === 'provider_capability'
    || kind === 'provider_billing'
    || kind === 'auth_failure';
}

export function isSameModelRetryEligible(kind: FailureKind): boolean {
  return kind === 'codex_cli_crash'
    || kind === 'timeout';
}

export function shouldMarkProviderUnavailable(kind: FailureKind): boolean {
  // NOTE: rate_limit is intentionally excluded. Anthropic 429s are per-model
  // (opus vs sonnet vs haiku have independent quota buckets), so marking the
  // entire provider unavailable on a single model's 429 causes cascading
  // fallback failures — e.g. opus rate_limit would also block sonnet[1m] and
  // haiku recoveries. Let each model get individually rate-limited as the
  // fallback chain walks. See `markModelRateLimited` in ModelClassifier.ts.
  return kind === 'provider_overload'
    || kind === 'provider_billing'
    || kind === 'auth_failure';
}
