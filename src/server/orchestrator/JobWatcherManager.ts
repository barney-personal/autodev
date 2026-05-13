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
import { WatcherSession, DEFAULT_WATCHER_MODEL } from './WatcherSession.js';
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

const _sessions = new Map<string, SessionEntry>();
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
  log.info({ heartbeatMs: envHeartbeatMs(), debounceMs: envDebounceMs() }, 'Job watcher manager started');
  _heartbeat = setInterval(() => {
    try { runHeartbeats(); } catch (err) {
      log.error({ err }, 'heartbeat error');
      captureWithContext(err, { component: 'JobWatcherManager' });
    }
  }, envHeartbeatMs());
  // Re-attach watchers for agents that were already running across a restart
  void rehydrateActiveWatchers();
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
  const cooldownMs = envManualTickCooldownMs();
  const lastAt = _lastManualTickAt.get(agentId);
  if (lastAt != null && Date.now() - lastAt < cooldownMs) {
    return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - (Date.now() - lastAt) };
  }
  _lastManualTickAt.set(agentId, Date.now());
  void entry.session.requestTick('user_request');
  return { ok: true };
}

/**
 * User-triggered start: spawn a watcher for an agent that previously had
 * `job.watch = 0` or was started before the manager came up.
 */
export function startWatcherForAgent(agentId: string): boolean {
  if (!_started || !envEnabled()) return false;
  // Mirror the automatic-startup gate — a watcher with no API key would just
  // 401 on its first tick, which contradicts the route's success semantics.
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
        model: DEFAULT_WATCHER_MODEL,
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
  _lastManualTickAt.delete(agentId);
  try {
    const w = queries.getWatcherByAgentId(agentId);
    if (w && (w.status === 'running' || w.status === 'starting')) {
      queries.updateWatcher(w.id, { status: 'stopped', finished_at: Date.now() });
      const fresh = queries.getWatcherById(w.id);
      if (fresh) socket.emitWatcherSessionUpdate(fresh);
    }
    // Drop any pending nudge note for this agent — the agent is gone, the
    // notes table doesn't need to hold stale advice indefinitely.
    const nudgeKey = `watcher/nudges/${agentId}`;
    const nudge = queries.getNote(nudgeKey);
    if (nudge?.value) queries.upsertNote(nudgeKey, '', null);
  } catch (err) {
    log.warn({ err, agentId }, 'stopSession DB update failed');
  }
}

function runHeartbeats(): void {
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

async function rehydrateActiveWatchers(): Promise<void> {
  const runningAgents = queries.listAllRunningAgents();
  let restored = 0;
  for (const agent of runningAgents) {
    if (!shouldWatch(agent.id)) continue;
    if (_sessions.has(agent.id)) continue;
    ensureSession(agent.id, 'initial');
    restored++;
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
