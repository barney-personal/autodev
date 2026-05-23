import { Router } from 'express';
import { isDbInitialized } from '../db/database.js';
import { countJobsByStatus, getLastDoneJobCompletedAt } from '../db/jobQueries.js';
import { getLastWorkflowCreatedAt, getWorkflowCountsByStatus } from '../db/workflowQueries.js';
import { countRouteDecisionsByModeSince } from '../db/routeDecisionQueries.js';
import { getRoutingBrainMode } from '../orchestrator/RoutingBrain.js';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * GET /api/system/snapshot
 *
 * Returns a read-only JSON aggregate of process, database, routing-brain, and
 * queue health. Pure read — never mutates state.
 *
 * queue.running counts both 'assigned' and 'running' jobs because assigned jobs
 * have been dispatched but may not yet have flipped to 'running'.
 *
 * db.last_job_completed_at uses MAX(updated_at) WHERE status='done' as a proxy
 * for completion time; archived done jobs are included because archiving
 * preserves updated_at as the original completion/status-change time.
 */
router.get('/snapshot', (_req, res) => {
  if (!isDbInitialized()) {
    res.status(503).json({ error: 'database not initialized' });
    return;
  }

  const sinceMs = Date.now() - THIRTY_DAYS_MS;
  const routingDecisions = countRouteDecisionsByModeSince(sinceMs);
  const workflowCounts = getWorkflowCountsByStatus();

  res.json({
    process: {
      uptime_seconds: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      node_version: process.version,
    },
    db: {
      last_workflow_created_at: getLastWorkflowCreatedAt(),
      last_job_completed_at: getLastDoneJobCompletedAt(),
      workflow_counts_by_status: workflowCounts,
    },
    routing_brain: {
      mode: getRoutingBrainMode(),
      total_decisions_30d: routingDecisions.total,
      by_mode_30d: routingDecisions.byMode,
    },
    queue: {
      queued: countJobsByStatus('queued'),
      running: countJobsByStatus('assigned') + countJobsByStatus('running'),
      blocked: workflowCounts.blocked,
    },
  });
});

export default router;
