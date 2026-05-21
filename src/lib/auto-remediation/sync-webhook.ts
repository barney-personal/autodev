import { randomUUID } from 'crypto';
import * as queries from '../../server/db/queries.js';
import * as socket from '../../server/socket/SocketManager.js';
import { nudgeQueue } from '../../server/orchestrator/WorkQueueManager.js';

export interface SyncFailurePhase {
  name: string;
  status: 'error' | 'success' | 'skipped';
  error?: string;
  detail?: string;
}

export interface SyncFailurePayload {
  syncLogId: number;
  source: string;
  status: 'error';
  startedAt: string;
  completedAt: string;
  errorMessage: string;
  lastSuccessAt: string | null;
  consecutiveFailureCount: number;
  failedPhases?: SyncFailurePhase[];
  deployedSha?: string;
}

export interface RemediationDispatch {
  dispatchId: string;
  jobId: string;
  status: 'queued';
}

export function buildSyncRemediationPrompt(payload: SyncFailurePayload, dispatchId: string): string {
  const failedPhasesText = payload.failedPhases?.length
    ? payload.failedPhases
        .map(p => {
          let line = `- ${p.name} [${p.status}]${p.error ? `: ${p.error}` : ''}`;
          if (p.detail) line += `\n    detail: ${p.detail}`;
          return line;
        })
        .join('\n')
    : '(none reported)';

  return `# Task: ${payload.source.charAt(0).toUpperCase() + payload.source.slice(1)} Sync failure: ${payload.source}

[CONTEXT]

- Dispatch id: ${dispatchId}
- Trigger type: sync
- Fingerprint: sync:${payload.source}
- Title: Sync failure: ${payload.source}

## Sync failure summary
- syncLogId: ${payload.syncLogId}
- source: ${payload.source}
- status: ${payload.status}
- startedAt: ${payload.startedAt}
- completedAt: ${payload.completedAt}
- errorMessage: ${payload.errorMessage}
- lastSuccessAt: ${payload.lastSuccessAt ?? 'never'}
- consecutiveFailureCount: ${payload.consecutiveFailureCount}
- Currently deployed SHA: ${payload.deployedSha ?? '(unknown)'}

## Failed phases
${failedPhasesText}

[INSTRUCTIONS]

You have been dispatched by the ceo-dashboard auto-remediation pipeline. Your job is to investigate the failure described above, write a failing test that reproduces the issue, fix it, verify all tests pass, then open a PR.

Workflow (do NOT skip steps):
1. Investigate. Read the [CONTEXT] above, then read the relevant files. Form a hypothesis about the root cause.
2. Write a failing test that reproduces the issue. Name it after the bug. The test must fail on the current main and pass after your fix.
3. Fix the code.
4. Verify all tests pass (run the project's full test suite, not just your new test).
5. Open a PR. The PR description must include: (a) a short statement of the root cause, (b) a link to the failing test you added, (c) the auto-remediation dispatch id from [CONTEXT].

Do NOT push or open a PR until step 2's test is failing on main and step 4's full test suite is green. If you cannot reproduce the issue with a test, post a comment on the dispatch instead of opening a PR.`;
}

export function dispatchSyncRemediationJob(payload: SyncFailurePayload): RemediationDispatch {
  const dispatchId = randomUUID();
  const jobId = randomUUID();

  const description = buildSyncRemediationPrompt(payload, dispatchId);
  const title = `[Sync] ${payload.source}: ${payload.errorMessage}`.slice(0, 120);

  const job = queries.insertJob({
    id: jobId,
    title,
    description,
    context: JSON.stringify({
      trigger: 'sync',
      syncSource: payload.source,
      syncLogId: payload.syncLogId,
      errorMessage: payload.errorMessage,
      dispatchId,
    }),
    priority: 5,
  });

  socket.emitJobNew(job);
  nudgeQueue();

  return { dispatchId, jobId, status: 'queued' };
}
