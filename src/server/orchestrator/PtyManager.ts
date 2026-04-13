/**
 * PtyManager.ts -- Facade module for backward compatibility.
 *
 * All implementation has been decomposed into focused sub-modules:
 *   - PtySessionManager.ts  (PTY attach/detach, events, resize, input, buffers, tmux liveness)
 *   - AgentSpawner.ts       (tmux spawn, script/prompt generation)
 *   - JobFinalizer.ts       (standalone print job resolution, ndjson parsing, exit polling)
 *   - PtyDiskLogger.ts      (log files, snapshots, FD management)
 *   - PtyResourceManager.ts (concurrency cap, backoff, resource checks)
 *   - AgentLifecycle.ts     (explicit agent state machine)
 *   - AgentConfig.ts        (shared constants, types -- breaks circular dep)
 */

// ── PtySessionManager: attach/detach, input, resize, buffers, liveness, spawn ─
export {
  attachPty,
  disconnectAgent,
  disconnectAll,
  writeInput,
  resizePty,
  resizeAndSnapshot,
  getPtyBuffer,
  getSnapshot,
  isTmuxSessionAlive,
  cleanupStaleTmuxSessions,
  checkPtyResources,
  startInteractiveAgent,
  agentStates,
  // Test helpers
  _getSessionNameForTest,
  _checkPtyResourceAvailabilityForTest,
  _getResourceBackoffForTest,
  _escalateResourceBackoffForTest,
  _resetResourceBackoffForTest,
  _cleanupStaleTmuxSessionsForTest,
  _seedSpawningAgentForTest,
  _isAgentSpawningForTest,
  _getAgentStateForTest,
  _resetPtySessionManagerStateForTest as _resetPtyManagerStateForTest,
} from './PtySessionManager.js';

// ── AgentSpawner: types ─────────────────────────────────────────────────────
export type { StartInteractiveOptions } from './AgentSpawner.js';

// ── JobFinalizer: standalone print job resolution, ndjson parsing ───────────
export {
  resolveStandalonePrintJobOutcome,
  reportStandaloneResolutionFailure,
  finalizeStandalonePrintJob,
  _statusFromNdjsonForTest,
  _checkCommitsSinceForTest,
  _seedStandaloneExitPollForTest,
  _resolveStandalonePrintJobOutcomeForTest,
  _isFinalizingForTest,
  _resetJobFinalizerStateForTest,
} from './JobFinalizer.js';

// ── PtyDiskLogger: log files, snapshots, FD management ─────────────────────
export { saveSnapshot } from './PtyDiskLogger.js';

// ── PtyResourceManager: concurrency cap, backoff ───────────────────────────
export { checkResources, MAX_PTY_SESSIONS } from './PtyResourceManager.js';

// ── AgentLifecycle: explicit state machine ─────────────────────────────────
export { AgentState, AgentStateManager } from './AgentLifecycle.js';
