/**
 * Read-only system snapshot endpoint.
 *
 * GET /api/system/snapshot aggregates process health, recent DB activity,
 * routing-brain mode + 30-day decision counts, and current queue state into a
 * single JSON payload. Every helper used here is SELECT-only — the handler must
 * not mutate any state.
 *
 * Timestamps in the `db` block are ISO strings (or null when the table is
 * empty). Counts default to 0 and mode breakdowns to an empty object.
 */
import { Router } from 'express';
import { isDbInitialized } from '../db/database.js';
import { getWorkflowSnapshotStats } from '../db/workflowQueries.js';
import { getLastDoneJobUpdatedAt, getQueueSnapshotStats } from '../db/jobQueries.js';
import { getRouteDecisionSnapshotStats } from '../db/routeDecisionQueries.js';
import { getRoutingBrainMode } from '../orchestrator/RoutingBrain.js';

const router = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isoOrNull(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

router.get('/snapshot', (_req, res) => {
  const dbReady = isDbInitialized();

  const process_ = {
    uptime_seconds: Math.round(process.uptime()),
    rss_mb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    node_version: process.version,
  };

  if (!dbReady) {
    res.json({
      process: process_,
      db: {
        last_workflow_created_at: null,
        last_job_completed_at: null,
        workflow_counts_by_status: {},
      },
      routing_brain: { mode: 'off', total_decisions_30d: 0, by_mode_30d: {} },
      queue: { queued: 0, running: 0, blocked: 0 },
    });
    return;
  }

  const wf = getWorkflowSnapshotStats();
  const lastJobDoneAt = getLastDoneJobUpdatedAt();
  const since = Date.now() - THIRTY_DAYS_MS;
  const routeStats = getRouteDecisionSnapshotStats(since);
  const queue = getQueueSnapshotStats();

  res.json({
    process: process_,
    db: {
      last_workflow_created_at: isoOrNull(wf.last_workflow_created_at),
      last_job_completed_at: isoOrNull(lastJobDoneAt),
      workflow_counts_by_status: wf.workflow_counts_by_status,
    },
    routing_brain: {
      mode: getRoutingBrainMode(),
      total_decisions_30d: routeStats.total_decisions,
      by_mode_30d: routeStats.by_mode,
    },
    queue,
  });
});

export default router;
