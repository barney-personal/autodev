import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job } from '../../shared/types.js';
import { claimRecovery } from './RecoveryLedger.js';

// Exponential backoff parameters
const BASE_DELAY_MS = 30_000;      // 30s base delay
const MAX_DELAY_MS = 10 * 60_000;  // 10 minute max delay
const JITTER_FACTOR = 0.3;         // +-30% jitter to prevent thundering herd

/**
 * Compute the backoff delay for a given retry attempt using exponential backoff with jitter.
 * attempt 1 → ~30s, attempt 2 → ~60s, attempt 3 → ~120s, etc.
 */
export function computeBackoffDelay(retryCount: number): number {
  const exponentialDelay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  const jitter = exponentialDelay * JITTER_FACTOR * (2 * Math.random() - 1); // [-30%, +30%]
  return Math.max(1000, Math.round(exponentialDelay + jitter)); // at least 1s
}

/**
 * Handles retry logic for a failed job.
 * Returns true if a retry was scheduled, false otherwise.
 */
export function handleRetry(job: Job, agentId: string): boolean {
  if (job.retry_policy === 'none') return false;
  if (job.retry_count >= job.max_retries) {
    console.log(`[retry] job ${job.id} exhausted all ${job.max_retries} retries`);
    return false;
  }
  if (!claimRecovery(job, 'retry-policy', { maxAttempts: job.max_retries + 1, lockMs: 60_000 })) {
    return false;
  }

  if (job.retry_policy === 'same') {
    return retrySame(job);
  } else if (job.retry_policy === 'analyze') {
    return retryAnalyze(job, agentId);
  }

  return false;
}

function retrySame(job: Job): boolean {
  const originalJobId = job.original_job_id ?? job.id;
  const retryCount = job.retry_count + 1;
  const backoffMs = computeBackoffDelay(retryCount - 1);
  const scheduledAt = Date.now() + backoffMs;

  console.log(`[retry] cloning job ${job.id} (same strategy, attempt ${retryCount}/${job.max_retries}, backoff ${Math.round(backoffMs / 1000)}s)`);

  const retryJob = queries.insertJob({
    id: randomUUID(),
    title: job.title,
    description: job.description,
    context: job.context,
    priority: job.priority,
    work_dir: (job as any).work_dir ?? null,
    max_turns: (job as any).max_turns ?? 50,
    model: job.model ?? null,
    template_id: job.template_id ?? null,
    depends_on: null,
    is_interactive: 0,
    use_worktree: job.use_worktree,
    project_id: job.project_id ?? null,
    retry_policy: job.retry_policy,
    max_retries: job.max_retries,
    retry_count: retryCount,
    original_job_id: originalJobId,
    completion_checks: job.completion_checks ?? null,
    scheduled_at: scheduledAt,
  });

  socket.emitJobNew(retryJob);
  console.log(`[retry] queued retry job ${retryJob.id} (attempt ${retryCount}/${job.max_retries}, scheduled in ${Math.round(backoffMs / 1000)}s)`);
  return true;
}

function retryAnalyze(job: Job, agentId: string): boolean {
  const originalJobId = job.original_job_id ?? job.id;
  const retryCount = job.retry_count + 1;
  const backoffMs = computeBackoffDelay(retryCount - 1);
  const scheduledAt = Date.now() + backoffMs;

  console.log(`[retry] spawning analysis agent for job ${job.id} (attempt ${retryCount}/${job.max_retries}, backoff ${Math.round(backoffMs / 1000)}s)`);

  // Gather failure context
  const agent = queries.getAgentById(agentId);
  const resultText = queries.getAgentResultText(agentId);
  const output = queries.getAgentOutput(agentId);

  // Last 50 readable output lines
  const readableLines: string[] = [];
  for (let i = output.length - 1; i >= 0 && readableLines.length < 50; i--) {
    try {
      const ev = JSON.parse(output[i].content);
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            readableLines.unshift(block.text.slice(0, 500));
          }
        }
      } else if (ev.type === 'result' && ev.result) {
        readableLines.unshift(ev.result.slice(0, 500));
      } else if (ev.type === 'error') {
        readableLines.unshift(`ERROR: ${ev.error?.message ?? ev.message ?? 'unknown'}`);
      }
    } catch { /* skip */ }
  }

  const truncatedDiff = agent?.diff ? agent.diff.slice(0, 10240) : '(no diff)';
  const errorMessage = agent?.error_message ?? '(no error message)';

  const analysisPrompt = buildAnalysisPrompt({
    title: job.title,
    description: job.description,
    errorMessage,
    resultText: resultText ?? '(no result text)',
    outputLines: readableLines,
    diff: truncatedDiff,
    retryCount,
    maxRetries: job.max_retries,
    originalJobId,
    originalJob: job,
  });

  const analysisJob = queries.insertJob({
    id: randomUUID(),
    title: `[Analysis] ${job.title}`.slice(0, 100),
    description: analysisPrompt,
    context: null,
    priority: job.priority + 1, // slightly higher to run soon
    work_dir: (job as any).work_dir ?? null,
    max_turns: 10,
    model: 'claude-haiku-4-5-20251001',
    template_id: null,
    depends_on: null,
    is_interactive: 0,
    use_worktree: 0,
    project_id: job.project_id ?? null,
    retry_policy: 'none', // analysis jobs never retry themselves
    max_retries: 0,
    retry_count: job.retry_count,
    original_job_id: originalJobId,
    completion_checks: null,
    scheduled_at: scheduledAt,
  });

  socket.emitJobNew(analysisJob);
  nudgeQueue();
  console.log(`[retry] queued analysis job ${analysisJob.id} for failed job ${job.id}`);
  return true;
}

interface AnalysisContext {
  title: string;
  description: string;
  errorMessage: string;
  resultText: string;
  outputLines: string[];
  diff: string;
  retryCount: number;
  maxRetries: number;
  originalJobId: string;
  originalJob: Job;
}

function buildAnalysisPrompt(ctx: AnalysisContext): string {
  const workDir = (ctx.originalJob as any).work_dir ?? process.cwd();
  const retrySettings = [
    `retry_policy: '${ctx.originalJob.retry_policy}'`,
    `max_retries: ${ctx.originalJob.max_retries}`,
    `retry_count: ${ctx.retryCount}`,
    `original_job_id: '${ctx.originalJobId}'`,
    ctx.originalJob.completion_checks ? `completion_checks: '${ctx.originalJob.completion_checks}'` : null,
  ].filter(Boolean).join(', ');

  return `You are a failure analysis agent. A task failed and you must diagnose why, then create a refined retry job.

## Original Task
**Title**: ${ctx.title}
**Description**:
${ctx.description}

## Failure Context
**Error message**: ${ctx.errorMessage}
**Result text**: ${ctx.resultText}
**Retry attempt**: ${ctx.retryCount} of ${ctx.maxRetries}

## Last Agent Output (up to 50 lines)
${ctx.outputLines.join('\n')}

## Agent Diff (truncated to 10KB)
\`\`\`
${ctx.diff}
\`\`\`

## Your Instructions

1. **Diagnose** the failure. What went wrong? Was it a code error, a timeout, a missing dependency, a wrong approach?
2. **Write your diagnosis** to the scratchpad using write_note with key \`retry/${ctx.originalJobId}/attempt_${ctx.retryCount}\`.
3. **Create a retry job** using create_job with:
   - The SAME task description as the original, PLUS an "## Previous Failure Analysis" section with your diagnosis and specific guidance on what to do differently
   - work_dir: '${workDir}'
   - max_turns: ${(ctx.originalJob as any).max_turns ?? 50}
   ${ctx.originalJob.model ? `- model: '${ctx.originalJob.model}'` : ''}
   ${ctx.originalJob.template_id ? `- template_id is not available via create_job, so include any relevant template context in the description` : ''}

IMPORTANT constraints:
- Do NOT attempt to fix the code yourself — only diagnose and create the retry job
- The retry job you create will automatically inherit retry settings: ${retrySettings}
- Be specific in your guidance — "try again" is not helpful; explain WHAT to change`;
}
