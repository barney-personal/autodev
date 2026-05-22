import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { dispatchRemediationJob, type SentryWebhookPayload } from '../../lib/auto-remediation/sentry-webhook.js';
import { dispatchSyncRemediationJob, type SyncFailurePayload, type SyncFailurePhase } from '../../lib/auto-remediation/sync-webhook.js';

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

function requireSyncBearer(req: Request, res: Response): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header. Expected: Bearer <token>' });
    return false;
  }

  if (header.slice(7) !== expected) {
    res.status(403).json({ error: 'Invalid bearer token' });
    return false;
  }

  return true;
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

function isValidSyncFailurePhase(phase: unknown): phase is SyncFailurePhase {
  if (!phase || typeof phase !== 'object') return false;
  const p = phase as Record<string, unknown>;
  return (
    typeof p.name === 'string' &&
    p.name.length > 0 &&
    (p.status === 'error' || p.status === 'success' || p.status === 'skipped') &&
    (p.error === undefined || typeof p.error === 'string')
  );
}

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
    typeof b.consecutiveFailureCount === 'number' &&
    (b.lastSuccessAt === undefined || b.lastSuccessAt === null || typeof b.lastSuccessAt === 'string') &&
    (b.deployedSha === undefined || typeof b.deployedSha === 'string') &&
    (b.failedPhases === undefined || (Array.isArray(b.failedPhases) && b.failedPhases.every(isValidSyncFailurePhase)))
  );
}

router.post('/sync', (req, res) => {
  if (!requireSyncBearer(req, res)) return;

  const body = req.body as Partial<SyncFailurePayload>;

  if (body.status !== 'error') {
    res.status(400).json({ error: 'Only "error" status is supported' });
    return;
  }

  if (!isValidSyncFailure(body)) {
    res.status(400).json({ error: 'Missing or invalid sync failure data' });
    return;
  }

  const dispatch = dispatchSyncRemediationJob(body);
  res.status(201).json(dispatch);
});

export default router;
