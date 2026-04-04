import { execSync } from 'child_process';
import * as queries from '../db/queries.js';
import type { Job, Agent } from '../../shared/types.js';

/**
 * Runs completion checks configured on a job after the agent reports success.
 * Returns null if all checks pass, or an error string describing failures.
 */
export function runCompletionChecks(job: Job, agent: Agent): string | null {
  if (!job.completion_checks) return null;

  let checks: string[];
  try {
    checks = JSON.parse(job.completion_checks);
  } catch {
    // malformed JSON in completion_checks field — treat as no checks configured
    return null;
  }
  if (!Array.isArray(checks) || checks.length === 0) return null;

  const failures: string[] = [];

  for (const check of checks) {
    if (check === 'diff_not_empty') {
      if (!agent.diff || !agent.diff.trim()) {
        failures.push('diff_not_empty: agent produced no git changes');
      }
    } else if (check === 'no_error_in_output') {
      const hasError = checkForErrorEvents(agent.id);
      if (hasError) {
        failures.push('no_error_in_output: error events found in agent output');
      }
    } else if (check.startsWith('custom_command:')) {
      const cmd = check.slice('custom_command:'.length).trim();
      if (cmd) {
        const result = runCustomCommand(cmd, job);
        if (result) {
          failures.push(`custom_command: ${result}`);
        }
      }
    }
  }

  return failures.length > 0 ? failures.join('; ') : null;
}

function checkForErrorEvents(agentId: string): boolean {
  const output = queries.getAgentOutput(agentId);
  // Check last 20 output rows for error events
  const last20 = output.slice(-20);
  for (const row of last20) {
    try {
      const ev = JSON.parse(row.content);
      if (ev.type === 'error') return true;
    } catch { /* non-JSON output row — not an event object, skip */ }
  }
  return false;
}

function runCustomCommand(cmd: string, job: Job): string | null {
  const workDir = job.work_dir ?? process.cwd();
  try {
    execSync(cmd, { cwd: workDir, timeout: 30_000, stdio: 'pipe' });
    return null; // exit 0 = pass
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() ?? '';
    const msg = stderr.slice(0, 200) || `command exited with code ${err.status ?? 'unknown'}`;
    return msg;
  }
}
