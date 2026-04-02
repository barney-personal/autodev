import * as queries from '../db/queries.js';

export type FailureKind =
  | 'rate_limit'
  | 'provider_overload'
  | 'provider_capability'
  | 'provider_billing'
  | 'mcp_disconnect'
  | 'timeout'
  | 'out_of_memory'
  | 'disk_full'
  | 'auth_failure'
  | 'context_overflow'
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

export function classifyFailureText(text: string | null | undefined): FailureKind {
  if (!text) return 'unknown';

  // Check patterns in order of specificity / priority
  if (RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text))) return 'rate_limit';
  if (PROVIDER_OVERLOAD_PATTERNS.some(pattern => pattern.test(text))) return 'provider_overload';
  if (PROVIDER_CAPABILITY_PATTERNS.some(pattern => pattern.test(text))) return 'provider_capability';
  if (PROVIDER_BILLING_PATTERNS.some(pattern => pattern.test(text))) return 'provider_billing';
  if (AUTH_PATTERNS.some(pattern => pattern.test(text))) return 'auth_failure';
  if (OOM_PATTERNS.some(pattern => pattern.test(text))) return 'out_of_memory';
  if (DISK_FULL_PATTERNS.some(pattern => pattern.test(text))) return 'disk_full';
  if (CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(text))) return 'context_overflow';
  if (MCP_DISCONNECT_PATTERNS.some(pattern => pattern.test(text))) return 'mcp_disconnect';
  if (TIMEOUT_PATTERNS.some(pattern => pattern.test(text))) return 'timeout';

  return 'task_failure';
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
  return kind === 'rate_limit'
    || kind === 'provider_overload'
    || kind === 'provider_capability'
    || kind === 'provider_billing';
}

export function shouldMarkProviderUnavailable(kind: FailureKind): boolean {
  return kind === 'rate_limit'
    || kind === 'provider_overload'
    || kind === 'provider_billing';
}
