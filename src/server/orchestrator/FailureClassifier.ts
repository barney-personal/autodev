import * as queries from '../db/queries.js';

export type FailureKind =
  | 'rate_limit'
  | 'provider_overload'
  | 'mcp_disconnect'
  | 'timeout'
  | 'task_failure'
  | 'unknown';

const RATE_LIMIT_PATTERNS = [
  /\brate[_ -]?limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
];

const PROVIDER_OVERLOAD_PATTERNS = [
  /\boverloaded_error\b/i,
  /\boverloaded\b/i,
  /\b529\b/,
];

const MCP_DISCONNECT_PATTERNS = [
  /\bmcp connection (?:dropped|lost|closed)\b/i,
  /\bsession not found\b/i,
  /\btransport\b/i,
];

const TIMEOUT_PATTERNS = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bdeadline exceeded\b/i,
];

export function classifyFailureText(text: string | null | undefined): FailureKind {
  if (!text) return 'unknown';

  if (RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text))) return 'rate_limit';
  if (PROVIDER_OVERLOAD_PATTERNS.some(pattern => pattern.test(text))) return 'provider_overload';
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
