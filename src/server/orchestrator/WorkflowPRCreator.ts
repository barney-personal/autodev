/**
 * PR creation, milestone PR logic, partial PR handling, and finalization
 * for the workflow engine.
 * Extracted from WorkflowManager.ts.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as queries from '../db/queries.js';
import type { Workflow } from '../../shared/types.js';
import { errMsg, execErrMsg } from '../../shared/errors.js';
import { workflowLogger } from '../lib/logger.js';
import { parseMilestones, CHECKBOX_CHECKED } from './WorkflowMilestoneParser.js';
import { ensureWorktreeBranch, removeWorktree, quarantineWorktree } from './WorkflowWorktreeManager.js';
import { captureAgentCreatedPrUrl } from './AgentPrUrlCapture.js';

export type WorkflowPrCreationOutcome = 'created' | 'failed_with_publishable_commits' | 'no_publishable_commits';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRemoteDefaultBranch(cwd: string): string | null {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString().trim();
    if (!ref.startsWith('refs/remotes/origin/')) return null;
    return ref.slice('refs/remotes/origin/'.length);
  } catch (err) {
    if (isMissingRemoteRefError(err)) return null;
    throw err;
  }
}

function isMissingRemoteRefError(err: unknown): boolean {
  const message = String((err as { message?: string } | null)?.message ?? err ?? '');
  return message.includes('not a symbolic ref')
    || message.includes('bad revision')
    || message.includes('unknown revision')
    || message.includes('ambiguous argument');
}

function countCommitsAgainstBaseRef(cwd: string, baseRef: string): number | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', baseRef], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
  } catch (err) {
    const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
    if (msg.includes('Needed a single revision') || msg.includes('not a valid object name') || msg.includes('unknown revision')) {
      return null;
    }
    throw err;
  }

  const count = execFileSync(
    'git', ['rev-list', '--count', 'HEAD', `^${baseRef}`],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }
  ).toString().trim();
  const parsed = parseInt(count, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Count commits on HEAD ahead of a verified origin base ref.
 *
 * Returns:
 *   - a number ≥ 0 when a base ref resolved and `git rev-list --count` succeeded.
 *     0 means the branch is genuinely empty relative to a verified base.
 *   - `null` when no candidate origin base ref could be verified. Callers MUST
 *     treat `null` as uncertainty — preserve the worktree, do not infer "empty".
 *
 * This was previously `number` and returned `0` on missing remote metadata,
 * which caused the wrap-up flow to delete worktrees with real local commits on
 * branches that were never pushed (the 2026-05-17 polymarket-agent regression).
 * The fallback chain now matches `probeRecoverableWorkflowWork`.
 */
export function countBranchCommits(cwd: string): number | null {
  const candidates: string[] = [];
  let defaultBranch: string | null = null;
  try {
    defaultBranch = getRemoteDefaultBranch(cwd);
  } catch {
    defaultBranch = null;
  }
  if (defaultBranch) candidates.push(`origin/${defaultBranch}`);
  for (const fallback of ['origin/HEAD', 'origin/main', 'origin/master']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  for (const baseRef of candidates) {
    const count = countCommitsAgainstBaseRef(cwd, baseRef);
    if (count !== null) return count;
  }

  return null;
}

// ─── Recoverable-Work Probe ─────────────────────────────────────────────────
//
// Wrap-up cleanup is gated by a stricter probe than countBranchCommits: any
// uncertainty (missing worktree, missing/ambiguous origin refs, dirty tree,
// probe command failures) must preserve the worktree. Only a positively clean
// state — verified worktree, clean status, verified origin base ref, zero
// commits ahead — may proceed to cleanup.

export type RecoverableWorkProbeStatus = 'has_work' | 'clean' | 'unknown';

export interface RecoverableWorkProbe {
  status: RecoverableWorkProbeStatus;
  detail: string;
  baseRef: string | null;
}

function verifyRevExists(cwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a workflow's worktree has any work that wrap-up cleanup
 * would otherwise destroy.
 *
 * Returns:
 *  - `clean`     — proven safe to cleanup: worktree exists, working tree is
 *                  clean, an origin base ref was verified, and HEAD has no
 *                  commits ahead of that base.
 *  - `has_work`  — known recoverable state: dirty tree or commits ahead.
 *  - `unknown`   — anything we can't positively verify (missing worktree,
 *                  missing branch, ambiguous origin refs, probe failures).
 *                  Treat as `has_work` for cleanup decisions.
 */
export function probeRecoverableWorkflowWork(workflow: Workflow): RecoverableWorkProbe {
  const { worktree_path, worktree_branch } = workflow;
  if (!worktree_path) {
    return { status: 'unknown', detail: 'workflow has no worktree_path', baseRef: null };
  }
  if (!existsSync(worktree_path)) {
    return { status: 'unknown', detail: `worktree directory missing at ${worktree_path}`, baseRef: null };
  }

  if (!worktree_branch) {
    return { status: 'unknown', detail: 'workflow has no worktree_branch', baseRef: null };
  }

  // Non-mutating branch sanity check. ensureWorktreeBranch performs a checkout
  // when it disagrees, which is the wrong shape for a probe — read-only here.
  try {
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktree_path, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).toString().trim();
    if (head !== worktree_branch) {
      return {
        status: 'unknown',
        detail: `HEAD on '${head}' instead of expected '${worktree_branch}'`,
        baseRef: null,
      };
    }
  } catch (err) {
    return { status: 'unknown', detail: `git rev-parse failed: ${execErrMsg(err)}`, baseRef: null };
  }

  // Dirty tree — uncommitted changes are recoverable work.
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktree_path, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).toString();
  } catch (err) {
    return { status: 'unknown', detail: `git status failed: ${execErrMsg(err)}`, baseRef: null };
  }
  if (porcelain.trim().length > 0) {
    return { status: 'has_work', detail: 'worktree has uncommitted changes', baseRef: null };
  }

  // Resolve a verified origin base ref.
  const candidates: string[] = [];
  let defaultBranch: string | null = null;
  try {
    defaultBranch = getRemoteDefaultBranch(worktree_path);
  } catch (err) {
    return {
      status: 'unknown',
      detail: `failed to resolve origin default branch: ${execErrMsg(err)}`,
      baseRef: null,
    };
  }
  if (defaultBranch) candidates.push(`origin/${defaultBranch}`);
  for (const fallback of ['origin/HEAD', 'origin/main', 'origin/master']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  let baseRef: string | null = null;
  for (const candidate of candidates) {
    if (verifyRevExists(worktree_path, candidate)) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) {
    return {
      status: 'unknown',
      detail: `could not verify any origin base ref (tried ${candidates.join(', ')})`,
      baseRef: null,
    };
  }

  // Count local commits ahead of the verified base ref.
  let log: string;
  try {
    log = execFileSync('git', ['log', '--format=%H', `${baseRef}..HEAD`], {
      cwd: worktree_path, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).toString();
  } catch (err) {
    return {
      status: 'unknown',
      detail: `git log against ${baseRef} failed: ${execErrMsg(err)}`,
      baseRef,
    };
  }

  const lines = log.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { status: 'clean', detail: `no commits ahead of ${baseRef}`, baseRef };
  }
  return {
    status: 'has_work',
    detail: `${lines.length} commit(s) ahead of ${baseRef}`,
    baseRef,
  };
}

// ─── PR Body ────────────────────────────────────────────────────────────────

export function _buildPrBody(workflow: Workflow, planText: string | null, options?: { partial?: boolean }): string {
  const { total, done } = parseMilestones(planText ?? '');
  const milestoneLines = planText
    ? planText.split('\n')
        .filter(l => /^\s*[-*]\s+\[/.test(l))
        .map(l => {
          const isDone = CHECKBOX_CHECKED.test(l);
          const title = l.replace(/^\s*[-*]\s+\[[xX ]*\]\s*/, '');
          return isDone ? `- Done: ${title}` : `- Pending: ${title}`;
        })
        .join('\n')
    : '';
  const lines = [
    `## ${workflow.title}`,
    '',
  ];
  if (options?.partial) {
    lines.push(`**Partial completion** — ${done}/${total} milestones done. Remaining milestones need manual intervention or resuming the workflow.`);
    lines.push('');
  }
  lines.push(
    `**Task:** ${workflow.task}`,
    '',
    `**Cycles:** ${workflow.current_cycle}/${workflow.max_cycles} · **Milestones:** ${done}/${total} complete`,
    '',
    '## Milestones',
    milestoneLines || '_No plan available_',
  );
  return lines.join('\n');
}

// ─── Push & PR Creation ─────────────────────────────────────────────────────

export interface PushBranchResult {
  ok: boolean;
  error?: string;
  authFailure?: boolean;
  /** Number of `git push` attempts performed (1 or 2 in normal flow, 0 if validation failed). */
  attempts?: number;
  /** True iff a second attempt with `--force-with-lease` was made. */
  retried?: boolean;
}

export interface CreatePrResult {
  ok: boolean;
  url?: string;
  error?: string;
}

const AUTH_FAILURE_PATTERNS = [
  'Authentication failed',
  'Permission denied',
  'could not read Username',
  'could not read Password',
  'terminal prompts disabled',
  '403',
  'The requested URL returned error: 403',
];

const RATE_LIMIT_PATTERNS = [
  'retry-after',
  'rate limit',
  'rate_limit',
  'secondary rate limit',
  'abuse detection',
];

function isRateLimited(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

function isAuthFailure(stderr: string): boolean {
  if (isRateLimited(stderr)) return false;
  const lower = stderr.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

const DEFAULT_PUSH_RETRY_DELAY_MS = 5000;

/**
 * Block the calling thread for `ms` without busy-waiting. Atomics.wait is the
 * standard sync-sleep idiom in Node and works under Vitest. Tests inject a
 * no-op `sleep` (or pass retryDelayMs: 0) to skip the real 5s wait.
 */
function defaultSyncSleep(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export interface PushBranchOptions {
  /** Use --force-with-lease on the first attempt. Retry always uses --force-with-lease. */
  force?: boolean;
  /** Delay between attempt 1 and attempt 2 in milliseconds. Defaults to 5000. */
  retryDelayMs?: number;
  /** Override the synchronous sleep used between attempts (for tests). */
  sleep?: (ms: number) => void;
}

/**
 * Push the worktree branch to origin with one bounded retry.
 *
 * Attempt 1: `git push -u origin <branch>` (or `--force-with-lease` if force=true).
 * Attempt 2: `git push --force-with-lease -u origin <branch>`, run only if attempt
 * 1 failed with a non-auth error, after a `retryDelayMs` pause.
 *
 * Auth failures (Authentication failed, Permission denied, terminal prompts
 * disabled, plain 403) fail fast; 403 with rate-limit wording remains
 * transient and gets the bounded retry.
 */
export function pushBranch(
  workflow: Workflow,
  options: PushBranchOptions = {},
): PushBranchResult {
  const { worktree_path, worktree_branch } = workflow;
  if (!worktree_path || !worktree_branch) {
    return { ok: false, error: 'missing worktree_path or worktree_branch', attempts: 0, retried: false };
  }
  if (!existsSync(worktree_path)) {
    return { ok: false, error: `worktree directory missing at ${worktree_path}`, attempts: 0, retried: false };
  }

  const branchCheck = ensureWorktreeBranch(worktree_path, worktree_branch);
  if (!branchCheck.ok) {
    console.warn(`[workflow ${workflow.id}] branch check failed:`, branchCheck.error);
  }

  const retryDelayMs = options.retryDelayMs ?? DEFAULT_PUSH_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSyncSleep;

  const firstArgs = options.force
    ? ['push', '--force-with-lease', '-u', 'origin', worktree_branch]
    : ['push', '-u', 'origin', worktree_branch];

  try {
    execFileSync('git', firstArgs, {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    });
    return { ok: true, attempts: 1, retried: false };
  } catch (err) {
    const stderr = execErrMsg(err);
    if (isAuthFailure(stderr)) {
      return { ok: false, error: stderr, authFailure: true, attempts: 1, retried: false };
    }

    console.warn(
      `[workflow ${workflow.id}] git push attempt 1 failed (${stderr.split('\n')[0]}) — retrying once with --force-with-lease after ${retryDelayMs}ms`,
    );
    if (retryDelayMs > 0) sleep(retryDelayMs);

    try {
      execFileSync('git', ['push', '--force-with-lease', '-u', 'origin', worktree_branch], {
        cwd: worktree_path, stdio: 'pipe', timeout: 30000,
      });
      return { ok: true, attempts: 2, retried: true };
    } catch (err2) {
      const stderr2 = execErrMsg(err2);
      return {
        ok: false,
        error: stderr2,
        authFailure: isAuthFailure(stderr2),
        attempts: 2,
        retried: true,
      };
    }
  }
}

/**
 * Create a GitHub PR for the workflow branch. Assumes branch is already pushed.
 */
export function createWorkflowPr(
  workflow: Workflow,
  { isDraft = false, updateAndEmit }: {
    isDraft?: boolean;
    updateAndEmit?: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void;
  } = {},
): CreatePrResult {
  const _updateAndEmit = updateAndEmit ?? ((id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => {
    queries.updateWorkflow(id, fields);
  });
  const { worktree_path, worktree_branch } = workflow;
  if (!worktree_path || !worktree_branch) {
    return { ok: false, error: 'missing worktree_path or worktree_branch' };
  }
  if (!existsSync(worktree_path)) {
    return { ok: false, error: `worktree directory missing at ${worktree_path}` };
  }

  try {
    const existingUrl = execFileSync(
      'gh', ['pr', 'view', worktree_branch, '--json', 'url', '-q', '.url'],
      { cwd: worktree_path, stdio: 'pipe', timeout: 15000 }
    ).toString().trim();
    if (existingUrl) {
      _updateAndEmit(workflow.id, { pr_url: existingUrl });
      console.log(`[workflow ${workflow.id}] PR already exists: ${existingUrl}`);
      return { ok: true, url: existingUrl };
    }
  } catch { /* no existing PR — create one */ }

  const planNote = queries.getNote(`workflow/${workflow.id}/plan`);
  const body = _buildPrBody(workflow, planNote?.value ?? null, { partial: isDraft });
  const title = `[Workflow] ${workflow.title}`;

  if (isDraft) {
    try {
      execFileSync('gh', ['label', 'create', 'partial', '--description', 'Partial workflow completion', '--color', 'FBCA04'], {
        cwd: worktree_path, stdio: 'pipe', timeout: 10000,
      });
    } catch { /* label already exists — fine */ }
  }

  let conflictWarning = '';
  try {
    let mergeBase = '';
    try {
      mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/HEAD'], {
        cwd: worktree_path, stdio: 'pipe', timeout: 10000,
      }).toString().trim();
    } catch { /* merge-base not available */ }
    if (mergeBase) {
      const mergeTree = execFileSync('git', ['merge-tree', mergeBase, 'origin/HEAD', 'HEAD'], {
        cwd: worktree_path, stdio: 'pipe', timeout: 10000,
      }).toString();
      if (mergeTree.includes('<<<<<<<') || mergeTree.includes('changed in both')) {
        const conflictFiles = mergeTree
          .split('\n')
          .filter(l => l.includes('changed in both'))
          .map(l => l.replace(/.*changed in both.*'([^']+)'.*/i, '$1'))
          .filter(l => l !== '');
        conflictWarning = `\n\n**Warning: Potential merge conflicts detected** with the base branch in: ${conflictFiles.join(', ') || '(unknown files)'}. Manual resolution may be needed.`;
        console.warn(`[workflow ${workflow.id}] merge conflict pre-check: conflicts in ${conflictFiles.join(', ')}`);
      }
    }
  } catch { /* merge-tree check failed */ }

  const finalBody = conflictWarning ? body + conflictWarning : body;
  const prArgs = ['pr', 'create', '--title', title, '--body', finalBody, '--head', worktree_branch];
  if (isDraft) {
    prArgs.push('--draft', '--label', 'partial');
  }

  try {
    const prUrl = execFileSync('gh', prArgs, {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    }).toString().trim();

    if (!prUrl) {
      return { ok: false, error: 'gh pr create exited 0 but returned empty stdout' };
    }

    _updateAndEmit(workflow.id, { pr_url: prUrl });
    console.log(`[workflow ${workflow.id}] ${isDraft ? 'draft ' : ''}PR created: ${prUrl}`);
    return { ok: true, url: prUrl };
  } catch (err) {
    const stderr = execErrMsg(err);
    if (stderr.includes('already exists')) {
      try {
        const existing = execFileSync(
          'gh', ['pr', 'view', worktree_branch, '--json', 'url', '-q', '.url'],
          { cwd: worktree_path, stdio: 'pipe', timeout: 15000 }
        ).toString().trim();
        if (existing) {
          _updateAndEmit(workflow.id, { pr_url: existing });
          console.log(`[workflow ${workflow.id}] PR already exists: ${existing}`);
          return { ok: true, url: existing };
        }
      } catch { /* can't find existing PR */ }
    }
    return { ok: false, error: stderr };
  }
}

/**
 * Legacy combined push + PR create. Used by finalizeWorkflow, reconcileBlockedPRs,
 * and the max-cycles partial PR path. The wrap-up handler calls pushBranch and
 * createWorkflowPr separately for attributed error reporting.
 */
function defaultSyncSleep(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export interface PushBranchOptions {
  /** Use --force-with-lease on the first attempt. Retry always uses --force-with-lease. */
  force?: boolean;
  /** Delay between attempt 1 and attempt 2 in milliseconds. Defaults to 5000. */
  retryDelayMs?: number;
  /** Override the synchronous sleep used between attempts (for tests). */
  sleep?: (ms: number) => void;
}

/**
 * Push the worktree branch to origin with one bounded retry.
 *
 * Attempt 1: `git push -u origin <branch>` (or `--force-with-lease` if force=true).
 * Attempt 2: `git push --force-with-lease -u origin <branch>`, run only if attempt
 * 1 failed with a non-auth error, after a `retryDelayMs` pause.
 *
 * Auth failures (Authentication failed, Permission denied, terminal prompts
 * disabled, plain 403) fail fast; 403 with rate-limit wording remains
 * transient and gets the bounded retry.
 */
export function pushBranch(
  workflow: Workflow,
  isDraft: boolean,
  updateAndEmit?: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void,
): string | null {
  const { worktree_path, worktree_branch, work_dir } = workflow;
  if (!worktree_path || !work_dir) return null;

  if (!existsSync(worktree_path)) {
    workflowLogger(workflow.id).warn({ worktreePath: worktree_path }, 'worktree directory missing — cannot create PR');
    return null;
  }

  if (!worktree_branch) {
    console.log(`[workflow ${workflow.id}] no worktree_branch — skipping PR`);
    return null;
  }

  // Verify the worktree is on the workflow branch BEFORE counting commits.
  // If it has drifted to a different (clean) branch, countBranchCommits would
  // count zero on the wrong branch and incorrectly skip PR creation, even
  // though the workflow branch has recoverable commits ahead of origin.
  const branchCheck = ensureWorktreeBranch(worktree_path, worktree_branch);
  if (!branchCheck.ok) {
    console.warn(`[workflow ${workflow.id}] branch check failed:`, branchCheck.error);
  }

  let hasCommits = false;
  try {
    const count = countBranchCommits(worktree_path);
    // null = unknown (no base ref verified) → safe default: attempt PR creation.
    // The downstream push/PR step will surface the real failure, and the
    // worktree is preserved/quarantined rather than silently deleted.
    hasCommits = count === null ? true : count > 0;
  } catch (err) {
    console.warn(`[workflow ${workflow.id}] rev-list failed, assuming commits exist:`, err);
    hasCommits = true;
  }

  if (!hasCommits) {
    console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR`);
    return null;
  }

  const pushResult = pushBranch(workflow);
  if (!pushResult.ok) {
    console.warn(`[workflow ${workflow.id}] push failed (worktree branch preserved locally):`, pushResult.error);
    return null;
  }

  const prResult = createWorkflowPr(workflow, { isDraft, updateAndEmit });
  if (!prResult.ok) {
    console.warn(`[workflow ${workflow.id}] PR creation failed after push:`, prResult.error);
    return null;
  }

  return prResult.url ?? null;
}

export function getPrCreationOutcome(workflow: Workflow, prUrl: string | null): WorkflowPrCreationOutcome {
  if (prUrl) return 'created';
  if (!workflow.worktree_path || !workflow.work_dir) return 'no_publishable_commits';

  let count: number | null = null;
  try {
    count = countBranchCommits(workflow.worktree_path);
  } catch (err) {
    console.warn(`[workflow ${workflow.id}] getPrCreationOutcome: git error — preserving worktree as safe default:`, errMsg(err));
    return 'failed_with_publishable_commits';
  }

  // Uncertainty (no base ref verified) must preserve the worktree — the
  // wrap-up path then quarantines instead of deleting. Only a positively
  // verified empty branch (count === 0) is reported as no_publishable_commits.
  if (count === null) return 'failed_with_publishable_commits';
  return count > 0 ? 'failed_with_publishable_commits' : 'no_publishable_commits';
}

// ─── Finalization ────────────────────────────────────────────────────────────

const _FINALIZE_MAX_ATTEMPTS = 3;
const _FINALIZE_RETRY_DELAY_MS = 30_000;

/**
 * Called when a workflow completes successfully.
 * Pushes the worktree branch, opens a GitHub PR, then removes the local worktree.
 */
export async function finalizeWorkflow(
  workflow: Workflow,
  updateAndEmit: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void,
): Promise<void> {
  queries.releaseWorkflowClaims(workflow.id);
  if (!workflow.worktree_path || !workflow.work_dir) return;

  let prUrl: string | null = null;

  for (let attempt = 1; attempt <= _FINALIZE_MAX_ATTEMPTS; attempt++) {
    prUrl = pushAndCreatePr(workflow, false, updateAndEmit);
    if (prUrl) break;

    if (attempt < _FINALIZE_MAX_ATTEMPTS) {
      let hasCommits = true;
      try {
        const count = countBranchCommits(workflow.worktree_path);
        // null (unknown) → keep retrying. Only break when verified empty.
        hasCommits = count === null ? true : count > 0;
      } catch { /* safe default */ }

      if (!hasCommits || !workflow.worktree_branch) break;

      console.log(`[workflow ${workflow.id}] PR creation attempt ${attempt} failed — retrying in 30s`);
      await new Promise<void>(resolve => setTimeout(resolve, _FINALIZE_RETRY_DELAY_MS));
      try {
        execFileSync('git', ['push', '-u', 'origin', workflow.worktree_branch], {
          cwd: workflow.worktree_path, stdio: 'pipe', timeout: 30000,
        });
      } catch (pushErr) {
        console.warn(`[workflow ${workflow.id}] pre-retry push failed:`, errMsg(pushErr));
      }
    }
  }

  if (!prUrl && workflow.worktree_branch && workflow.worktree_path) {
    try {
      const existing = execFileSync(
        'gh', ['pr', 'view', workflow.worktree_branch, '--json', 'url', '-q', '.url'],
        { cwd: workflow.worktree_path, stdio: 'pipe', timeout: 15000 },
      ).toString().trim();
      if (existing) {
        prUrl = existing;
        updateAndEmit(workflow.id, { pr_url: existing });
        console.log(`[workflow ${workflow.id}] found existing PR via fallback lookup: ${existing}`);
      }
    } catch { /* no existing PR found */ }
  }

  // Safety net: an implementer may have run `gh pr create` itself as part of a
  // milestone. The branch-name lookup above only finds a PR open on the exact
  // worktree branch from this repo's perspective — if `gh` auth in the worktree
  // is degraded, that branch lookup can fail even when the PR exists. Scan the
  // latest implementer agent's recent output for a URL and validate it.
  if (!prUrl) {
    try {
      const captured = captureAgentCreatedPrUrl(workflow, { updateAndEmit });
      if (captured.found && captured.url) {
        prUrl = captured.url;
      }
    } catch (err) {
      console.warn(`[workflow ${workflow.id}] agent PR URL capture errored (non-fatal):`, errMsg(err));
    }
  }

  const prOutcome = getPrCreationOutcome(workflow, prUrl);

  if (prOutcome === 'created') {
    removeWorktree(workflow);
  } else if (prOutcome === 'failed_with_publishable_commits') {
    console.warn(`[workflow ${workflow.id}] PR creation failed after ${_FINALIZE_MAX_ATTEMPTS} attempts — worktree preserved at ${workflow.worktree_path} for retry`);
    updateAndEmit(workflow.id, {
      status: 'blocked',
      blocked_reason: `PR creation failed — worktree preserved for retry at ${workflow.worktree_path}`,
    });
  } else {
    // no_publishable_commits — the orchestrator's commit-detection said the
    // branch is verifiably empty. Per the brief's Goal A.4 defense-in-depth
    // rule, never delete the worktree on this path. Quarantine it so a human
    // operator can rescue any work the orchestrator misclassified.
    console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR (quarantining worktree)`);
    const quarantined = quarantineWorktree(workflow, 'finalize: no_publishable_commits');
    updateAndEmit(workflow.id, {
      blocked_reason: quarantined.ok
        ? `no_publishable_commits — worktree quarantined at ${quarantined.path}`
        : `no_publishable_commits — quarantine failed: ${quarantined.error}`,
    });
  }
}

function isReconcilablePrBlockedReason(reason: string): boolean {
  if (reason.includes('PR creation failed')) return true;
  if (reason.includes('gh pr create failed')) return true;
  if (reason.includes('unknown PR-creation failure')) return true;
  // Push failures that are auth-related won't fix themselves on retry
  if (reason.includes('branch push failed') && !isAuthFailure(reason)) return true;
  return false;
}

/**
 * On startup, find workflows blocked due to PR creation failure and retry.
 */
export async function reconcileBlockedPRs(
  updateAndEmit: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void,
): Promise<void> {
  const blocked = queries.listWorkflows().filter(
    wf => wf.status === 'blocked'
      && typeof wf.blocked_reason === 'string'
      && isReconcilablePrBlockedReason(wf.blocked_reason),
  );

  if (blocked.length === 0) return;
  const reconcileLog = workflowLogger('reconcile');
  reconcileLog.info({ count: blocked.length }, 'found workflows blocked on PR creation — retrying');

  for (const workflow of blocked) {
    if (!workflow.worktree_path || !workflow.worktree_branch || !workflow.work_dir) {
      workflowLogger(workflow.id).warn({ worktreePath: workflow.worktree_path ?? null, branch: workflow.worktree_branch ?? null, workDir: workflow.work_dir ?? null }, 'missing worktree fields — skipping PR reconciliation');
      continue;
    }

    if (!existsSync(workflow.worktree_path)) {
      updateAndEmit(workflow.id, {
        blocked_reason: 'Worktree directory missing — cannot retry',
      });
      workflowLogger(workflow.id).warn({ worktreePath: workflow.worktree_path }, 'worktree directory missing — updated blocked reason');
      continue;
    }

    try {
      const prUrl = pushAndCreatePr(workflow, false, updateAndEmit);
      if (prUrl) {
        updateAndEmit(workflow.id, { status: 'complete', blocked_reason: null, pr_url: prUrl });
        removeWorktree(workflow);
        workflowLogger(workflow.id).info({ prUrl }, 'recovered workflow via PR reconciliation');
      } else {
        workflowLogger(workflow.id).warn('PR creation still failing — leaving blocked');
      }
    } catch (err) {
      workflowLogger(workflow.id).warn({ err: errMsg(err) }, 'error retrying PR creation');
    }
  }
}
