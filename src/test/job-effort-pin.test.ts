/**
 * Regression tests for the classifier-pinned `jobs.effort` column surviving
 * job-clone paths (PR #41 review finding): retry and repeat clones used to
 * drop the pin because insertJob didn't accept `effort`, so a medium Fable
 * job would silently escalate to the one-shot default `xhigh` on retry.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { cleanupTestDb, setupTestDb } from './helpers.js';

describe('job effort pin survives clone paths', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  async function insertPinnedJob() {
    const queries = await import('../server/db/queries.js');
    return queries.insertJob({
      id: randomUUID(),
      title: 'Pinned job',
      description: 'Do something medium-complex',
      context: null,
      priority: 0,
      model: 'claude-fable-5[1m]',
      effort: 'medium',
      retry_policy: 'same',
      max_retries: 2,
      repeat_interval_ms: 60_000,
    });
  }

  it('insertJob persists effort and getJobById round-trips it', async () => {
    const queries = await import('../server/db/queries.js');
    const job = await insertPinnedJob();
    expect(queries.getJobById(job.id)!.effort).toBe('medium');
  });

  it('scheduleRepeatJob carries the pin onto the repeated job', async () => {
    const queries = await import('../server/db/queries.js');
    const job = await insertPinnedJob();
    const repeated = queries.scheduleRepeatJob(job);
    expect(repeated.id).not.toBe(job.id);
    expect(repeated.effort).toBe('medium');
    expect(repeated.model).toBe('claude-fable-5[1m]');
  });

  it('retry-policy "same" clones keep the pin', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleRetry } = await import('../server/orchestrator/RetryManager.js');
    const job = await insertPinnedJob();
    queries.updateJobStatus(job.id, 'assigned');
    queries.updateJobStatus(job.id, 'running');
    queries.updateJobStatus(job.id, 'failed');

    const retried = handleRetry(queries.getJobById(job.id)!, randomUUID());
    expect(retried).toBe(true);

    const clone = queries
      .listJobs()
      .find(j => j.id !== job.id && j.original_job_id === job.id);
    expect(clone).toBeDefined();
    expect(clone!.effort).toBe('medium');
    expect(clone!.model).toBe('claude-fable-5[1m]');
  });

  it('jobs without a pin stay unpinned through the same paths', async () => {
    const queries = await import('../server/db/queries.js');
    const job = queries.insertJob({
      id: randomUUID(),
      title: 'Unpinned job',
      description: 'Plain job',
      context: null,
      priority: 0,
      model: 'claude-fable-5[1m]',
      repeat_interval_ms: 60_000,
    });
    expect(queries.getJobById(job.id)!.effort).toBeNull();
    expect(queries.scheduleRepeatJob(job).effort).toBeNull();
  });
});
