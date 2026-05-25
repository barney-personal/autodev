import { randomUUID } from 'crypto';
import * as path from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import type { FileLock } from '../../shared/types.js';

// Prefix used to represent a global checkout/worktree lock.
// e.g. "checkout::/home/user/project" locks the entire git working tree at that path.
export const CHECKOUT_PREFIX = 'checkout::';

export function isCheckoutLock(p: string): boolean {
  return p.startsWith(CHECKOUT_PREFIX);
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
}

/**
 * Normalize a non-checkout file lock path. Returns an absolute POSIX-normalized
 * path with no trailing separator and with `.`/`..` segments collapsed. Relative
 * paths are resolved against the current working directory — this matches what
 * scripts/check-lock-hook.mjs does before calling /api/locks/check so stored vs.
 * query keys stay consistent.
 *
 * If the input already carries the `checkout::` prefix, it is delegated to
 * normalizeCheckoutLockPath so callers can normalize either kind safely.
 */
export function normalizeLockPath(p: string): string {
  if (isCheckoutLock(p)) return normalizeCheckoutLockPath(p);
  const absolute = path.isAbsolute(p) ? p : path.resolve(p);
  return stripTrailingSep(path.normalize(absolute));
}

/**
 * Normalize a checkout:: lock path. Accepts either `checkout::/abs/dir` or a
 * bare directory path and always returns `checkout::<normalized-absolute-dir>`.
 */
export function normalizeCheckoutLockPath(p: string): string {
  const inner = p.startsWith(CHECKOUT_PREFIX) ? p.slice(CHECKOUT_PREFIX.length) : p;
  const absolute = path.isAbsolute(inner) ? inner : path.resolve(inner);
  return CHECKOUT_PREFIX + stripTrailingSep(path.normalize(absolute));
}

/**
 * True iff `candidate` is the same path as `base` or strictly nested under it.
 * Uses path.relative to compute containment, so sibling-prefix paths like
 * `/repo/src2` are correctly NOT considered within `/repo/src`. Both inputs
 * are normalized first; callers may pass raw or normalized paths.
 */
export function isPathWithin(base: string, candidate: string): boolean {
  const nBase = stripTrailingSep(path.normalize(base));
  const nCand = stripTrailingSep(path.normalize(candidate));
  if (nBase === nCand) return true;
  const rel = path.relative(nBase, nCand);
  if (rel === '' || rel === '.') return true;
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(rel);
}

function checkoutDirOf(lockPath: string): string {
  return lockPath.slice(CHECKOUT_PREFIX.length);
}

export interface AcquireResult {
  success: boolean;
  acquired: string[];
  blocked: Array<{ file: string; held_by: string; expires_at: number; held_by_status: string | null; lock_reason: string | null }>;
  timed_out?: boolean;
  deadlock_detected?: boolean;
}

type BlockedEntry = AcquireResult['blocked'][number];

// Max sleep per waitForRelease cycle — short so missed notifications don't
// cause multi-minute stalls. We rely on the deadline check in acquire() to
// honour the caller's timeout_ms accurately.
const MAX_WAIT_CYCLE_MS = 5_000;

let _instance: FileLockRegistry | null = null;

export function getFileLockRegistry(): FileLockRegistry {
  if (!_instance) _instance = new FileLockRegistry();
  return _instance;
}

export function _resetForTest(): void {
  _instance = null;
}

class FileLockRegistry {
  // Each entry is a callback that wakes a single waiter to re-check.
  private waiters = new Set<() => void>();

  // Tracks which files each agent is currently blocked waiting to acquire.
  // Used for deadlock (cycle) detection in the wait-for graph. Stored values
  // are always normalized via normalizeLockPath.
  private waitingFor = new Map<string, string[]>();

  // Counter for automatic deadlock resolutions (observable via getDeadlockResolutionCount).
  private deadlockResolutions = 0;

  constructor() {
    // Heartbeat: periodically wake all waiters so a missed release notification
    // doesn't cause indefinite stalls. The cycle cap (MAX_WAIT_CYCLE_MS) is the
    // real guard, but this catches any edge cases where notifyWaiters() was never
    // called (e.g. lock expired via TTL rather than explicit release).
    setInterval(() => this.notifyWaiters(), 2_000).unref();
  }

  private toBlocked(file: string, lock: FileLock): BlockedEntry {
    const holder = queries.getAgentById(lock.agent_id);
    return {
      file,
      held_by: lock.agent_id,
      expires_at: lock.expires_at,
      held_by_status: holder?.status_message ?? null,
      lock_reason: lock.reason ?? null,
    };
  }

  /**
   * Single source of truth for "who else is currently blocking `file`?"
   * Used by tryAcquireOnce, buildBlockedList, holdersOf, and the deadlock
   * oldest-lock selector so direct and checkout conflicts cannot drift.
   *
   * `file` must already be normalized via normalizeLockPath.
   * Returns raw conflicting lock rows; callers map to BlockedEntry as needed.
   *
   * Compatibility note: pre-normalization rows may live in the DB with
   * non-canonical paths (e.g. `/repo/src/./foo.ts`, `/repo/src/foo.ts/`).
   * We therefore never trust an exact `file_path = ?` match alone — direct
   * row sweeps always re-normalize each row before deciding equivalence.
   */
  private findConflictingLocks(excludeAgent: string, file: string): Array<{ file: string; lock: FileLock }> {
    const conflicts: Array<{ file: string; lock: FileLock }> = [];

    if (isCheckoutLock(file)) {
      const dir = checkoutDirOf(file);
      // (a) Any checkout lock whose normalized path equals `file`.
      for (const lock of queries.getAllActiveCheckoutLocks()) {
        if (lock.agent_id === excludeAgent) continue;
        if (normalizeCheckoutLockPath(lock.file_path) === file) {
          conflicts.push({ file, lock });
        }
      }
      // (b) Any direct file lock under the checkout directory (or exactly at it).
      //     Scans ALL active direct locks rather than the LIKE-pattern helper so
      //     legacy non-canonical rows and direct locks equal to `dir` are caught.
      for (const lock of queries.getAllActiveDirectFileLocks()) {
        if (lock.agent_id === excludeAgent) continue;
        const lockedPath = normalizeLockPath(lock.file_path);
        if (isPathWithin(dir, lockedPath)) {
          conflicts.push({ file: lockedPath, lock });
        }
      }
    } else {
      // (a) Any direct lock whose normalized path equals `file`.
      for (const lock of queries.getAllActiveDirectFileLocks()) {
        if (lock.agent_id === excludeAgent) continue;
        if (normalizeLockPath(lock.file_path) === file) {
          conflicts.push({ file, lock });
        }
      }
      // (b) Any checkout:: lock by another agent that covers this file.
      for (const lock of queries.getAllActiveCheckoutLocks()) {
        if (lock.agent_id === excludeAgent) continue;
        const dir = checkoutDirOf(normalizeCheckoutLockPath(lock.file_path));
        if (isPathWithin(dir, file)) conflicts.push({ file, lock });
      }
    }

    return conflicts;
  }

  /**
   * Find all active rows whose normalized path equals `file` (which must
   * already be normalized). Used by release() so that callers can release
   * legacy non-canonical rows by passing a normalized path.
   */
  private findOwnedLocksMatching(agentId: string, file: string): FileLock[] {
    const matches: FileLock[] = [];
    if (isCheckoutLock(file)) {
      for (const lock of queries.getAllActiveCheckoutLocks()) {
        if (lock.agent_id !== agentId) continue;
        if (normalizeCheckoutLockPath(lock.file_path) === file) matches.push(lock);
      }
    } else {
      for (const lock of queries.getAllActiveDirectFileLocks()) {
        if (lock.agent_id !== agentId) continue;
        if (normalizeLockPath(lock.file_path) === file) matches.push(lock);
      }
    }
    return matches;
  }

  // Attempt a single non-blocking acquire. Returns null if any file is blocked.
  // `files` must already be normalized via normalizeLockPath.
  private tryAcquireOnce(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
  ): AcquireResult | null {
    const blocked: BlockedEntry[] = [];
    for (const file of files) {
      for (const { file: conflictFile, lock } of this.findConflictingLocks(agentId, file)) {
        blocked.push(this.toBlocked(conflictFile, lock));
      }
    }

    if (blocked.length > 0) return null;

    // All clear — insert all locks atomically.
    const now = Date.now();
    const acquired: string[] = [];
    for (const file of files) {
      const lock: FileLock = {
        id: randomUUID(),
        agent_id: agentId,
        file_path: file,
        reason,
        acquired_at: now,
        expires_at: now + ttlMs,
        released_at: null,
      };
      queries.insertFileLock(lock);
      socket.emitLockAcquired(lock);
      acquired.push(file);
    }

    return { success: true, acquired, blocked: [] };
  }

  /**
   * Build the blocked-by list for the given agent and files (used in failure results).
   * `files` must already be normalized.
   */
  private buildBlockedList(agentId: string, files: string[]): BlockedEntry[] {
    const blocked: BlockedEntry[] = [];
    for (const file of files) {
      for (const { file: conflictFile, lock } of this.findConflictingLocks(agentId, file)) {
        blocked.push(this.toBlocked(conflictFile, lock));
      }
    }
    return blocked;
  }

  /**
   * Return all agents (other than `excludeAgent`) currently blocking access
   * to `filePath` (normalized). Considers both direct file locks and checkout::
   * locks that cover the file.
   */
  private holdersOf(filePath: string, excludeAgent: string): string[] {
    const holders = new Set<string>();
    for (const { lock } of this.findConflictingLocks(excludeAgent, filePath)) {
      holders.add(lock.agent_id);
    }
    return [...holders];
  }

  /**
   * Detect whether registering agentId as waiting for its files (already set in
   * this.waitingFor) would create a cycle in the wait-for graph.
   *
   * Wait-for graph: edge A -> B means "A is blocked waiting for a file held by B".
   * A deadlock exists when there is a cycle: A -> B -> ... -> A.
   *
   * Algorithm: DFS from each current holder of the files agentId wants.
   * If any DFS path reaches agentId, we have a cycle.
   *
   * Returns the cycle as an array of agent IDs, or null if no cycle.
   */
  private detectDeadlock(agentId: string): string[] | null {
    const myFiles = this.waitingFor.get(agentId);
    if (!myFiles || myFiles.length === 0) return null;

    const visited = new Set<string>();
    const dfsPath: string[] = [];

    const canReachSelf = (current: string): boolean => {
      if (current === agentId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      dfsPath.push(current);

      const waiting = this.waitingFor.get(current);
      if (!waiting) { dfsPath.pop(); return false; }

      for (const file of waiting) {
        for (const holder of this.holdersOf(file, current)) {
          if (canReachSelf(holder)) return true;
        }
      }
      dfsPath.pop();
      return false;
    };

    for (const file of myFiles) {
      for (const holder of this.holdersOf(file, agentId)) {
        visited.clear();
        dfsPath.length = 0;
        if (canReachSelf(holder)) {
          return [agentId, ...dfsPath];
        }
      }
    }

    return null;
  }

  /**
   * Find the oldest lock held by an agent in the cycle that is blocking another
   * agent in the cycle. This is the lock to force-release for deadlock recovery.
   */
  private getOldestLockInCycle(cycleAgents: string[]): { agentId: string; file: string; lock: FileLock } | null {
    const agentSet = new Set(cycleAgents);
    let oldest: { agentId: string; file: string; lock: FileLock } | null = null;

    for (const agentId of cycleAgents) {
      const waitingFiles = this.waitingFor.get(agentId);
      if (!waitingFiles) continue;

      for (const file of waitingFiles) {
        for (const { lock } of this.findConflictingLocks(agentId, file)) {
          if (agentSet.has(lock.agent_id) && lock.agent_id !== agentId) {
            if (!oldest || lock.acquired_at < oldest.lock.acquired_at) {
              oldest = { agentId: lock.agent_id, file: lock.file_path, lock };
            }
          }
        }
      }
    }

    return oldest;
  }

  /**
   * Attempt to auto-resolve a deadlock by force-releasing the oldest lock in the
   * cycle, but ONLY if the holding agent has no active MCP transport and its last
   * activity was >5s ago. Returns true if the lock was released.
   */
  private async tryAutoResolveDeadlock(cycleAgents: string[]): Promise<boolean> {
    const oldest = this.getOldestLockInCycle(cycleAgents);
    if (!oldest) return false;

    const { hasActiveTransport } = await import('../mcp/McpServer.js');

    if (hasActiveTransport(oldest.agentId)) return false;

    const agent = queries.getAgentById(oldest.agentId);
    if (agent && Date.now() - agent.updated_at < 5_000) return false;

    this.release(oldest.agentId, [oldest.file]);
    this.deadlockResolutions++;

    const details = {
      cycle_agents: cycleAgents,
      released_agent: oldest.agentId,
      released_file: oldest.file,
      lock_id: oldest.lock.id,
      lock_acquired_at: oldest.lock.acquired_at,
      resolution_count: this.deadlockResolutions,
    };

    logResilienceEvent('deadlock_resolved', 'lock', oldest.lock.id, details);
    socket.emitDeadlockResolved(details);

    console.log(`[file-lock] Auto-resolved deadlock: released ${oldest.file} held by ${oldest.agentId} (cycle: ${cycleAgents.join(' -> ')})`);

    return true;
  }

  getDeadlockResolutionCount(): number {
    return this.deadlockResolutions;
  }

  /**
   * Blocking acquire. Waits until all requested files are free, then grabs
   * them all at once (all-or-nothing). If timeoutMs elapses before the locks
   * become available, returns { success: false, timed_out: true }.
   */
  async acquire(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
    timeoutMs: number,
  ): Promise<AcquireResult> {
    const normFiles = files.map(normalizeLockPath);
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const result = this.tryAcquireOnce(agentId, normFiles, reason, ttlMs);
        if (result) return result;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const last = this.tryAcquireOnce(agentId, normFiles, reason, ttlMs);
          if (last) return last;

          return { success: false, acquired: [], blocked: this.buildBlockedList(agentId, normFiles), timed_out: true };
        }

        this.waitingFor.set(agentId, normFiles);

        const cycle = this.detectDeadlock(agentId);
        if (cycle) {
          try {
            if (await this.tryAutoResolveDeadlock(cycle)) {
              continue;
            }
          } catch (err) {
            console.error(`[file-lock] tryAutoResolveDeadlock failed:`, err);
          }
          return {
            success: false,
            acquired: [],
            blocked: this.buildBlockedList(agentId, normFiles),
            deadlock_detected: true,
          };
        }

        await this.waitForRelease(Math.min(remaining, MAX_WAIT_CYCLE_MS));
      }
    } finally {
      this.waitingFor.delete(agentId);
    }
  }

  private waitForRelease(maxWaitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this.waiters.delete(wake);
          resolve();
        }
      }, maxWaitMs);

      const wake = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        }
      };

      this.waiters.add(wake);
    });
  }

  private notifyWaiters(): void {
    for (const wake of this.waiters) wake();
  }

  release(agentId: string, files: string[]): string[] {
    const released: string[] = [];
    for (const rawFile of files) {
      const file = normalizeLockPath(rawFile);
      for (const lock of this.findOwnedLocksMatching(agentId, file)) {
        queries.releaseLock(lock.id);
        socket.emitLockReleased(lock.id, lock.file_path);
        released.push(file);
      }
    }
    if (released.length > 0) this.notifyWaiters();
    return released;
  }

  releaseAll(agentId: string): void {
    // Use getAllUnreleasedLocksForAgent (no TTL filter) so that locks whose TTL
    // has already expired still get released and emit lock:released events.
    const locks = queries.getAllUnreleasedLocksForAgent(agentId);
    for (const lock of locks) {
      queries.releaseLock(lock.id);
      socket.emitLockReleased(lock.id, lock.file_path);
    }
    if (locks.length > 0) this.notifyWaiters();
  }
}
