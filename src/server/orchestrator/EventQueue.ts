/**
 * EventQueue — disk-backed ring buffer for Socket.io events.
 *
 * When the UI disconnects and reconnects, events emitted during the gap are lost.
 * This module keeps a bounded ring buffer (in-memory, persisted to SQLite) so
 * the UI can replay missed events on reconnect.
 *
 * Events older than MAX_AGE_MS or beyond MAX_EVENTS are discarded.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDb, isDbInitialized } from '../db/database.js';

const MAX_EVENTS = 5000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Amortize pruning across many pushEvent calls. Every socket emit (job/agent/
// workflow updates, lock acquire/release, etc.) funnels through pushEvent, so
// pruning on every call ran an INSERT + range-scan DELETE + full-table
// COUNT(*) per event — under moderate load that saturated the event loop
// and blocked WAL checkpointing. Instead, prune at most every
// PRUNE_EVERY_N inserts or every PRUNE_INTERVAL_MS, whichever comes first.
const PRUNE_EVERY_N = 100;
const PRUNE_INTERVAL_MS = 30_000;

// Track which DB instance we initialized the table for, so that test
// isolation (which swaps in-memory DBs) correctly re-creates the table and
// rebuilds the prepared-statement cache below.
let _initializedDb: unknown = null;

// Prepared-statement cache. node:sqlite db.prepare() parses SQL and allocates
// a statement object on every call — caching removes that cost from the hot
// path, since every socket emit goes through pushEvent.
type Stmts = {
  insert: ReturnType<DatabaseSync['prepare']>;
  deleteByAge: ReturnType<DatabaseSync['prepare']>;
  trimToMax: ReturnType<DatabaseSync['prepare']>;
  selectSince: ReturnType<DatabaseSync['prepare']>;
};
let _stmts: Stmts | null = null;

let _insertsSincePrune = 0;
let _lastPruneAt = 0;

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
  _stmts = {
    insert: db.prepare(
      'INSERT INTO event_queue (event_name, payload, created_at) VALUES (?, ?, ?)'
    ),
    deleteByAge: db.prepare('DELETE FROM event_queue WHERE created_at < ?'),
    // Bounded trim: delete rows whose id ≤ the id at OFFSET MAX_EVENTS from
    // the newest end. Uses the PK index via a single seek — no COUNT(*), no
    // full-table scan. If fewer than MAX_EVENTS rows exist, the inner SELECT
    // yields no row and the DELETE is a no-op.
    trimToMax: db.prepare(
      'DELETE FROM event_queue WHERE id <= (SELECT id FROM event_queue ORDER BY id DESC LIMIT 1 OFFSET ?)'
    ),
    selectSince: db.prepare(
      'SELECT event_name, payload, created_at FROM event_queue WHERE created_at > ? ORDER BY id ASC LIMIT ?'
    ),
  };
  _insertsSincePrune = 0;
  _lastPruneAt = 0;
}

function runPrune(now: number): void {
  if (!_stmts) return;
  _stmts.deleteByAge.run(now - MAX_AGE_MS);
  _stmts.trimToMax.run(MAX_EVENTS);
  _insertsSincePrune = 0;
  _lastPruneAt = now;
}

/**
 * Push an event into the queue. Called from SocketManager emit wrappers.
 */
export function pushEvent(eventName: string, payload: unknown): void {
  if (!isDbInitialized()) return;
  try {
    ensureTable();
    if (!_stmts) return;
    const now = Date.now();

    _stmts.insert.run(eventName, JSON.stringify(payload), now);

    _insertsSincePrune++;
    if (_insertsSincePrune >= PRUNE_EVERY_N || now - _lastPruneAt >= PRUNE_INTERVAL_MS) {
      runPrune(now);
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
export function getEventsSince(sinceMs: number): Array<{ event_name: string; payload: unknown; created_at: number }> {
  if (!isDbInitialized()) return [];
  try {
    ensureTable();
    if (!_stmts) return [];
    const rows = _stmts.selectSince.all(sinceMs, MAX_EVENTS) as Array<{ event_name: string; payload: string; created_at: number }>;

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
 * Clear old events. Called during shutdown or periodic cleanup. Unlike the
 * amortized prune inside pushEvent, this always runs immediately.
 */
export function pruneEvents(): void {
  if (!isDbInitialized()) return;
  try {
    ensureTable();
    if (!_stmts) return;
    runPrune(Date.now());
  } catch (err) {
    // Don't throw during cleanup
    console.warn('[EventQueue] pruneEvents failed:', err);
  }
}
