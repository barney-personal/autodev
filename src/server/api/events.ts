/**
 * Event replay endpoint — allows the UI to catch up on missed events after
 * a Socket.io disconnection.
 *
 * GET /api/events?since=<timestamp_ms>
 *
 * Returns the list of buffered events since the given timestamp, ordered
 * chronologically. The UI can replay these to update its local state
 * without needing a full snapshot reload.
 */

import { Router } from 'express';
import { getEventsSince } from '../orchestrator/EventQueue.js';

const router = Router();

router.get('/', (req, res) => {
  const since = Number(req.query.since);
  if (isNaN(since) || since < 0) {
    res.status(400).json({ error: 'Missing or invalid "since" query parameter (unix timestamp in ms)' });
    return;
  }

  const events = getEventsSince(since);
  res.json({
    events,
    count: events.length,
    oldest: events.length > 0 ? events[0].created_at : null,
    newest: events.length > 0 ? events[events.length - 1].created_at : null,
  });
});

export default router;
