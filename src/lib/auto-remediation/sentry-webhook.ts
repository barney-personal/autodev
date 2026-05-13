import { randomUUID } from 'crypto';
import * as queries from '../../server/db/queries.js';
import * as socket from '../../server/socket/SocketManager.js';
import { nudgeQueue } from '../../server/orchestrator/WorkQueueManager.js';

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  web_url: string;
  fingerprints: string[];
  tags?: Array<{ key: string; value: string }>;
  metadata?: { value?: string; type?: string };
}

export interface SentryWebhookPayload {
  action: string;
  data: {
    issue: SentryIssue;
  };
}

export interface RemediationDispatch {
  dispatchId: string;
  jobId: string;
  status: 'queued';
}

export function buildRemediationPrompt(issue: SentryIssue, dispatchId: string): string {
  const fingerprint = issue.fingerprints[0] ?? 'unknown';
  const tags = issue.tags
    ? issue.tags.map(t => `- ${t.key}: ${t.value}`).join('\n')
    : '(none)';

  return `# Task: Auto-Remediation Dispatch

[CONTEXT]

- Dispatch id: ${dispatchId}
- Trigger type: sentry
- Fingerprint: ${fingerprint}
- Title: ${issue.title}

## Error summary
- Sentry issue id: ${issue.id}
- Sentry fingerprint: ${fingerprint}
- Sentry URL: ${issue.web_url}
- Culprit: ${issue.culprit}

## Tags
${tags}

[INSTRUCTIONS]

You have been dispatched by the auto-remediation pipeline. Your job is to investigate the failure described above, write a failing test that reproduces the issue, fix it, verify all tests pass, then open a PR.

Workflow (do NOT skip steps):
1. Investigate. Read the [CONTEXT] above, then read the relevant files. Form a hypothesis about the root cause.
2. Write a failing test that reproduces the issue. Name it after the bug. The test must fail on the current main and pass after your fix.
3. Fix the code.
4. Verify all tests pass (run the project's full test suite, not just your new test).
5. Open a PR. The PR description must include: (a) a short statement of the root cause, (b) a link to the failing test you added, (c) the auto-remediation dispatch id from [CONTEXT].

Do NOT push or open a PR until step 2's test is failing on main and step 4's full test suite is green. If you cannot reproduce the issue with a test, post a comment on the dispatch instead of opening a PR.`;
}

export function dispatchRemediationJob(payload: SentryWebhookPayload): RemediationDispatch {
  const issue = payload.data.issue;
  const dispatchId = randomUUID();
  const jobId = randomUUID();

  const description = buildRemediationPrompt(issue, dispatchId);
  const title = `[Sentry] ${issue.title}`.slice(0, 120);

  const job = queries.insertJob({
    id: jobId,
    title,
    description,
    context: JSON.stringify({
      trigger: 'sentry',
      sentryIssueId: issue.id,
      sentryFingerprint: issue.fingerprints[0] ?? null,
      sentryUrl: issue.web_url,
      dispatchId,
    }),
    priority: 5,
  });

  socket.emitJobNew(job);
  nudgeQueue();

  return { dispatchId, jobId, status: 'queued' };
}
