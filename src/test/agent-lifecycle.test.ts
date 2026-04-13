import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStateManager, AgentState } from '../server/orchestrator/AgentLifecycle.js';

describe('AgentStateManager', () => {
  let manager: AgentStateManager;

  beforeEach(() => {
    manager = new AgentStateManager();
  });

  it('tracks agent through normal lifecycle', () => {
    manager.transition('agent-1', AgentState.Spawning);
    expect(manager.getState('agent-1')).toBe(AgentState.Spawning);
    manager.transition('agent-1', AgentState.Attaching);
    expect(manager.getState('agent-1')).toBe(AgentState.Attaching);
    manager.transition('agent-1', AgentState.Running);
    expect(manager.getState('agent-1')).toBe(AgentState.Running);
    manager.transition('agent-1', AgentState.Exiting);
    expect(manager.getState('agent-1')).toBe(AgentState.Exiting);
    manager.transition('agent-1', AgentState.Done);
    expect(manager.getState('agent-1')).toBeUndefined();
  });

  it('rejects invalid transitions', () => {
    manager.transition('agent-1', AgentState.Spawning);
    expect(() => manager.transition('agent-1', AgentState.Done)).toThrow(/invalid transition/i);
  });

  it('returns undefined for unknown agents', () => {
    expect(manager.getState('nonexistent')).toBeUndefined();
  });

  it('counts active agents (non-terminal)', () => {
    manager.transition('a1', AgentState.Spawning);
    manager.transition('a2', AgentState.Spawning);
    manager.transition('a2', AgentState.Attaching);
    manager.transition('a2', AgentState.Running);
    manager.transition('a3', AgentState.Spawning);
    expect(manager.activeCount()).toBe(3);
  });

  it('counts agents in specific states', () => {
    manager.transition('a1', AgentState.Spawning);
    manager.transition('a2', AgentState.Spawning);
    manager.transition('a2', AgentState.Attaching);
    manager.transition('a2', AgentState.Running);
    manager.transition('a3', AgentState.Spawning);
    expect(manager.countInState(AgentState.Spawning)).toBe(2);
    expect(manager.countInState(AgentState.Running)).toBe(1);
  });

  it('allows Spawning → Failed for resource exhaustion', () => {
    manager.transition('agent-1', AgentState.Spawning);
    manager.transition('agent-1', AgentState.Failed);
    expect(manager.getState('agent-1')).toBeUndefined();
  });

  it('allows Attaching → Polling for standalone print jobs', () => {
    manager.transition('agent-1', AgentState.Spawning);
    manager.transition('agent-1', AgentState.Attaching);
    manager.transition('agent-1', AgentState.Polling);
    expect(manager.getState('agent-1')).toBe(AgentState.Polling);
  });

  it('allows remove to force-clean an agent', () => {
    manager.transition('agent-1', AgentState.Spawning);
    manager.remove('agent-1');
    expect(manager.getState('agent-1')).toBeUndefined();
    expect(manager.activeCount()).toBe(0);
  });

  it('rejects new agent not starting at Spawning', () => {
    expect(() => manager.transition('agent-1', AgentState.Running)).toThrow(/must start at Spawning/i);
  });
});
