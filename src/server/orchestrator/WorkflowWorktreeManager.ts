/**
 * Git worktree creation, cleanup, branch management, and health verification
 * for the workflow engine.
 * Extracted from WorkflowManager.ts.
 *
 * All git invocations use execFileSync with argument arrays so branch names
 * containing shell-sensitive characters are passed safely.
 */

import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import * as queries from '../db/queries.js';
import type { Workflow } from '../../shared/types.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { errMsg } from '../../shared/errors.js';
import { getWorkflowWorktreeIdentity } from './WorkflowWorktreeIdentity.js';

function git(cwd: string, args: string[], opts: { timeout?: number } = {}): Buffer {
  const options: ExecFileSyncOptions = { cwd, stdio: 'pipe', timeout: opts.timeout ?? 10000 };
  return execFileSync('git', args, options) as Buffer;
}

// ─── Worktree Health & Branch Verification ─────────────────────────────────

/**
 * Verify a worktree HEAD is on the expected branch. If drifted, attempt checkout.
 * Returns { ok: true } on success, or { ok: false, error } if checkout fails.
 */
export function ensureWorktreeBranch(
  worktreePath: string,
  expectedBranch: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const currentBranch = git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
      .toString()
      .trim();
    if (currentBranch !== expectedBranch) {
      console.warn(`[worktree] on '${currentBranch}' instead of '${expectedBranch}' — switching`);
      git(worktreePath, ['checkout', expectedBranch], { timeout: 10000 });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/**
 * Deep health check for a worktree. Verifies directory, .git, git internals,
 * and branch — attempting auto-repair when possible.
 */
export function verifyWorktreeHealth(
  worktreePath: string,
  expectedBranch: string,
  mainRepoDir?: string | null,
): { ok: true } | { ok: false; error: string } {
  // Check 1: directory exists
  if (!existsSync(worktreePath)) {
    if (!mainRepoDir) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'directory_missing', action: 'no_repair_possible', branch: expectedBranch,
      });
      return { ok: false, error: `Worktree directory does not exist: ${worktreePath}` };
    }
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'directory_missing', action: 'recreate', branch: expectedBranch,
    });
    return recreateWorktree(worktreePath, expectedBranch, mainRepoDir);
  }

  // Check 2: .git file/dir is present
  const gitPath = path.join(worktreePath, '.git');
  if (!existsSync(gitPath)) {
    if (!mainRepoDir) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'git_missing', action: 'no_repair_possible', branch: expectedBranch,
      });
      return { ok: false, error: `Worktree .git is missing: ${worktreePath}` };
    }
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'git_missing', action: 'recreate', branch: expectedBranch,
    });
    return recreateWorktree(worktreePath, expectedBranch, mainRepoDir);
  }

  // Check 3: git rev-parse --is-inside-work-tree
  try {
    git(worktreePath, ['rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
  } catch {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'not_inside_work_tree', action: 'force_checkout', branch: expectedBranch,
    });
    try {
      git(worktreePath, ['checkout', '-f', expectedBranch], { timeout: 10000 });
    } catch (err) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'not_inside_work_tree', action: 'force_checkout', outcome: 'failed', error: errMsg(err),
      });
      return { ok: false, error: `git not functional in worktree and force checkout failed: ${errMsg(err)}` };
    }
  }

  // Check 4: HEAD is valid
  try {
    git(worktreePath, ['rev-parse', 'HEAD'], { timeout: 5000 });
  } catch {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      check: 'invalid_head', action: 'force_checkout', branch: expectedBranch,
    });
    try {
      git(worktreePath, ['checkout', '-f', expectedBranch], { timeout: 10000 });
    } catch (err) {
      logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
        check: 'invalid_head', action: 'force_checkout', outcome: 'failed', error: errMsg(err),
      });
      return { ok: false, error: `Invalid HEAD and force checkout failed: ${errMsg(err)}` };
    }
  }

  // Check 5: branch is correct
  return ensureWorktreeBranch(worktreePath, expectedBranch);
}

/**
 * Remove and re-create a worktree from the main repo directory.
 */
function recreateWorktree(
  worktreePath: string,
  branch: string,
  mainRepoDir: string,
): { ok: true } | { ok: false; error: string } {
  try {
    try {
      git(mainRepoDir, ['worktree', 'remove', '--force', worktreePath], { timeout: 15000 });
    } catch { /* may not be registered — fine */ }
    git(mainRepoDir, ['worktree', 'prune'], { timeout: 10000 });
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(mainRepoDir, ['worktree', 'add', worktreePath, branch], { timeout: 30000 });
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      action: 'recreate', outcome: 'success', branch,
    });
    return { ok: true };
  } catch (err) {
    logResilienceEvent('worktree_repair', 'worktree', worktreePath, {
      action: 'recreate', outcome: 'failed', branch, error: errMsg(err),
    });
    return { ok: false, error: `Worktree recreation failed: ${errMsg(err)}` };
  }
}

// ─── Worktree Creation ──────────────────────────────────────────────────────

/**
 * Create a worktree for a new workflow. Returns the updated workflow on success,
 * or null if creation failed (workflow will be marked blocked).
 */
export function createWorkflowWorktree(
  workflow: Workflow,
  updateAndEmit: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void,
): Workflow | null {
  try {
    const identity = getWorkflowWorktreeIdentity(workflow);
    if (!identity) {
      throw new Error('cannot resolve worktree identity (missing work_dir)');
    }
    const { worktree_path: worktreePath, worktree_branch: branchName } = identity;
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(workflow.work_dir!, ['worktree', 'add', worktreePath, '-b', branchName], { timeout: 30000 });
    const activeWorkflow = queries.updateWorkflow(workflow.id, {
      worktree_path: worktreePath,
      worktree_branch: branchName,
    }) ?? workflow;
    console.log(`[workflow ${workflow.id}] created worktree at ${worktreePath} (branch: ${branchName})`);
    return activeWorkflow;
  } catch (err) {
    const reason = `Worktree creation failed: ${errMsg(err)}`;
    console.warn(`[workflow ${workflow.id}] ${reason}`);
    updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
    return null;
  }
}

/**
 * Restore a missing worktree for a resumed workflow.
 * Throws on failure so the caller can propagate the error.
 */
export function restoreWorkflowWorktree(workflow: Workflow): void {
  const identity = getWorkflowWorktreeIdentity(workflow);
  if (!identity) {
    throw new Error('Worktree restoration failed during resume: missing work_dir');
  }
  const { worktree_path: worktreePath, worktree_branch: branchName } = identity;
  try {
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    try {
      git(workflow.work_dir!, ['worktree', 'prune'], { timeout: 10000 });
    } catch { /* prune failure is non-fatal */ }
    let branchExists = false;
    try {
      git(workflow.work_dir!, ['rev-parse', '--verify', `refs/heads/${branchName}`], { timeout: 10000 });
      branchExists = true;
    } catch { /* branch doesn't exist — will create with -b */ }
    if (branchExists) {
      git(workflow.work_dir!, ['worktree', 'add', worktreePath, branchName], { timeout: 30000 });
    } else {
      git(workflow.work_dir!, ['worktree', 'add', worktreePath, '-b', branchName], { timeout: 30000 });
    }
    queries.updateWorkflow(workflow.id, { worktree_path: worktreePath, worktree_branch: branchName });
    logResilienceEvent('worktree_restore', 'workflow', workflow.id, {
      action: 'restore', outcome: 'success', branch: branchName, worktree_path: worktreePath,
    });
    console.log(`[workflow ${workflow.id}] restored worktree at ${worktreePath} (branch: ${branchName}) during resume`);
  } catch (err) {
    logResilienceEvent('worktree_restore', 'workflow', workflow.id, {
      action: 'restore', outcome: 'failed', branch: branchName, error: errMsg(err),
    });
    throw new Error(`Worktree restoration failed during resume: ${errMsg(err)}`);
  }
}

/**
 * Called when a workflow is cancelled — skip the PR, just clean up the worktree.
 */
export function cleanupWorktree(workflow: Workflow): void {
  queries.releaseWorkflowClaims(workflow.id);
  removeWorktree(workflow);
}

/**
 * Quarantine a worktree instead of deleting it.
 *
 * Used when the orchestrator's commit-detection thinks the branch is empty
 * (`no_publishable_commits` outcome). Even when the detection is correct,
 * the brief (Goal A.4) requires preserving the worktree for human rescue —
 * the 2026-05-17 incident lost work because verified-empty was indistinguishable
 * from "unverifiable" until the new `countBranchCommits` semantics landed.
 *
 * Moves <worktree_path> to <work_dir>/.orchestrator-quarantine/<workflow_id>/
 * (timestamp-suffixed if a prior quarantine exists), writes a one-line WHY.md
 * with the workflow id, ISO timestamp, original path, and reason, then prunes
 * the git worktree registration and clears `worktree_path` on the workflow row.
 */
export function quarantineWorktree(
  workflow: Workflow,
  reason: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const { worktree_path, work_dir, id } = workflow;
  if (!worktree_path || !work_dir) {
    return { ok: false, error: 'missing worktree_path or work_dir' };
  }
  if (!existsSync(worktree_path)) {
    return { ok: false, error: `worktree directory missing at ${worktree_path}` };
  }

  const quarantineRoot = path.join(work_dir, '.orchestrator-quarantine');
  let destPath = path.join(quarantineRoot, id);
  if (existsSync(destPath)) {
    destPath = `${destPath}-${Date.now()}`;
  }

  try {
    mkdirSync(quarantineRoot, { recursive: true });
    renameSync(worktree_path, destPath);
  } catch (err) {
    return { ok: false, error: `move failed: ${errMsg(err)}` };
  }

  try {
    const why = [
      `workflow_id: ${id}`,
      `timestamp_iso: ${new Date().toISOString()}`,
      `original_worktree_path: ${worktree_path}`,
      `worktree_branch: ${workflow.worktree_branch ?? ''}`,
      `reason: ${reason}`,
      '',
      'This worktree was preserved by the orchestrator because the wrap-up flow',
      'classified it as having no publishable commits. The brief (Goal A.4)',
      'requires preservation rather than deletion on this path; a human operator',
      'should inspect this directory, push or discard any salvageable work, and',
      'remove it via `git worktree remove --force` once handled.',
      '',
    ].join('\n');
    writeFileSync(path.join(destPath, 'WHY.md'), why);
  } catch (err) {
    console.warn(`[workflow ${id}] quarantine WHY.md write failed: ${errMsg(err)}`);
  }

  // Prune the git worktree registration so a future `git worktree list` does
  // not see a stale entry pointing at the now-moved directory.
  try {
    git(work_dir, ['worktree', 'prune'], { timeout: 10000 });
  } catch (err) {
    console.warn(`[workflow ${id}] git worktree prune failed during quarantine: ${errMsg(err)}`);
  }

  try {
    queries.updateWorkflow(id, { worktree_path: null });
  } catch (err) {
    console.warn(`[workflow ${id}] DB clear of worktree_path failed: ${errMsg(err)}`);
  }

  console.log(`[workflow ${id}] worktree quarantined at ${destPath} (${reason})`);
  return { ok: true, path: destPath };
}

/**
 * Remove a worktree, auto-saving uncommitted work first.
 * Exported for use by WorkflowPRCreator.
 */
export function removeWorktree(workflow: Workflow): void {
  const { worktree_path, work_dir } = workflow;
  if (!worktree_path || !work_dir) return;
  try {
    const status = git(worktree_path, ['status', '--porcelain'], { timeout: 5000 })
      .toString()
      .trim();
    if (status) {
      console.log(`[workflow ${workflow.id}] saving uncommitted work before worktree removal`);
      git(worktree_path, ['add', '-A'], { timeout: 10000 });
      git(worktree_path, ['commit', '-m', 'wip: auto-saved uncommitted work before worktree cleanup'], { timeout: 10000 });
      const branch = workflow.worktree_branch;
      if (branch) {
        try {
          git(worktree_path, ['push', 'origin', branch], { timeout: 30000 });
        } catch { /* push failed — work is still in local branch */ }
      }
    }
  } catch { /* status/commit failed — proceed with removal anyway */ }

  // If the worktree directory is already gone (concurrent cleanup,
  // manual rm, crashed cancel that removed the dir before recording
  // status), the git remove call will fail with "is not a working
  // tree" even though the desired end state is already reached. Treat
  // that as success and prune stale registrations. Suppresses
  // HURLICANE-SF.
  if (!existsSync(worktree_path)) {
    pruneWorktreeRegistrations(work_dir);
    console.log(`[workflow ${workflow.id}] worktree already removed — pruned registrations`);
    return;
  }

  try {
    git(work_dir, ['worktree', 'remove', '--force', worktree_path], { timeout: 15000 });
    pruneWorktreeRegistrations(work_dir);
    console.log(`[workflow ${workflow.id}] worktree removed`);
  } catch (err) {
    const message = errMsg(err);
    if (/is not a working tree/i.test(message)) {
      pruneWorktreeRegistrations(work_dir);
      console.log(`[workflow ${workflow.id}] worktree already removed — pruned registrations`);
      return;
    }
    console.warn(`[workflow ${workflow.id}] worktree removal failed:`, message);
  }
}

function pruneWorktreeRegistrations(workDir: string): void {
  try {
    git(workDir, ['worktree', 'prune'], { timeout: 10000 });
  } catch { /* prune is best-effort */ }
}
