import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import type { FileLock } from '../../shared/types.js';

// Prefix used to represent a global checkout/worktree lock.
// e.g. "checkout::/home/user/project" locks the entire git working tree at that path.
export const CHECKOUT_PREFIX = 'checkout::';

function isCheckoutLock(path: string): boolean {
  return path.startsWith(CHECKOUT_PREFIX);
}

function checkoutPath(lockPath: string): string {
  return lockPath.slice(CHECKOUT_PREFIX.length);
}

/**
 * Given a normal file path, return all active checkout:: locks held by OTHER
 * agents that cover this file (i.e. the file is under their checkout directory).
 */
function getConflictingCheckoutLocks(agentId: string, filePath: string): Array<{ lock: FileLock; file: string }> {
  const checkoutLocks = queries.getAllActiveCheckoutLocks();
  const conflicts: Array<{ lock: FileLock; file: string }> = [];
  for (const lock of checkoutLocks) {
    if (lock.agent_id === agentId) continue;
    const dir = checkoutPath(lock.file_path);
    if (filePath.startsWith(dir + '/') || filePath === dir) {
      conflicts.push({ lock, file: filePath });
    }
  }
  return conflicts;
}

/**
 * Given a checkout lock path (e.g. "checkout::/path"), return all active
 * file locks held by OTHER agents for files under that directory.
 */
function getConflictingFileLocksUnderCheckout(agentId: string, dir: string): Array<{ lock: FileLock; file: string }> {
  const fileLocks = queries.getActiveFileLocksUnderPath(dir);
  return fileLocks
    .filter(lock => lock.agent_id !== agentId)
    .map(lock => ({ lock, file: lock.file_path }));
}

export interface AcquireResult {
  success: boolean;
  acquired: string[];
  blocked: Array<{ file: string; held_by: string; expires_at: number; held_by_status: string | null; lock_reason: string | null }>;
  timed_out?: boolean;
  deadlock_detected?: boolean;
}

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
  // Used for deadlock (cycle) detection in the wait-for graph.
  private waitingFor = new Map<string, string[]>();

  // Counter for automatic deadlock resolutions.
  private deadlockResolutions = 0;

  constructor() {
    // Heartbeat: periodically wake all waiters so a missed release notification
    // doesn't cause indefinite stalls. The cycle cap (MAX_WAIT_CYCLE_MS) is the
    // real guard, but this catches any edge cases where notifyWaiters() was never
    // called (e.g. lock expired via TTL rather than explicit release).
    setInterval(() => this.notifyWaiters(), 2_000).unref();
  }

  // Attempt a single non-blocking acquire. Returns null if any file is blocked.
  private tryAcquireOnce(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
  ): AcquireResult | null {
    const blocked: AcquireResult['blocked'] = [];
    for (const file of files) {
      if (isCheckoutLock(file)) {
        // Checkout lock: blocked by (a) another checkout lock on same path,
        // and (b) any file lock held by another agent under the checkout directory.
        const dir = checkoutPath(file);
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (lock.agent_id !== agentId) {
            const holder = queries.getAgentById(lock.agent_id);
            blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
          }
        }
        for (const { lock } of getConflictingFileLocksUnderCheckout(agentId, dir)) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({ file: lock.file_path, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
        }
      } else {
        // Normal file lock: blocked by (a) direct lock on this file, and
        // (b) any checkout:: lock by another agent that covers this file.
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (lock.agent_id !== agentId) {
            const holder = queries.getAgentById(lock.agent_id);
            blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
          }
        }
        for (const { lock } of getConflictingCheckoutLocks(agentId, file)) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
        }
      }
    }

    if (blocked.length > 0) return null;

    // All clear — insert all locks atomically
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
   */
  private buildBlockedList(agentId: string, files: string[]): AcquireResult['blocked'] {
    const blocked: AcquireResult['blocked'] = [];
    for (const file of files) {
      if (isCheckoutLock(file)) {
        const dir = checkoutPath(file);
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (lock.agent_id !== agentId) {
            const holder = queries.getAgentById(lock.agent_id);
            blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
          }
        }
        for (const { lock } of getConflictingFileLocksUnderCheckout(agentId, dir)) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({ file: lock.file_path, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
        }
      } else {
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (lock.agent_id !== agentId) {
            const holder = queries.getAgentById(lock.agent_id);
            blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
          }
        }
        for (const { lock } of getConflictingCheckoutLocks(agentId, file)) {
          const holder = queries.getAgentById(lock.agent_id);
          blocked.push({ file, held_by: lock.agent_id, expires_at: lock.expires_at, held_by_status: holder?.status_message ?? null, lock_reason: lock.reason ?? null });
        }
      }
    }
    return blocked;
  }

  /**
   * Return all agents (other than `excludeAgent`) that are currently blocking
   * access to the given file path, considering both direct file locks and
   * checkout:: locks that cover the file.
   */
  private holdersOf(filePath: string, excludeAgent: string): string[] {
    const holders = new Set<string>();
    for (const lock of queries.getActiveLocksForFile(filePath)) {
      if (lock.agent_id !== excludeAgent) holders.add(lock.agent_id);
    }
    if (!isCheckoutLock(filePath)) {
      for (const { lock } of getConflictingCheckoutLocks(excludeAgent, filePath)) {
        holders.add(lock.agent_id);
      }
    } else {
      // For checkout locks, also include holders of file locks under the directory
      const dir = checkoutPath(filePath);
      for (const { lock } of getConflictingFileLocksUnderCheckout(excludeAgent, dir)) {
        holders.add(lock.agent_id);
      }
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
    const path: string[] = [];

    // Returns true if we can reach agentId by following wait-for edges from `current`.
    const canReachSelf = (current: string): boolean => {
      if (current === agentId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      path.push(current);

      const waiting = this.waitingFor.get(current);
      if (!waiting) { path.pop(); return false; }

      for (const file of waiting) {
        for (const holder of this.holdersOf(file, current)) {
          if (canReachSelf(holder)) return true;
        }
      }
      path.pop();
      return false;
    };

    // Start DFS from each holder of the files agentId is blocked on.
    for (const file of myFiles) {
      for (const holder of this.holdersOf(file, agentId)) {
        visited.clear();
        path.length = 0;
        if (canReachSelf(holder)) {
          return [agentId, ...path];
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
        for (const lock of queries.getActiveLocksForFile(file)) {
          if (agentSet.has(lock.agent_id) && lock.agent_id !== agentId) {
            if (!oldest || lock.acquired_at < oldest.lock.acquired_at) {
              oldest = { agentId: lock.agent_id, file, lock };
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

    // Dynamic import to avoid import-time dependency on McpServer (which pulls
    // in integrations/child_process and breaks test mocks that don't include it).
    const { hasActiveTransport } = await import('../mcp/McpServer.js');

    // Don't force-release if the holder is actively connected
    if (hasActiveTransport(oldest.agentId)) return false;

    // Don't force-release if the holder had recent activity (<5s ago)
    const agent = queries.getAgentById(oldest.agentId);
    if (agent && Date.now() - agent.updated_at < 5_000) return false;

    // Safe to force-release
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
   *
   * Deadlock detection: before each sleep cycle the registry checks for a cycle
   * in the wait-for graph. If Agent A holds file1 and waits for file2 while
   * Agent B holds file2 and waits for file1, the cycle is detected immediately.
   * The system first tries to auto-resolve by force-releasing the oldest lock
   * held by an idle agent. If the holder is still active, the waiting agent
   * receives { success: false, deadlock_detected: true } so it can release its
   * held locks and retry.
   */
  async acquire(
    agentId: string,
    files: string[],
    reason: string | null,
    ttlMs: number,
    timeoutMs: number,
  ): Promise<AcquireResult> {
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const result = this.tryAcquireOnce(agentId, files, reason, ttlMs);
        if (result) return result;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // Re-check one more time — a release may have just happened
          const last = this.tryAcquireOnce(agentId, files, reason, ttlMs);
          if (last) return last;

          return { success: false, acquired: [], blocked: this.buildBlockedList(agentId, files), timed_out: true };
        }

        // Register this agent as waiting for these files so other agents'
        // deadlock checks can traverse through us.
        this.waitingFor.set(agentId, files);

        // Check for a cycle in the wait-for graph. If detected, try to auto-
        // resolve by force-releasing the oldest lock held by an idle agent.
        // If the holder is still active, fall back to returning deadlock_detected
        // so this agent can release its held locks and retry.
        const cycle = this.detectDeadlock(agentId);
        if (cycle) {
          if (await this.tryAutoResolveDeadlock(cycle)) {
            // Lock was released — retry acquire on next iteration
            continue;
          }
          return {
            success: false,
            acquired: [],
            blocked: this.buildBlockedList(agentId, files),
            deadlock_detected: true,
          };
        }

        // Wait for any release event (or at most MAX_WAIT_CYCLE_MS, whichever comes
        // first). The short cap means a missed notifyWaiters() causes at most a
        // 5-second delay rather than a multi-minute stall.
        await this.waitForRelease(Math.min(remaining, MAX_WAIT_CYCLE_MS));
      }
    } finally {
      // Always clean up our wait-for registration, whether we succeeded,
      // timed out, or detected a deadlock.
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
    // Wake all waiters so each re-checks; they will re-sleep if still blocked.
    for (const wake of this.waiters) wake();
  }

  release(agentId: string, files: string[]): string[] {
    const released: string[] = [];
    for (const file of files) {
      for (const lock of queries.getActiveLocksForFile(file)) {
        if (lock.agent_id === agentId) {
          queries.releaseLock(lock.id);
          socket.emitLockReleased(lock.id, lock.file_path);
          released.push(file);
        }
      }
    }
    if (released.length > 0) this.notifyWaiters();
    return released;
  }

  releaseAll(agentId: string): void {
    // Use getAllUnreleasedLocksForAgent (no TTL filter) so that locks whose TTL
    // has already expired still get released and emit lock:released events.
    // Without this, expired locks accumulate in the UI forever.
    const locks = queries.getAllUnreleasedLocksForAgent(agentId);
    for (const lock of locks) {
      queries.releaseLock(lock.id);
      socket.emitLockReleased(lock.id, lock.file_path);
    }
    if (locks.length > 0) this.notifyWaiters();
  }
}
