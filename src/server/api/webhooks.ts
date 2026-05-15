import { Router } from 'express';
import { dispatchRemediationJob, type SentryWebhookPayload } from '../../lib/auto-remediation/sentry-webhook.js';
import { dispatchSyncRemediationJob, type SyncFailurePayload } from '../../lib/auto-remediation/sync-webhook.js';

const router = Router();

function isValidSentryIssue(issue: unknown): issue is SentryWebhookPayload['data']['issue'] {
  if (!issue || typeof issue !== 'object') return false;
  const i = issue as Record<string, unknown>;
  return (
    typeof i.id === 'string' &&
    typeof i.title === 'string' &&
    typeof i.culprit === 'string' &&
    typeof i.web_url === 'string' &&
    Array.isArray(i.fingerprints)
  );
}

router.post('/sentry', (req, res) => {
  const body = req.body as Partial<SentryWebhookPayload>;

  if (body.action !== 'created') {
    res.status(400).json({ error: 'Only "created" action is supported' });
    return;
  }

  if (!isValidSentryIssue(body.data?.issue)) {
    res.status(400).json({ error: 'Missing or invalid issue data' });
    return;
  }

  const dispatch = dispatchRemediationJob(body as SentryWebhookPayload);
  res.status(201).json(dispatch);
});

function isValidSyncFailure(body: unknown): body is SyncFailurePayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.syncLogId === 'number' &&
    typeof b.source === 'string' &&
    b.source.length > 0 &&
    b.status === 'error' &&
    typeof b.errorMessage === 'string' &&
    typeof b.startedAt === 'string' &&
    typeof b.completedAt === 'string' &&
    typeof b.consecutiveFailureCount === 'number'
  );
}

router.post('/sync', (req, res) => {
  const body = req.body as Partial<SyncFailurePayload>;

  if (body.status !== 'error') {
    res.status(400).json({ error: 'Only "error" status is supported' });
    return;
  }

  if (!isValidSyncFailure(body)) {
    res.status(400).json({ error: 'Missing or invalid sync failure data' });
    return;
  }

  const dispatch = dispatchSyncRemediationJob(body as SyncFailurePayload);
  res.status(201).json(dispatch);
});

export default router;
