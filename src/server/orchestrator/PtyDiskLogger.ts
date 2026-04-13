/**
 * PtyDiskLogger — Disk I/O for PTY log files, persistent FDs, fsync, and snapshots.
 *
 * Extracted from PtyManager to isolate all filesystem concerns (log paths,
 * persistent file descriptors, periodic fsync, snapshot capture/save/read,
 * and the generic readTextTail utility).
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sessionName } from './AgentConfig.js';

const TMUX = process.env.TMUX_BIN ?? 'tmux';

/** Directory where all PTY log files are stored */
export const PTY_LOG_DIR = path.join(process.cwd(), 'data', 'agent-logs');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getPtyLogPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.pty`);
}

export function getNdjsonPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.ndjson`);
}

export function getPtyStderrPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.stderr`);
}

export function getSnapshotPath(agentId: string): string {
  return path.join(PTY_LOG_DIR, `${agentId}.snapshot`);
}

// ---------------------------------------------------------------------------
// Persistent file descriptors for PTY log writes
// ---------------------------------------------------------------------------

/** Persistent FDs for PTY log writes (avoids open/close per write) */
const _ptyLogFds = new Map<string, number>();

/** Periodic fsync for PTY logs to ensure durability without syncing every write */
let _fsyncTimer: NodeJS.Timeout | null = null;
const FSYNC_INTERVAL_MS = 5_000; // fsync all open PTY logs every 5s

function ensureFsyncTimer(): void {
  if (_fsyncTimer) return;
  _fsyncTimer = setInterval(() => {
    for (const [agentId, fd] of _ptyLogFds) {
      try { fs.fsyncSync(fd); } catch { _ptyLogFds.delete(agentId); }
    }
  }, FSYNC_INTERVAL_MS);
  _fsyncTimer.unref();
}

export function getPtyLogFd(agentId: string): number {
  let fd = _ptyLogFds.get(agentId);
  if (fd !== undefined) return fd;
  fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
  fd = fs.openSync(getPtyLogPath(agentId), 'a');
  _ptyLogFds.set(agentId, fd);
  ensureFsyncTimer();
  return fd;
}

export function closePtyLogFd(agentId: string): void {
  const fd = _ptyLogFds.get(agentId);
  if (fd !== undefined) {
    try { fs.fsyncSync(fd); } catch { /* ignore */ }
    try { fs.closeSync(fd); } catch { /* ignore */ }
    _ptyLogFds.delete(agentId);
  }
}

/** Close all open PTY log FDs. Used during shutdown / test cleanup. */
export function closeAllPtyLogFds(): void {
  for (const agentId of Array.from(_ptyLogFds.keys())) closePtyLogFd(agentId);
}

// ---------------------------------------------------------------------------
// readTextTail — generic tail reader utility
// ---------------------------------------------------------------------------

export function readTextTail(filePath: string, maxBytes = 4096): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }

    let text = buffer.toString('utf8');
    if (stat.size > bytesToRead) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tmux snapshot capture / save / read
// ---------------------------------------------------------------------------

// sessionName imported from AgentConfig

export function captureTmuxSnapshot(agentId: string): string | null {
  try {
    const output = execFileSync(TMUX, [
      'capture-pane', '-p', '-e', '-S', '-',
      '-t', sessionName(agentId),
    ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
    return output;
  } catch {
    return null;
  }
}

export function saveSnapshot(agentId: string): void {
  const snapshot = captureTmuxSnapshot(agentId);
  if (!snapshot) return;
  try {
    fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
    const snapshotPath = getSnapshotPath(agentId);
    fs.writeFileSync(snapshotPath, snapshot, 'utf8');
    // fsync to ensure snapshot survives a crash immediately after write
    const fd = fs.openSync(snapshotPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* ignore write errors */ }
}

/**
 * Get a snapshot of the agent's terminal.
 * Prefers a live capture from tmux; falls back to a saved snapshot on disk.
 *
 * @param agentId - The agent ID
 * @param tmuxAlive - Whether the tmux session is currently alive (caller provides this
 *   to avoid a circular dependency on PtyManager.isTmuxSessionAlive)
 */
export function getSnapshot(agentId: string, tmuxAlive: boolean): string | null {
  // Prefer live capture from tmux if the session is still running
  if (tmuxAlive) {
    const live = captureTmuxSnapshot(agentId);
    if (live) return live;
  }
  // Fall back to saved snapshot file on disk
  try {
    return fs.readFileSync(getSnapshotPath(agentId), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Clear previous session log files (used before spawning a fresh session)
// ---------------------------------------------------------------------------

export function clearAgentLogFiles(agentId: string): void {
  closePtyLogFd(agentId); // close any lingering FD from a previous session
  fs.mkdirSync(PTY_LOG_DIR, { recursive: true });
  try { fs.unlinkSync(getPtyLogPath(agentId)); } catch { /* no previous log */ }
  try { fs.unlinkSync(getNdjsonPath(agentId)); } catch { /* no previous ndjson */ }
  try { fs.unlinkSync(getSnapshotPath(agentId)); } catch { /* no previous snapshot */ }
  try { fs.unlinkSync(getPtyStderrPath(agentId)); } catch { /* no previous stderr */ }
}
