/**
 * Tests for M8 — backfillReleaseStaleClaims().
 *
 * Brief Goal D.2: at server boot, release any workflow_file_claims rows whose
 * workflow is already in a terminal status (complete/cancelled/failed). The
 * operation must be idempotent — a second run releases 0 rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb, insertTestProject, insertTestWorkflow } from './helpers.js';

describe('backfillReleaseStaleClaims (M8)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('releases active claims belonging to terminal workflows and leaves running ones alone', async () => {
    const { claimFiles, getActiveClaimsForWorkflow } = await import('../server/db/queries.js');
    const { backfillReleaseStaleClaims } = await import('../server/orchestrator/StartupMaintenance.js');

    const project = await insertTestProject();
    const completeWf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    const cancelledWf = await insertTestWorkflow({ project_id: project.id, status: 'cancelled' });
    const failedWf = await insertTestWorkflow({ project_id: project.id, status: 'failed' });
    const runningWf = await insertTestWorkflow({ project_id: project.id, status: 'running' });

    claimFiles(completeWf.id, ['a.py', 'b.py']);
    claimFiles(cancelledWf.id, ['c.py']);
    claimFiles(failedWf.id, ['d.py']);
    claimFiles(runningWf.id, ['e.py']);

    const released = backfillReleaseStaleClaims();
    expect(released).toBe(4);

    expect(getActiveClaimsForWorkflow(completeWf.id)).toHaveLength(0);
    expect(getActiveClaimsForWorkflow(cancelledWf.id)).toHaveLength(0);
    expect(getActiveClaimsForWorkflow(failedWf.id)).toHaveLength(0);
    // running workflow's claim must remain intact
    expect(getActiveClaimsForWorkflow(runningWf.id)).toHaveLength(1);
  });

  it('is idempotent — a second run releases 0 rows', async () => {
    const { claimFiles } = await import('../server/db/queries.js');
    const { backfillReleaseStaleClaims } = await import('../server/orchestrator/StartupMaintenance.js');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id, status: 'complete' });
    claimFiles(wf.id, ['foo.py']);

    expect(backfillReleaseStaleClaims()).toBe(1);
    expect(backfillReleaseStaleClaims()).toBe(0);
  });

  it('no-op when there are no claims', async () => {
    const { backfillReleaseStaleClaims } = await import('../server/orchestrator/StartupMaintenance.js');
    expect(backfillReleaseStaleClaims()).toBe(0);
  });
});
