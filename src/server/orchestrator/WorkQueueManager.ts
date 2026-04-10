import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { captureWithContext } from '../instrument.js';
import { queueLogger } from '../lib/logger.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { runAgent } from './AgentRunner.js';
import { startInteractiveAgent } from './PtyManager.js';
import { resolveModel } from './ModelClassifier.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel, isAutoExitJob } from '../../shared/types.js';

const log = queueLogger();

let _maxConcurrent = Number(process.env.MAX_CONCURRENT_AGENTS ?? 20);
const POLL_INTERVAL_MS = 2000;
const PROVIDER_PAUSE_RETRY_MS = 60_000;

export function getMaxConcurrent(): number { return _maxConcurrent; }
export function setMaxConcurrent(n: number): void { _maxConcurrent = n; }

let _running = false;
let _timer: NodeJS.Timeout | null = null;
// Tracks jobs currently being classified so the next tick doesn't re-pick them
const _classifying = new Set<string>();
// Debounce flag for nudgeQueue — prevents queueing multiple microtask ticks
let _nudgePending = false;
// Reentrancy guard: only one tick() executes at a time.
// If a second tick() call arrives while one is in-flight (e.g. setInterval fires
// while the previous tick is awaiting resolveModel), it sets _retickRequested instead
// of running concurrently. The in-flight tick checks this flag in its finally block
// and schedules one follow-up tick so the job is not lost.
let _tickInProgress = false;
let _retickRequested = false;

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

/**
 * Wake the work queue immediately instead of waiting for the next 2s poll tick.
 * Safe to call from any context — debounced so multiple calls coalesce into a
 * single tick. The regular poll interval continues as a safety fallback.
 */
export function nudgeQueue(): void {
  if (!_running || _nudgePending) return;
  _nudgePending = true;
  Promise.resolve().then(() => {
    _nudgePending = false;
    if (_running) tick().catch(err => log.error({ err }, 'tick error'));
  });
}

/** Exposed for testing — reset module-level state. */
export function _resetForTest(): void {
  _classifying.clear();
  _nudgePending = false;
  _tickInProgress = false;
  _retickRequested = false;
}

/** Exposed for testing — runs one full dispatch cycle (temporarily enables _running). */
export const _tickForTest = async (): Promise<void> => {
  const wasRunning = _running;
  _running = true;
  try {
    await tick();
  } finally {
    _running = wasRunning;
  }
};

export function startWorkQueue(): void {
  if (_running) return;
  _running = true;
  log.info('WorkQueueManager started');
  _timer = setInterval(() => { try { tick().catch(err => log.error({ err }, 'tick error')); } catch (err) { log.error({ err }, 'tick error'); captureWithContext(err, { component: 'WorkQueueManager' }); } }, POLL_INTERVAL_MS);
  try { tick().catch(err => log.error({ err }, 'tick error')); } catch (err) { log.error({ err }, 'initial tick error'); captureWithContext(err, { component: 'WorkQueueManager' }); }
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

  // Reentrancy guard: the setInterval and nudgeQueue microtasks can both fire
  // tick() while a previous invocation is awaiting resolveModel. Only one tick
  // runs at a time; additional calls set a flag so the running tick re-checks
  // the queue once it finishes, ensuring no job is silently dropped.
  if (_tickInProgress) {
    _retickRequested = true;
    return;
  }
  _tickInProgress = true;

  try {

  // Cascade-fail: mark queued jobs as failed if any dependency failed/cancelled
  for (const job of queries.getJobsWithFailedDeps()) {
    const failedDeps = queries.getFailedDepsForJob(job.id);
    const names = failedDeps.map(d => `${d.title} (${d.status})`).join(', ');
    log.info({ jobId: job.id, failedDeps: names }, 'cascade-fail');
    queries.updateJobStatus(job.id, 'failed');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
  }

  // Capacity-aware dispatch: keep claiming jobs until concurrency is full or queue is empty.
  // This replaces the old single-job-per-tick approach, removing up to 2s idle time between
  // dispatches when multiple jobs are ready (e.g. workflow phase transitions, batch creates).
  let guardLoops = 0;
  while (_running && guardLoops++ < 100) {
    const activeAgents = queries.listAgents().filter(a =>
      a.status === 'starting' || a.status === 'running' || a.status === 'waiting_user'
    );

    // Count classifying jobs against the concurrency limit so we don't over-dispatch
    if (activeAgents.length + _classifying.size >= _maxConcurrent) break;

    const job = queries.getNextQueuedJob();
    if (!job || _classifying.has(job.id)) break;

    // Concurrent workflow throttle: limit simultaneous workflow phase jobs to
    // prevent tmux/PTY exhaustion. The PTY cleanup and backoff fixes handle
    // resource recovery, so we can safely allow a few concurrent jobs.
    const MAX_CONCURRENT_WORKFLOW_PHASES = 3;
    if (job.workflow_id && job.workflow_phase) {
      const runningWorkflowPhaseJobs = queries.listJobs('assigned')
        .concat(queries.listJobs('running'))
        .filter(j => j.workflow_id && j.workflow_phase && j.id !== job.id);
      if (runningWorkflowPhaseJobs.length >= MAX_CONCURRENT_WORKFLOW_PHASES) {
        // Skip — at capacity. Will be picked up on next tick.
        break;
      }
    }

    // Double-dispatch guard: verify the job is still queued before claiming it.
    // A rapid succession of ticks could both see the same job as "queued" before
    // either has a chance to mark it as "assigned".
    const fresh = queries.getJobById(job.id);
    if (!fresh || fresh.status !== 'queued') continue;

    // Mark assigned immediately to prevent double-dispatch across ticks
    queries.updateJobStatus(job.id, 'assigned');
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    _classifying.add(job.id);

    // Hoist agentId so the catch block can clean up the agent row on failure
    let agentId: string | null = null;
    try {
      // Classify & resolve model (no-op if user already picked one)
      const model = await resolveModel(job);
      if (model == null) {
        log.warn({ jobId: job.id, cooldownSec: Math.round(PROVIDER_PAUSE_RETRY_MS / 1000) }, 'no model — cooling');
        queries.updateJobStatus(job.id, 'queued');
        queries.updateJobScheduledAt(job.id, Date.now() + PROVIDER_PAUSE_RETRY_MS);
        socket.emitJobUpdate(queries.getJobById(job.id)!);
        continue;
      }

      // Re-fetch so the agent sees the now-resolved model field
      const readyJob = queries.getJobById(job.id)!;

      agentId = randomUUID();
      queries.insertAgent({ id: agentId, job_id: job.id, status: 'starting', parent_agent_id: readyJob.created_by_agent_id ?? undefined });
      socket.emitAgentNew(queries.getAgentWithJob(agentId)!);

      // If worktree requested, create one and override the working directory
      const dispatchJob = readyJob.use_worktree
        ? createWorktree(readyJob, agentId)
        : readyJob;

      // Create a git checkpoint tag before the agent starts, so mid-edit crashes
      // can be recovered by resetting to this tag. Lightweight and cheap.
      const dispatchWorkDir = dispatchJob.work_dir ?? process.cwd();
      try {
        const isGitRepo = fs.existsSync(path.join(dispatchWorkDir, '.git')) ||
          (() => { try { execSync('git rev-parse --git-dir', { cwd: dispatchWorkDir, stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; } })();
        if (isGitRepo) {
          const tagName = `orchestrator/checkpoint/${agentId.slice(0, 8)}`;
          execSync(`git tag -f ${tagName}`, { cwd: dispatchWorkDir, stdio: 'pipe', timeout: 5000 });
        }
      } catch (err) {
        // Non-fatal — checkpoint is best-effort
        log.warn({ err, agentId }, 'git checkpoint failed');
      }

      // Codex batch agents still use runAgent (stream-json path); all others use tmux.
      // Debate-stage jobs use --print inside tmux (piped through tee to .ndjson for UI display)
      // and exit naturally — no finish_job needed.
      const useCodexBatch = isCodexModel(dispatchJob.model ?? null) && !dispatchJob.is_interactive;
      const isDebateStage = isAutoExitJob(dispatchJob);
      const autoFinish = !dispatchJob.is_interactive && !isDebateStage;
      const resumeSessionId = queries.getNote(`job-resume:${job.id}`)?.value ?? undefined;
      _totalDispatched++;
      _lastDispatchAt = Date.now();
      log.info({ jobId: job.id, agentId, model, interactive: !!readyJob.is_interactive, worktree: !!readyJob.use_worktree, codexBatch: useCodexBatch }, 'dispatching job');
      if (useCodexBatch) {
        runAgent({ agentId, job: dispatchJob, resumeSessionId });
      } else {
        startInteractiveAgent({ agentId, job: dispatchJob, autoFinish, ...(resumeSessionId ? { resumeSessionId } : {}) });
      }
      if (resumeSessionId) queries.upsertNote(`job-resume:${job.id}`, '', null);
    } catch (err: any) {
      _totalFailed++;
      log.error({ err, jobId: job.id }, 'dispatch failed');
      captureWithContext(err, { job_id: job.id, component: 'WorkQueueManager' });
      queries.updateJobStatus(job.id, 'failed');
      // If an agent row was already inserted, mark it as failed so it doesn't
      // consume a concurrency slot or mislead workflow state.
      if (agentId) {
        queries.updateAgent(agentId, { status: 'failed', error_message: String(err?.message ?? err), finished_at: Date.now() });
        const failedAgent = queries.getAgentWithJob(agentId);
        if (failedAgent) socket.emitAgentUpdate(failedAgent);
      }
      socket.emitJobUpdate(queries.getJobById(job.id)!);
    } finally {
      _classifying.delete(job.id);
    }
  }

  } finally {
    _tickInProgress = false;
    // If another caller arrived while this tick was in-flight, run one follow-up
    // tick now that the concurrency slot is free. Scheduling via microtask avoids
    // deep call stacks from rapid nudge sequences.
    if (_retickRequested && _running) {
      _retickRequested = false;
      Promise.resolve().then(() => tick().catch(err => log.error({ err }, 'tick error')));
    }
  }
}

/**
 * Create a git worktree for a job and return a shallow copy of the job
 * with work_dir pointing to the new worktree.
 */
function createWorktree(job: Job, agentId: string): Job {
  const workDir = job.work_dir ?? process.cwd();
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

  // Place worktrees in a namespaced sibling directory: .orchestrator-worktrees/<repoName>/<shortId>
  // This matches the layout used by WorkflowManager and prevents collisions across repos.
  const repoName = path.basename(repoDir);
  const worktreeDir = path.resolve(repoDir, '..', '.orchestrator-worktrees', repoName, shortId);

  // Ensure the namespace directory exists before git worktree add
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  log.info({ worktreeDir, branchName, agentId }, 'creating worktree');
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
  } catch (err) { log.warn({ err }, 'failed to record worktree'); }

  // Update the job's work_dir in DB so sub-agents inherit the worktree path
  // (not the original main-repo path) when they call create_job without an explicit work_dir.
  queries.updateJobWorkDir(job.id, worktreeDir);

  // Return a copy of the job with the overridden work_dir
  return { ...job, work_dir: worktreeDir };
}
