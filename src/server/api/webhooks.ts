import { Router, type Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { dispatchRemediationJob, type SentryWebhookPayload } from '../../lib/auto-remediation/sentry-webhook.js';

const router = Router();

// Sentry signs webhooks with HMAC-SHA256(secret, raw_body) in the
// `sentry-hook-signature` header. If `SENTRY_WEBHOOK_SECRET` is unset we accept
// unsigned requests (back-compat with local dev); the warning is logged once at
// dispatch time so an internet-facing deployment without a secret is loud.
let warnedAboutMissingSecret = false;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isTagArray(v: unknown): v is Array<{ key: string; value: string }> {
  if (!Array.isArray(v)) return false;
  return v.every(t => {
    if (!t || typeof t !== 'object') return false;
    const r = t as Record<string, unknown>;
    return typeof r.key === 'string' && typeof r.value === 'string';
  });
}

function isValidSentryIssue(issue: unknown): issue is SentryWebhookPayload['data']['issue'] {
  if (!issue || typeof issue !== 'object') return false;
  const i = issue as Record<string, unknown>;
  if (typeof i.id !== 'string') return false;
  if (typeof i.title !== 'string') return false;
  if (typeof i.culprit !== 'string') return false;
  if (typeof i.web_url !== 'string') return false;
  if (!isStringArray(i.fingerprints)) return false;
  if (i.tags !== undefined && !isTagArray(i.tags)) return false;
  return true;
}

function verifySentrySignature(req: Request): boolean {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) {
    if (!warnedAboutMissingSecret) {
      // eslint-disable-next-line no-console
      console.warn('[webhooks/sentry] SENTRY_WEBHOOK_SECRET is unset — accepting unsigned webhooks. Set this for any deployment reachable from the internet.');
      warnedAboutMissingSecret = true;
    }
    return true;
  }
  const sig = req.headers['sentry-hook-signature'];
  if (typeof sig !== 'string') return false;
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) return false;
  const expectedHex = createHmac('sha256', secret).update(raw).digest('hex');
  if (sig.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(sig, 'utf8'));
  } catch {
    return false;
  }
}

router.post('/sentry', (req, res) => {
  if (!verifySentrySignature(req)) {
    res.status(401).json({ error: 'Invalid or missing sentry-hook-signature' });
    return;
  }

  const body = req.body as Partial<SentryWebhookPayload>;

  // Sentry sends other actions (assigned, resolved, ignored) over the same
  // webhook. Respond 200 so Sentry doesn't flag the integration as broken; we
  // just don't dispatch a remediation job.
  if (body.action !== 'created') {
    res.status(200).json({ status: 'ignored', reason: `action=${body.action ?? 'unknown'}` });
    return;
  }

  if (!isValidSentryIssue(body.data?.issue)) {
    res.status(400).json({ error: 'Missing or invalid issue data' });
    return;
  }

  const dispatch = dispatchRemediationJob(body as SentryWebhookPayload);
  res.status(dispatch.deduplicated ? 200 : 201).json(dispatch);
});

export default router;
