/**
 * JobWatcherManager — singleton wiring layer for the live watcher feature.
 *
 * Owns:
 * - The Map<agentId, WatcherSession> of in-process sessions.
 * - A debouncer per session: bursts of trigger events from AgentRunner are
 *   coalesced into a single tick (default 800ms window).
 * - A heartbeat loop that requests a heartbeat tick every WATCHER_HEARTBEAT_MS
 *   for every active session.
 * - Lifecycle: onAgentStarted (create), onAgentFinished (stop), onAgentEvent /
 *   onWarning / requestTick (trigger sources).
 *
 * The manager is intentionally cheap to call — every code path that fires
 * events can call into it without worrying about cost. Decisions about
 * whether to actually tick happen inside WatcherSession.
 */
import { randomUUID } from 'crypto';
import { workflowLogger } from '../lib/logger.js';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { WatcherSession, defaultWatcherModel, validateWatcherModel } from './WatcherSession.js';
import { highestTrigger, type WatcherTrigger } from './watcherFeed.js';
import type { ClaudeStreamEvent, CodexStreamEvent, AgentWarning } from '../../shared/types.js';

const log = workflowLogger('watcher-manager');

// Read env on every access so tests can patch values without ESM hoisting tricks.
// In production this is read once per call which is negligible.
function envHeartbeatMs(): number { return Number(process.env.WATCHER_HEARTBEAT_MS ?? 45_000); }
function envDebounceMs(): number { return Number(process.env.WATCHER_DEBOUNCE_MS ?? 800); }
function envEnabled(): boolean { return (process.env.WATCHER_ENABLED ?? '1') !== '0'; }
function envHasKey(): boolean { return !!process.env.ANTHROPIC_API_KEY; }
// Cooldown between manual /watcher/tick requests, per agent. Cheap defence
// against accidental dashboard hammering or adversarial spam — every tick
// fires a real Opus 4.7 call.
function envManualTickCooldownMs(): number { return Number(process.env.WATCHER_MANUAL_TICK_COOLDOWN_MS ?? 10_000); }

interface SessionEntry {
  session: WatcherSession;
  debounceTimer: NodeJS.Timeout | null;
  pendingTrigger: WatcherTrigger | null;
}

interface ReconcileResult {
  started: number;
  stopped: number;
  skippedStopped: number;
}

const _sessions = new Map<string, SessionEntry>();
// In-memory only — a server restart resets all manual-tick cooldowns. For a
// local-only orchestrator that's fine (an attacker controlling restarts is
// already past the security model). If this ever moves behind a network
// boundary the cooldown should be persisted alongside watcher_actions.
const _lastManualTickAt = new Map<string, number>();
let _heartbeat: NodeJS.Timeout | null = null;
let _started = false;
let _initialised = false;

/** Test-only: reset module state between tests. */
export function _resetForTest(): void {
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  for (const entry of _sessions.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.session.stop();
  }
  _sessions.clear();
  _lastManualTickAt.clear();
  _started = false;
  _initialised = false;
}

export function startJobWatcherManager(): void {
  if (_started) return;
  _started = true;
  _initialised = true;
  if (!envEnabled()) {
    log.info('Job watcher disabled (WATCHER_ENABLED=0)');
    return;
  }
  if (!envHasKey()) {
    log.warn('ANTHROPIC_API_KEY not set — watchers will not be created');
  }
  const model = defaultWatcherModel();
  validateWatcherModel(model, log);
  log.info({ heartbeatMs: envHeartbeatMs(), debounceMs: envDebounceMs(), model }, 'Job watcher manager started');
  _heartbeat = setInterval(() => {
    try { runHeartbeats(); } catch (err) {
      log.error({ err }, 'heartbeat error');
      captureWithContext(err, { component: 'JobWatcherManager' });
    }
  }, envHeartbeatMs());
  // Re-attach watchers for agents that were already running across a restart
  // Don't await — startup must not block on rehydration — but DO surface
  // failures. Previously errors here were silently swallowed (e.g. a
  // corrupt job_watchers table would leave the manager running but with
  // zero rehydrated sessions, and no log line to point at the cause).
  rehydrateActiveWatchers().catch(err => {
    log.error({ err }, 'rehydrateActiveWatchers failed — running agents will not have watcher sessions until next event');
    captureWithContext(err, { component: 'JobWatcherManager' });
  });
}

export function stopJobWatcherManager(): void {
  if (!_started) return;
  _started = false;
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  for (const [agentId, entry] of _sessions.entries()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.session.stop();
    // Mark as stopped in DB so a future restart doesn't try to resume it.
    try {
      const w = queries.getWatcherByAgentId(agentId);
      if (w && (w.status === 'running' || w.status === 'starting')) {
        queries.updateWatcher(w.id, { status: 'stopped', finished_at: Date.now() });
      }
    } catch { /* shutdown — best effort */ }
  }
  _sessions.clear();
  log.info('Job watcher manager stopped');
}

/** Test-only: snapshot of active session count. */
export function _activeSessionCount(): number {
  return _sessions.size;
}

/** Test-only: run the periodic reconciliation pass synchronously. */
export function _reconcileActiveWatchersForTest(): ReconcileResult {
  return reconcileActiveWatchers();
}

/**
 * Spawn (or reuse) a watcher session for an agent that just started.
 * No-op if the agent's job has watch=0 or the manager is disabled.
 */
export function onAgentStarted(agentId: string): void {
  if (!shouldWatch(agentId)) return;
  ensureSession(agentId, 'initial');
}

/**
 * Notify the watcher that a stream-json event arrived from the agent.
 * The manager coalesces bursts into a single tick.
 */
export function onAgentEvent(agentId: string, event: ClaudeStreamEvent | CodexStreamEvent): void {
  if (!_started || !envEnabled()) return;
  const trigger = classifyEvent(event);
  if (!trigger) return;
  const entry = _sessions.get(agentId);
  if (!entry) return;
  scheduleTick(agentId, trigger);
}

export function onAgentFinished(agentId: string, status: 'done' | 'failed' | 'cancelled'): void {
  if (!_started) return;
  const entry = _sessions.get(agentId);
  if (!entry) return;
  // Run one final tick so the watcher posts a postmortem, then stop.
  const trigger: WatcherTrigger = status === 'done' ? 'agent_done' : status === 'failed' ? 'agent_failed' : 'agent_cancelled';
  scheduleTick(agentId, trigger);
  // Intentional overlap: the final tick fires after `debounce` ms but the
  // API call inside it can take several seconds. The stop timer fires
  // ~debounce+200ms, which usually races AHEAD of the in-flight tick. That
  // is OK — three guards keep us safe:
  //   1. stopSession removes the entry from `_sessions` immediately, so no
  //      new triggers can schedule on top of the dying session.
  //   2. WatcherSession's stop-race guard (isStoppedWatcherStatus check)
  //      prevents the in-flight tick from resurrecting the watcher row
  //      back to 'running' when it completes.
  //   3. Tool dispatches the in-flight tick already started (e.g.
  //      post_commentary for the postmortem) continue to run — they're
  //      bounded sync side effects on a stopped row, which is fine.
  setTimeout(() => stopSession(agentId), envDebounceMs() + 200);
}

export function onWarning(warning: AgentWarning): void {
  if (!_started) return;
  const entry = _sessions.get(warning.agent_id);
  if (!entry) return;
  scheduleTick(warning.agent_id, 'warning');
}

export type ManualTickResult =
  | { ok: true }
  | { ok: false; reason: 'manager_stopped' | 'no_session' | 'cooldown'; retryAfterMs?: number };

export type ManualStartResult =
  | { ok: true; cooldownMs: number }
  | { ok: false; reason: 'manager_stopped' | 'agent_unavailable' | 'cooldown'; retryAfterMs?: number };

/**
 * Shared per-agent rate limit for billable watcher API endpoints (start,
 * tick). A successful `start` schedules an initial tick via ensureSession,
 * so it consumes the same budget as a manual tick — without this gate the
 * `start → stop → start` cycle was an unbounded way to spin up Opus 4.7
 * calls. Returns the result of the gate check; on `ok=true` the caller is
 * expected to immediately perform the billable action and (for write
 * paths) call `_markBillableActionAt` so the next call cools down.
 */
function checkBillableCooldown(agentId: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const cooldownMs = envManualTickCooldownMs();
  const lastAt = _lastManualTickAt.get(agentId);
  if (lastAt != null && Date.now() - lastAt < cooldownMs) {
    return { ok: false, retryAfterMs: cooldownMs - (Date.now() - lastAt) };
  }
  return { ok: true };
}

/**
 * User-triggered tick (e.g. dashboard "Re-evaluate now" button).
 *
 * Rate-limited per agent: each tick fires a real Opus 4.7 API call, so a
 * naive endpoint would let any dashboard user run up an unbounded bill.
 * Returns the structured result so the API layer can map `cooldown` to 429.
 */
export function requestTickNow(agentId: string): ManualTickResult {
  if (!_started) return { ok: false, reason: 'manager_stopped' };
  const entry = _sessions.get(agentId);
  if (!entry) return { ok: false, reason: 'no_session' };
  const gate = checkBillableCooldown(agentId);
  if (!gate.ok) return { ok: false, reason: 'cooldown', retryAfterMs: gate.retryAfterMs };
  _lastManualTickAt.set(agentId, Date.now());
  void entry.session.requestTick('user_request');
  return { ok: true };
}

/**
 * User-triggered start, with the same per-agent cooldown as requestTickNow.
 *
 * Without this gate a caller could rapidly POST /start → /stop → /start
 * and fire an `initial` trigger tick on every spawn, since ensureSession
 * schedules a tick for new sessions. The shared cooldown map closes that
 * loop: a successful start consumes the same budget as a tick, so the
 * next start (or tick) for the same agent waits out the window.
 */
export function requestStartNow(agentId: string): ManualStartResult {
  if (!_started || !envEnabled()) return { ok: false, reason: 'manager_stopped' };
  // Mirror the automatic-startup gate — a watcher with no API key would
  // just 401 on its first tick, which contradicts the route's success
  // semantics. Same with non-running agents.
  if (!envHasKey()) return { ok: false, reason: 'agent_unavailable' };
  const agent = queries.getAgentById(agentId);
  if (!agent) return { ok: false, reason: 'agent_unavailable' };
  if (!['starting', 'running', 'waiting_user'].includes(agent.status)) return { ok: false, reason: 'agent_unavailable' };
  const gate = checkBillableCooldown(agentId);
  if (!gate.ok) return { ok: false, reason: 'cooldown', retryAfterMs: gate.retryAfterMs };
  ensureSession(agentId, 'user_request');
  if (!_sessions.has(agentId)) return { ok: false, reason: 'agent_unavailable' };
  // Only mark the cooldown AFTER ensureSession succeeded — otherwise a
  // start that bailed inside ensureSession (e.g. session-creation throw)
  // would still consume the cooldown and lock the user out of retry.
  const cooldownMs = envManualTickCooldownMs();
  _lastManualTickAt.set(agentId, Date.now());
  // Surface the cooldown duration so the UI can present "initial tick
  // scheduled — re-tick in Xs" instead of letting the user discover the
  // shared cooldown by clicking Re-tick and getting a 429.
  return { ok: true, cooldownMs };
}

/**
 * User-triggered start, **without** the cooldown gate. Kept for callers
 * that need to programmatically start a watcher (rehydration, tests) and
 * shouldn't be subject to the user-facing rate limit. The HTTP endpoint
 * uses requestStartNow instead.
 */
export function startWatcherForAgent(agentId: string): boolean {
  if (!_started || !envEnabled()) return false;
  if (!envHasKey()) return false;
  const agent = queries.getAgentById(agentId);
  if (!agent) return false;
  if (!['starting', 'running', 'waiting_user'].includes(agent.status)) return false;
  ensureSession(agentId, 'user_request');
  return _sessions.has(agentId);
}

/** User-triggered stop. */
export function stopWatcherForAgent(agentId: string): boolean {
  if (!_started) return false;
  if (!_sessions.has(agentId)) return false;
  stopSession(agentId);
  return true;
}

// ─── Internals ───────────────────────────────────────────────────────────────

function shouldWatch(agentId: string): boolean {
  if (!_started || !envEnabled()) return false;
  if (!envHasKey()) return false;
  const agent = queries.getAgentById(agentId);
  if (!agent) return false;
  const job = queries.getJobById(agent.job_id);
  if (!job) return false;
  // Skip interactive jobs — the user is already watching the terminal.
  if (job.is_interactive) return false;
  // Skip jobs that explicitly opted out.
  if (job.watch === 0) return false;
  return true;
}

function ensureSession(agentId: string, trigger: WatcherTrigger): void {
  if (_sessions.has(agentId)) {
    scheduleTick(agentId, trigger);
    return;
  }
  const agent = queries.getAgentById(agentId);
  if (!agent) return;
  let watcher = queries.getWatcherByAgentId(agentId);
  if (!watcher) {
    try {
      watcher = queries.insertWatcher({
        id: randomUUID(),
        agent_id: agentId,
        job_id: agent.job_id,
        model: defaultWatcherModel(),
        status: 'starting',
      });
      socket.emitWatcherSessionNew(watcher);
    } catch (err) {
      log.error({ err, agentId }, 'failed to create watcher row');
      return;
    }
  } else if (watcher.status === 'stopped' || watcher.status === 'error') {
    // Re-activate a previously-terminated watcher (e.g. user restart)
    queries.updateWatcher(watcher.id, { status: 'starting', error_message: null, finished_at: null });
    watcher = queries.getWatcherById(watcher.id);
    if (watcher) socket.emitWatcherSessionUpdate(watcher);
  }
  if (!watcher) return;
  const session = new WatcherSession(watcher.id, agentId);
  _sessions.set(agentId, { session, debounceTimer: null, pendingTrigger: null });
  scheduleTick(agentId, trigger);
}

function scheduleTick(agentId: string, trigger: WatcherTrigger): void {
  const entry = _sessions.get(agentId);
  if (!entry) return;
  // Coalesce: keep the highest-rank trigger in the debounce window (TRIGGER_RANK is shared with WatcherSession).
  entry.pendingTrigger = highestTrigger(entry.pendingTrigger, trigger);
  if (entry.debounceTimer) return;  // already scheduled
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    const t = entry.pendingTrigger;
    entry.pendingTrigger = null;
    if (!t) return;
    void entry.session.requestTick(t).catch(err => {
      log.error({ err, agentId }, 'requestTick failed');
      captureWithContext(err, { agent_id: agentId, component: 'JobWatcherManager' });
    });
  }, envDebounceMs());
  // Don't keep the event loop alive for the watcher debouncer
  entry.debounceTimer.unref?.();
}

function stopSession(agentId: string): void {
  const entry = _sessions.get(agentId);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.session.stop();
  _sessions.delete(agentId);
  // NOTE: _lastManualTickAt is intentionally NOT cleared here. The cooldown
  // is shared between /watcher/tick and /watcher/start (each represents a
  // billable Opus 4.7 call), so a `stop → start` cycle inside the window
  // must still wait it out — otherwise the rate limit would be trivially
  // bypassable by stopping first. The natural cleanup happens when the
  // agent eventually finishes (onAgentFinished → eventually the entry
  // becomes irrelevant) and on _resetForTest.
  try {
    const w = queries.getWatcherByAgentId(agentId);
    if (w && (w.status === 'running' || w.status === 'starting')) {
      queries.updateWatcher(w.id, { status: 'stopped', finished_at: Date.now() });
      const fresh = queries.getWatcherById(w.id);
      if (fresh) socket.emitWatcherSessionUpdate(fresh);
      // Cost observability: each watcher's tick budget is small but a busy
      // orchestrator running many concurrent agents adds up. Log the
      // per-session cost plus the running lifetime total so an operator
      // can spot runaway spend without a dashboard query.
      const total = queries.totalWatcherCostUsd();
      log.info(
        { agentId, sessionCostUsd: +fresh!.cost_usd.toFixed(4), tickCount: fresh!.tick_count, lifetimeTotalUsd: +total.toFixed(4) },
        'watcher session stopped',
      );
    }
    // Drop any pending nudge note for this agent — the agent is gone, the
    // notes table doesn't need to hold stale advice indefinitely. Use
    // deleteNote (not upsertNote('')) so we don't leave a tombstone row
    // per agent in the notes table for the lifetime of the DB.
    const nudgeKey = `watcher/nudges/${agentId}`;
    if (queries.getNote(nudgeKey)) queries.deleteNote(nudgeKey);
  } catch (err) {
    log.warn({ err, agentId }, 'stopSession DB update failed');
  }
}

function runHeartbeats(): void {
  const reconciled = reconcileActiveWatchers();
  if (reconciled.started > 0 || reconciled.stopped > 0) {
    log.info(reconciled, 'watcher reconciliation adjusted sessions');
  }
  for (const [agentId] of _sessions) {
    // Only fire if the agent is still in a live state — recovery already covers
    // dead agents.
    const agent = queries.getAgentById(agentId);
    if (!agent) { stopSession(agentId); continue; }
    if (!['starting', 'running', 'waiting_user'].includes(agent.status)) {
      stopSession(agentId);
      continue;
    }
    scheduleTick(agentId, 'heartbeat');
  }
}

function isLiveAgentStatus(status: string): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting_user';
}

/**
 * Repair watcher/session drift for long-lived servers.
 *
 * The normal path is event-driven: AgentRunner/AgentSpawner call
 * onAgentStarted and the session lives until onAgentFinished. A missed hook
 * during a spawn race, a module-level reset, or a dashboard restart can leave a
 * real running job without a watcher until the server itself restarts. The
 * heartbeat now reconciles the invariant directly from DB state:
 *
 *   every live, watch-enabled, non-interactive agent should have exactly one
 *   in-process watcher session, unless the operator manually stopped it.
 */
function reconcileActiveWatchers(): ReconcileResult {
  const result: ReconcileResult = { started: 0, stopped: 0, skippedStopped: 0 };

  for (const [agentId] of [..._sessions]) {
    const agent = queries.getAgentById(agentId);
    if (!agent || !isLiveAgentStatus(agent.status) || !shouldWatch(agentId)) {
      stopSession(agentId);
      result.stopped++;
    }
  }

  for (const agent of queries.listAllRunningAgents()) {
    if (_sessions.has(agent.id)) continue;
    if (!shouldWatch(agent.id)) continue;

    const watcher = queries.getWatcherByAgentId(agent.id);
    if (watcher?.status === 'stopped') {
      result.skippedStopped++;
      continue;
    }

    ensureSession(agent.id, 'initial');
    if (_sessions.has(agent.id)) result.started++;
  }

  return result;
}

async function rehydrateActiveWatchers(): Promise<void> {
  // Step 1: orphan cleanup. stopSession runs in a setTimeout(debounce+200ms)
  // after onAgentFinished, so if the server crashes in that narrow window the
  // watcher row stays in 'starting' / 'running' even though its agent is
  // already terminal. Mark those rows 'stopped' on boot so the dashboard
  // doesn't show ghost active watchers attached to dead agents.
  const activeWatchers = queries.listActiveWatchers();
  let orphansCleared = 0;
  for (const w of activeWatchers) {
    const agent = queries.getAgentById(w.agent_id);
    const stillRunning = !!agent && ['starting', 'running', 'waiting_user'].includes(agent.status);
    if (stillRunning) continue;
    queries.updateWatcher(w.id, { status: 'stopped', finished_at: Date.now() });
    orphansCleared++;
  }
  if (orphansCleared > 0) log.info({ orphansCleared }, 'cleared orphan watcher rows attached to terminal agents');

  // Step 2: re-attach in-process sessions for currently-running agents.
  const runningAgents = queries.listAllRunningAgents();
  let restored = 0;
  for (const agent of runningAgents) {
    if (!shouldWatch(agent.id)) continue;
    if (_sessions.has(agent.id)) continue;
    const watcher = queries.getWatcherByAgentId(agent.id);
    if (watcher?.status === 'stopped') continue;
    ensureSession(agent.id, 'initial');
    if (_sessions.has(agent.id)) restored++;
  }
  if (restored > 0) log.info({ restored }, 'rehydrated watcher sessions for running agents');
}

function classifyEvent(event: ClaudeStreamEvent | CodexStreamEvent): WatcherTrigger | null {
  const t = event.type;
  if (t === 'assistant') {
    // Only fire on tool_use blocks — text-only narration is low-signal.
    const message = (event as ClaudeStreamEvent).message;
    if (Array.isArray(message?.content) && message.content.some(b => b.type === 'tool_use')) {
      return 'tool_use';
    }
    return null;
  }
  if (t === 'result') {
    return (event as ClaudeStreamEvent).is_error ? 'turn_failed' : 'turn_complete';
  }
  if (t === 'error') return 'turn_failed';
  if (t === 'turn.completed') return 'turn_complete';
  if (t === 'turn.failed') return 'turn_failed';
  if (t === 'item.completed') {
    const item = (event as CodexStreamEvent).item;
    if (item?.type === 'command_execution') return 'tool_use';
    return null;
  }
  return null;
}

/** Internal hook: check if the manager has finished bootstrapping. */
export function isInitialised(): boolean { return _initialised; }
