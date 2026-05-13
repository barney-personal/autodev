import { Router } from 'express';
import { dispatchRemediationJob, type SentryWebhookPayload } from '../../lib/auto-remediation/sentry-webhook.js';

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

export default router;
