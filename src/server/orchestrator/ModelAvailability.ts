import * as queries from '../db/queries.js';

const PREFIX = 'model-unavailable:';
const RETEST_AFTER_MS = 24 * 60 * 60 * 1000;
export interface ModelUnavailable { model: string; reason: string; checkedAt: number; expiresAt: number }

export function isModelAccessError(message: string | null | undefined): boolean {
  return !!message && /model.{0,120}(?:is not supported|not available|does not exist|not found)|unsupported model|do not have access to (?:the |this )?model/i.test(message);
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
