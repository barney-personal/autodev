import { Router } from 'express';
import { getDb } from '../db/database.js';
import * as queries from '../db/queries.js';

const router = Router();

router.get('/snapshot', (_req, res) => {
  const db = getDb();

  const processInfo = {
    uptime_seconds: Math.round(process.uptime()),
    rss_mb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    node_version: process.version,
  };

  const lastWorkflowRow = db.prepare(
    'SELECT MAX(created_at) AS value FROM workflows',
  ).get() as { value: number | null } | undefined;
  const lastJobRow = db.prepare(
    "SELECT MAX(updated_at) AS value FROM jobs WHERE status = 'done'",
  ).get() as { value: number | null } | undefined;

  const statusRows = db.prepare(
    'SELECT status, COUNT(*) AS count FROM workflows GROUP BY status',
  ).all() as Array<{ status: string; count: number }>;
  const workflowCountsByStatus: Record<string, number> = {};
  for (const row of statusRows) {
    workflowCountsByStatus[row.status] = row.count;
  }

  const dbInfo = {
    last_workflow_created_at: lastWorkflowRow?.value ?? null,
    last_job_completed_at: lastJobRow?.value ?? null,
    workflow_counts_by_status: workflowCountsByStatus,
  };

  const modeNote = queries.getNote('setting:routing_brain_mode');
  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

  const totalRow = db.prepare(
    'SELECT COUNT(*) AS count FROM route_decisions WHERE created_at >= ?',
  ).get(thirtyDaysAgo) as { count: number };

  const modeRows = db.prepare(
    'SELECT mode, COUNT(*) AS count FROM route_decisions WHERE created_at >= ? GROUP BY mode',
  ).all(thirtyDaysAgo) as Array<{ mode: string; count: number }>;
  const byMode30d: Record<string, number> = {};
  for (const row of modeRows) {
    byMode30d[row.mode] = row.count;
  }

  const routingBrain = {
    mode: modeNote?.value ?? 'off',
    total_decisions_30d: totalRow.count,
    by_mode_30d: byMode30d,
  };

  const blockedRow = db.prepare(
    "SELECT COUNT(*) AS count FROM workflows WHERE status = 'blocked'",
  ).get() as { count: number };

  const queue = {
    queued: queries.countJobsByStatus('queued'),
    running: queries.countJobsByStatus('running'),
    blocked: blockedRow.count,
  };

  res.json({ process: processInfo, db: dbInfo, routing_brain: routingBrain, queue });
});

export default router;
