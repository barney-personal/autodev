/**
 * EventQueue — disk-backed ring buffer for Socket.io events.
 *
 * When the UI disconnects and reconnects, events emitted during the gap are lost.
 * This module keeps a bounded ring buffer (in-memory, persisted to SQLite) so
 * the UI can replay missed events on reconnect.
 *
 * Events older than MAX_AGE_MS or beyond MAX_EVENTS are discarded.
 */

import { getDb, isDbInitialized } from '../db/database.js';

const MAX_EVENTS = 5000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Track which DB instance we initialized the table for, so that test
// isolation (which swaps in-memory DBs) correctly re-creates the table.
let _initializedDb: any = null;

function ensureTable(): void {
  if (!isDbInitialized()) return;
  const db = getDb();
  if (_initializedDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_queue_created ON event_queue(created_at)');
  _initializedDb = db;
}

/**
 * Push an event into the queue. Called from SocketManager emit wrappers.
 */
export function pushEvent(eventName: string, payload: any): void {
  if (!isDbInitialized()) return;
  try {
    ensureTable();
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO event_queue (event_name, payload, created_at) VALUES (?, ?, ?)'
    ).run(eventName, JSON.stringify(payload), now);

    // Prune: delete events beyond max count or max age
    const cutoffTime = now - MAX_AGE_MS;
    db.prepare('DELETE FROM event_queue WHERE created_at < ?').run(cutoffTime);

    // If still over limit, keep only the newest MAX_EVENTS
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM event_queue').get() as { cnt: number }).cnt;
    if (count > MAX_EVENTS) {
      const excess = count - MAX_EVENTS;
      db.prepare(
        'DELETE FROM event_queue WHERE id IN (SELECT id FROM event_queue ORDER BY id ASC LIMIT ?)'
      ).run(excess);
    }
  } catch (err) {
    // Don't let event queue errors break the main flow
    console.warn('[EventQueue] pushEvent failed (event dropped):', err);
  }
}

/**
 * Get all events since a given timestamp. Used by the UI on reconnect
 * to replay missed events.
 */
export function getEventsSince(sinceMs: number): Array<{ event_name: string; payload: any; created_at: number }> {
  if (!isDbInitialized()) return [];
  try {
    ensureTable();
    const db = getDb();
    const rows = db.prepare(
      'SELECT event_name, payload, created_at FROM event_queue WHERE created_at > ? ORDER BY id ASC LIMIT ?'
    ).all(sinceMs, MAX_EVENTS) as Array<{ event_name: string; payload: string; created_at: number }>;

    return rows.map(r => ({
      event_name: r.event_name,
      payload: JSON.parse(r.payload),
      created_at: r.created_at,
    }));
  } catch (err) {
    console.debug('[EventQueue] getEventsSince failed, returning empty:', err);
    return [];
  }
}

/**
 * Clear old events. Called during shutdown or periodic cleanup.
 */
export function pruneEvents(): void {
  if (!isDbInitialized()) return;
  try {
    ensureTable();
    const db = getDb();
    const cutoff = Date.now() - MAX_AGE_MS;
    db.prepare('DELETE FROM event_queue WHERE created_at < ?').run(cutoff);
  } catch (err) {
    // Don't throw during cleanup
    console.warn('[EventQueue] pruneEvents failed:', err);
  }
}
