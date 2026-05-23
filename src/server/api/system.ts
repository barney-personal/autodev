import { Router } from 'express';
import { getDb } from '../db/database.js';
import { countJobsByStatus, getNote } from '../db/queries.js';

const router = Router();

router.get('/snapshot', (_req, res) => {
  try {
    const db = getDb();

    // process section
    const processSection = {
      uptime_seconds: process.uptime(),
      rss_mb: process.memoryUsage().rss / 1024 / 1024,
      node_version: process.version,
    };

    // db section — MAX queries return null when the table is empty
    const wfRow = db.prepare('SELECT MAX(created_at) AS ts FROM workflows').get() as { ts: number | null };
    const last_workflow_created_at = wfRow?.ts ?? null;

    const jobRow = db.prepare("SELECT MAX(updated_at) AS ts FROM jobs WHERE status = 'done'").get() as { ts: number | null };
    const last_job_completed_at = jobRow?.ts ?? null;

    // Initialise all known statuses with 0 so empty-DB callers get a deterministic shape.
    const workflow_counts_by_status: Record<string, number> = {
      running: 0, complete: 0, blocked: 0, failed: 0, cancelled: 0,
    };
    const statusRows = db.prepare(
      'SELECT status, COUNT(*) AS cnt FROM workflows GROUP BY status',
    ).all() as { status: string; cnt: number }[];
    for (const row of statusRows) {
      if (Object.prototype.hasOwnProperty.call(workflow_counts_by_status, row.status)) {
        workflow_counts_by_status[row.status] = Number(row.cnt);
      }
    }

    const dbSection = {
      last_workflow_created_at,
      last_job_completed_at,
      workflow_counts_by_status,
    };

    // routing_brain section
    const modeNote = getNote('setting:routing_brain_mode');
    const mode = modeNote?.value?.trim() || 'off';

    const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const decisionRows = db.prepare(
      'SELECT mode, COUNT(*) AS cnt FROM route_decisions WHERE created_at >= ? GROUP BY mode',
    ).all(cutoff30d) as { mode: string; cnt: number }[];

    const by_mode_30d: Record<string, number> = {};
    let total_decisions_30d = 0;
    for (const row of decisionRows) {
      const cnt = Number(row.cnt);
      by_mode_30d[row.mode] = cnt;
      total_decisions_30d += cnt;
    }

    const routingBrainSection = { mode, total_decisions_30d, by_mode_30d };

    // queue section
    const blockedWfRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM workflows WHERE status = 'blocked'",
    ).get() as { cnt: number };
    const queueSection = {
      queued: countJobsByStatus('queued'),
      running: countJobsByStatus('running'),
      blocked: Number(blockedWfRow.cnt),
    };

    res.json({
      process: processSection,
      db: dbSection,
      routing_brain: routingBrainSection,
      queue: queueSection,
    });
  } catch (err) {
    console.error('GET /system/snapshot error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
