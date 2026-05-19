/**
 * REST endpoints for the Auto Resolver.
 *
 * GET  /api/resolver/runs                        — recent Resolver runs (all workflows)
 * GET  /api/resolver/runs/:id                    — single run with its actions
 * GET  /api/resolver/runs/:id/actions            — journaled actions for a run
 * GET  /api/workflows/:id/resolver/runs          — runs for a specific workflow
 * POST /api/workflows/:id/resolver/reset         — reset circuit breaker + attempt count
 * POST /api/workflows/:id/resolver/dispatch      — manually fire the Resolver (operator override)
 */
import { Router } from 'express';
import * as queries from '../db/queries.js';
import { resetResolverCircuit } from '../orchestrator/ResumeOrchestrator.js';
import { dispatchResolverForWorkflowAsync } from '../orchestrator/ResolverDispatcher.js';

const router = Router();

// Global routes mounted at /api/resolver
router.get('/runs', (req, res) => {
  const limit = parseLimit(req.query.limit, 50, 200);
  res.json(queries.listRecentResolverRuns(limit));
});

router.get('/runs/:id', (req, res) => {
  const run = queries.getResolverRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'not found' }); return; }
  const actions = queries.listResolverActions(run.id);
  res.json({ run, actions });
});

router.get('/runs/:id/actions', (req, res) => {
  const run = queries.getResolverRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.listResolverActions(run.id));
});

export default router;

// ─── workflow-scoped router (mounted at /api/workflows/:id/resolver) ────────

export const workflowResolverRouter = Router({ mergeParams: true });

workflowResolverRouter.get('/runs', (req, res) => {
  const workflowId = (req.params as { id: string }).id;
  const wf = queries.getWorkflowById(workflowId);
  if (!wf) { res.status(404).json({ error: 'workflow not found' }); return; }
  const limit = parseLimit(req.query.limit, 50, 200);
  res.json(queries.listResolverRunsForWorkflow(workflowId, limit));
});

workflowResolverRouter.post('/reset', (req, res) => {
  const workflowId = (req.params as { id: string }).id;
  const ok = resetResolverCircuit(workflowId);
  if (!ok) { res.status(404).json({ error: 'workflow not found' }); return; }
  const wf = queries.getWorkflowById(workflowId);
  res.json({ ok: true, workflow: wf });
});

workflowResolverRouter.post('/dispatch', (req, res) => {
  const workflowId = (req.params as { id: string }).id;
  const wf = queries.getWorkflowById(workflowId);
  if (!wf) { res.status(404).json({ error: 'workflow not found' }); return; }
  if (wf.status !== 'blocked') {
    res.status(400).json({ error: `workflow status is '${wf.status}', not 'blocked'` });
    return;
  }
  dispatchResolverForWorkflowAsync(workflowId);
  res.status(202).json({ ok: true, message: 'Resolver dispatched (running asynchronously)' });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
