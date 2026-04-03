import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from './helpers.js';

describe('ResilienceLogger', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('logResilienceEvent inserts a row that listResilienceEvents returns', async () => {
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    const { listResilienceEvents } = await import('../server/db/queries.js');

    logResilienceEvent('workflow_reconciled', 'workflow', 'wf-123', { phase: 'implement', cycle: 2 });

    const events = listResilienceEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('workflow_reconciled');
    expect(events[0].entity_type).toBe('workflow');
    expect(events[0].entity_id).toBe('wf-123');
    expect(JSON.parse(events[0].details!)).toEqual({ phase: 'implement', cycle: 2 });
  });

  it('listResilienceEvents filters by type', async () => {
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    const { listResilienceEvents } = await import('../server/db/queries.js');

    logResilienceEvent('deadlock_resolved', 'lock', 'lock-1');
    logResilienceEvent('agent_recovered', 'agent', 'agent-1');
    logResilienceEvent('deadlock_resolved', 'lock', 'lock-2');

    const deadlocks = listResilienceEvents({ type: 'deadlock_resolved' });
    expect(deadlocks).toHaveLength(2);
    expect(deadlocks.every(e => e.event_type === 'deadlock_resolved')).toBe(true);

    const recoveries = listResilienceEvents({ type: 'agent_recovered' });
    expect(recoveries).toHaveLength(1);
  });

  it('listResilienceEvents respects limit', async () => {
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    const { listResilienceEvents } = await import('../server/db/queries.js');

    for (let i = 0; i < 5; i++) {
      logResilienceEvent('test_event', 'test', `id-${i}`);
    }

    const limited = listResilienceEvents({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('logResilienceEvent handles string details', async () => {
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    const { listResilienceEvents } = await import('../server/db/queries.js');

    logResilienceEvent('simple_event', 'agent', 'a-1', 'some plain text detail');

    const events = listResilienceEvents();
    expect(events[0].details).toBe('some plain text detail');
  });

  it('logResilienceEvent handles null/undefined details', async () => {
    const { logResilienceEvent } = await import('../server/orchestrator/ResilienceLogger.js');
    const { listResilienceEvents } = await import('../server/db/queries.js');

    logResilienceEvent('no_details', 'agent', 'a-2');
    logResilienceEvent('null_details', 'agent', 'a-3', null);

    const events = listResilienceEvents();
    expect(events).toHaveLength(2);
    expect(events[0].details).toBeNull();
    expect(events[1].details).toBeNull();
  });
});
