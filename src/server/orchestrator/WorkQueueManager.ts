import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Sentry } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent } from './AgentRunner.js';
import { startInteractiveAgent } from './PtyManager.js';
import { resolveModel } from './ModelClassifier.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel, isAutoExitJob } from '../../shared/types.js';

let _maxConcurrent = Number(process.env.MAX_CONCURRENT_AGENTS ?? 20);
const POLL_INTERVAL_MS = 2000;
const PROVIDER_PAUSE_RETRY_MS = 60_000;

export function getMaxConcurrent(): number { return _maxConcurrent; }
export function setMaxConcurrent(n: number): void { _maxConcurrent = n; }

let _running = false;
let _timer: NodeJS.Timeout | null = null;
// Tracks jobs currently being classified so the next tick doesn't re-pick them
const _classifying = new Set<string>();

// Queue metrics for health endpoint
let _totalDispatched = 0;
let _totalFailed = 0;
let _lastDispatchAt = 0;

export function getQueueMetrics() {
  return {
    running: _running,
    maxConcurrent: _maxConcurrent,
    classifying: _classifying.size,
    totalDispatched: _totalDispatched,
    totalDispatchFailed: _totalFailed,
    lastDispatchAt: _lastDispatchAt || null,
  };
}

export function startWorkQueue(): void {
  if (_running) return;
  _running = true;
  console.log('[queue] WorkQueueManager started');
  _timer = setInterval(() => { try { tick().catch(console.error); } catch (err) { console.error('[queue] tick error:', err); Sentry.captureException(err); } }, POLL_INTERVAL_MS);
  try { tick().catch(console.error); } catch (err) { console.error('[queue] initial tick error:', err); Sentry.captureException(err); }
}

export function stopWorkQueue(): void {
  _running = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function tick(): Promise<void> {
  if (!_running) return;

  // Cascade-fail: mark queued jobs as failed if any dependency failed/cancelled
  for (const job of queries.getJobsWithFailedDeps()) {
    const failedDeps = queries.getFailedDepsForJob(job.id);
    const names = failedDeps.map(d => `${d.title} (${d.status})`).join(', ');
    console.log(`[queue] cascade-fail "${job.title}" — failed deps: ${names}`);
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  }

  const activeAgents = queries.listAgents().filter(a =>
    a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user'
  );

  // Count classifying jobs against the concurrency limit so we don't over-dispatch
  if (activeAgents.length + _classifying.size >= _maxConcurrent) return;

  const job = queries.getNextQueuedJob();
  if (!job || _classifying.has(job.id)) return;

  // Double-dispatch guard: verify the job is still queued before claiming it.
  // A rapid succession of ticks could both see the same job as "queued" before
  // either has a chance to mark it as "assigned".
  const fresh = queries.getJobById(job.id);
  if (!fresh || fresh.status !== 'queued') return;

  // Mark assigned immediately to prevent double-dispatch across ticks
  queries.updateJobStatus(job.id, 'assigned');
  socket.emitJobUpdate(queries.getJobById(job.id)!);
  _classifying.add(job.id);

  try {
    // Classify & resolve model (no-op if user already picked one)
    const model = await resolveModel(job);
    if (model == null) {
      console.warn(`[queue] no dispatchable model available for "${job.title}" — cooling job for ${Math.round(PROVIDER_PAUSE_RETRY_MS / 1000)}s`);
      queries.updateJobStatus(job.id, 'queued');
      queries.updateJobScheduledAt(job.id, Date.now() + PROVIDER_PAUSE_RETRY_MS);
      socket.emitJobUpdate(queries.getJobById(job.id)!);
      return;
    }

    // Re-fetch so the agent sees the now-resolved model field
    const readyJob = queries.getJobById(job.id)!;

    const agentId = randomUUID();
    queries.insertAgent({ id: agentId, job_id: job.id, status: 'starting', parent_agent_id: (readyJob as any).created_by_agent_id ?? undefined });
    socket.emitAgentNew(queries.getAgentWithJob(agentId)!);

    // If worktree requested, create one and override the working directory
    const dispatchJob = readyJob.use_worktree
      ? createWorktree(readyJob, agentId)
      : readyJob;

    // Create a git checkpoint tag before the agent starts, so mid-edit crashes
    // can be recovered by resetting to this tag. Lightweight and cheap.
    const dispatchWorkDir = (dispatchJob as any).work_dir ?? process.cwd();
    try {
      const isGitRepo = fs.existsSync(path.join(dispatchWorkDir, '.git')) ||
        (() => { try { execSync('git rev-parse --git-dir', { cwd: dispatchWorkDir, stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; } })();
      if (isGitRepo) {
        const tagName = `orchestrator/checkpoint/${agentId.slice(0, 8)}`;
        execSync(`git tag -f ${tagName}`, { cwd: dispatchWorkDir, stdio: 'pipe', timeout: 5000 });
      }
    } catch (err) {
      // Non-fatal — checkpoint is best-effort
      console.warn(`[queue] git checkpoint failed for agent ${agentId}:`, err);
    }

    // Codex batch agents still use runAgent (stream-json path); all others use tmux.
    // Debate-stage jobs use --print inside tmux (piped through tee to .ndjson for UI display)
    // and exit naturally — no finish_job needed.
    const useCodexBatch = isCodexModel((dispatchJob as any).model ?? null) && !dispatchJob.is_interactive;
    const isDebateStage = isAutoExitJob(dispatchJob as any);
    const autoFinish = !dispatchJob.is_interactive && !isDebateStage;
    const resumeSessionId = queries.getNote(`job-resume:${job.id}`)?.value ?? undefined;
    _totalDispatched++;
    _lastDispatchAt = Date.now();
    console.log(`[queue] dispatching "${job.title}" → agent ${agentId} (model: ${model}, interactive: ${!!readyJob.is_interactive}${readyJob.use_worktree ? ', worktree' : ''}${useCodexBatch ? ', codex-batch' : ''}${isDebateStage ? ', auto-exit' : ''})`);
    if (useCodexBatch) {
      runAgent({ agentId, job: dispatchJob, resumeSessionId });
    } else {
      startInteractiveAgent({ agentId, job: dispatchJob, autoFinish, ...(resumeSessionId ? { resumeSessionId } : {}) });
    }
    if (resumeSessionId) queries.upsertNote(`job-resume:${job.id}`, '', null);
  } catch (err: any) {
    _totalFailed++;
    console.error(`[queue] dispatch failed for job ${job.id}:`, err);
    Sentry.captureException(err);
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  } finally {
    _classifying.delete(job.id);
  }
}

/**
 * Create a git worktree for a job and return a shallow copy of the job
 * with work_dir pointing to the new worktree.
 */
function createWorktree(job: Job, agentId: string): Job {
  const workDir = (job as any).work_dir ?? process.cwd();
  const shortId = agentId.slice(0, 8);

  // Resolve to the actual git repo root — prevents nested .orchestrator-worktrees
  // when work_dir is already a worktree (child job inheriting parent's worktree)
  let repoDir: string;
  try {
    repoDir = execSync('git rev-parse --show-toplevel', { cwd: workDir, stdio: 'pipe', timeout: 5000 })
      .toString().trim();
  } catch {
    repoDir = workDir;
  }

  // Slugify job title for the branch name
  const slug = job.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const branchName = `orchestrator/${slug}-${shortId}`;

  // Place worktrees in a sibling directory to keep the source repo clean
  const worktreeDir = path.resolve(repoDir, '..', '.orchestrator-worktrees', shortId);

  console.log(`[queue] creating worktree: ${worktreeDir} (branch: ${branchName})`);
  execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)}`, {
    cwd: repoDir,
    timeout: 30000,
  });

  // Record worktree in DB for cleanup tracking
  try {
    queries.insertWorktree({
      id: randomUUID(),
      agent_id: agentId,
      job_id: job.id,
      path: worktreeDir,
      branch: branchName,
    });
  } catch (err) { console.warn('[queue] failed to record worktree:', err); }

  // Update the job's work_dir in DB so sub-agents inherit the worktree path
  // (not the original main-repo path) when they call create_job without an explicit work_dir.
  queries.updateJobWorkDir(job.id, worktreeDir);

  // Return a copy of the job with the overridden work_dir
  return { ...job, work_dir: worktreeDir } as any;
}
