/**
 * Shared test helpers for Hurlicane integration tests.
 *
 * Provides:
 * - Fresh in-memory SQLite database per test via setupTestDb / cleanupTestDb
 * - SocketManager mock that captures all emitted events
 * - Factory helpers for inserting test fixtures
 */
import { vi } from 'vitest';
import { randomUUID } from 'crypto';

// ─── Database Helpers ─────────────────────────────────────────────────────────

/**
 * Initialize a fresh in-memory database with the full schema + migrations.
 * This calls the real initDb() from database.ts with ':memory:' which works
 * because path.dirname(':memory:') returns '.' and mkdirSync('.', {recursive:true})
 * is a no-op.
 *
 * Call cleanupTestDb() in afterEach to tear it down.
 */
export async function setupTestDb() {
  const { initDb } = await import('../server/db/database.js');
  return initDb(':memory:');
}

/**
 * Close and discard the current in-memory database.
 */
export async function cleanupTestDb() {
  const { closeDb } = await import('../server/db/database.js');
  closeDb();
}

// ─── Manager Reset ───────────────────────────────────────────────────────────

/**
 * Reset module-level dedup state in all managers that use a _processedJobs Set.
 * Call in beforeEach so each test starts with a clean slate.
 */
export async function resetManagerState() {
  const { _resetForTest: resetWorkflow } = await import('../server/orchestrator/WorkflowManager.js');
  const { _resetForTest: resetDebate } = await import('../server/orchestrator/DebateManager.js');
  const { _resetForTest: resetModelClassifier } = await import('../server/orchestrator/ModelClassifier.js');
  const { _resetForTest: resetRecoveryLedger } = await import('../server/orchestrator/RecoveryLedger.js');
  resetWorkflow();
  resetDebate();
  resetModelClassifier();
  resetRecoveryLedger();
}

// ─── Socket Mock ──────────────────────────────────────────────────────────────

export interface SocketMockCalls {
  emitJobNew: any[];
  emitJobUpdate: any[];
  emitWorkflowNew: any[];
  emitWorkflowUpdate: any[];
  emitDebateNew: any[];
  emitDebateUpdate: any[];
  emitSnapshot: any[];
  emitAgentNew: any[];
  emitAgentUpdate: any[];
  emitProjectNew: any[];
  [key: string]: any[];
}

/**
 * Create a vi.mock factory for '../socket/SocketManager.js' (or the path you
 * need). Returns an object whose keys are the emit function names and values
 * are arrays of call arguments — so you can assert exactly what was emitted.
 *
 * Usage in a test file:
 * ```ts
 * vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
 * ```
 *
 * Access the mock's recorded calls via the returned object, or via
 * `vi.mocked(socket.emitJobNew).mock.calls`.
 */
export function createSocketMock() {
  return {
    initSocketManager: vi.fn(),
    getIo: vi.fn(() => ({ emit: vi.fn() })),
    emitSnapshot: vi.fn(),
    emitAgentNew: vi.fn(),
    emitAgentUpdate: vi.fn(),
    emitAgentOutput: vi.fn(),
    emitQuestionNew: vi.fn(),
    emitQuestionAnswered: vi.fn(),
    emitLockAcquired: vi.fn(),
    emitLockReleased: vi.fn(),
    emitProjectNew: vi.fn(),
    emitJobNew: vi.fn(),
    emitJobUpdate: vi.fn(),
    emitPtyData: vi.fn(),
    emitPtyClosed: vi.fn(),
    emitDebateNew: vi.fn(),
    emitDebateUpdate: vi.fn(),
    emitWorkflowNew: vi.fn(),
    emitWorkflowUpdate: vi.fn(),
    emitWarningNew: vi.fn(),
    emitDiscussionNew: vi.fn(),
    emitDiscussionMessage: vi.fn(),
    emitDiscussionUpdate: vi.fn(),
    emitProposalNew: vi.fn(),
    emitProposalUpdate: vi.fn(),
    emitProposalMessage: vi.fn(),
    emitPrNew: vi.fn(),
    emitPrReviewNew: vi.fn(),
    emitPrReviewUpdate: vi.fn(),
    emitPrReviewMessage: vi.fn(),
  };
}

// ─── Fixture Factories ────────────────────────────────────────────────────────

/**
 * Insert a minimal project into the DB and return its id.
 */
export async function insertTestProject(overrides: { id?: string; name?: string } = {}) {
  const { insertProject } = await import('../server/db/queries.js');
  const id = overrides.id ?? randomUUID();
  return insertProject({
    id,
    name: overrides.name ?? 'Test Project',
    description: 'test project',
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

/**
 * Insert a minimal workflow into the DB and return it.
 */
export async function insertTestWorkflow(overrides: Partial<{
  id: string;
  title: string;
  task: string;
  work_dir: string | null;
  implementer_model: string;
  reviewer_model: string;
  max_cycles: number;
  current_cycle: number;
  current_phase: string;
  status: string;
  milestones_total: number;
  milestones_done: number;
  project_id: string | null;
  template_id: string | null;
  use_worktree: number;
}> = {}) {
  const { insertWorkflow } = await import('../server/db/queries.js');
  const id = overrides.id ?? randomUUID();
  return insertWorkflow({
    id,
    title: overrides.title ?? 'Test Workflow',
    task: overrides.task ?? 'Test task',
    work_dir: overrides.work_dir ?? '/tmp/test',
    implementer_model: overrides.implementer_model ?? 'claude-sonnet-4-6',
    reviewer_model: overrides.reviewer_model ?? 'codex',
    max_cycles: overrides.max_cycles ?? 10,
    current_cycle: overrides.current_cycle ?? 0,
    current_phase: (overrides.current_phase ?? 'idle') as any,
    status: (overrides.status ?? 'running') as any,
    milestones_total: overrides.milestones_total ?? 0,
    milestones_done: overrides.milestones_done ?? 0,
    project_id: overrides.project_id ?? null,
    max_turns_assess: 50,
    max_turns_review: 30,
    max_turns_implement: 100,
    stop_mode_assess: 'turns',
    stop_value_assess: 50,
    stop_mode_review: 'turns',
    stop_value_review: 30,
    stop_mode_implement: 'turns',
    stop_value_implement: 100,
    template_id: overrides.template_id ?? null,
    use_worktree: overrides.use_worktree ?? 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  } as any);
}

/**
 * Insert a minimal job into the DB and return it.
 */
export async function insertTestJob(overrides: Partial<{
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  workflow_id: string | null;
  workflow_cycle: number | null;
  workflow_phase: string | null;
  project_id: string | null;
  work_dir: string | null;
  model: string | null;
}> = {}) {
  const { insertJob } = await import('../server/db/queries.js');
  return insertJob({
    id: overrides.id ?? randomUUID(),
    title: overrides.title ?? 'Test Job',
    description: overrides.description ?? 'Test job description',
    context: null,
    priority: overrides.priority ?? 0,
    status: (overrides.status ?? 'queued') as any,
    workflow_id: overrides.workflow_id ?? null,
    workflow_cycle: overrides.workflow_cycle ?? null,
    workflow_phase: (overrides.workflow_phase ?? null) as any,
    project_id: overrides.project_id ?? null,
    work_dir: overrides.work_dir ?? null,
    model: overrides.model ?? null,
  });
}
