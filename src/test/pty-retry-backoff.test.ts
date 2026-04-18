/**
 * Unit tests for `computePtyRetryDelayMs` — the jittered backoff used when
 * `posix_spawnp` fails and we retry attaching a PTY.
 *
 * Regression: Sentry issue 7382278958 recorded 2831 PTY-spawn failures and
 * 2222 paired retry-log events over ~2 weeks. Breadcrumbs show they
 * clustered in bursts, which matched the pattern of the watchdog restarting
 * several agents simultaneously: every agent retried at exactly 2s/4s/8s,
 * repeatedly re-pressuring the OS process table at the same moment.
 */

import { describe, it, expect } from 'vitest';
import {
  computePtyRetryDelayMs,
  PTY_SPAWN_BASE_DELAY_MS,
  PTY_SPAWN_MAX_RETRIES,
} from '../server/orchestrator/PtySessionManager.js';

describe('computePtyRetryDelayMs', () => {
  it('returns a value within ±25% of the unjittered exponential delay', () => {
    for (let attempt = 1; attempt <= PTY_SPAWN_MAX_RETRIES; attempt++) {
      const base = PTY_SPAWN_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      for (const rand of [0, 0.25, 0.5, 0.75, 0.9999]) {
        const delay = computePtyRetryDelayMs(attempt, PTY_SPAWN_BASE_DELAY_MS, () => rand);
        expect(delay).toBeGreaterThanOrEqual(Math.round(base * 0.75));
        expect(delay).toBeLessThanOrEqual(Math.round(base * 1.25));
      }
    }
  });

  it('keeps exponential progression across attempts (attempt 2 > attempt 1 worst-case)', () => {
    // Even with minimum jitter on attempt 2 and maximum jitter on attempt 1,
    // attempt 2's floor (0.75 * 4s = 3s) must still exceed attempt 1's ceiling
    // (1.25 * 2s = 2.5s). Otherwise the ladder loses its shape.
    const a1Ceiling = computePtyRetryDelayMs(1, PTY_SPAWN_BASE_DELAY_MS, () => 0.9999);
    const a2Floor = computePtyRetryDelayMs(2, PTY_SPAWN_BASE_DELAY_MS, () => 0);
    expect(a2Floor).toBeGreaterThan(a1Ceiling);
  });

  it('de-correlates concurrent retries (many callers, same attempt, spread across window)', () => {
    // Simulate 100 agents all hitting the same retry number at the same moment.
    // Without jitter, all 100 would land on the same millisecond. With ±25%
    // jitter, we expect the set of observed delays to be spread across the
    // window — at least 20 distinct values out of 100 samples is a generous
    // lower bound that only fails if jitter is degenerate.
    const delays = new Set<number>();
    let seed = 0;
    const prng = () => {
      // Simple LCG — reproducible across platforms, unlike Math.random.
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < 100; i++) {
      delays.add(computePtyRetryDelayMs(2, PTY_SPAWN_BASE_DELAY_MS, prng));
    }
    expect(delays.size).toBeGreaterThan(20);
  });

  it('defaults to Math.random when no rng is supplied', () => {
    // Two back-to-back calls almost never produce the same value with
    // Math.random. (Collision probability ~1/1000 for attempt=1's window,
    // so this test is effectively deterministic.)
    const a = computePtyRetryDelayMs(1);
    const b = computePtyRetryDelayMs(1);
    expect(Math.abs(a - b)).toBeGreaterThan(0);
  });
});
