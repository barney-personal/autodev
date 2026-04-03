import { Router } from 'express';
import { listResilienceEvents } from '../db/queries.js';

const router = Router();

router.get('/', (req, res) => {
  const type = req.query.type as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 100;

  if (isNaN(limit) || limit < 1 || limit > 1000) {
    res.status(400).json({ error: '"limit" must be between 1 and 1000' });
    return;
  }

  const events = listResilienceEvents({ type, limit });
  res.json({ events, count: events.length });
});

export default router;
