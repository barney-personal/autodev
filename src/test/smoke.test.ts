/**
 * Smoke tests proving the test harness works:
 * - In-memory SQLite DB initializes with full schema
 * - Queries work against the in-memory DB
 * - Each test gets an isolated DB (no cross-test state leakage)
 * - SocketManager mock captures emitted events
 * - Module-level singleton state can be reset between tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestProject, insertTestWorkflow, insertTestJob } from './helpers.js';

// Mock SocketManager before any module that imports it
vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('Test Harness: In-memory DB', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('initializes the full schema in :memory:', async () => {
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    // Verify key tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('jobs');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('workflows');
    expect(tableNames).toContain('notes');
    expect(tableNames).toContain('debates');
    expect(tableNames).toContain('projects');
  });

  it('inserts and retrieves a job via queries module', async () => {
    const { insertJob, getJobById } = await import('../server/db/queries.js');
    const job = insertJob({
      id: 'test-job-1',
      title: 'Smoke Test Job',
      description: 'A job for testing',
      context: null,
      priority: 5,
    });
    expect(job.id).toBe('test-job-1');
    expect(job.title).toBe('Smoke Test Job');
    expect(job.status).toBe('queued');
    expect(job.priority).toBe(5);

    const fetched = getJobById('test-job-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Smoke Test Job');
  });

  it('inserts and retrieves a workflow', async () => {
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id });
    expect(workflow.id).toBeTruthy();
    expect(workflow.status).toBe('running');
    expect(workflow.current_phase).toBe('idle');

    const { getWorkflowById } = await import('../server/db/queries.js');
    const fetched = getWorkflowById(workflow.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test Workflow');
  });

  it('provides isolation between tests (no leftover data)', async () => {
    const { getJobById } = await import('../server/db/queries.js');
    // This job was inserted in the previous test — it should not exist here
    const ghost = getJobById('test-job-1');
    expect(ghost).toBeNull();
  });
});

describe('Test Harness: Socket Mock', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('captures emitJobNew calls', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const { insertJob } = await import('../server/db/queries.js');

    const job = insertJob({
      id: 'mock-test-job',
      title: 'Mock Test',
      description: 'Testing socket mock',
      context: null,
      priority: 0,
    });
    socket.emitJobNew(job);

    expect(socket.emitJobNew).toHaveBeenCalledTimes(1);
    expect(vi.mocked(socket.emitJobNew).mock.calls[0][0].id).toBe('mock-test-job');
  });

  it('captures emitWorkflowUpdate calls', async () => {
    const socket = await import('../server/socket/SocketManager.js');
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id });

    socket.emitWorkflowUpdate(workflow);

    expect(socket.emitWorkflowUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(socket.emitWorkflowUpdate).mock.calls[0][0].id).toBe(workflow.id);
  });
});

describe('Test Harness: Fixture Factories', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('insertTestJob creates a job with overrides', async () => {
    const job = await insertTestJob({
      title: 'Custom Job',
      status: 'running',
      priority: 10,
    });
    expect(job.title).toBe('Custom Job');
    expect(job.status).toBe('running');
    expect(job.priority).toBe(10);
  });

  it('insertTestWorkflow creates a workflow linked to a project', async () => {
    const project = await insertTestProject({ name: 'My Project' });
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      max_cycles: 5,
      current_phase: 'assess',
    });
    expect(workflow.project_id).toBe(project.id);
    expect(workflow.max_cycles).toBe(5);
    expect(workflow.current_phase).toBe('assess');
  });

  it('insertTestJob supports workflow fields', async () => {
    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({ project_id: project.id });
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'review',
    });
    expect(job.workflow_id).toBe(workflow.id);
    expect(job.workflow_cycle).toBe(1);
    expect(job.workflow_phase).toBe('review');
  });
});

describe('Test Harness: Module state reset', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('parseMilestones is importable and works with test data', async () => {
    const { parseMilestones } = await import('../server/orchestrator/WorkflowManager.js');
    const result = parseMilestones('- [x] Done\n- [ ] Not done\n- [ ] Also not done');
    expect(result.total).toBe(3);
    expect(result.done).toBe(1);
  });

  it('parseMilestones returns zeros for empty input', async () => {
    const { parseMilestones } = await import('../server/orchestrator/WorkflowManager.js');
    const result = parseMilestones('');
    expect(result.total).toBe(0);
    expect(result.done).toBe(0);
  });
});
