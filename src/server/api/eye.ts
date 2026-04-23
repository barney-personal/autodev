import { Router } from 'express';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { disconnectAgent } from '../orchestrator/PtyManager.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import { buildEyePrompt, getEyeTargets, EYE_PROMPT, type EyeTarget } from '../orchestrator/EyeConfig.js';
import { getGitHubPollerStatus } from '../integrations/GitHubPoller.js';
import { nudgeQueue } from '../orchestrator/WorkQueueManager.js';
import { updateJobRepeatInterval } from '../db/queries.js';
import { Sentry } from '../instrument.js';
import { eyeStartSchema, eyeConfigSchema, eyeDiscussionSchema, eyeMessageSchema, eyePrReviewDeleteSchema, validateBody } from './validation.js';
import { DEFAULT_EYE_MODEL } from '../../shared/models.js';

const router = Router();

// ─── Eye Lifecycle ────────────────────────────────────────────────────────────

function setTargets(targets: EyeTarget[]): void {
  queries.upsertNote('setting:eyeTargets', JSON.stringify(targets), null);
}

function getCustomPrompt(): string {
  return queries.getNote('setting:eye:prompt')?.value ?? '';
}

function isEyeJob(j: { context?: string | null }): boolean {
  try { return !!(j.context && JSON.parse(j.context).eye); } catch { return false; }
}

// Find the most relevant current Eye job: prefer active (queued/assigned/running),
// fall back to the most recently done job that still has repeat set.
function findCurrentEyeJob(): ReturnType<typeof queries.getJobById> {
  const allJobs = queries.listJobs().filter(isEyeJob);
  const active = allJobs
    .filter(j => ['queued', 'assigned', 'running'].includes(j.status))
    .sort((a, b) => b.created_at - a.created_at);
  if (active.length > 0) return active[0];
  const withRepeat = allJobs
    .filter(j => (j.status === 'done' || j.status === 'failed') && j.repeat_interval_ms)
    .sort((a, b) => b.created_at - a.created_at);
  return withRepeat[0] ?? null;
}

function getEyeState(): { running: boolean; active: boolean; scheduledAt: number | null; jobId: string | null; cycleCount: number; failed?: boolean } {
  const note = queries.getNote('setting:eyeJobId');
  if (!note?.value) return { running: false, active: false, scheduledAt: null, jobId: null, cycleCount: 0 };

  const job = findCurrentEyeJob();
  if (!job) {
    // All Eye jobs gone — clean up
    queries.upsertNote('setting:eyeJobId', '', null);
    return { running: false, active: false, scheduledAt: null, jobId: null, cycleCount: 0 };
  }

  const cycleCount = queries.countEyeCycles();

  const isActive = ['assigned', 'running'].includes(job.status);
  const isSleeping = job.status === 'queued' && !!job.scheduled_at && job.scheduled_at > Date.now();
  const isFailed = job.status === 'failed';
  const running = isActive || isSleeping || !!job.repeat_interval_ms;
  const scheduledAt = isSleeping ? job.scheduled_at : null;

  // Auto-recover: if Eye failed and AgentRunner didn't schedule the next repeat
  // (e.g. server restart between failure and repeat scheduling), queue it now.
  if (isFailed && job.repeat_interval_ms) {
    const activeJobs = queries.listJobs().filter(isEyeJob);
    const hasActiveFollowup = activeJobs.some(j => ['queued', 'assigned', 'running'].includes(j.status));
    if (!hasActiveFollowup) {
      try {
        const nextJob = queries.scheduleRepeatJob(job, buildEyePrompt());
        socket.emitJobNew(nextJob);
        nudgeQueue();
        console.log(`[eye] auto-recovered failed Eye cycle, scheduled new job ${nextJob.id}`);
      } catch (err) {
        console.error('[eye] auto-recovery scheduleRepeatJob error:', err);
        Sentry.captureException(err);
      }
    }
  }

  return { running, active: isActive, scheduledAt, jobId: job.id, cycleCount, failed: isFailed };
}

// Wake Eye immediately if it's sleeping between cycles.
// Optionally record the reason so Eye knows what triggered the wake.
export function wakeEye(reason?: string): void {
  const state = getEyeState();
  if (!state.running || !state.jobId) return;

  // Record wake event so Eye can prioritize on next cycle start
  if (reason) {
    const key = `events/eye/${Date.now()}`;
    queries.upsertNote(key, JSON.stringify({ reason, at: new Date().toISOString() }), null);
  }

  if (state.scheduledAt) {
    // Eye is sleeping — move scheduled_at to now so the work queue picks it up immediately
    queries.updateJobScheduledAt(state.jobId, Date.now());
    socket.emitJobUpdate(queries.getJobById(state.jobId)!);
    nudgeQueue();
  }
  // If Eye is currently running it will pick up the reply in its next cycle naturally.
}

let eyeStatusCache: { data: any; expires: number } | null = null;
const EYE_STATUS_CACHE_TTL = 2000;

router.get('/status', (_req, res) => {
  const now = Date.now();
  if (eyeStatusCache && now < eyeStatusCache.expires) {
    return res.json(eyeStatusCache.data);
  }
  const state = getEyeState();
  eyeStatusCache = { data: state, expires: now + EYE_STATUS_CACHE_TTL };
  res.json(state);
});

router.get('/github-status', (_req, res) => {
  res.json(getGitHubPollerStatus());
});

function findOrCreateEyeProject(): string {
  const existing = queries.listProjects().find(p => p.name === 'Eye');
  if (existing) return existing.id;
  const now = Date.now();
  const id = randomUUID();
  const project = queries.insertProject({ id, name: 'Eye', description: 'Jobs created by the Eye monitoring agent', created_at: now, updated_at: now });
  socket.emitProjectNew(project);
  return project.id;
}

const DEFAULT_REPEAT_INTERVAL_MS = 120_000; // 2 minutes

function getConfiguredRepeatIntervalMs(): number {
  const val = getConfigVal('repeatIntervalMs');
  const parsed = val ? parseInt(val, 10) : NaN;
  return isNaN(parsed) ? DEFAULT_REPEAT_INTERVAL_MS : parsed;
}

router.post('/start', (req, res) => {
  const state = getEyeState();
  if (state.running) {
    res.status(409).json({ error: 'Eye is already running', ...state });
    return;
  }

  const startParsed = validateBody(eyeStartSchema, req.body ?? {});
  if (!startParsed.success) { res.status(400).json({ error: startParsed.error }); return; }

  const {
    repeatIntervalMs = getConfiguredRepeatIntervalMs(),
    maxTurns = 100,
    model = DEFAULT_EYE_MODEL,
    workDir,
  } = startParsed.data;

  const eyeProjectId = findOrCreateEyeProject();

  const job = queries.insertJob({
    id: randomUUID(),
    title: 'Eye Cycle',
    description: buildEyePrompt(),
    context: JSON.stringify({ eye: true }),
    priority: 1,
    work_dir: workDir ?? null,
    max_turns: maxTurns,
    model,
    repeat_interval_ms: repeatIntervalMs,
    project_id: eyeProjectId,
  });

  queries.upsertNote('setting:eyeJobId', job.id, null);
  socket.emitJobNew(job);
  nudgeQueue();

  res.status(201).json({ jobId: job.id, status: 'queued' });
});

router.post('/stop', async (_req, res) => {
  const state = getEyeState();
  if (!state.jobId) {
    res.status(404).json({ error: 'Eye is not running' });
    return;
  }

  const job = queries.getJobById(state.jobId);
  if (job) {
    // Remove repeat so it doesn't re-queue, then cancel if active
    if (job.repeat_interval_ms) {
      queries.clearJobRepeat(job.id);
    }
    if (['queued', 'assigned', 'running'].includes(job.status)) {
      queries.updateJobStatus(job.id, 'cancelled');
      socket.emitJobUpdate(queries.getJobById(job.id)!);
      // Cancel associated agent — properly kill the process and release resources
      const agents = queries.listAllRunningAgents().filter(a => a.job_id === job.id);
      for (const agent of agents) {
        cancelledAgents.add(agent.id);

        if (agent.pid) {
          try {
            process.kill(-agent.pid, 'SIGTERM');
          } catch (err: any) {
            if (err.code !== 'ESRCH') {
              cancelledAgents.delete(agent.id);
            }
            // ESRCH = process already gone — still mark as cancelled
          }
        }

        queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
        getFileLockRegistry().releaseAll(agent.id);
        disconnectAgent(agent.id);

        const updated = queries.getAgentWithJob(agent.id);
        if (updated) socket.emitAgentUpdate(updated);
      }
    }
  }

  queries.upsertNote('setting:eyeJobId', '', null);
  res.json({ ok: true, stopped: true });
});

// ─── Eye Configuration ────────────────────────────────────────────────────────

function getConfigVal(key: string): string {
  return queries.getNote(`setting:eye:${key}`)?.value ?? '';
}

function setConfigVal(key: string, value: string): void {
  queries.upsertNote(`setting:eye:${key}`, value, null);
}

let eyeConfigCache: { data: any; expires: number } | null = null;
const EYE_CONFIG_CACHE_TTL = 2000;

router.get('/config', (_req, res) => {
  const now = Date.now();
  if (eyeConfigCache && now < eyeConfigCache.expires) {
    return res.json(eyeConfigCache.data);
  }
  const data = {
    targets: getEyeTargets(),
    prompt: getCustomPrompt(),
    defaultPrompt: EYE_PROMPT,
    linearApiKey: getConfigVal('linearApiKey') ? '***configured***' : '',
    scriptsPath: getConfigVal('scriptsPath'),
    repoPath: getConfigVal('repoPath'),
    repeatIntervalMs: getConfiguredRepeatIntervalMs(),
    addendum: queries.getNote('setting:eye:addendum')?.value ?? '',
  };
  eyeConfigCache = { data, expires: now + EYE_CONFIG_CACHE_TTL };
  res.json(data);
});

router.put('/config', (req, res) => {
  const configParsed = validateBody(eyeConfigSchema, req.body);
  if (!configParsed.success) { res.status(400).json({ error: configParsed.error }); return; }
  const { targets, linearApiKey, scriptsPath, repoPath, prompt, repeatIntervalMs } = configParsed.data;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) {
      res.status(400).json({ error: 'targets must be an array' });
      return;
    }
    const cleaned: EyeTarget[] = targets
      .filter((t: any) => typeof t.path === 'string' && t.path.trim())
      .map((t: any) => ({ path: t.path.trim(), context: (t.context ?? '').trim() }));
    setTargets(cleaned);
  }
  if (linearApiKey !== undefined) setConfigVal('linearApiKey', linearApiKey);
  if (scriptsPath !== undefined) setConfigVal('scriptsPath', scriptsPath);
  if (repoPath !== undefined) setConfigVal('repoPath', repoPath);
  if (prompt !== undefined) queries.upsertNote('setting:eye:prompt', prompt ?? '', null);
  if (configParsed.data.addendum !== undefined) queries.upsertNote('setting:eye:addendum', configParsed.data.addendum ?? '', null);
  if (repeatIntervalMs !== undefined) {
    const ms = parseInt(String(repeatIntervalMs), 10);
    if (!isNaN(ms) && ms > 0) {
      setConfigVal('repeatIntervalMs', String(ms));
      // Also update the current Eye job if running, so the next cycle uses the new interval
      const state = getEyeState();
      if (state.jobId) {
        const job = queries.getJobById(state.jobId);
        if (job && job.repeat_interval_ms) {
          updateJobRepeatInterval(state.jobId, ms);
        }
      }
    }
  }
  res.json({
    targets: getEyeTargets(),
    prompt: getCustomPrompt(),
    defaultPrompt: EYE_PROMPT,
    linearApiKey: getConfigVal('linearApiKey') ? '***configured***' : '',
    scriptsPath: getConfigVal('scriptsPath'),
    repoPath: getConfigVal('repoPath'),
    repeatIntervalMs: getConfiguredRepeatIntervalMs(),
    addendum: queries.getNote('setting:eye:addendum')?.value ?? '',
  });
});

// ─── Eye Jobs (for the activity view) ────────────────────────────────────────

router.get('/jobs', (_req, res) => {
  res.json(queries.listEyeJobs());
});

// ─── Daily Summaries ──────────────────────────────────────────────────────────

router.get('/summaries', (_req, res) => {
  const notes = queries.listNotes('summary:');
  const summaries = notes
    .map(n => { try { return JSON.parse(n.value); } catch { return null; } })
    .filter(Boolean)
    .sort((a: any, b: any) => b.date.localeCompare(a.date));
  res.json(summaries);
});

// ─── PRs ─────────────────────────────────────────────────────────────────────

function parsePrNotes(): any[] {
  return queries.listNotes('pr:')
    .map(n => { try { return JSON.parse(n.value); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.created_at - a.created_at);
}

function ghStatusToLocal(state: string, isDraft: boolean): string {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return isDraft ? 'draft' : 'open';
}

router.get('/prs', (_req, res) => {
  res.json(parsePrNotes());
});

router.post('/prs/refresh', (_req, res) => {
  const prs = parsePrNotes();
  if (prs.length === 0) {
    res.json(prs);
    return;
  }

  // Fetch all open PRs in one call instead of N sequential gh pr view calls
  try {
    // Extract unique repos from PR URLs (format: https://github.com/owner/repo/pull/N)
    const repos = new Set<string>();
    for (const pr of prs) {
      const match = pr.url?.match(/github\.com\/([^/]+\/[^/]+)\//);
      if (match) repos.add(match[1]);
    }

    // Fetch all PRs from each repo in one call
    const ghPrMap = new Map<string, { state: string; isDraft: boolean }>();
    for (const repo of repos) {
      try {
        const result = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--json', 'number,state,isDraft', '--limit', '200'], { encoding: 'utf-8', timeout: 15_000 });
        const ghPrs = JSON.parse(result);
        for (const ghPr of ghPrs) {
          ghPrMap.set(`${repo}#${ghPr.number}`, { state: ghPr.state, isDraft: ghPr.isDraft });
        }
      } catch {
        // If bulk fetch fails for a repo, we'll fall through to per-PR lookup below
      }
    }

    const refreshed = prs.map(pr => {
      try {
        const urlMatch = pr.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (urlMatch) {
          const key = `${urlMatch[1]}#${urlMatch[2]}`;
          const ghPr = ghPrMap.get(key);
          if (ghPr) {
            const updated = { ...pr, status: ghStatusToLocal(ghPr.state, ghPr.isDraft) };
            queries.upsertNote(`pr:${pr.id}`, JSON.stringify(updated), null);
            return updated;
          }
        }
        // Fallback: individual fetch if not found in bulk results
        const result = execFileSync('gh', ['pr', 'view', pr.url, '--json', 'state,isDraft'], { encoding: 'utf-8', timeout: 10_000 });
        const { state, isDraft } = JSON.parse(result);
        const updated = { ...pr, status: ghStatusToLocal(state, isDraft) };
        queries.upsertNote(`pr:${pr.id}`, JSON.stringify(updated), null);
        return updated;
      } catch {
        return pr;
      }
    });
    res.json(refreshed);
  } catch {
    // If everything fails, return existing data
    res.json(prs);
  }
});

// ─── PR Reviews ───────────────────────────────────────────────────────────
router.get('/pr-reviews', (_req, res) => {
  const reviews = queries.listPrReviews();
  res.json(reviews);
});

router.get('/pr-reviews/:id', (req, res) => {
  const review = queries.getPrReviewById(req.params.id);
  if (!review) { res.status(404).json({ error: 'not found' }); return; }
  res.json(review);
});

router.get('/pr-reviews/:id/messages', (req, res) => {
  res.json(queries.getPrReviewMessages(req.params.id));
});

router.post('/pr-reviews/:id/messages', (req, res) => {
  const prMsgParsed = validateBody(eyeMessageSchema, req.body);
  if (!prMsgParsed.success) { res.status(400).json({ error: prMsgParsed.error }); return; }
  const { content } = prMsgParsed.data;
  const review = queries.getPrReviewById(req.params.id);
  if (!review) { res.status(404).json({ error: 'not found' }); return; }
  const msg = queries.insertPrReviewMessage({ id: randomUUID(), review_id: review.id, role: 'user', content: content.trim() });
  socket.emitPrReviewMessage(msg);
  const updated = queries.getPrReviewById(review.id)!;
  socket.emitPrReviewUpdate(updated);
  wakeEye('user replied to PR review');
  res.json(msg);
});

router.post('/pr-reviews/:id/submit', (req, res) => {
  const review = queries.getPrReviewById(req.params.id);
  if (!review) { res.status(404).json({ error: 'not found' }); return; }
  if (!review.github_review_id) { res.status(400).json({ error: 'No pending GitHub review to submit (github_review_id not set)' }); return; }

  const [owner, repoName] = (review.repo as string).split('/');
  if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repo format' }); return; }

  try {
    execFileSync('gh', ['api', '--method', 'POST', `/repos/${owner}/${repoName}/pulls/${review.pr_number}/reviews/${review.github_review_id}/events`, '-f', 'event=COMMENT'], { encoding: 'utf-8', timeout: 30_000 });
    queries.updatePrReview(review.id, { status: 'submitted' });
    const updated = queries.getPrReviewById(review.id)!;
    socket.emitPrReviewUpdate(updated);
    res.json({ ok: true, review_id: review.id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'GitHub API error' });
  }
});

router.delete('/pr-reviews/:id', (req, res) => {
  const review = queries.getPrReviewById(req.params.id);
  if (!review) { res.status(404).json({ error: 'not found' }); return; }
  const delParsed = validateBody(eyePrReviewDeleteSchema, req.body ?? {});
  if (!delParsed.success) { res.status(400).json({ error: delParsed.error }); return; }
  const { reason } = delParsed.data;

  // Delete the pending GitHub review if it exists
  if (review.github_review_id && review.status === 'draft') {
    const [owner, repoName] = (review.repo as string).split('/');
    if (owner && repoName) {
      try {
        execFileSync('gh', ['api', '--method', 'DELETE', `/repos/${owner}/${repoName}/pulls/${review.pr_number}/reviews/${review.github_review_id}`], { encoding: 'utf-8', timeout: 30_000 });
      } catch { /* review may already be dismissed or submitted */ }
    }
  }

  // Store the reason as a user message if provided
  if (reason?.trim()) {
    const msg = queries.insertPrReviewMessage({ id: randomUUID(), review_id: review.id, role: 'user', content: `[Deleted] ${reason.trim()}` });
    socket.emitPrReviewMessage(msg);
    wakeEye('user replied to PR review');
  }

  queries.updatePrReview(review.id, { status: 'dismissed' });
  const updated = queries.getPrReviewById(review.id)!;
  socket.emitPrReviewUpdate(updated);
  res.json({ ok: true, review_id: review.id });
});

router.get('/agents', (_req, res) => {
  res.json(queries.getEyeAgentsSlim());
});

// ─── Discussions ──────────────────────────────────────────────────────────────

router.get('/discussions', (_req, res) => {
  const discussions = queries.listDiscussions();
  res.json(discussions);
});

router.post('/discussions', (req, res) => {
  const discParsed = validateBody(eyeDiscussionSchema, req.body);
  if (!discParsed.success) { res.status(400).json({ error: discParsed.error }); return; }
  const { content } = discParsed.data;

  const disc = queries.insertDiscussion({
    id: randomUUID(),
    agent_id: 'user',
    topic: content.trim().slice(0, 80),
    category: 'question',
    priority: 'medium',
    context: null,
  });

  const msg = queries.insertDiscussionMessage({
    id: randomUUID(),
    discussion_id: disc.id,
    role: 'user',
    content: content.trim(),
  });

  socket.emitDiscussionNew(disc, msg);
  wakeEye('new discussion from user');

  res.status(201).json({ discussion: disc, message: msg });
});

router.get('/discussions/:id', (req, res) => {
  const disc = queries.getDiscussionById(req.params.id);
  if (!disc) { res.status(404).json({ error: 'not found' }); return; }
  const messages = queries.getDiscussionMessages(disc.id);
  res.json({ ...disc, messages });
});

router.get('/discussions/:id/messages', (req, res) => {
  const messages = queries.getDiscussionMessages(req.params.id);
  res.json(messages);
});

router.post('/discussions/:id/messages', (req, res) => {
  const msgParsed = validateBody(eyeMessageSchema, req.body);
  if (!msgParsed.success) { res.status(400).json({ error: msgParsed.error }); return; }
  const { content } = msgParsed.data;

  const disc = queries.getDiscussionById(req.params.id);
  if (!disc) { res.status(404).json({ error: 'not found' }); return; }

  const msg = queries.insertDiscussionMessage({
    id: randomUUID(),
    discussion_id: disc.id,
    role: 'user',
    content: content.trim(),
  });

  socket.emitDiscussionMessage(msg);

  // Re-fetch to get updated_at
  const updated = queries.getDiscussionById(disc.id)!;
  socket.emitDiscussionUpdate(updated);

  wakeEye('user replied to discussion');

  res.json(msg);
});

router.post('/discussions/:id/resolve', (req, res) => {
  const disc = queries.getDiscussionById(req.params.id);
  if (!disc) { res.status(404).json({ error: 'not found' }); return; }

  queries.updateDiscussion(disc.id, { status: 'resolved' });
  const updated = queries.getDiscussionById(disc.id)!;
  socket.emitDiscussionUpdate(updated);
  res.json(updated);
});

router.post('/discussions/:id/reopen', (req, res) => {
  const disc = queries.getDiscussionById(req.params.id);
  if (!disc) { res.status(404).json({ error: 'not found' }); return; }

  queries.updateDiscussion(disc.id, { status: 'open' });
  const updated = queries.getDiscussionById(disc.id)!;
  socket.emitDiscussionUpdate(updated);
  res.json(updated);
});

// ─── Proposals ────────────────────────────────────────────────────────────────

router.get('/proposals', (_req, res) => {
  const proposals = queries.listProposals();
  res.json(proposals);
});

router.get('/proposals/:id', (req, res) => {
  const prop = queries.getProposalById(req.params.id);
  if (!prop) { res.status(404).json({ error: 'not found' }); return; }
  const messages = queries.getProposalMessages(prop.id);
  res.json({ ...prop, messages });
});

router.get('/proposals/:id/messages', (req, res) => {
  const messages = queries.getProposalMessages(req.params.id);
  res.json(messages);
});

router.post('/proposals/:id/messages', (req, res) => {
  const propMsgParsed = validateBody(eyeMessageSchema, req.body);
  if (!propMsgParsed.success) { res.status(400).json({ error: propMsgParsed.error }); return; }
  const { content } = propMsgParsed.data;

  const prop = queries.getProposalById(req.params.id);
  if (!prop) { res.status(404).json({ error: 'not found' }); return; }

  const msg = queries.insertProposalMessage({
    id: randomUUID(),
    proposal_id: prop.id,
    role: 'user',
    content: content.trim(),
  });

  socket.emitProposalMessage(msg);

  const updated = queries.getProposalById(prop.id)!;
  socket.emitProposalUpdate(updated);

  wakeEye('user replied to proposal');

  res.json(msg);
});

router.post('/proposals/:id/approve', (req, res) => {
  const prop = queries.getProposalById(req.params.id);
  if (!prop) { res.status(404).json({ error: 'not found' }); return; }

  queries.updateProposal(prop.id, { status: 'approved' });
  const updated = queries.getProposalById(prop.id)!;
  socket.emitProposalUpdate(updated);
  wakeEye('proposal approved');
  res.json(updated);
});

router.post('/proposals/:id/reject', (req, res) => {
  const prop = queries.getProposalById(req.params.id);
  if (!prop) { res.status(404).json({ error: 'not found' }); return; }

  queries.updateProposal(prop.id, { status: 'rejected' });
  const updated = queries.getProposalById(prop.id)!;
  socket.emitProposalUpdate(updated);
  wakeEye('proposal rejected');
  res.json(updated);
});

router.post('/proposals/:id/retry', (req, res) => {
  const prop = queries.getProposalById(req.params.id);
  if (!prop) { res.status(404).json({ error: 'not found' }); return; }

  // Reset to approved so Eye picks it up for re-execution on its next cycle
  queries.updateProposal(prop.id, { status: 'approved' });
  const updated = queries.getProposalById(prop.id)!;
  socket.emitProposalUpdate(updated);
  wakeEye('proposal retry requested');
  res.json(updated);
});

export default router;
