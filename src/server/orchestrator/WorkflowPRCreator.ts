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
import { ensureWorktreeBranch, removeWorktree } from './WorkflowWorktreeManager.js';

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

export function countBranchCommits(cwd: string): number {
  const candidateBaseRefs = new Set<string>();
  const defaultBranch = getRemoteDefaultBranch(cwd);
  if (defaultBranch) candidateBaseRefs.add(`origin/${defaultBranch}`);
  candidateBaseRefs.add('origin/HEAD');

  for (const baseRef of candidateBaseRefs) {
    const count = countCommitsAgainstBaseRef(cwd, baseRef);
    if (count !== null) return count;
  }

  return 0;
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

/**
 * Push the worktree branch and create a GitHub PR.
 * Does NOT remove the worktree — callers decide when to clean up.
 * Returns the PR URL on success, or null if no PR was created.
 */
export function pushAndCreatePr(
  workflow: Workflow,
  isDraft: boolean,
  updateAndEmit?: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void,
): string | null {
  const _updateAndEmit = updateAndEmit ?? ((id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => {
    queries.updateWorkflow(id, fields);
  });
  const { worktree_path, worktree_branch, work_dir } = workflow;
  if (!worktree_path || !work_dir) return null;

  if (!existsSync(worktree_path)) {
    workflowLogger(workflow.id).warn({ worktreePath: worktree_path }, 'worktree directory missing — cannot create PR');
    return null;
  }

  if (worktree_branch) {
    const branchCheck = ensureWorktreeBranch(worktree_path, worktree_branch);
    if (!branchCheck.ok) {
      console.warn(`[workflow ${workflow.id}] branch check failed:`, branchCheck.error);
    }
  }

  let hasCommits = false;
  try {
    hasCommits = countBranchCommits(worktree_path) > 0;
  } catch (err) {
    console.warn(`[workflow ${workflow.id}] rev-list failed, assuming commits exist:`, err);
    hasCommits = true;
  }

  if (!hasCommits || !worktree_branch) {
    console.log(`[workflow ${workflow.id}] no commits on branch — skipping PR`);
    return null;
  }

  try {
    execFileSync('git', ['push', '-u', 'origin', worktree_branch], {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    });

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

    // M14/6D: Merge conflict pre-check
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

    try {
      const existingUrl = execFileSync(
        'gh', ['pr', 'view', worktree_branch, '--json', 'url', '-q', '.url'],
        { cwd: worktree_path, stdio: 'pipe', timeout: 15000 }
      ).toString().trim();
      if (existingUrl) {
        _updateAndEmit(workflow.id, { pr_url: existingUrl });
        console.log(`[workflow ${workflow.id}] PR already exists: ${existingUrl}`);
        return existingUrl;
      }
    } catch { /* no existing PR — create one */ }

    const finalBody = conflictWarning ? body + conflictWarning : body;
    const prArgs = ['pr', 'create', '--title', title, '--body', finalBody, '--head', worktree_branch];
    if (isDraft) {
      prArgs.push('--draft', '--label', 'partial');
    }
    const prUrl = execFileSync('gh', prArgs, {
      cwd: worktree_path, stdio: 'pipe', timeout: 30000,
    }).toString().trim();

    _updateAndEmit(workflow.id, { pr_url: prUrl });
    console.log(`[workflow ${workflow.id}] ${isDraft ? 'draft ' : ''}PR created: ${prUrl}`);
    return prUrl;
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
          return existing;
        }
      } catch { /* can't find existing PR */ }
    }
    console.warn(`[workflow ${workflow.id}] push/PR failed (worktree branch preserved locally):`, stderr);
    return null;
  }
}

export function getPrCreationOutcome(workflow: Workflow, prUrl: string | null): WorkflowPrCreationOutcome {
  if (prUrl) return 'created';
  if (!workflow.worktree_path || !workflow.work_dir) return 'no_publishable_commits';

  let hasPublishableCommits = false;
  try {
    hasPublishableCommits = countBranchCommits(workflow.worktree_path) > 0;
  } catch (err) {
    console.warn(`[workflow ${workflow.id}] getPrCreationOutcome: git error — preserving worktree as safe default:`, errMsg(err));
    return 'failed_with_publishable_commits';
  }

  return hasPublishableCommits ? 'failed_with_publishable_commits' : 'no_publishable_commits';
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
        hasCommits = countBranchCommits(workflow.worktree_path) > 0;
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
    removeWorktree(workflow);
  }
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
      && wf.blocked_reason.includes('PR creation failed'),
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
