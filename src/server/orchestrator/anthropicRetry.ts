/**
 * Shared retry + transient-error classification for the orchestrator's own
 * Anthropic SDK calls (ResolverSession, WatcherSession).
 *
 * Both sessions drive the Messages API directly rather than through an agent
 * PTY, so a provider blip (500 / 529) or the host losing its network
 * (EHOSTUNREACH on v6 then ETIMEDOUT on v4) surfaces as a thrown error inside
 * a single tick. The resolver already retried those; the watcher did not, so
 * every transient failure became a Sentry issue plus a watcher flipped to
 * status='error'. This module is the resolver's proven logic lifted verbatim,
 * plus transport-failure classification, so both callers share one predicate.
 *
 * Nothing here decides what a failure *means*: once the retries are exhausted
 * the error is rethrown and the caller owns the reporting policy. See
 * WatcherSession.runTick for the bounded "N consecutive transient failures,
 * then escalate exactly as if it had been permanent" rule — a retry helper
 * must never be the reason a real outage goes unreported.
 */
import type Anthropic from '@anthropic-ai/sdk';

/** Provider-side statuses worth retrying. */
export const RETRYABLE_API_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Default number of retries AFTER the initial attempt. */
export const MAX_ANTHROPIC_API_RETRIES = 3;

/**
 * Transport-level failures: the request never reached the provider. The SDK
 * wraps these as APIConnectionError / APIConnectionTimeoutError, whose
 * `status` is undefined, so the status check alone can't see them.
 *
 * We match on constructor name + errno code + message text rather than
 * `instanceof` because several suites replace '@anthropic-ai/sdk' with a stub
 * module that exports only the client class — `err instanceof undefined`
 * would throw inside the error handler.
 */
const TRANSPORT_ERROR_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

const TRANSPORT_ERROR_PATTERNS = [
  'Connection error.',   // APIConnectionError default message
  'Request timed out.',  // APIConnectionTimeoutError default message
  'fetch failed',        // undici, wrapped by the SDK
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
];

/** Depth cap when walking `err.cause` — undici nests fetch failures. */
const MAX_CAUSE_DEPTH = 5;

export function getAnthropicErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === 'number' && Number.isFinite(status)) return status;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/\b(408|429|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function isTransportError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
    const ctorName = (cur as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && TRANSPORT_ERROR_CONSTRUCTORS.has(ctorName)) return true;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_ERROR_PATTERNS.includes(code)) return true;
    const message = cur instanceof Error ? cur.message : typeof cur === 'string' ? cur : '';
    if (message && TRANSPORT_ERROR_PATTERNS.some(p => message.includes(p))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when the failure is a provider/transport transient that a later
 * attempt could plausibly succeed at. An error carrying a non-retryable HTTP
 * status (400, 401, 422, …) is never treated as transient, even if its body
 * happens to contain connection-ish wording.
 */
export function isRetryableApiError(err: unknown): boolean {
  const status = getAnthropicErrorStatus(err);
  if (status !== null) return RETRYABLE_API_STATUSES.has(status);
  return isTransportError(err);
}

export function anthropicApiBackoffMs(attempt: number): number {
  if (process.env.VITEST) return 0;
  const base = [1000, 3000, 8000][attempt] ?? 8000;
  const jitter = base * 0.3 * (2 * Math.random() - 1);
  return Math.max(250, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call `messages.create` with bounded retries on transient failures.
 *
 * The client is passed as a factory so each attempt re-reads the caller's
 * module-level singleton (which tests replace via their own `_set*Client`
 * hooks). A non-retryable error is rethrown immediately; a retryable one is
 * rethrown once the attempt budget is spent.
 */
export async function createAnthropicMessage(
  getClient: () => Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  log: { warn: (obj: unknown, msg?: string) => void },
  opts: { maxRetries?: number; label?: string } = {},
): Promise<Anthropic.Messages.Message> {
  const maxRetries = opts.maxRetries ?? MAX_ANTHROPIC_API_RETRIES;
  const label = opts.label ?? 'anthropic';
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getClient().messages.create(params);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryableApiError(err)) {
        throw err;
      }
      const waitMs = anthropicApiBackoffMs(attempt);
      log.warn(
        { err, attempt: attempt + 1, max_retries: maxRetries, wait_ms: waitMs },
        `${label} API call failed with retryable provider error — retrying`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}
