/**
 * DbBackup — periodic SQLite database backup.
 *
 * Creates timestamped copies of the database file at regular intervals.
 * Keeps the last N backups and deletes older ones to prevent disk bloat.
 * Uses VACUUM INTO which is safe to run concurrently with read/write operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Sentry } from '../instrument.js';
import { getDb } from '../db/database.js';

const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const MAX_BACKUPS = 5;

let _timer: NodeJS.Timeout | null = null;
let _dbPath: string | null = null;

export function startDbBackup(dbPath: string): void {
  if (_timer) return;
  _dbPath = dbPath;

  // Don't backup in-memory databases
  if (dbPath === ':memory:') return;

  console.log('[db-backup] started (interval: 30min)');
  _timer = setInterval(() => {
    try { runBackup(); } catch (err) {
      console.error('[db-backup] error:', err);
      Sentry.captureException(err);
    }
  }, BACKUP_INTERVAL_MS);
  _timer.unref();
}

export function stopDbBackup(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function runBackup(): void {
  if (!_dbPath || _dbPath === ':memory:') return;

  const backupDir = path.join(path.dirname(_dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `orchestrator-${timestamp}.db`);

  try {
    const db = getDb();
    // VACUUM INTO creates a consistent snapshot — safe even during writes
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`[db-backup] created backup: ${backupPath}`);
  } catch (err) {
    console.error('[db-backup] VACUUM INTO failed:', err);
    return;
  }

  // Prune old backups beyond MAX_BACKUPS
  try {
    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('orchestrator-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (backups.length > MAX_BACKUPS) {
      for (const old of backups.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(path.join(backupDir, old));
          console.log(`[db-backup] pruned old backup: ${old}`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore pruning errors */ }
}

/** Run a backup immediately (for shutdown or manual trigger) */
export function runBackupNow(): void {
  try { runBackup(); } catch (err) {
    console.error('[db-backup] manual backup error:', err);
  }
}
