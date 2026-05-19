/**
 * Operator API for the routing brain.
 *
 * Cost deltas are estimates from `CostEstimator` against actual agent token
 * usage. They are NOT measured spend and are labelled clearly in responses.
 */
import { Router } from 'express';
import * as queries from '../db/queries.js';
import {
  getRoutingBrainShadowReport,
  getRoutingBrainStats,
} from '../orchestrator/RoutingBrainStats.js';

const router = Router();

const MODE_VALUES = ['off', 'shadow', 'live'] as const;
type Mode = typeof MODE_VALUES[number];

function parseDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 365) return null;
  return Math.floor(n);
}

router.post('/mode', (req, res) => {
  const { mode } = req.body ?? {};
  if (typeof mode !== 'string' || !MODE_VALUES.includes(mode as Mode)) {
    res.status(400).json({ error: 'mode must be one of: off, shadow, live' });
    return;
  }
  queries.upsertNote('setting:routing_brain_mode', mode, null);
  res.json({ mode });
});

router.post('/decision-model', (req, res) => {
  const { model } = req.body ?? {};
  if (typeof model !== 'string' || model.trim().length === 0) {
    res.status(400).json({ error: 'model must be a non-empty string' });
    return;
  }
  const trimmed = model.trim();
  queries.upsertNote('setting:routing_brain_decision_model', trimmed, null);
  res.json({ model: trimmed });
});

router.get('/shadow-report', (req, res) => {
  const days = parseDays(req.query.days);
  if (days === null) {
    res.status(400).json({ error: 'days must be a number between 1 and 365' });
    return;
  }
  res.json(getRoutingBrainShadowReport(days));
});

router.get('/stats', (req, res) => {
  const days = parseDays(req.query.days);
  if (days === null) {
    res.status(400).json({ error: 'days must be a number between 1 and 365' });
    return;
  }
  res.json(getRoutingBrainStats(days));
});

export default router;
