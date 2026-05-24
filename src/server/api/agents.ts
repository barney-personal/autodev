import { Router } from 'express';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { cancelledAgents } from '../orchestrator/AgentRunner.js';
import { onJobCompleted as workflowOnJobCompleted } from '../orchestrator/WorkflowManager.js';
import { markJobRunning } from '../orchestrator/JobLifecycle.js';
import { disconnectAgent, disconnectAll, getPtyBuffer, getSnapshot, attachPty, isTmuxSessionAlive, saveSnapshot } from '../orchestrator/PtyManager.js';
import { getFileLockRegistry } from '../orchestrator/FileLockRegistry.js';
import { nudgeQueue } from '../orchestrator/WorkQueueManager.js';
import { requestTickNow, requestStartNow, stopWatcherForAgent } from '../orchestrator/JobWatcherManager.js';
import { agentReadAllSchema, agentRetrySchema, agentContinueSchema, validateBody } from './validation.js';

const router = Router();

// Short-TTL cache — when CPU is contended, prevents duplicate heavy work
let agentsCache: { data: unknown; expires: number } | null = null;
const AGENTS_CACHE_TTL = 1500; // 1.5s

router.get('/', (_req, res) => {
  const now = Date.now();
  if (agentsCache && now < agentsCache.expires) {
    res.json(agentsCache.data);
    return;
  }
  const data = queries.getAgentsWithJobForSnapshot();
  agentsCache = { data, expires: now + AGENTS_CACHE_TTL };
  res.json(data);
});

// Must be registered before /:id to avoid param capture
router.post('/read-all', (req, res) => {
  const parsed = validateBody(agentReadAllSchema, req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  const { ids } = parsed.data;
  const targets = Array.isArray(ids) && ids.length > 0
    ? ids
    : queries.getAgentsWithJobForSnapshot()
        .filter(a => (a.status === 'done' || a.status === 'failed') && a.output_read === 0)
        .map(a => a.id);
  for (const id of targets) {
    const agent = queries.getAgentById(id);
    if (!agent || agent.output_read !== 0) continue;
    queries.updateAgent(id, { output_read: 1 });
    const updated = queries.getAgentWithJob(id);
    if (updated) socket.emitAgentUpdate(updated);
  }
  res.json({ marked: targets.length });
});

router.delete('/disconnect-all', (_req, res) => {
  const agentIds = disconnectAll();
  let count = 0;
  for (const agentId of agentIds) {
    const agent = queries.getAgentById(agentId);
    if (!agent) continue;
    markJobRunning(agent.job_id);
    queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });
    queries.updateJobStatus(agent.job_id, 'done');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    count++;
  }
  res.json({ disconnected: count });
});

router.get('/:id', (req, res) => {
  const agent = queries.getAgentWithJob(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json(agent);
});

router.get('/:id/output', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json(queries.getAgentOutput(req.params.id));
});

router.get('/:id/full-output', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
  // Use slim variant that trims large tool inputs/results for terminal display
  res.json(queries.getAgentFullOutputSlim(req.params.id, tail));
});

// Pre-rendered terminal output — server does JSON parse + render so the client
// just calls term.write() with the result. Much smaller payload, zero client-side parsing.
router.get('/:id/rendered-output', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
  res.json(queries.getAgentPrerenderedOutput(req.params.id, tail));
});

router.get('/:id/pty-history', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  // Prefer a clean tmux snapshot over raw PTY replay chunks
  const snapshot = getSnapshot(req.params.id);
  if (snapshot) {
    res.json({ snapshot, mode: 'snapshot' });
  } else {
    res.json({ chunks: getPtyBuffer(req.params.id), mode: 'chunks' });
  }
});

router.get('/:id/result-text', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const text = queries.getAgentResultText(req.params.id);
  res.json({ text });
});

router.get('/:id/diff', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  res.json({
    diff: agent.diff ?? null,
    base_sha: agent.base_sha ?? null,
  });
});

router.post('/:id/read', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  queries.updateAgent(req.params.id, { output_read: 1 });
  const updated = queries.getAgentWithJob(req.params.id)!;
  socket.emitAgentUpdate(updated);
  res.json(updated);
});

router.post('/:id/retry', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  if (agent.status !== 'failed') { res.status(400).json({ error: 'Only failed agents can be retried' }); return; }

  const original = queries.getAgentWithJob(req.params.id)!;
  const originalJob = original.job;
  const retryParsed = validateBody(agentRetrySchema, req.body ?? {});
  if (!retryParsed.success) { res.status(400).json({ error: retryParsed.error }); return; }
  const { interactive } = retryParsed.data;

  const retryJob = queries.insertJob({
    id: randomUUID(),
    title: `↺ ${original.job.title}`,
    description: originalJob.description,
    context: originalJob.context ?? null,
    priority: original.job.priority,
    status: 'queued',
    work_dir: originalJob.work_dir ?? null,
    max_turns: originalJob.max_turns ?? 50,
    model: original.job.model,
    template_id: originalJob.template_id ?? null,
    is_interactive: interactive ? 1 : 0,
    project_id: originalJob.project_id ?? null,
  });
  socket.emitJobNew(retryJob);
  nudgeQueue();
  res.status(201).json({ job: retryJob, queued: true });
});

router.post('/:id/continue', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const contParsed = validateBody(agentContinueSchema, req.body);
  if (!contParsed.success) { res.status(400).json({ error: contParsed.error }); return; }
  const { message, interactive } = contParsed.data;

  const original = queries.getAgentWithJob(req.params.id)!;
  const originalJob = original.job;

  // Create a continuation job, marked running immediately to bypass the work queue
  const contJob = queries.insertJob({
    id: randomUUID(),
    title: `↩ ${original.job.title}`,
    description: message.trim(),
    context: originalJob.context ?? null,
    priority: original.job.priority,
    status: 'queued',
    work_dir: originalJob.work_dir ?? null,
    max_turns: originalJob.max_turns ?? 50,
    model: original.job.model,
    template_id: originalJob.template_id ?? null,
    is_interactive: interactive ? 1 : 0,
    project_id: originalJob.project_id ?? null,
  });
  if (agent.session_id) {
    queries.upsertNote(`job-resume:${contJob.id}`, agent.session_id, null);
  }
  socket.emitJobNew(contJob);
  nudgeQueue();
  res.status(201).json({ job: contJob, queued: true, resumes_session: !!agent.session_id });
});

router.post('/:id/cancel', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  const cancellable: string[] = ['starting', 'running', 'waiting_user'];
  if (!cancellable.includes(agent.status)) {
    res.status(400).json({ error: 'Agent is not running' }); return;
  }

  // Mark cancelled before killing so handleAgentExit won't overwrite the status
  cancelledAgents.add(agent.id);

  // Save tmux snapshot before killing so we have the last terminal state
  if (isTmuxSessionAlive(agent.id)) {
    try { saveSnapshot(agent.id); } catch { /* non-fatal */ }
  }

  if (agent.pid) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        cancelledAgents.delete(agent.id);
        res.status(500).json({ error: 'Failed to kill process' }); return;
      }
      // ESRCH = process already gone — still mark as cancelled
    }
  }

  // Also kill the tmux session to ensure full cleanup
  try {
    execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' });
  } catch { /* session doesn't exist or already gone */ }

  // Update DB immediately so the UI reflects the change right away
  queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
  queries.updateJobStatus(agent.job_id, 'cancelled');
  getFileLockRegistry().releaseAll(agent.id);
  disconnectAgent(agent.id);

  // Timeout any pending question so the MCP ask_user call doesn't hang
  const pendingQ = queries.getPendingQuestion(agent.id);
  if (pendingQ) {
    queries.updateQuestion(pendingQ.id, {
      status: 'timeout',
      answer: '[TIMEOUT] Agent cancelled via API.',
      answered_at: Date.now(),
    });
  }

  const updated = queries.getAgentWithJob(agent.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);
  if (updatedJob?.workflow_id) workflowOnJobCompleted(updatedJob, { force: true });

  res.json(updated);
});

router.post('/:id/requeue', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  const requeueable: string[] = ['starting', 'running', 'waiting_user'];
  if (!requeueable.includes(agent.status)) {
    res.status(400).json({ error: 'Agent is not running' }); return;
  }

  // Mark cancelled before killing so handleAgentExit won't overwrite the status
  cancelledAgents.add(agent.id);

  // Save tmux snapshot before killing
  if (isTmuxSessionAlive(agent.id)) {
    try { saveSnapshot(agent.id); } catch { /* non-fatal */ }
  }

  if (agent.pid) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        cancelledAgents.delete(agent.id);
        res.status(500).json({ error: 'Failed to kill process' }); return;
      }
      // ESRCH = process already gone — still requeue
    }
  }

  // Also kill the tmux session to ensure full cleanup
  try {
    execFileSync('tmux', ['kill-session', '-t', `orchestrator-${agent.id}`], { stdio: 'pipe' });
  } catch { /* session doesn't exist or already gone */ }

  // Mark agent cancelled, but set job back to queued so WorkQueueManager re-dispatches it
  queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
  queries.updateJobStatus(agent.job_id, 'queued');
  getFileLockRegistry().releaseAll(agent.id);
  disconnectAgent(agent.id);

  // Timeout any pending question so the MCP ask_user call doesn't hang
  const pendingQ = queries.getPendingQuestion(agent.id);
  if (pendingQ) {
    queries.updateQuestion(pendingQ.id, {
      status: 'timeout',
      answer: '[TIMEOUT] Agent requeued via API.',
      answered_at: Date.now(),
    });
  }

  const updated = queries.getAgentWithJob(agent.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);
  nudgeQueue();

  res.json(updated);
});

// ─── Live Watcher ─────────────────────────────────────────────────────────
// Matches WatcherPanel's store cap so a fresh hydrate after server restart
// returns the same number of entries the live stream would have accumulated.
const WATCHER_HYDRATE_LIMIT = 500;

router.get('/:id/watcher', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const watcher = queries.getWatcherByAgentId(req.params.id);
  const commentary = queries.listCommentaryForAgent(req.params.id, WATCHER_HYDRATE_LIMIT);
  const actions = queries.listActionsForAgent(req.params.id, WATCHER_HYDRATE_LIMIT);
  res.json({ watcher: watcher ?? null, commentary, actions });
});

router.get('/:id/commentary', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  // Clamp the limit to [1, 1000]. Previously `parseInt('-1') || DEFAULT`
  // returned -1 (truthy, not NaN) and `Math.min(-1, 1000) === -1` got
  // passed to SQLite, which treats `LIMIT -1` as "no limit" — bypassing
  // the row cap and letting a caller paginate the entire table in one
  // request. NaN values still fall through to the default.
  const raw = req.query.limit;
  let limit = WATCHER_HYDRATE_LIMIT;
  if (raw !== undefined) {
    const parsed = parseInt(raw as string, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, 1000);
    }
  }
  res.json(queries.listCommentaryForAgent(req.params.id, limit));
});

router.post('/:id/watcher/start', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const result = requestStartNow(req.params.id);
  if (result.ok) {
    const watcher = queries.getWatcherByAgentId(req.params.id);
    // cooldown_ms tells the UI that an initial tick is scheduled and a
    // subsequent /watcher/tick within this window will 429. Lets the
    // panel show "initial tick scheduled — re-tick in Xs" instead of
    // the user having to click Re-tick and discover the 429.
    res.json({ ok: true, watcher, cooldown_ms: result.cooldownMs });
    return;
  }
  if (result.reason === 'cooldown') {
    // Same shared per-agent cooldown as /watcher/tick — a successful
    // start fires an initial tick (Opus 4.7 call), so the rate limit
    // must cover both endpoints together. See JobWatcherManager.
    res.setHeader('Retry-After', Math.ceil((result.retryAfterMs ?? 1000) / 1000));
    res.status(429).json({
      ok: false,
      error: 'start cooldown active',
      retry_after_ms: result.retryAfterMs,
      note: 'cooldown is in-memory only; resets on server restart',
    });
    return;
  }
  res.status(400).json({ error: 'unable to start watcher (manager disabled, agent not running, or API key missing)' });
});

router.post('/:id/watcher/stop', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const ok = stopWatcherForAgent(req.params.id);
  res.json({ ok });
});

router.post('/:id/watcher/tick', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  const result = requestTickNow(req.params.id);
  if (result.ok) {
    res.json({ ok: true });
    return;
  }
  if (result.reason === 'cooldown') {
    // Each tick is an Opus 4.7 call; the cooldown prevents accidental spam.
    res.setHeader('Retry-After', Math.ceil((result.retryAfterMs ?? 1000) / 1000));
    // The cooldown is tracked in-memory only (_lastManualTickAt) and
    // therefore resets when the orchestrator process restarts. Acceptable
    // for the local-only model documented in CLAUDE.md; flag it in the
    // response so operators don't assume the cooldown is persistent.
    res.status(429).json({
      ok: false,
      error: 'tick cooldown active',
      retry_after_ms: result.retryAfterMs,
      note: 'cooldown is in-memory only; resets on server restart',
    });
    return;
  }
  res.status(400).json({ ok: false, error: result.reason });
});

router.post('/:id/dismiss-warnings', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }
  queries.dismissWarningsForAgent(req.params.id);
  const updated = queries.getAgentWithJob(req.params.id);
  if (updated) socket.emitAgentUpdate(updated);
  res.json({ dismissed: true });
});

router.delete('/:id/disconnect', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  disconnectAgent(req.params.id);
  getFileLockRegistry().releaseAll(req.params.id);
  markJobRunning(agent.job_id);
  queries.updateAgent(req.params.id, { status: 'done', finished_at: Date.now() });
  queries.updateJobStatus(agent.job_id, 'done');

  const updated = queries.getAgentWithJob(req.params.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);
  res.json(updated);
});

// Re-attach the PTY for an interactive agent whose tmux session is still alive
// but whose node-pty connection was lost (e.g. posix_spawnp failed transiently).
router.post('/:id/reconnect', (req, res) => {
  const agent = queries.getAgentById(req.params.id);
  if (!agent) { res.status(404).json({ error: 'not found' }); return; }

  const job = queries.getJobById(agent.job_id);
  if (!job) { res.status(404).json({ error: 'job not found' }); return; }

  if (!job.is_interactive) {
    res.status(400).json({ error: 'Only interactive agents can be reconnected' }); return;
  }

  if (!isTmuxSessionAlive(req.params.id)) {
    res.status(400).json({ error: 'tmux session is no longer alive' }); return;
  }

  queries.updateAgent(req.params.id, { status: 'running', error_message: null, finished_at: null });
  queries.updateJobStatus(agent.job_id, 'running');

  const updated = queries.getAgentWithJob(req.params.id)!;
  socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(agent.job_id);
  if (updatedJob) socket.emitJobUpdate(updatedJob);

  // Re-attach node-pty to the existing tmux session
  attachPty(req.params.id, job);

  res.json(queries.getAgentWithJob(req.params.id));
});

export default router;
