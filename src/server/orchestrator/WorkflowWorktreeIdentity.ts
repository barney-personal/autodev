/**
 * Single source of truth for workflow worktree branch and path naming.
 *
 * Both WorkflowManager (rehydration) and WorkflowWorktreeManager (create/restore)
 * resolve identity through this helper so the two cannot drift.
 *
 * Naming format (must be preserved for DB compatibility):
 *   branch: workflow/<slug>-<shortId>
 *   path:   <work_dir>/../.orchestrator-worktrees/<repoName>/wf-<shortId>
 */

import path from 'path';
import type { Workflow } from '../../shared/types.js';

export interface WorkflowWorktreeIdentity {
  worktree_path: string;
  worktree_branch: string;
}

export function slugForWorkflow(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function shortWorkflowId(id: string): string {
  return id.slice(0, 8);
}

export function getWorkflowWorktreeIdentity(workflow: Workflow): WorkflowWorktreeIdentity | null {
  if (!workflow.work_dir) return null;
  const shortId = shortWorkflowId(workflow.id);
  const slug = slugForWorkflow(workflow.title);
  const worktree_branch = `workflow/${slug}-${shortId}`;
  const repoName = path.basename(workflow.work_dir);
  const worktree_path = path.resolve(
    workflow.work_dir,
    '..',
    '.orchestrator-worktrees',
    repoName,
    `wf-${shortId}`,
  );
  return { worktree_path, worktree_branch };
}
