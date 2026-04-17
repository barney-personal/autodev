import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../server/orchestrator/CircuitBreaker.js';
import { KNOWN_MODELS } from '../server/orchestrator/ModelClassifier.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(KNOWN_MODELS);
  });

  it('starts in closed (healthy) state', () => {
    expect(breaker.isOpen()).toBe(false);
  });

  it('opens when all known models are rate-limited', () => {
    breaker.recordModelLimited('claude-opus-4-7');
    breaker.recordModelLimited('claude-opus-4-7[1m]');
    breaker.recordModelLimited('claude-opus-4-6');
    breaker.recordModelLimited('claude-opus-4-6[1m]');
    breaker.recordModelLimited('claude-sonnet-4-6');
    breaker.recordModelLimited('claude-sonnet-4-6[1m]');
    breaker.recordModelLimited('claude-haiku-4-5-20251001');
    breaker.recordModelLimited('codex');
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.reason()).toContain('all models rate-limited');
  });

  it('closes when a model becomes available', () => {
    breaker.recordModelLimited('claude-opus-4-7');
    breaker.recordModelLimited('claude-opus-4-7[1m]');
    breaker.recordModelLimited('claude-opus-4-6');
    breaker.recordModelLimited('claude-opus-4-6[1m]');
    breaker.recordModelLimited('claude-sonnet-4-6');
    breaker.recordModelLimited('claude-sonnet-4-6[1m]');
    breaker.recordModelLimited('claude-haiku-4-5-20251001');
    breaker.recordModelLimited('codex');
    expect(breaker.isOpen()).toBe(true);

    breaker.recordModelAvailable('claude-sonnet-4-6');
    expect(breaker.isOpen()).toBe(false);
  });

  it('opens on repeated infrastructure failures', () => {
    for (let i = 0; i < 5; i++) {
      breaker.recordInfraFailure();
    }
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.reason()).toContain('infrastructure');
  });

  it('resets infra failure count on success', () => {
    for (let i = 0; i < 4; i++) breaker.recordInfraFailure();
    breaker.recordSuccess();
    expect(breaker.consecutiveInfraFailures()).toBe(0);
    expect(breaker.isOpen()).toBe(false);
  });

  it('does not open with only some models limited', () => {
    breaker.recordModelLimited('claude-opus-4-6');
    breaker.recordModelLimited('claude-sonnet-4-6');
    expect(breaker.isOpen()).toBe(false);
  });

  it('reports reason as circuit closed when healthy', () => {
    expect(breaker.reason()).toBe('circuit closed');
  });
});
