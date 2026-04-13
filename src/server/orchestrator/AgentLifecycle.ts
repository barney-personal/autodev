export enum AgentState {
  Spawning = 'spawning',
  Attaching = 'attaching',
  Running = 'running',
  Polling = 'polling',
  Exiting = 'exiting',
  Done = 'done',
  Failed = 'failed',
}

const TERMINAL_STATES = new Set([AgentState.Done, AgentState.Failed]);

const VALID_TRANSITIONS: Record<AgentState, Set<AgentState>> = {
  [AgentState.Spawning]:  new Set([AgentState.Attaching, AgentState.Failed]),
  [AgentState.Attaching]: new Set([AgentState.Running, AgentState.Polling, AgentState.Failed]),
  [AgentState.Running]:   new Set([AgentState.Exiting, AgentState.Failed]),
  [AgentState.Polling]:   new Set([AgentState.Exiting, AgentState.Failed]),
  [AgentState.Exiting]:   new Set([AgentState.Done, AgentState.Failed]),
  [AgentState.Done]:      new Set(),
  [AgentState.Failed]:    new Set(),
};

export class AgentStateManager {
  private _states = new Map<string, AgentState>();

  getState(agentId: string): AgentState | undefined {
    return this._states.get(agentId);
  }

  transition(agentId: string, to: AgentState): void {
    const from = this._states.get(agentId);

    if (from === undefined) {
      if (to !== AgentState.Spawning) {
        throw new Error(`Invalid transition: new agent must start at Spawning, got ${to}`);
      }
      this._states.set(agentId, to);
      return;
    }

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.has(to)) {
      throw new Error(`Invalid transition for agent ${agentId}: ${from} → ${to}`);
    }

    if (TERMINAL_STATES.has(to)) {
      this._states.delete(agentId);
    } else {
      this._states.set(agentId, to);
    }
  }

  activeCount(): number {
    return this._states.size;
  }

  countInState(state: AgentState): number {
    let count = 0;
    for (const s of this._states.values()) {
      if (s === state) count++;
    }
    return count;
  }

  remove(agentId: string): void {
    this._states.delete(agentId);
  }

  clear(): void {
    this._states.clear();
  }
}
