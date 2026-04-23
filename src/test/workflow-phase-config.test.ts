/**
 * Tests for WorkflowPhaseConfig — phase lookup table that replaces duplicated
 * switch statements in spawnPhaseJob and resumeWorkflow.
 */
import { describe, it, expect } from 'vitest';
import { getPhaseConfig, type WorkflowPhase } from '../server/orchestrator/WorkflowPhaseConfig.js';

describe('getPhaseConfig', () => {
  it('returns config for all 4 phases', () => {
    for (const phase of ['assess', 'implement', 'review', 'verify'] as WorkflowPhase[]) {
      const config = getPhaseConfig(phase);
      expect(config).toBeDefined();
      expect(typeof config.buildPrompt).toBe('function');
    }
  });

  it('throws for unknown phase', () => {
    expect(() => getPhaseConfig('nonexistent' as any)).toThrow(/unknown/i);
  });

  it('verify phase has model override', () => {
    const config = getPhaseConfig('verify');
    expect(config.overrides?.model).toBe('claude-opus-4-7');
  });

  it('verify phase has stop mode overrides', () => {
    const config = getPhaseConfig('verify');
    expect(config.overrides?.stopMode).toBe('turns');
    expect(config.overrides?.stopValue).toBe(40);
  });

  it('assess uses implementer_model as modelKey', () => {
    const config = getPhaseConfig('assess');
    expect(config.modelKey).toBe('implementer_model');
    expect(config.stopModeKey).toBe('stop_mode_assess');
    expect(config.stopValueKey).toBe('stop_value_assess');
  });

  it('review uses reviewer_model as modelKey', () => {
    const config = getPhaseConfig('review');
    expect(config.modelKey).toBe('reviewer_model');
    expect(config.stopModeKey).toBe('stop_mode_review');
    expect(config.stopValueKey).toBe('stop_value_review');
  });

  it('implement uses implementer_model as modelKey', () => {
    const config = getPhaseConfig('implement');
    expect(config.modelKey).toBe('implementer_model');
    expect(config.stopModeKey).toBe('stop_mode_implement');
    expect(config.stopValueKey).toBe('stop_value_implement');
  });
});
