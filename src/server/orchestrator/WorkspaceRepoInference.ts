/**
 * Infer the workspace git repository for a workflow whose work_dir is null,
 * using the leading segment of the workflow title.
 *
 * Used by StuckJobWatchdog for automatic recovery and by WorkflowBlockedDiagnostics
 * for operator-facing recovery hints.
 */
import { execFileSync as _defaultExecFileSync } from 'child_process';
import { existsSync as _defaultExistsSync, readdirSync as _defaultReaddirSync, statSync as _defaultStatSync } from 'fs';
import path from 'path';

export const WORKSPACE_BASE_DIR = process.env.WORKSPACE_BASE_DIR ?? '/home/node/.openclaw/workspace';

export interface InferWorkspaceRepoResult {
  match: string | null;
  candidates: string[];
  reason: string;
}

export interface InferWorkspaceRepoOpts {
  workspaceBaseDir?: string;
  execFileSync?: typeof _defaultExecFileSync;
  existsSync?: typeof _defaultExistsSync;
  readdirSync?: typeof _defaultReaddirSync;
  statSync?: typeof _defaultStatSync;
}

/**
 * Normalize a string to lowercase kebab-case for comparison.
 * Converts non-alphanumeric characters (except hyphens) to hyphens,
 * collapses runs, trims leading/trailing hyphens.
 */
export function normalizeToKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract the leading segment of a workflow title before the first separator.
 * Separators: em dash (—), en dash (–), hyphen-minus surrounded by spaces ( - ),
 * or colon (:).
 */
export function extractTitleLeadingSegment(title: string): string {
  // Match em dash, en dash, or space-hyphen-space as separator
  const match = title.match(/^(.*?)(?:\s+[—–]\s+|\s+-\s+|:).*/);
  if (match) return match[1].trim();
  return title.trim();
}

/**
 * Infer the workspace git repo path from a workflow title.
 *
 * Algorithm:
 * 1. Extract the leading title segment (text before the first separator)
 * 2. Normalize to lowercase kebab
 * 3. List immediate children of workspaceBaseDir
 * 4. For each child: check exists, is directory, is git repo
 * 5. Match when normalized child name equals normalized title segment
 * 6. Return match only when exactly one candidate matches
 */
export function inferWorkspaceRepoFromTitle(
  title: string,
  opts: InferWorkspaceRepoOpts = {},
): InferWorkspaceRepoResult {
  const {
    workspaceBaseDir = WORKSPACE_BASE_DIR,
    execFileSync = _defaultExecFileSync,
    existsSync = _defaultExistsSync,
    readdirSync = _defaultReaddirSync,
    statSync = _defaultStatSync,
  } = opts;

  const leading = extractTitleLeadingSegment(title);
  const normalizedTitle = normalizeToKebab(leading);

  if (!normalizedTitle) {
    return { match: null, candidates: [], reason: 'title leading segment is empty after normalization' };
  }

  if (!existsSync(workspaceBaseDir)) {
    return { match: null, candidates: [], reason: `workspace base dir does not exist: ${workspaceBaseDir}` };
  }

  let entries: string[];
  try {
    entries = readdirSync(workspaceBaseDir) as string[];
  } catch (err: any) {
    return { match: null, candidates: [], reason: `could not list workspace base dir: ${err?.message ?? String(err)}` };
  }

  const validCandidates: string[] = [];
  const allConsideredPaths: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(workspaceBaseDir, entry);
    allConsideredPaths.push(fullPath);

    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const normalizedEntry = normalizeToKebab(entry);
    if (normalizedEntry !== normalizedTitle) continue;

    // Verify it's a valid git repo
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: fullPath,
        timeout: 5000,
        stdio: 'pipe',
      });
      validCandidates.push(fullPath);
    } catch {
      // Not a git repo — skip
    }
  }

  if (validCandidates.length === 0) {
    const tried = allConsideredPaths.length > 0
      ? `Considered ${allConsideredPaths.length} workspace entr${allConsideredPaths.length === 1 ? 'y' : 'ies'}; none matched normalized title segment '${normalizedTitle}'.`
      : `Workspace dir is empty or has no entries.`;
    return { match: null, candidates: allConsideredPaths, reason: tried };
  }

  if (validCandidates.length > 1) {
    return {
      match: null,
      candidates: validCandidates,
      reason: `ambiguous: ${validCandidates.length} workspace repos match title segment '${normalizedTitle}': ${validCandidates.join(', ')}`,
    };
  }

  return {
    match: validCandidates[0],
    candidates: validCandidates,
    reason: `inferred from title segment '${normalizedTitle}' → ${validCandidates[0]}`,
  };
}
