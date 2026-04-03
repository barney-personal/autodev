/**
 * In-process event notifier for job terminal-state transitions.
 *
 * Only depends on shared/types (for Job) — safe to import from the DB
 * or MCP layer without creating circular imports.  When `updateJobStatus()` writes a terminal
 * status it calls `notifyJobTerminal()`, which synchronously fires any
 * listeners registered by `waitForJobsHandler()` (or tests).
 */
import { EventEmitter } from 'events';
import type { Job } from '../../shared/types.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // allow unlimited concurrent waiters

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Call this whenever a job reaches (or is set to) a terminal status.
 * Safe to call for non-terminal statuses — they are silently ignored.
 */
export function notifyJobTerminal(jobId: string, status: string): void {
  if (TERMINAL.has(status)) {
    emitter.emit(`terminal:${jobId}`, status);
  }
}

/**
 * Returns a promise that resolves when ANY of the given jobs emits a
 * terminal event, plus a `cancel` function that removes all listeners
 * (call it when the poll-sleep wins the race to avoid leaks).
 */
export function onAnyTerminal(jobIds: string[]): { promise: Promise<string>; cancel: () => void } {
  let settled = false;
  const cleanups: (() => void)[] = [];

  const promise = new Promise<string>((resolve) => {
    const finish = (jobId: string) => {
      if (settled) return;
      settled = true;
      for (const fn of cleanups) fn();
      resolve(jobId);
    };

    for (const id of jobIds) {
      const handler = () => finish(id);
      emitter.once(`terminal:${id}`, handler);
      cleanups.push(() => emitter.removeListener(`terminal:${id}`, handler));
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      for (const fn of cleanups) fn();
    },
  };
}

// ---------------------------------------------------------------------------
// Callback registration — allows MCP tools (finishJob) to invoke
// handleJobCompletion without importing AgentRunner directly.
// ---------------------------------------------------------------------------

type CompletionHandler = (agentId: string, job: Job, status: 'done' | 'failed') => Promise<void>;
let _completionHandler: CompletionHandler | null = null;

export function registerCompletionHandler(h: CompletionHandler): void {
  _completionHandler = h;
}

export async function runJobCompletion(agentId: string, job: Job, status: 'done' | 'failed'): Promise<void> {
  if (!_completionHandler) throw new Error('No job completion handler registered — AgentRunner may not have initialized');
  return _completionHandler(agentId, job, status);
}

/** Expose emitter for testing only. */
export function _getEmitter(): EventEmitter {
  return emitter;
}
