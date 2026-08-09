/**
 * Push-remote readiness checks shared by both PR-creation paths:
 * WorkflowPRCreator (workflow branches) and PrCreator (standalone jobs).
 *
 * Jobs run in worktrees under /tmp/.orchestrator-worktrees/<repo>/. When the
 * parent repo has no `origin`, git reads the literal string 'origin' as a URL
 * and fails with "fatal: 'origin' does not appear to be a git repository".
 * That is a permanent environment condition, not a transient push error —
 * retrying never helps, so callers should skip the push and preserve the
 * worktree instead.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { execErrMsg } from '../../shared/errors.js';

export interface PushRemoteReadiness {
  ok: boolean;
  error?: string;
}

export function validatePushRemote(cwd: string): PushRemoteReadiness {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString().trim();
  } catch (err) {
    return { ok: false, error: `origin remote is not configured: ${execErrMsg(err)}` };
  }

  if (!isUsablePushRemoteUrl(remoteUrl, cwd)) {
    return { ok: false, error: `origin remote is not a usable push URL: ${remoteUrl || '(empty)'}` };
  }

  return { ok: true };
}

export function isUsablePushRemoteUrl(remoteUrl: string, cwd: string): boolean {
  // `git remote get-url` should not produce empty stdout on a real configured
  // remote. Treat empty as unknown rather than blocking so tests and unusual Git
  // wrappers can still fall through to the real push error.
  if (!remoteUrl) return true;
  if (/^(https?|ssh|git):\/\//i.test(remoteUrl)) return true;
  if (/^[^@\s]+@[^:\s]+:.+/.test(remoteUrl)) return true;
  if (remoteUrl.startsWith('file://')) return true;
  if (path.isAbsolute(remoteUrl)) return existsSync(remoteUrl);
  if (remoteUrl.startsWith('.') || remoteUrl.includes('/')) {
    return existsSync(path.resolve(cwd, remoteUrl));
  }
  return false;
}

export function isPermanentPushFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('does not appear to be a git repository')
    || lower.includes('could not read from remote repository')
    || lower.includes('repository not found');
}
