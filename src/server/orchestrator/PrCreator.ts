/**
 * Creates GitHub PRs for completed worktree jobs.
 *
 * Extracted from WorkflowManager.finalizeWorkflow so both standalone jobs
 * and workflow jobs share the same resilient push-and-PR logic.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';
import { validatePushRemote, isPermanentPushFailure } from './GitRemote.js';
import { execErrMsg } from '../../shared/errors.js';

const PR_TIMEOUT = 30_000;
const PUSH_RETRY_DELAY = 5_000;

/**
 * Push the branch and create a GitHub PR for a completed worktree job.
 * Returns the PR URL, or null if no PR was created (no commits, push failed, etc.).
 * Never throws — all errors are caught and logged.
 */
export async function createPrForJob(job: Job): Promise<string | null> {
  const wt = queries.listActiveWorktrees().find(w => w.job_id === job.id);
  if (!wt) {
    console.log(`[pr-creator] no active worktree for job ${job.id} — skipping PR`);
    return null;
  }

  const { path: wtPath, branch } = wt;
  if (!branch || !fs.existsSync(wtPath)) {
    console.log(`[pr-creator] worktree path missing or no branch for job ${job.id} — skipping PR`);
    return null;
  }

  // Ensure worktree is on the correct branch
  try {
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: wtPath, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (currentBranch !== branch) {
      console.warn(`[pr-creator] job ${job.id} worktree on '${currentBranch}' instead of '${branch}' — switching`);
      execFileSync('git', ['checkout', branch], { cwd: wtPath, stdio: 'pipe', timeout: 10000 });
    }
  } catch (err: any) {
    console.warn(`[pr-creator] branch check failed for job ${job.id}:`, err.message);
  }

  // Commit any uncommitted changes the agent left behind
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: wtPath, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (status) {
      execFileSync('git', ['add', '-A'], { cwd: wtPath, stdio: 'pipe', timeout: 5000 });
      execFileSync('git', ['commit', '-m', `chore: commit uncommitted work from agent\n\nAuto-committed by orchestrator at job completion.`], {
        cwd: wtPath, stdio: 'pipe', timeout: 10000,
      });
    }
  } catch { /* no uncommitted changes or commit failed — not fatal */ }

  // Count commits on branch that aren't on the remote default branch
  let hasCommits = false;
  try {
    const n = execFileSync('git', ['rev-list', '--count', 'HEAD', '^origin/HEAD'], {
      cwd: wtPath, stdio: 'pipe', timeout: 10000,
    }).toString().trim();
    hasCommits = parseInt(n, 10) > 0;
  } catch {
    // Fallback: just check if there are any commits at all
    try {
      const n = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: wtPath, stdio: 'pipe', timeout: 10000,
      }).toString().trim();
      hasCommits = parseInt(n, 10) > 0;
    } catch { /* not a git repo — skip */ }
  }

  if (!hasCommits) {
    console.log(`[pr-creator] no commits on branch for job ${job.id} — skipping PR`);
    return null;
  }

  // A worktree whose parent repo has no `origin` can never be pushed. Skip
  // before the retry loop: retrying is pure waste, and the warn/error/exception
  // trio below turned one environment condition into three Sentry issues.
  const remoteReadiness = validatePushRemote(wtPath);
  if (!remoteReadiness.ok) {
    console.log(`[pr-creator] PR creation skipped: ${remoteReadiness.error}; worktree preserved at ${wtPath}`);
    return null;
  }

  // Push branch (retry once on failure)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execFileSync('git', ['push', '-u', 'origin', branch], {
        cwd: wtPath, stdio: 'pipe', timeout: PR_TIMEOUT,
      });
      break;
    } catch (err: any) {
      // The remote disappeared between the pre-check and the push (or the
      // pre-check could not see it). Permanent — no retry, and no Sentry
      // exception for an environment condition. Genuinely transient failures
      // keep the retry and the full error+capture reporting below.
      if (isPermanentPushFailure(execErrMsg(err))) {
        console.log(`[pr-creator] PR creation skipped: origin remote is not usable for job ${job.id}; worktree preserved at ${wtPath}`);
        return null;
      }
      if (attempt === 0) {
        console.warn(`[pr-creator] push failed for job ${job.id} (will retry in ${PUSH_RETRY_DELAY}ms):`, err.message);
        await new Promise(r => setTimeout(r, PUSH_RETRY_DELAY));
      } else {
        console.error(`[pr-creator] push failed permanently for job ${job.id}:`, err.message);
        captureWithContext(err, { job_id: job.id, component: 'PrCreator' });
        return null;
      }
    }
  }

  // Build PR body
  const body = buildPrBody(job);

  // Create PR (or detect existing one)
  try {
    const prUrl = execFileSync('gh', [
      'pr', 'create',
      '--title', job.title,
      '--body', body,
      '--head', branch,
    ], { cwd: wtPath, stdio: 'pipe', timeout: PR_TIMEOUT }).toString().trim();

    console.log(`[pr-creator] PR created for job ${job.id}: ${prUrl}`);
    return prUrl;
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? err.message ?? '';
    // gh CLI returns error if PR already exists — try to find it
    if (stderr.includes('already exists')) {
      try {
        const existing = execFileSync('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], {
          cwd: wtPath, stdio: 'pipe', timeout: PR_TIMEOUT,
        }).toString().trim();
        if (existing) {
          console.log(`[pr-creator] PR already exists for job ${job.id}: ${existing}`);
          return existing;
        }
      } catch { /* can't find existing PR — give up */ }
    }
    console.error(`[pr-creator] gh pr create failed for job ${job.id}:`, stderr);
    captureWithContext(err, { job_id: job.id, component: 'PrCreator' });
    return null;
  }
}

/**
 * Push the branch for a failed job to preserve work, but don't create a PR.
 * Returns true if the branch was pushed successfully.
 */
export function pushBranchForFailedJob(job: Job): boolean {
  const wt = queries.listActiveWorktrees().find(w => w.job_id === job.id);
  if (!wt?.branch || !fs.existsSync(wt.path)) return false;

  // Commit uncommitted changes before pushing
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: wt.path, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    if (status) {
      execFileSync('git', ['add', '-A'], { cwd: wt.path, stdio: 'pipe', timeout: 5000 });
      execFileSync('git', ['commit', '-m', `chore: commit work-in-progress from failed agent\n\nAuto-committed by orchestrator. Job failed — branch pushed to preserve work.`], {
        cwd: wt.path, stdio: 'pipe', timeout: 10000,
      });
    }
  } catch { /* not fatal */ }

  // The work is committed locally by now. Without a usable origin the push can
  // only fail, so report the environment condition instead of a push error —
  // console.warn pages Sentry, and the missing remote is not a bug.
  const remoteReadiness = validatePushRemote(wt.path);
  if (!remoteReadiness.ok) {
    console.log(`[pr-creator] branch push skipped for failed job ${job.id}: ${remoteReadiness.error}; work committed locally on ${wt.branch}, worktree preserved at ${wt.path}`);
    return false;
  }

  try {
    execFileSync('git', ['push', '-u', 'origin', wt.branch], {
      cwd: wt.path, stdio: 'pipe', timeout: PR_TIMEOUT,
    });
    console.log(`[pr-creator] pushed branch for failed job ${job.id}: ${wt.branch}`);
    return true;
  } catch (err: any) {
    if (isPermanentPushFailure(execErrMsg(err))) {
      console.log(`[pr-creator] branch push skipped for failed job ${job.id}: origin remote is not usable; work committed locally on ${wt.branch}, worktree preserved at ${wt.path}`);
      return false;
    }
    console.warn(`[pr-creator] push failed for failed job ${job.id}:`, err.message);
    return false;
  }
}

function buildPrBody(job: Job): string {
  // Get commit log for the PR body
  let commitLog = '';
  const wt = queries.listActiveWorktrees().find(w => w.job_id === job.id);
  if (wt) {
    try {
      commitLog = execFileSync('git', ['log', '--oneline', 'origin/HEAD..HEAD'], {
        cwd: wt.path, stdio: 'pipe', timeout: 5000,
      }).toString().trim();
    } catch { /* ignore */ }
  }

  // Get agent result summary if available
  const agents = queries.getAgentsWithJobByJobId(job.id);
  const lastAgent = agents[0]; // most recent (ordered by started_at DESC)
  let resultSummary = '';
  if (lastAgent) {
    const output = queries.getLatestAgentOutput(lastAgent.id);
    if (output?.event_type === 'result') {
      try {
        const parsed = JSON.parse(output.content);
        resultSummary = parsed.result ?? '';
      } catch { /* ignore */ }
    }
  }

  const lines = [
    `## ${job.title}`,
    '',
  ];

  if (resultSummary) {
    lines.push('### Summary', '', resultSummary, '');
  }

  if (commitLog) {
    lines.push('### Commits', '', '```', commitLog, '```', '');
  }

  lines.push(
    '---',
    'Generated by Autodev autonomous agent orchestrator',
  );

  if (lastAgent?.job.model) {
    lines.push(`Model: \`${lastAgent.job.model}\``);
  }

  return lines.join('\n');
}
