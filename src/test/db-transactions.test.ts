/**
 * Tests for M6: transaction wrappers around multi-step DB operations.
 *
 * Proves:
 *   1. withTransaction commits on success and re-throws on error
 *   2. deleteTemplate is atomic — if DELETE FROM templates fails, the prior
 *      UPDATE jobs SET template_id = NULL is rolled back
 *   3. deleteProject is atomic — if DELETE FROM projects fails, all prior
 *      UPDATEs and DELETEs within the same call are rolled back
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

async function setup() {
  const { initDb } = await import('../server/db/database.js');
  return initDb(':memory:');
}

async function teardown() {
  const { closeDb } = await import('../server/db/database.js');
  closeDb();
}

// ---------------------------------------------------------------------------
// Helper: add a BEFORE DELETE trigger that always raises ABORT
// ---------------------------------------------------------------------------
function addFailTrigger(db: any, table: string, triggerName: string) {
  db.exec(`
    CREATE TRIGGER ${triggerName} BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, 'Simulated failure in ${table} delete');
    END
  `);
}

function dropTrigger(db: any, triggerName: string) {
  db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

async function seedOldTerminalAgent(agentId: string, jobId: string, lineCount: number) {
  const queries = await import('../server/db/queries.js');
  const finishedAt = Date.now() - 48 * 60 * 60 * 1000;

  queries.insertJob({ id: jobId, title: `${jobId}-title`, description: 'desc', context: null, priority: 0, status: 'done' });
  queries.insertAgent({ id: agentId, job_id: jobId, status: 'done', finished_at: finishedAt });

  for (let seq = 0; seq < lineCount; seq++) {
    queries.insertAgentOutput({
      agent_id: agentId,
      seq,
      event_type: 'assistant',
      content: `line ${seq}`,
      created_at: finishedAt + seq,
    });
  }

  return queries;
}

// ---------------------------------------------------------------------------
// withTransaction — basic behaviour
// ---------------------------------------------------------------------------
describe('withTransaction', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it('returns the value from the callback on success', async () => {
    const { withTransaction } = await import('../server/db/database.js');
    const result = withTransaction(() => 42);
    expect(result).toBe(42);
  });

  it('commits the write when the callback succeeds', async () => {
    const { withTransaction, getDb } = await import('../server/db/database.js');
    const db = getDb();
    const key = `txn-test-${randomUUID()}`;
    withTransaction(() => {
      db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(key, 'hello', Date.now());
    });
    const row = db.prepare('SELECT value FROM notes WHERE key = ?').get(key) as { value: string } | undefined;
    expect(row?.value).toBe('hello');
  });

  it('rolls back the write and re-throws when the callback throws', async () => {
    const { withTransaction, getDb } = await import('../server/db/database.js');
    const db = getDb();
    const key = `txn-rollback-${randomUUID()}`;
    expect(() =>
      withTransaction(() => {
        db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(key, 'should-not-persist', Date.now());
        throw new Error('Deliberate failure');
      })
    ).toThrow('Deliberate failure');

    // Write must have been rolled back
    const row = db.prepare('SELECT value FROM notes WHERE key = ?').get(key);
    expect(row).toBeUndefined();
  });

  it('handles nested calls by running the inner function directly (no nested BEGIN)', async () => {
    const { withTransaction, getDb } = await import('../server/db/database.js');
    const db = getDb();
    const outerKey = `txn-nested-outer-${randomUUID()}`;
    const innerKey = `txn-nested-inner-${randomUUID()}`;

    withTransaction(() => {
      db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(outerKey, 'outer', Date.now());
      // Nested withTransaction should not issue a second BEGIN
      withTransaction(() => {
        db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(innerKey, 'inner', Date.now());
      });
    });

    // Both writes should be committed
    const outerRow = db.prepare('SELECT value FROM notes WHERE key = ?').get(outerKey) as { value: string } | undefined;
    const innerRow = db.prepare('SELECT value FROM notes WHERE key = ?').get(innerKey) as { value: string } | undefined;
    expect(outerRow?.value).toBe('outer');
    expect(innerRow?.value).toBe('inner');
  });

  it('rolls back both outer and inner writes when inner nested call throws', async () => {
    const { withTransaction, getDb } = await import('../server/db/database.js');
    const db = getDb();
    const outerKey = `txn-nested-rollback-outer-${randomUUID()}`;
    const innerKey = `txn-nested-rollback-inner-${randomUUID()}`;

    expect(() =>
      withTransaction(() => {
        db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(outerKey, 'outer', Date.now());
        withTransaction(() => {
          db.prepare("INSERT INTO notes (key, value, agent_id, updated_at) VALUES (?, ?, NULL, ?)").run(innerKey, 'inner', Date.now());
          throw new Error('Inner failure');
        });
      })
    ).toThrow('Inner failure');

    // Both writes must have been rolled back
    expect(db.prepare('SELECT value FROM notes WHERE key = ?').get(outerKey)).toBeUndefined();
    expect(db.prepare('SELECT value FROM notes WHERE key = ?').get(innerKey)).toBeUndefined();
  });

  it('rejects async callbacks with a clear error message', async () => {
    const { withTransaction } = await import('../server/db/database.js');

    expect(() =>
      withTransaction(() => Promise.resolve(42) as any)
    ).toThrow('withTransaction does not support async callbacks');
  });
});

// ---------------------------------------------------------------------------
// deleteTemplate atomicity
// ---------------------------------------------------------------------------
describe('deleteTemplate atomicity', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it('rolls back UPDATE jobs when DELETE FROM templates fails', async () => {
    const { getDb } = await import('../server/db/database.js');
    const { insertTemplate, deleteTemplate } = await import('../server/db/noteQueries.js');
    const queries = await import('../server/db/queries.js');

    const db = getDb();
    const now = Date.now();

    // Insert a template and a job that references it
    const tpl = insertTemplate({ id: randomUUID(), name: 'Test Template', content: 'body', work_dir: null, model: null, created_at: now, updated_at: now });
    const job = queries.insertJob({
      id: randomUUID(),
      title: 'Job With Template',
      description: 'desc',
      context: null,
      priority: 0,
      status: 'queued',
      template_id: tpl.id,
      created_at: now,
      updated_at: now,
    });

    // Confirm the job references the template
    const before = db.prepare('SELECT template_id FROM jobs WHERE id = ?').get(job.id) as { template_id: string };
    expect(before.template_id).toBe(tpl.id);

    // Add a trigger that makes DELETE FROM templates always fail
    addFailTrigger(db, 'templates', 'fail_delete_template_test');

    // deleteTemplate should throw because of the trigger
    expect(() => deleteTemplate(tpl.id)).toThrow();

    // The UPDATE (nulling template_id on jobs) must have been rolled back
    const after = db.prepare('SELECT template_id FROM jobs WHERE id = ?').get(job.id) as { template_id: string };
    expect(after.template_id).toBe(tpl.id);

    // Template must still exist
    const tplAfter = db.prepare('SELECT id FROM templates WHERE id = ?').get(tpl.id);
    expect(tplAfter).toBeDefined();

    dropTrigger(db, 'fail_delete_template_test');
  });

  it('successfully deletes template and nulls job reference when no failure', async () => {
    const { getDb } = await import('../server/db/database.js');
    const { insertTemplate, deleteTemplate } = await import('../server/db/noteQueries.js');
    const queries = await import('../server/db/queries.js');

    const db = getDb();
    const now = Date.now();

    const tpl = insertTemplate({ id: randomUUID(), name: 'TPL', content: 'body', work_dir: null, model: null, created_at: now, updated_at: now });
    const job = queries.insertJob({
      id: randomUUID(), title: 'J', description: 'd', context: null, priority: 0, status: 'queued',
      template_id: tpl.id, created_at: now, updated_at: now,
    });

    deleteTemplate(tpl.id);

    // Template gone
    expect(db.prepare('SELECT id FROM templates WHERE id = ?').get(tpl.id)).toBeUndefined();
    // Job template_id nulled
    const row = db.prepare('SELECT template_id FROM jobs WHERE id = ?').get(job.id) as { template_id: string | null };
    expect(row.template_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteProject atomicity
// ---------------------------------------------------------------------------
describe('deleteProject atomicity', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it('rolls back all prior statements when DELETE FROM projects fails', async () => {
    const { getDb } = await import('../server/db/database.js');
    const { insertProject, deleteProject } = await import('../server/db/noteQueries.js');
    const queries = await import('../server/db/queries.js');

    const db = getDb();
    const now = Date.now();

    const proj = insertProject({ id: randomUUID(), name: 'Test Project', description: null, created_at: now, updated_at: now });
    const job = queries.insertJob({
      id: randomUUID(), title: 'Proj Job', description: 'd', context: null, priority: 0, status: 'queued',
      project_id: proj.id, created_at: now, updated_at: now,
    });

    // Add a trigger that prevents deleting the project row
    addFailTrigger(db, 'projects', 'fail_delete_project_test');

    expect(() => deleteProject(proj.id)).toThrow();

    // Project must still exist
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(proj.id)).toBeDefined();

    // The job's project_id must NOT have been changed (rollback)
    const jobAfter = db.prepare('SELECT project_id, archived_at FROM jobs WHERE id = ?').get(job.id) as { project_id: string | null; archived_at: number | null };
    expect(jobAfter.project_id).toBe(proj.id);
    expect(jobAfter.archived_at).toBeNull();

    dropTrigger(db, 'fail_delete_project_test');
  });

  it('successfully deletes project and all related records when no failure', async () => {
    const { getDb } = await import('../server/db/database.js');
    const { insertProject, deleteProject } = await import('../server/db/noteQueries.js');
    const queries = await import('../server/db/queries.js');

    const db = getDb();
    const now = Date.now();

    const proj = insertProject({ id: randomUUID(), name: 'P', description: null, created_at: now, updated_at: now });
    const job = queries.insertJob({
      id: randomUUID(), title: 'J', description: 'd', context: null, priority: 0, status: 'queued',
      project_id: proj.id, created_at: now, updated_at: now,
    });

    deleteProject(proj.id);

    // Project gone
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(proj.id)).toBeUndefined();
    // Job's project_id nulled
    const row = db.prepare('SELECT project_id FROM jobs WHERE id = ?').get(job.id) as { project_id: string | null };
    expect(row.project_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pruneOldAgentOutput atomicity
// ---------------------------------------------------------------------------
describe('pruneOldAgentOutput atomicity', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  it('rolls back earlier agent deletions when a later prune delete fails', async () => {
    const { getDb } = await import('../server/db/database.js');
    const queries = await seedOldTerminalAgent('prune-agent-a', 'prune-job-a', 5);
    await seedOldTerminalAgent('prune-agent-b', 'prune-job-b', 5);
    const db = getDb();

    db.exec(`
      CREATE TABLE prune_delete_counter (n INTEGER)
    `);
    db.exec(`
      CREATE TRIGGER fail_second_prune_delete BEFORE DELETE ON agent_output
      BEGIN
        INSERT INTO prune_delete_counter (n) VALUES (1);
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM prune_delete_counter) >= 3
          THEN RAISE(ABORT, 'Simulated prune failure')
        END;
      END
    `);

    expect(() => queries.pruneOldAgentOutput(60 * 60 * 1000, 3)).toThrow('Simulated prune failure');

    const agentARows = queries.getAgentOutput('prune-agent-a');
    const agentBRows = queries.getAgentOutput('prune-agent-b');
    expect(agentARows.map(row => row.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(agentBRows.map(row => row.seq)).toEqual([0, 1, 2, 3, 4]);

    dropTrigger(db, 'fail_second_prune_delete');
  });

  it('removes only the oldest rows and keeps the newest tail on success', async () => {
    const queries = await seedOldTerminalAgent('prune-agent-tail', 'prune-job-tail', 6);

    const deleted = queries.pruneOldAgentOutput(60 * 60 * 1000, 3);

    expect(deleted).toBe(3);
    const remaining = queries.getAgentOutput('prune-agent-tail');
    expect(remaining.map(row => row.seq)).toEqual([3, 4, 5]);
  });
});
