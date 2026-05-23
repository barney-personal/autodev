import { Router } from 'express';
import {
  countJobsByStatus,
  getLastDoneJobUpdatedAt,
  getLastWorkflowCreatedAt,
  countWorkflowsByStatus,
  countRouteDecisionsByModeSince,
  getNote,
} from '../db/queries.js';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

router.get('/snapshot', (_req, res) => {
  const sinceMs = Date.now() - THIRTY_DAYS_MS;

  const routeDecisions = countRouteDecisionsByModeSince(sinceMs);
  const routingModeNote = getNote('setting:routing_brain_mode');
  const workflowCounts = countWorkflowsByStatus();

  const snapshot = {
    process: {
      uptime_seconds: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
      node_version: process.version,
    },
    db: {
      last_workflow_created_at: getLastWorkflowCreatedAt(),
      last_job_completed_at: getLastDoneJobUpdatedAt(),
      workflow_counts_by_status: workflowCounts,
    },
    routing_brain: {
      mode: routingModeNote?.value ?? 'off',
      total_decisions_30d: routeDecisions.total,
      by_mode_30d: routeDecisions.byMode,
    },
    queue: {
      queued: countJobsByStatus('queued'),
      running: countJobsByStatus('assigned') + countJobsByStatus('running'),
      blocked: workflowCounts.blocked,
    },
  };

  res.json(snapshot);
});

export default router;
