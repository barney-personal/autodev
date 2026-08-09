/**
 * Tests for instrument.ts's beforeSend allowlist.
 *
 * captureConsoleIntegration promotes every console.warn/error to a Sentry
 * issue, so the allowlist is the only thing standing between operational log
 * lines and the issue stream. Two gaps closed here:
 *
 *   - 7502098535: the assess-repair diagnostic suppressor matched only the
 *     `never_called` variant, so `called_but_failed` / `called_ok` still
 *     opened one issue per workflow id.
 *   - 7552581624: Node's warning writer uses console.error, so the DEP0205
 *     notice emitted by the ESM loader hooks @sentry/node and tsx register
 *     became a priority=high issue on every boot.
 *
 * Each suppressor is permanent blindness, so the "still reported" cases below
 * matter as much as the dropped ones.
 */
import { describe, it, expect } from 'vitest';
import { filterSentryEvent } from '../server/instrument.js';

function ev(message: string) {
  return { message } as never;
}

describe('filterSentryEvent — assess repair diagnostics', () => {
  it('drops every diagnostic status, not just never_called', () => {
    for (const status of ['never_called', 'called_but_failed', 'called_ok']) {
      expect(filterSentryEvent(ev(`[workflow 8f2b] assess missing plan: ${status}`))).toBeNull();
      expect(filterSentryEvent(ev(`[workflow 8f2b] assess missing contract: ${status}`))).toBeNull();
    }
    expect(filterSentryEvent(ev(
      '[workflow 8f2b] assess missing plan, contract: called_but_failed — write_note rejected: unknown tool',
    ))).toBeNull();
  });

  it('still reports the permanent failure that follows a spent repair ladder', () => {
    // The blocked transition is the real signal and must stay visible.
    const blocked = ev('[workflow 8f2b] Assess phase completed but missing plan — marking blocked');
    expect(filterSentryEvent(blocked)).toBe(blocked);
  });

  it('does not swallow unrelated assess-phase errors', () => {
    const other = ev('[workflow 8f2b] error in assess handler (cycle 2): TypeError');
    expect(filterSentryEvent(other)).toBe(other);
  });
});

describe('filterSentryEvent — Node process warnings', () => {
  it('drops the DEP0205 module.register() notice from the ESM loader hooks', () => {
    expect(filterSentryEvent(ev(
      '(node:47122) [DEP0205] DeprecationWarning: module.register() is deprecated. '
      + 'Use module.registerHooks() instead.',
    ))).toBeNull();
  });

  it('drops other process warnings emitted by the Node warning writer', () => {
    expect(filterSentryEvent(ev('(node:47122) MaxListenersExceededWarning: Possible EventEmitter memory leak'))).toBeNull();
    expect(filterSentryEvent(ev('(node:9) ExperimentalWarning: SQLite is an experimental feature'))).toBeNull();
  });

  it('keeps deprecation-shaped text that did not come from the warning writer', () => {
    // The `(node:1234)` test is pinned to the writer's own prefix so agent or
    // orchestrator output that merely talks about deprecation stays visible.
    const appMsg = ev('[workflow 8f2b] agent reports the deprecated API path is still in use');
    expect(filterSentryEvent(appMsg)).toBe(appMsg);
    const nodeish = ev('job output mentioned node:internal but is a real failure');
    expect(filterSentryEvent(nodeish)).toBe(nodeish);
  });
});

describe('filterSentryEvent — existing suppressors and pass-through', () => {
  it('keeps dropping the pre-existing operational lines', () => {
    expect(filterSentryEvent(ev('[mcp] session closed'))).toBeNull();
    expect(filterSentryEvent(ev('[resource] WARNING: orchestrator RSS 1.2GB'))).toBeNull();
    expect(filterSentryEvent(ev('Error: 529 overloaded_error'))).toBeNull();
  });

  it('passes real errors through untouched', () => {
    const real = ev('WorkflowBlocked: implement_spawn_error');
    expect(filterSentryEvent(real)).toBe(real);
    const exceptionEvent = {
      exception: { values: [{ value: "fatal: 'origin' does not appear to be a git repository" }] },
    } as never;
    expect(filterSentryEvent(exceptionEvent)).toBe(exceptionEvent);
  });

  it('tolerates an event with neither message nor exception', () => {
    const bare = {} as never;
    expect(filterSentryEvent(bare)).toBe(bare);
  });
});
