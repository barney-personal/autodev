import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from './helpers.js';

describe('RecoveryLedger', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('prevents duplicate claims while the family lock is active', async () => {
    const { insertJob } = await import('../server/db/queries.js');
    const { claimRecovery } = await import('../server/orchestrator/RecoveryLedger.js');

    const job = insertJob({
      id: 'job-a',
      title: 'A',
      description: 'desc',
      context: null,
      priority: 0,
      status: 'failed',
      original_job_id: 'family-a',
    });

    expect(claimRecovery(job, 'watchdog', { lockMs: 60_000 })).toBe(true);
    expect(claimRecovery(job, 'runner', { lockMs: 60_000 })).toBe(false);
  });

  it('clears state on success and allows future claims', async () => {
    const { insertJob } = await import('../server/db/queries.js');
    const { claimRecovery, clearRecoveryState } = await import('../server/orchestrator/RecoveryLedger.js');

    const job = insertJob({
      id: 'job-b',
      title: 'B',
      description: 'desc',
      context: null,
      priority: 0,
      status: 'failed',
      original_job_id: 'family-b',
    });

    expect(claimRecovery(job, 'watchdog', { lockMs: 60_000 })).toBe(true);
    clearRecoveryState(job);
    expect(claimRecovery(job, 'runner', { lockMs: 60_000 })).toBe(true);
  });
});
