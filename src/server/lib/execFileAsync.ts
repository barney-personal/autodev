/**
 * Lazy-promisified execFile shared by the watcher modules.
 *
 * Why lazy: several test files in this codebase mock `child_process`
 * partially (e.g. providing only `execFileSync` for tmux teardown). Doing
 * `promisify(execFile)` at module-init evaluates the named import
 * immediately, and `promisify(undefined)` throws — which would crash every
 * test that loads any module in the same graph.
 *
 * Deferring the promisify call until first invocation lets test mocks stay
 * valid: a test that never triggers a git or tmux call won't ever resolve
 * `execFile`, so its partial mock works fine.
 *
 * AgentRunner has its own copy of this pattern (with a deliberately separate
 * lifecycle because its mocks are scoped differently); this helper covers
 * the watcher modules so they don't drift.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

export interface ExecFileAsyncOpts {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
}

let _execFileAsync: ((file: string, args: string[], opts?: ExecFileAsyncOpts) => Promise<{ stdout: string; stderr: string }>) | null = null;

export function execFileAsync(
  file: string,
  args: string[],
  opts: ExecFileAsyncOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!_execFileAsync) {
    _execFileAsync = promisify(execFile) as unknown as (
      file: string,
      args: string[],
      opts?: ExecFileAsyncOpts,
    ) => Promise<{ stdout: string; stderr: string }>;
  }
  return _execFileAsync(file, args, opts);
}
