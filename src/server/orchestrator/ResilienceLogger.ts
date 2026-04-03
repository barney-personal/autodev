import { randomUUID } from 'crypto';
import { insertResilienceEvent } from '../db/queries.js';

/**
 * Log a resilience event (recovery, deadlock resolution, repair, rate-limit fallback, etc.)
 * to the resilience_events table for observability.
 */
export function logResilienceEvent(
  eventType: string,
  entityType: string,
  entityId: string,
  details?: Record<string, unknown> | string | null,
): void {
  try {
    insertResilienceEvent({
      id: randomUUID(),
      event_type: eventType,
      entity_type: entityType,
      entity_id: entityId,
      details: details != null
        ? (typeof details === 'string' ? details : JSON.stringify(details))
        : null,
      created_at: Date.now(),
    });
  } catch (err) {
    // Best-effort — never let logging break the caller
    console.error(`[resilience] failed to log event ${eventType}:`, err);
  }
}
