/**
 * ResourceMonitor — periodic check for system resource exhaustion.
 *
 * Monitors:
 * 1. Disk space in the data directory (agents write logs here)
 * 2. Process memory (orchestrator's own RSS)
 * 3. Individual agent process RSS (via /proc or ps)
 *
 * When resources are critically low, emits warnings and can pause the work queue.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';

const TICK_INTERVAL_MS = 60_000; // check every 60s

// Thresholds
const DISK_WARN_MB = 500;         // warn when <500MB free
const DISK_CRITICAL_MB = 100;     // pause queue when <100MB free
const PROCESS_RSS_WARN_MB = 1024; // warn if orchestrator >1GB RSS
const AGENT_RSS_WARN_MB = 2048;   // warn if any single agent >2GB RSS

let _timer: NodeJS.Timeout | null = null;
let _diskWarned = false;
let _diskCritical = false;
let _memoryWarned = false;
let _paused = false;

// Callbacks set by the server to control the work queue
let _pauseQueue: (() => void) | null = null;
let _resumeQueue: (() => void) | null = null;

export function setQueueControls(pause: () => void, resume: () => void): void {
  _pauseQueue = pause;
  _resumeQueue = resume;
}

export function startResourceMonitor(): void {
  if (_timer) return;
  console.log('[resource] ResourceMonitor started');
  // Run once immediately
  try { tick(); } catch (err) { console.error('[resource] initial tick error:', err); captureWithContext(err, { component: 'ResourceMonitor' }); }
  _timer = setInterval(() => {
    try { tick(); } catch (err) { console.error('[resource] tick error:', err); captureWithContext(err, { component: 'ResourceMonitor' }); }
  }, TICK_INTERVAL_MS);
}

export function stopResourceMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function tick(): void {
  checkDiskSpace();
  checkProcessMemory();
  checkAgentProcesses();
}

/**
 * Check available disk space in the data directory.
 */
function checkDiskSpace(): void {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    // Use df to get available space; works on macOS and Linux
    const output = execFileSync('df', ['-m', dataDir], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return;
    // Parse the "Available" column (4th column on most systems)
    const parts = lines[1].split(/\s+/);
    const availMb = parseInt(parts[3], 10);
    if (isNaN(availMb)) return;

    if (availMb < DISK_CRITICAL_MB) {
      if (!_diskCritical) {
        console.error(`[resource] CRITICAL: only ${availMb}MB disk space remaining — pausing work queue`);
        _diskCritical = true;
        _diskWarned = true;
        if (_pauseQueue && !_paused) {
          _pauseQueue();
          _paused = true;
        }
      }
    } else if (availMb < DISK_WARN_MB) {
      if (!_diskWarned) {
        console.warn(`[resource] WARNING: only ${availMb}MB disk space remaining`);
        _diskWarned = true;
      }
      // Recover from critical
      if (_diskCritical) {
        _diskCritical = false;
        if (_resumeQueue && _paused) {
          console.log(`[resource] disk space recovered to ${availMb}MB — resuming work queue`);
          _resumeQueue();
          _paused = false;
        }
      }
    } else {
      // All clear
      if (_diskWarned) {
        console.log(`[resource] disk space recovered to ${availMb}MB`);
        _diskWarned = false;
      }
      if (_diskCritical) {
        _diskCritical = false;
        if (_resumeQueue && _paused) {
          _resumeQueue();
          _paused = false;
        }
      }
    }
  } catch {
    // df not available or failed — skip silently
  }
}

/**
 * Check orchestrator process memory usage.
 */
function checkProcessMemory(): void {
  const rssMb = process.memoryUsage.rss() / (1024 * 1024);
  if (rssMb > PROCESS_RSS_WARN_MB) {
    if (!_memoryWarned) {
      console.warn(`[resource] WARNING: orchestrator RSS is ${Math.round(rssMb)}MB (threshold: ${PROCESS_RSS_WARN_MB}MB)`);
      _memoryWarned = true;
    }
  } else if (_memoryWarned && rssMb < PROCESS_RSS_WARN_MB * 0.8) {
    _memoryWarned = false;
  }
}

/**
 * Check agent subprocess RSS via `ps`.
 * Only logs a warning — doesn't kill agents, as they may be in the middle of important work.
 */
function checkAgentProcesses(): void {
  const agents = queries.listAllRunningAgents();
  if (agents.length === 0) return;

  const pids = agents.filter(a => a.pid != null).map(a => a.pid!);
  if (pids.length === 0) return;

  try {
    // Use ps to get RSS for all agent PIDs at once
    const output = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,rss='], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    for (const line of output.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = parseInt(parts[0], 10);
      const rssKb = parseInt(parts[1], 10);
      if (isNaN(pid) || isNaN(rssKb)) continue;

      const rssMb = rssKb / 1024;
      if (rssMb > AGENT_RSS_WARN_MB) {
        const agent = agents.find(a => a.pid === pid);
        if (agent) {
          console.warn(`[resource] agent ${agent.id.slice(0, 8)} (PID ${pid}) using ${Math.round(rssMb)}MB RSS`);
        }
      }
    }
  } catch {
    // ps failed — skip silently (agent may have already exited)
  }
}

/** Exported for testing */
export function _getState() {
  return { diskWarned: _diskWarned, diskCritical: _diskCritical, memoryWarned: _memoryWarned, paused: _paused };
}
