/**
 * GET /api/system/snapshot — aggregated read-only system health snapshot.
 *
 * Returns process, db, routing_brain, and queue sections. All DB queries are
 * `SELECT` aggregates; the route never mutates state.
 */
import { Router } from 'express';
import { isDbInitialized } from '../db/database.js';
import {
  getWorkflowSnapshotStats,
  getLastJobCompletedAt,
  countJobsByStatus,
  countActiveJobs,
  getRouteDecisionModeCountsSince,
} from '../db/queries.js';
import { getRoutingBrainMode } from '../orchestrator/RoutingBrain.js';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

router.get('/snapshot', (_req, res) => {
  if (!isDbInitialized()) {
    res.status(503).json({ error: 'Database not initialized' });
    return;
  }

  try {
    const wfStats = getWorkflowSnapshotStats();
    const lastJobDone = getLastJobCompletedAt();
    const queued = countJobsByStatus('queued');
    const active = countActiveJobs();
    const since = Date.now() - THIRTY_DAYS_MS;
    const routeStats = getRouteDecisionModeCountsSince(since);
    const mode = getRoutingBrainMode();
    const mem = process.memoryUsage();

    res.json({
      process: {
        uptime_seconds: Math.round(process.uptime()),
        rss_mb: Math.round(mem.rss / (1024 * 1024)),
        node_version: process.version,
      },
      db: {
        last_workflow_created_at: wfStats.last_workflow_created_at,
        last_job_completed_at: lastJobDone,
        workflow_counts_by_status: wfStats.workflow_counts_by_status,
      },
      routing_brain: {
        mode,
        total_decisions_30d: routeStats.total,
        by_mode_30d: routeStats.byMode,
      },
      queue: {
        queued,
        running: active,
        blocked: wfStats.blocked_count,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'snapshot failed' });
  }
});

export default router;
