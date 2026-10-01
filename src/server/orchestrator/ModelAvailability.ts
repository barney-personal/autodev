import * as queries from '../db/queries.js';

const PREFIX = 'model-unavailable:';
const RETEST_AFTER_MS = 24 * 60 * 60 * 1000;
export interface ModelUnavailable { model: string; reason: string; checkedAt: number; expiresAt: number }

export function isModelAccessError(message: string | null | undefined): boolean {
  return !!message && /\bmodel\s+(?:['"`][a-z0-9._-]+['"`]\s+)?(?:is not supported|is not available|does not exist)\b|\bunsupported model\s*[:=]|\bdo not have access to (?:the |this )?model\b/i.test(message);
}
/** A rejected startup may be retried; a run that emitted work may not. */
export function hasAgentWorkStarted(event: { type?: string; item?: { type?: string } }): boolean {
  return event.type === 'assistant' ||
    ((event.type === 'item.started' || event.type === 'item.completed') && event.item?.type !== 'error');
}
export function markModelUnavailable(model: string, reason: string): void {
  const checkedAt = Date.now();
  queries.upsertNote(PREFIX + model, JSON.stringify({ model, reason: reason.slice(0, 500), checkedAt, expiresAt: checkedAt + RETEST_AFTER_MS }), null);
}
export function getModelUnavailability(model: string): ModelUnavailable | null {
  try {
    const note = queries.getNote(PREFIX + model);
    const value = note ? JSON.parse(note.value) as ModelUnavailable : null;
    return value && value.expiresAt > Date.now() ? value : null;
  } catch { return null; }
}
export function clearModelUnavailability(model: string): void {
  queries.upsertNote(PREFIX + model, '{}', null);
}
