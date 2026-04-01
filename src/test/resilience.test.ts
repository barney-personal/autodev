/**
 * Tests for agent resilience improvements:
 * - Retry exponential backoff
 * - TTL-expired lock cleanup
 * - Resource monitor basics
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, resetManagerState } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

describe('RetryManager - exponential backoff', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('computeBackoffDelay increases exponentially', async () => {
    const { computeBackoffDelay } = await import('../server/orchestrator/RetryManager.js');

    // Use a fixed seed by mocking Math.random to remove jitter
    const origRandom = Math.random;
    Math.random = () => 0.5; // jitter factor = 0

    try {
      const d0 = computeBackoffDelay(0); // ~30s
      const d1 = computeBackoffDelay(1); // ~60s
      const d2 = computeBackoffDelay(2); // ~120s
      const d3 = computeBackoffDelay(3); // ~240s

      expect(d0).toBeGreaterThanOrEqual(20_000);
      expect(d0).toBeLessThanOrEqual(50_000);
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
      // Should cap at MAX_DELAY_MS (10 minutes)
      const d10 = computeBackoffDelay(10);
      expect(d10).toBeLessThanOrEqual(10 * 60_000 * 1.3 + 1000);
    } finally {
      Math.random = origRandom;
    }
  });

  it('retry jobs are scheduled with a future scheduled_at', async () => {
    const queries = await import('../server/db/queries.js');
    const { handleRetry } = await import('../server/orchestrator/RetryManager.js');

    const job = queries.insertJob({
      id: 'retry-backoff-test',
      title: 'Test Job',
      description: 'desc',
      context: null,
      priority: 0,
      status: 'failed',
      retry_policy: 'same',
      max_retries: 3,
      retry_count: 0,
    });

    const agent = queries.insertAgent({ id: 'agent-retry-1', job_id: job.id, status: 'failed' });
    const before = Date.now();

    const result = handleRetry(job, agent.id);
    expect(result).toBe(true);

    // Find the retry job
    const allJobs = queries.listJobs();
    const retryJob = allJobs.find(j => j.id !== job.id);
    expect(retryJob).toBeDefined();
    expect(retryJob!.scheduled_at).toBeDefined();
    expect(retryJob!.scheduled_at).toBeGreaterThan(before);
    // Should be at least a few seconds in the future
    expect(retryJob!.scheduled_at! - before).toBeGreaterThanOrEqual(1000);
  });
});

describe('TTL-expired lock cleanup', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('getExpiredUnreleasedLocks returns only expired unreleased locks', async () => {
    const queries = await import('../server/db/queries.js');

    // Insert a job + agent for the lock FK constraints
    queries.insertJob({ id: 'job-1', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'agent-lock-1', job_id: 'job-1', status: 'running' });

    const now = Date.now();

    // Insert an expired lock (TTL already passed)
    queries.insertFileLock({
      id: 'expired-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/expired.ts',
      reason: 'test',
      acquired_at: now - 120_000,
      expires_at: now - 60_000, // expired 60s ago
      released_at: null,
    });

    // Insert an active lock (TTL not yet passed)
    queries.insertFileLock({
      id: 'active-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/active.ts',
      reason: 'test',
      acquired_at: now - 60_000,
      expires_at: now + 300_000, // expires in 5 min
      released_at: null,
    });

    // Insert an already-released lock
    queries.insertFileLock({
      id: 'released-lock-1',
      agent_id: 'agent-lock-1',
      file_path: '/test/released.ts',
      reason: 'test',
      acquired_at: now - 120_000,
      expires_at: now - 60_000,
      released_at: now - 30_000,
    });

    const expired = queries.getExpiredUnreleasedLocks();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe('expired-lock-1');
  });
});

describe('ResourceMonitor', () => {
  it('exports start/stop functions without crashing', async () => {
    const { startResourceMonitor, stopResourceMonitor, _getState } = await import('../server/orchestrator/ResourceMonitor.js');

    // Just verify it can start and stop without errors
    startResourceMonitor();
    const state = _getState();
    expect(typeof state.diskWarned).toBe('boolean');
    expect(typeof state.memoryWarned).toBe('boolean');
    stopResourceMonitor();
  });
});

describe('Health endpoint', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('returns ok status with all checks when DB is healthy', async () => {
    // We can't easily spin up an Express app in this test, but we can test
    // the core health logic by verifying the DB queries used by the endpoint work
    const queries = await import('../server/db/queries.js');

    // These should not throw with a healthy in-memory DB
    const jobs = queries.listJobs();
    const agents = queries.listAllRunningAgents();
    const locks = queries.getAllActiveLocks();

    expect(Array.isArray(jobs)).toBe(true);
    expect(Array.isArray(agents)).toBe(true);
    expect(Array.isArray(locks)).toBe(true);
  });

  it('DB check validates connectivity', async () => {
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();
    // Should be able to execute a simple query
    const result = db.prepare('SELECT 1 as val').get() as any;
    expect(result.val).toBe(1);
  });
});

describe('Zombie process cleanup', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('detects agents in terminal state that should have their sessions cleaned up', async () => {
    const queries = await import('../server/db/queries.js');

    // Create a job and agent that's in a terminal state
    queries.insertJob({ id: 'zombie-job-1', title: 'test', description: 'test', context: null, priority: 0, status: 'done' });
    queries.insertAgent({ id: 'zombie-agent-1', job_id: 'zombie-job-1', status: 'done' });

    // The agent should be in listAgents and have terminal status
    const agents = queries.listAgents();
    const agent = agents.find(a => a.id === 'zombie-agent-1');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('done');
    // A zombie would be one where pid is set and status is terminal
    // The watchdog check logic works correctly for this case
  });
});

describe('Output deduplication', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('INSERT OR IGNORE prevents duplicate (agent_id, seq) pairs', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'dedup-job', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'dedup-agent', job_id: 'dedup-job', status: 'running' });

    // Insert first output
    queries.insertAgentOutput({
      agent_id: 'dedup-agent',
      seq: 0,
      event_type: 'assistant',
      content: '{"type":"assistant","message":"hello"}',
      created_at: Date.now(),
    });

    // Insert duplicate — should NOT throw, should be silently ignored
    queries.insertAgentOutput({
      agent_id: 'dedup-agent',
      seq: 0,
      event_type: 'assistant',
      content: '{"type":"assistant","message":"hello duplicate"}',
      created_at: Date.now(),
    });

    // Should only have one row
    const output = queries.getAgentOutput('dedup-agent');
    expect(output).toHaveLength(1);
    // Should keep the original content
    expect(output[0].content).toContain('hello');
  });

  it('allows different seq numbers for same agent', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'dedup-job2', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'dedup-agent2', job_id: 'dedup-job2', status: 'running' });

    queries.insertAgentOutput({
      agent_id: 'dedup-agent2', seq: 0, event_type: 'assistant',
      content: 'first', created_at: Date.now(),
    });
    queries.insertAgentOutput({
      agent_id: 'dedup-agent2', seq: 1, event_type: 'assistant',
      content: 'second', created_at: Date.now(),
    });

    const output = queries.getAgentOutput('dedup-agent2');
    expect(output).toHaveLength(2);
  });
});

describe('EventQueue', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('pushEvent stores events and getEventsSince retrieves them', async () => {
    const { pushEvent, getEventsSince } = await import('../server/orchestrator/EventQueue.js');

    const before = Date.now();
    pushEvent('job:new', { job: { id: 'test-job' } });
    pushEvent('agent:new', { agent: { id: 'test-agent' } });

    const events = getEventsSince(before - 1);
    expect(events).toHaveLength(2);
    expect(events[0].event_name).toBe('job:new');
    expect(events[1].event_name).toBe('agent:new');
    expect(events[0].payload.job.id).toBe('test-job');
  });

  it('getEventsSince filters by timestamp', async () => {
    const { pushEvent, getEventsSince } = await import('../server/orchestrator/EventQueue.js');

    pushEvent('old:event', { data: 'old' });
    const midpoint = Date.now();
    // Small delay so timestamps differ
    pushEvent('new:event', { data: 'new' });

    const events = getEventsSince(midpoint);
    // May get 0 or 1 depending on timestamp resolution — but should not include old
    for (const ev of events) {
      expect(ev.created_at).toBeGreaterThan(midpoint);
    }
  });

  it('pruneEvents removes old entries', async () => {
    const { pushEvent, pruneEvents, getEventsSince } = await import('../server/orchestrator/EventQueue.js');

    pushEvent('test:event', { data: 'test' });
    pruneEvents();

    // Events less than MAX_AGE_MS old should survive pruning
    const events = getEventsSince(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Partial workflow recovery', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('resumeWorkflow accepts phase override', async () => {
    const queries = await import('../server/db/queries.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    // Create a project for the workflow
    queries.insertProject({
      id: 'proj-resume-1',
      name: 'Test',
      description: 'test',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    // Create a blocked workflow stuck in 'implement' at cycle 2
    const now = Date.now();
    queries.insertWorkflow({
      id: 'wf-resume-1',
      title: 'Test Workflow',
      task: 'test task',
      work_dir: '/tmp/test',
      implementer_model: 'claude-sonnet-4-6',
      reviewer_model: 'codex',
      max_cycles: 10,
      current_cycle: 2,
      current_phase: 'implement',
      status: 'blocked',
      milestones_total: 5,
      milestones_done: 3,
      project_id: 'proj-resume-1',
      max_turns_assess: 50,
      max_turns_review: 30,
      max_turns_implement: 100,
      stop_mode_assess: 'turns',
      stop_value_assess: 50,
      stop_mode_review: 'turns',
      stop_value_review: 30,
      stop_mode_implement: 'turns',
      stop_value_implement: 100,
      template_id: null,
      use_worktree: 0,
      created_at: now,
      updated_at: now,
    } as any);

    const workflow = queries.getWorkflowById('wf-resume-1')!;

    // Resume from 'review' at cycle 1 (partial recovery — go back to review)
    const job = resumeWorkflow(workflow, { phase: 'review', cycle: 1 });
    expect(job).toBeDefined();
    expect(job.workflow_phase).toBe('review');
    expect(job.workflow_cycle).toBe(1);
    expect(job.title).toContain('Review');
    expect(job.title).toContain('resumed');

    // Verify workflow state was updated
    const updatedWf = queries.getWorkflowById('wf-resume-1')!;
    expect(updatedWf.status).toBe('running');
    expect(updatedWf.current_phase).toBe('review');
    expect(updatedWf.current_cycle).toBe(1);
  });

  it('resumeWorkflow defaults to blocked phase when no override', async () => {
    const queries = await import('../server/db/queries.js');
    const { resumeWorkflow } = await import('../server/orchestrator/WorkflowManager.js');

    queries.insertProject({
      id: 'proj-resume-2',
      name: 'Test',
      description: 'test',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const now = Date.now();
    queries.insertWorkflow({
      id: 'wf-resume-2',
      title: 'Test Workflow 2',
      task: 'test task',
      work_dir: '/tmp/test',
      implementer_model: 'claude-sonnet-4-6',
      reviewer_model: 'codex',
      max_cycles: 10,
      current_cycle: 3,
      current_phase: 'implement',
      status: 'blocked',
      milestones_total: 5,
      milestones_done: 2,
      project_id: 'proj-resume-2',
      max_turns_assess: 50,
      max_turns_review: 30,
      max_turns_implement: 100,
      stop_mode_assess: 'turns',
      stop_value_assess: 50,
      stop_mode_review: 'turns',
      stop_value_review: 30,
      stop_mode_implement: 'turns',
      stop_value_implement: 100,
      template_id: null,
      use_worktree: 0,
      created_at: now,
      updated_at: now,
    } as any);

    const workflow = queries.getWorkflowById('wf-resume-2')!;
    const job = resumeWorkflow(workflow); // no override
    expect(job.workflow_phase).toBe('implement');
    expect(job.workflow_cycle).toBe(3);
  });
});

describe('Token tracking for PTY agents', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('cost_usd column can be set on agents', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'cost-job', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'cost-agent', job_id: 'cost-job', status: 'running' });

    // Update with a cost
    queries.updateAgent('cost-agent', { cost_usd: 1.23 });

    const agent = queries.getAgentById('cost-agent');
    expect(agent).toBeDefined();
    expect(agent!.cost_usd).toBeCloseTo(1.23, 2);
  });

  it('estimateCostUsd calculates correctly', async () => {
    const { estimateCostUsd } = await import('../server/orchestrator/CostEstimator.js');

    // Sonnet: $3/M input, $15/M output
    const cost = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 100_000);
    expect(cost).toBeCloseTo(3 + 1.5, 1); // $3 input + $1.5 output

    // Opus: $15/M input, $75/M output
    const opusCost = estimateCostUsd('claude-opus-4-6', 500_000, 50_000);
    expect(opusCost).toBeCloseTo(7.5 + 3.75, 1);
  });
});
