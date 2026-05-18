import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import jobsRouter from './jobs.js';
import agentsRouter from './agents.js';
import repliesRouter from './replies.js';
import locksRouter from './locks.js';
import templatesRouter from './templates.js';
import projectsRouter from './projects.js';
import usageRouter from './usage.js';
import searchRouter from './search.js';
import batchTemplatesRouter from './batchTemplates.js';
import settingsRouter from './settings.js';
import debatesRouter from './debates.js';
import workflowsRouter from './workflows.js';
import worktreesRouter from './worktrees.js';
import statsRouter from './stats.js';
import knowledgeBaseRouter from './knowledgeBase.js';
import eyeRouter from './eye.js';
import localConfigRouter from './localConfig.js';
import modelsRouter from './models.js';
import healthRouter from './health.js';
import eventsRouter from './events.js';
import resilienceEventsRouter from './resilienceEvents.js';
import tasksRouter from './tasks.js';
import webhooksRouter from './webhooks.js';

const router = Router();

const AUTH_TOKEN = process.env.AUTH_TOKEN;

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) { next(); return; }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header. Expected: Bearer <token>' });
    return;
  }
  const token = header.slice(7);
  if (token !== AUTH_TOKEN) {
    res.status(403).json({ error: 'Invalid bearer token' });
    return;
  }
  next();
}

router.use('/health', healthRouter);
// Mounted before the app-wide bearer middleware because Sentry uses its own
// HMAC verification; sync webhooks enforce AUTH_TOKEN inside the webhooks router.
router.use('/webhooks', webhooksRouter);

router.use(authMiddleware);
router.use('/events', eventsRouter);
router.use('/jobs', jobsRouter);
router.use('/agents', agentsRouter);
router.use('/replies', repliesRouter);
router.use('/locks', locksRouter);
router.use('/templates', templatesRouter);
router.use('/projects', projectsRouter);
router.use('/usage', usageRouter);
router.use('/search', searchRouter);
router.use('/batch-templates', batchTemplatesRouter);
router.use('/settings', settingsRouter);
router.use('/debates', debatesRouter);
router.use('/workflows', workflowsRouter);
router.use('/autonomous-agent-runs', workflowsRouter);
router.use('/worktrees', worktreesRouter);
router.use('/stats', statsRouter);
router.use('/knowledge-base', knowledgeBaseRouter);
router.use('/eye', eyeRouter);
router.use('/local-config', localConfigRouter);
router.use('/models', modelsRouter);
router.use('/resilience-events', resilienceEventsRouter);
router.use('/tasks', tasksRouter);

export default router;
