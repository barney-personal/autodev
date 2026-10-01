import { getModelUnavailability, clearModelUnavailability } from '../orchestrator/ModelAvailability.js';
import { Router } from 'express';
import { CLAUDE_MODEL_OPTIONS, DEFAULT_WORKFLOW_IMPLEMENTER_MODEL, DEFAULT_WORKFLOW_REVIEWER_MODEL } from '../../shared/models.js';
import { getCodexCatalog } from '../orchestrator/ModelCatalog.js';
import { getRateLimitStatus, markModelRateLimited, clearModelRateLimit } from '../orchestrator/ModelClassifier.js';
import { getAdaptiveRoutingStatus } from '../orchestrator/AdaptiveModelRouter.js';

const router = Router();

router.get('/', (_req, res) => {
  const catalog = getCodexCatalog();
  res.json({
    claude: CLAUDE_MODEL_OPTIONS,
    codex: catalog.models.map(model => getModelUnavailability(model.value) ? { ...model, label: model.label + ' (account unavailable; uses fallback)' } : model),
    unavailable: [...CLAUDE_MODEL_OPTIONS, ...catalog.models].map(m => getModelUnavailability(m.value)).filter(Boolean),
    source: catalog.source,
    lastFetchedAt: catalog.fetchedAt,
    defaults: {
      implementer: DEFAULT_WORKFLOW_IMPLEMENTER_MODEL,
      reviewer: DEFAULT_WORKFLOW_REVIEWER_MODEL,
    },
    rateLimits: getRateLimitStatus(),
    adaptiveRouting: getAdaptiveRoutingStatus(),
  });
});

router.delete('/availability/:model', (req, res) => {
  clearModelUnavailability(req.params.model);
  res.json({ ok: true });
});

router.get('/rate-limits', (_req, res) => {
  res.json(getRateLimitStatus());
});

router.post('/rate-limits', (req, res) => {
  const { model, cooldownMs } = req.body;
  if (!model || typeof model !== 'string') {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  markModelRateLimited(model, cooldownMs ?? 300_000);
  res.json(getRateLimitStatus());
});

router.delete('/rate-limits/:model', (req, res) => {
  clearModelRateLimit(decodeURIComponent(req.params.model));
  res.json(getRateLimitStatus());
});

export default router;
