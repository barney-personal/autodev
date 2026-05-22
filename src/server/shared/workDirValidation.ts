import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

export interface WorkDirValidationOk {
  ok: true;
  workDir: string;
}

export interface WorkDirValidationError {
  ok: false;
  error: string;
}

export type WorkDirValidationResult = WorkDirValidationOk | WorkDirValidationError;

export function validateGitWorkDir(
  workDir: string | undefined | null,
  opts: { requireGit?: boolean } = {},
): WorkDirValidationResult {
  const trimmed = workDir?.trim();
  if (!trimmed) {
    return { ok: false, error: 'work_dir is required for worktree-enabled workflows' };
  }
  if (!existsSync(trimmed)) {
    return { ok: false, error: `work_dir does not exist: ${trimmed}` };
  }
  if (opts.requireGit !== false) {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: trimmed,
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      return { ok: false, error: `work_dir is not a git repository: ${trimmed}` };
    }
  }
  return { ok: true, workDir: trimmed };
}
