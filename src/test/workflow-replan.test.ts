/**
 * Tests for M8/1C — Auto-split failed milestones via re-plan on zero progress.
 *
 * Verifies:
 * 1. First zero-progress cycle spawns a review job for plan restructuring
 * 2. Second zero-progress cycle (replan already attempted) increments counter as before
 * 3. Re-plan note prevents infinite re-plan loop
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  resetManagerState,
  insertTestProject,
  insertTestWorkflow,
  insertTestJob,
} from './helpers.js';

// Mock fs.existsSync so pre-flight checks pass
vi.mock(import('fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// Mock child_process.execSync for branch verification
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('rev-parse --abbrev-ref HEAD')) {
      return Buffer.from('expected-branch\n');
    }
    return Buffer.from('');
  }),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  getCircuitBreaker: vi.fn(() => ({
    isOpen: () => false,
    reason: () => 'circuit closed',
    recordModelLimited: () => {},
    recordModelAvailable: () => {},
    recordInfraFailure: () => {},
    recordSuccess: () => {},
    consecutiveInfraFailures: () => 0,
  })),
  getAvailableModel: vi.fn((model: string) => model),
  getFallbackModel: vi.fn((model: string) => model),
  getAlternateProviderModel: vi.fn(() => null),
  markModelRateLimited: vi.fn(),
  markProviderRateLimited: vi.fn(),
  getModelProvider: vi.fn(() => 'anthropic'),
  resolveModel: vi.fn(async (job: any) => job.model ?? 'claude-sonnet-4-6'),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyJobFailure: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  isSameModelRetryEligible: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

describe('WorkflowManager: auto-split via re-plan on zero progress (M8/1C)', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('spawns review job on first zero-progress cycle (no replan-attempted)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    // Plan with 2/5 done, pre-implement also 2 → delta = 0
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    // No replan-attempted note — this is the first zero-progress

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // replan-attempted note should be set
    const replanNote = getNote(`workflow/${workflow.id}/replan-attempted/3`);
    expect(replanNote?.value).toBe('1');

    // Zero-progress counter should NOT be incremented (re-plan intercepts)
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value ?? '0').toBe('0');

    // A review job should have been spawned for the same cycle
    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJob = jobs.find(j => j.workflow_phase === 'review' && j.workflow_cycle === 3);
    expect(reviewJob).toBeDefined();

    // Workflow should NOT be blocked
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('increments zero-progress counter on second zero-progress when replan already attempted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    // Replan already attempted this cycle
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Zero-progress counter SHOULD be incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');

    // No additional review job should be spawned (only the original implement job exists)
    const jobs = getJobsForWorkflow(workflow.id);
    const reviewJobs = jobs.filter(j => j.workflow_phase === 'review' && j.workflow_cycle === 3);
    expect(reviewJobs).toHaveLength(0);
  });

  it('re-plan does not trigger on cycles with actual progress', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 3,
    });

    // Plan with 3/5 done, pre-implement was 2 → delta = 1 (progress!)
    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [x] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // No replan-attempted note should be set (progress was made)
    const replanNote = getNote(`workflow/${workflow.id}/replan-attempted/3`);
    expect(replanNote).toBeNull();

    // Zero-progress counter should be reset
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');
  });
});

describe('WorkflowManager: evidence-based zero-progress bypass', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('commit evidence bypasses replan on first zero-progress cycle', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, insertAgent, updateAgent } = await import('../server/db/queries.js');
    const { execSync } = await import('child_process');
    const { randomUUID } = await import('crypto');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    // No replan-attempted — first zero-progress cycle

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Agent with base_sha so commit detection runs
    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: job.id, status: 'done' });
    updateAgent(agentId, { base_sha: 'abc1234def' });

    // Simulate 3 commits found since base_sha
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('3\n') as any);

    onJobCompleted(job);

    // No replan-attempted note (evidence bypass prevented replan)
    const replanNote = getNote(`workflow/${workflow.id}/replan-attempted/3`);
    expect(replanNote).toBeNull();

    // Zero-progress counter reset to 0
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');

    // Workflow not blocked
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('commit evidence bypasses counter increment when replan-attempted is already set', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, insertAgent, updateAgent } = await import('../server/db/queries.js');
    const { execSync } = await import('child_process');
    const { randomUUID } = await import('crypto');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: job.id, status: 'done' });
    updateAgent(agentId, { base_sha: 'abc1234def' });

    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('2\n') as any);

    onJobCompleted(job);

    // Counter should be reset to 0 (evidence bypass), not incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');

    // Workflow not blocked
    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('commit detection uses the newest agent when multiple agents exist for the job', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote, insertAgent, updateAgent } = await import('../server/db/queries.js');
    const { execSync } = await import('child_process');
    const { randomUUID } = await import('crypto');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    const now = Date.now();
    // Older agent — stale base_sha
    const oldAgentId = randomUUID();
    insertAgent({ id: oldAgentId, job_id: job.id, status: 'done', started_at: now - 10000 });
    updateAgent(oldAgentId, { base_sha: 'old-sha-111' });

    // Newer agent — newer base_sha
    const newAgentId = randomUUID();
    insertAgent({ id: newAgentId, job_id: job.id, status: 'done', started_at: now });
    updateAgent(newAgentId, { base_sha: 'new-sha-222' });

    // execSync returns commits only when the newest agent's sha is in the command
    vi.mocked(execSync).mockImplementationOnce((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('"new-sha-222"')) return Buffer.from('4\n') as any;
      return Buffer.from('0\n') as any;
    });

    onJobCompleted(job);

    // Newest agent's sha detected commits → evidence bypass → counter at 0
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');
  });

  it('substantive worklog with no commits also bypasses zero-progress escalation', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    // No agent with base_sha — git commit check skipped
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Substantive worklog: contains real body text, not just template
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`,
      '## Cycle 3 — M3\n**Owner:** Implementer\n**Timestamp:** 2026-04-04T22:00:00Z\n### What changed\n- src/foo.ts: refactored bar function\n### Blockers\n- None', null);

    onJobCompleted(job);

    // Counter reset to 0 (worklog evidence bypass)
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('blank worklog and no commits follows existing zero-progress path', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Blank worklog — not substantive
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`, '   ', null);

    onJobCompleted(job);

    // No evidence → counter incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');
  });

  it('heading-only worklog and no commits follows existing zero-progress path', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Heading-only worklog — all non-blank lines start with '#'
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`,
      '## Cycle 3 — M3\n### What changed\n### Commits\n### Blockers\n### Next step', null);

    onJobCompleted(job);

    // No evidence → counter incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');
  });

  it('template-only worklog (Owner+Timestamp metadata only) and no commits follows existing path', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Template-only worklog: only headings and **Owner:**/**Timestamp:** metadata
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`,
      '## Cycle 3 — M3\n**Owner:** Implementer\n**Timestamp:** 2026-04-04T22:00:00Z\n### What changed\n### Commits\n### Blockers\n### Next step', null);

    onJobCompleted(job);

    // Template-only is not substantive (M2 fix) → no evidence → counter incremented
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('1');
  });

  it('execSync failure falls back to worklog evidence check', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote, insertAgent, updateAgent } = await import('../server/db/queries.js');
    const { execSync } = await import('child_process');
    const { randomUUID } = await import('crypto');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: job.id, status: 'done' });
    updateAgent(agentId, { base_sha: 'abc1234def' });

    // git fails — should fall through to worklog check
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('git: not a repository'); });

    // Substantive worklog provides the signal
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`,
      '## Cycle 3 — M3\n### What changed\n- src/bar.ts: implemented feature X', null);

    onJobCompleted(job);

    // Worklog evidence bypasses escalation
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });

  it('missing base_sha falls back gracefully to worklog check', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { upsertNote, getWorkflowById, getNote } = await import('../server/db/queries.js');

    const project = await insertTestProject();
    const workflow = await insertTestWorkflow({
      project_id: project.id,
      status: 'running',
      current_phase: 'implement',
      current_cycle: 3,
      max_cycles: 10,
      milestones_total: 5,
      milestones_done: 2,
    });

    upsertNote(`workflow/${workflow.id}/plan`,
      '- [x] M1\n- [x] M2\n- [ ] M3\n- [ ] M4\n- [ ] M5', null);
    upsertNote(`workflow/${workflow.id}/pre-implement-milestones/3`, '2', null);
    upsertNote(`workflow/${workflow.id}/replan-attempted/3`, '1', null);

    // Agent has no base_sha — git check skipped
    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 3,
      workflow_phase: 'implement',
      status: 'done',
    });

    // Substantive worklog provides the evidence signal instead
    upsertNote(`workflow/${workflow.id}/worklog/cycle-3`,
      '## Cycle 3\n### What changed\n- src/baz.ts: fixed edge case in parser', null);

    onJobCompleted(job);

    // Worklog signal picked up even without base_sha
    const zpNote = getNote(`workflow/${workflow.id}/zero-progress-count`);
    expect(zpNote?.value).toBe('0');

    const updated = getWorkflowById(workflow.id)!;
    expect(updated.status).not.toBe('blocked');
  });
});
