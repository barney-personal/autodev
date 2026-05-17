/**
 * Tests for M13/6B — Shared in-progress manifest (workflow_file_claims).
 *
 * Verifies:
 * 1. claimFiles creates claims and detects conflicts
 * 2. releaseWorkflowClaims releases all active claims
 * 3. Duplicate claims from same workflow are idempotent
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb, insertTestProject, insertTestWorkflow } from './helpers.js';

describe('workflow file claims (M13/6B)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('creates claims and returns no conflicts when files are unclaimed', async () => {
    const { claimFiles, getActiveClaimsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });

    const conflicts = claimFiles(wf.id, ['src/foo.ts', 'src/bar.ts']);
    expect(conflicts).toHaveLength(0);

    const claims = getActiveClaimsForWorkflow(wf.id);
    expect(claims).toHaveLength(2);
    expect(claims.map(c => c.file_path).sort()).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('detects conflicts from other workflows', async () => {
    const { claimFiles } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const wf1 = await insertTestWorkflow({ project_id: project.id });
    const wf2 = await insertTestWorkflow({ project_id: project.id });

    // wf1 claims foo.ts
    claimFiles(wf1.id, ['src/foo.ts']);

    // wf2 tries to claim foo.ts — conflict
    const conflicts = claimFiles(wf2.id, ['src/foo.ts', 'src/baz.ts']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].workflow_id).toBe(wf1.id);
    expect(conflicts[0].file_path).toBe('src/foo.ts');
  });

  it('duplicate claims from same workflow are idempotent', async () => {
    const { claimFiles, getActiveClaimsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const wf = await insertTestWorkflow({ project_id: project.id });

    claimFiles(wf.id, ['src/foo.ts']);
    claimFiles(wf.id, ['src/foo.ts']); // duplicate

    const claims = getActiveClaimsForWorkflow(wf.id);
    expect(claims).toHaveLength(1);
  });

  // Brief Goal D.1 — updateWorkflow must atomically release file claims when a
  // workflow transitions into a terminal status (complete/cancelled/failed).
  // Non-terminal transitions must leave claims intact so an in-flight workflow
  // that briefly enters `blocked` does not lose its claims.
  describe('auto-release on terminal status transition (M7)', () => {
    for (const status of ['complete', 'cancelled', 'failed'] as const) {
      it(`releases active claims when status transitions to ${status}`, async () => {
        const { claimFiles, getActiveClaimsForWorkflow, updateWorkflow } = await import('../server/db/queries.js');

        const project = await insertTestProject();
        const wf = await insertTestWorkflow({ project_id: project.id });
        claimFiles(wf.id, ['foo.py', 'bar.py']);
        expect(getActiveClaimsForWorkflow(wf.id)).toHaveLength(2);

        const updated = updateWorkflow(wf.id, { status });
        expect(updated?.status).toBe(status);
        expect(getActiveClaimsForWorkflow(wf.id)).toHaveLength(0);
      });
    }

    it('keeps active claims when status transitions to a non-terminal value', async () => {
      const { claimFiles, getActiveClaimsForWorkflow, updateWorkflow } = await import('../server/db/queries.js');

      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      claimFiles(wf.id, ['foo.py']);

      updateWorkflow(wf.id, { status: 'blocked' as any });
      expect(getActiveClaimsForWorkflow(wf.id)).toHaveLength(1);
    });

    it('applies pr_url and releases claims atomically when status update bundles both', async () => {
      // Atomicity check: status + other fields go through together; claims are
      // released as part of the same transaction.
      const { claimFiles, getActiveClaimsForWorkflow, updateWorkflow, getWorkflowById } = await import('../server/db/queries.js');

      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });
      claimFiles(wf.id, ['foo.py']);

      updateWorkflow(wf.id, { status: 'complete', pr_url: 'https://github.com/o/r/pull/1', blocked_reason: null });
      const refreshed = getWorkflowById(wf.id);
      expect(refreshed?.status).toBe('complete');
      expect(refreshed?.pr_url).toBe('https://github.com/o/r/pull/1');
      expect(getActiveClaimsForWorkflow(wf.id)).toHaveLength(0);
    });

    it('terminal update without prior claims is a no-op for claims', async () => {
      const { updateWorkflow, getActiveClaimsForWorkflow } = await import('../server/db/queries.js');

      const project = await insertTestProject();
      const wf = await insertTestWorkflow({ project_id: project.id });

      updateWorkflow(wf.id, { status: 'complete' });
      expect(getActiveClaimsForWorkflow(wf.id)).toHaveLength(0);
    });
  });

  it('releaseWorkflowClaims releases all active claims', async () => {
    const { claimFiles, releaseWorkflowClaims, getActiveClaimsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const wf1 = await insertTestWorkflow({ project_id: project.id });
    const wf2 = await insertTestWorkflow({ project_id: project.id });

    claimFiles(wf1.id, ['src/foo.ts', 'src/bar.ts']);
    claimFiles(wf2.id, ['src/baz.ts']);

    releaseWorkflowClaims(wf1.id);

    // wf1 claims should be released
    expect(getActiveClaimsForWorkflow(wf1.id)).toHaveLength(0);
    // wf2 claims should still be active
    expect(getActiveClaimsForWorkflow(wf2.id)).toHaveLength(1);

    // wf2 can now claim foo.ts without conflict
    const conflicts = claimFiles(wf2.id, ['src/foo.ts']);
    expect(conflicts).toHaveLength(0);
  });
});
