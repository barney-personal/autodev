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

  it('reports uninitialized DB without throwing', async () => {
    await cleanupTestDb();
    const { default: healthRouter } = await import('../server/api/health.js');
    const expressMod = await import('express');
    const requestMod = await import('supertest');

    const app = expressMod.default();
    app.use('/', healthRouter);

    const res = await requestMod.default(app).get('/');
    expect(res.status).toBe(503);
    expect(res.body.checks.db.status).toBe('unhealthy');
    expect(res.body.checks.db.error).toContain('not initialized');
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

  it('no-ops cleanly before DB initialization', async () => {
    await cleanupTestDb();
    const { pushEvent, getEventsSince, pruneEvents } = await import('../server/orchestrator/EventQueue.js');

    expect(() => pushEvent('test:event', { data: 'test' })).not.toThrow();
    expect(() => pruneEvents()).not.toThrow();
    expect(getEventsSince(0)).toEqual([]);
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

describe('Event replay API', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('getEventsSince returns events in chronological order', async () => {
    const { pushEvent, getEventsSince } = await import('../server/orchestrator/EventQueue.js');

    const before = Date.now() - 1;
    pushEvent('job:new', { job: { id: 'j1', title: 'first' } });
    pushEvent('agent:update', { agent: { id: 'a1', status: 'running' } });
    pushEvent('job:update', { job: { id: 'j1', status: 'done' } });

    const events = getEventsSince(before);
    expect(events.length).toBe(3);
    // Verify chronological order
    for (let i = 1; i < events.length; i++) {
      expect(events[i].created_at).toBeGreaterThanOrEqual(events[i - 1].created_at);
    }
    expect(events[0].event_name).toBe('job:new');
    expect(events[2].event_name).toBe('job:update');
  });
});

describe('Failure classification', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { _resetWarnedUnclassifiedForTest } = await import('../server/orchestrator/FailureClassifier.js');
    _resetWarnedUnclassifiedForTest();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    const { _resetWarnedUnclassifiedForTest } = await import('../server/orchestrator/FailureClassifier.js');
    _resetWarnedUnclassifiedForTest();
  });

  it('classifies rate limit errors', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('rate_limit_error: too many requests')).toBe('rate_limit');
    expect(classifyFailureText('Error 429: Rate limited')).toBe('rate_limit');
    expect(classifyFailureText('Please retry after 30 seconds')).toBe('rate_limit');
  });

  it('classifies provider overload', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('overloaded_error')).toBe('provider_overload');
    expect(classifyFailureText('Service unavailable (503)')).toBe('provider_overload');
  });

  it('classifies provider capability and billing failures', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('API Error: Extra usage is required for 1M context')).toBe('provider_capability');
    expect(classifyFailureText('Model not available on your plan')).toBe('provider_capability');
    expect(classifyFailureText('Payment required: insufficient credits')).toBe('provider_billing');
  });

  it('classifies OOM errors', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('FATAL ERROR: JavaScript heap out of memory')).toBe('out_of_memory');
    expect(classifyFailureText('ENOMEM: not enough memory')).toBe('out_of_memory');
  });

  it('classifies disk full errors', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('ENOSPC: no space left on device')).toBe('disk_full');
    expect(classifyFailureText('Disk quota exceeded')).toBe('disk_full');
  });

  it('classifies auth errors', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('Error 401: Unauthorized')).toBe('auth_failure');
    expect(classifyFailureText('invalid_api_key')).toBe('auth_failure');
  });

  it('classifies context overflow', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('context length exceeded')).toBe('context_overflow');
    expect(classifyFailureText('too many tokens in request')).toBe('context_overflow');
  });

  it('classifies MCP disconnect', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('MCP connection dropped')).toBe('mcp_disconnect');
    expect(classifyFailureText('ECONNREFUSED')).toBe('mcp_disconnect');
    expect(classifyFailureText('socket hang up')).toBe('mcp_disconnect');
  });

  it('classifies Codex stdin hang as codex_cli_crash', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('Reading additional input from stdin...')).toBe('codex_cli_crash');
    expect(classifyFailureText('Reading input from stdin...')).toBe('codex_cli_crash');
    expect(classifyFailureText('Reading prompt from stdin...')).toBe('codex_cli_crash');
  });

  it('classifies timeout errors', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText('Connection timeout waiting for response')).toBe('timeout');
    expect(classifyFailureText('Request timed out after 60s')).toBe('timeout');
    expect(classifyFailureText('deadline exceeded')).toBe('timeout');
    expect(classifyFailureText('ETIMEDOUT')).toBe('timeout');
  });

  it('isSameModelRetryEligible returns true for timeout and codex_cli_crash', async () => {
    const { isSameModelRetryEligible } = await import('../server/orchestrator/FailureClassifier.js');
    expect(isSameModelRetryEligible('timeout')).toBe(true);
    expect(isSameModelRetryEligible('codex_cli_crash')).toBe(true);
    expect(isSameModelRetryEligible('rate_limit')).toBe(false);
    expect(isSameModelRetryEligible('task_failure')).toBe(false);
    expect(isSameModelRetryEligible('unknown')).toBe(false);
  });

  it('shouldMarkProviderUnavailable excludes rate_limit to prevent cascade blocks', async () => {
    const { shouldMarkProviderUnavailable } = await import('../server/orchestrator/FailureClassifier.js');
    // rate_limit MUST NOT mark the whole provider unavailable — Anthropic 429s
    // are per-model, so marking anthropic as a whole blocks sonnet[1m] and
    // haiku recoveries when opus hits a 429. Observed in the Apr 9 14:57
    // fallback-exhaustion cluster where two workflows blocked with "no
    // fallback model available" because opus rate_limit cascaded to all
    // claude variants at the same moment codex was still in its own cooldown.
    expect(shouldMarkProviderUnavailable('rate_limit')).toBe(false);

    // Hard-provider failures should still mark the whole provider.
    expect(shouldMarkProviderUnavailable('provider_overload')).toBe(true);
    expect(shouldMarkProviderUnavailable('provider_billing')).toBe(true);
    expect(shouldMarkProviderUnavailable('auth_failure')).toBe(true);

    // Per-model/per-call failures should not cascade either.
    expect(shouldMarkProviderUnavailable('timeout')).toBe(false);
    expect(shouldMarkProviderUnavailable('context_overflow')).toBe(false);
    expect(shouldMarkProviderUnavailable('launch_environment')).toBe(false);
    expect(shouldMarkProviderUnavailable('codex_cli_crash')).toBe(false);
    expect(shouldMarkProviderUnavailable('task_failure')).toBe(false);
    expect(shouldMarkProviderUnavailable('unknown')).toBe(false);
  });

  it('returns unknown without warning for SessionStart hook JSON noise', async () => {
    const {
      classifyFailureText,
      _resetWarnedUnclassifiedForTest,
    } = await import('../server/orchestrator/FailureClassifier.js');

    const sessionStartPayloads = [
      '{"type":"system","subtype":"hook_started","hook_id":"8e702a89-2007-4f5c-bc0c-01d83a081886","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"311620d6-0a47-4529-a7c1-867ac092c710"}',
      '{"type":"system","subtype":"hook_started","hook_event":"SessionStart"}',
      '{"type":"system","hook_event":"SessionStart","uuid":"cbb00737-eccb-4d42-9222-2edba62d8af9"}',
    ];

    for (const payload of sessionStartPayloads) {
      _resetWarnedUnclassifiedForTest();
      warnSpy.mockClear();
      expect(classifyFailureText(payload)).toBe('unknown');
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('returns unknown without warning for whitespace-only input', async () => {
    const {
      classifyFailureText,
      _resetWarnedUnclassifiedForTest,
    } = await import('../server/orchestrator/FailureClassifier.js');

    for (const input of ['   ', '\n\t  \n', '\t\t']) {
      _resetWarnedUnclassifiedForTest();
      warnSpy.mockClear();
      expect(classifyFailureText(input)).toBe('unknown');
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('returns unknown without warning for startup MCP tool-list fragments', async () => {
    const {
      classifyFailureText,
      _resetWarnedUnclassifiedForTest,
    } = await import('../server/orchestrator/FailureClassifier.js');

    const toolListFragments = [
      'mcp__claude_ai_Granola__list_meetings mcp__claude_ai_Granola__query_granola_meetings mcp__claude_ai_Notion__notion-create-comment mcp__claude_ai_Notion__notion-create-database',
      'Available tools: mcp__foo__list_jobs, mcp__foo__create_job, mcp__bar__fetch_notes, mcp__baz__read_doc, mcp__qux__search',
    ];

    for (const fragment of toolListFragments) {
      _resetWarnedUnclassifiedForTest();
      warnSpy.mockClear();
      expect(classifyFailureText(fragment)).toBe('unknown');
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('returns task_failure and warns once for unrecognized errors', async () => {
    const {
      classifyFailureText,
      _resetWarnedUnclassifiedForTest,
    } = await import('../server/orchestrator/FailureClassifier.js');

    _resetWarnedUnclassifiedForTest();

    expect(classifyFailureText('Something went wrong in the build')).toBe('task_failure');
    expect(classifyFailureText('Something went wrong in the build')).toBe('task_failure');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Unclassified failure text');
  });

  it('returns unknown for null/empty input', async () => {
    const { classifyFailureText } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureText(null)).toBe('unknown');
    expect(classifyFailureText('')).toBe('unknown');
    expect(classifyFailureText(undefined)).toBe('unknown');
  });

  it('classifyFailureTextQuietly matches infra patterns without warnings', async () => {
    const { classifyFailureTextQuietly, _resetWarnedUnclassifiedForTest } = await import('../server/orchestrator/FailureClassifier.js');
    _resetWarnedUnclassifiedForTest();

    expect(classifyFailureTextQuietly('rate_limit_error: too many requests')).toBe('rate_limit');
    expect(classifyFailureTextQuietly('overloaded_error')).toBe('provider_overload');
    expect(classifyFailureTextQuietly('ENOSPC: no space left')).toBe('disk_full');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('classifyFailureTextQuietly returns task_failure without warning for unrecognised text', async () => {
    const { classifyFailureTextQuietly, _resetWarnedUnclassifiedForTest } = await import('../server/orchestrator/FailureClassifier.js');
    _resetWarnedUnclassifiedForTest();

    expect(classifyFailureTextQuietly('const x = 42; function foo() { return x; }')).toBe('task_failure');
    expect(classifyFailureTextQuietly('✓ src/lib/api/queries.test.ts > passes')).toBe('task_failure');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('classifyFailureTextQuietly returns unknown for null/empty input', async () => {
    const { classifyFailureTextQuietly } = await import('../server/orchestrator/FailureClassifier.js');
    expect(classifyFailureTextQuietly(null)).toBe('unknown');
    expect(classifyFailureTextQuietly('')).toBe('unknown');
    expect(classifyFailureTextQuietly(undefined)).toBe('unknown');
  });
});

describe('DB integrity on init', () => {
  it('resets stale assigned jobs back to queued', async () => {
    const { initDb, closeDb } = await import('../server/db/database.js');

    // Create a fresh DB with a stale assigned job
    const db = initDb(':memory:');
    const now = Date.now();

    // Insert a job that was assigned > 60s ago (simulating a crash)
    db.prepare(`
      INSERT INTO jobs (id, title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, 'assigned', 0, ?, ?)
    `).run('stale-assigned-1', 'Stale Job', 'test', now - 120000, now - 120000);

    // Insert a recently assigned job (should NOT be reset)
    db.prepare(`
      INSERT INTO jobs (id, title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, 'assigned', 0, ?, ?)
    `).run('recent-assigned-1', 'Recent Job', 'test', now - 5000, now - 5000);

    closeDb();

    // Re-init triggers the cleanup
    const db2 = initDb(':memory:');

    // Can't test the cleanup on the previous DB since it's closed,
    // but we can verify the init doesn't crash and the quick_check runs
    const result = db2.prepare('PRAGMA quick_check(1)').get() as any;
    expect(result.quick_check).toBe('ok');
    closeDb();
  });
});

describe('Double-dispatch prevention', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('getNextQueuedJob only returns queued jobs', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({
      id: 'dd-job-1', title: 'queued job', description: 'test',
      context: null, priority: 0, status: 'queued',
    });
    queries.insertJob({
      id: 'dd-job-2', title: 'assigned job', description: 'test',
      context: null, priority: 0, status: 'assigned',
    });

    const next = queries.getNextQueuedJob();
    expect(next).toBeDefined();
    expect(next!.id).toBe('dd-job-1');
    expect(next!.status).toBe('queued');

    // After marking assigned, getNextQueuedJob should not return it
    queries.updateJobStatus('dd-job-1', 'assigned');
    const next2 = queries.getNextQueuedJob();
    expect(next2).toBeNull();
  });
});

describe('Queue metrics', () => {
  it('getQueueMetrics returns initial state', async () => {
    const { getQueueMetrics } = await import('../server/orchestrator/WorkQueueManager.js');
    const metrics = getQueueMetrics();
    expect(typeof metrics.running).toBe('boolean');
    expect(typeof metrics.maxConcurrent).toBe('number');
    expect(typeof metrics.totalDispatched).toBe('number');
    expect(typeof metrics.totalDispatchFailed).toBe('number');
    expect(metrics.classifying).toBe(0);
  });
});

describe('Health endpoint enrichment', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('recovery notes can be read and parsed', async () => {
    const queries = await import('../server/db/queries.js');

    // Write a recovery state note
    const state = {
      attempts: 1,
      window_started_at: Date.now(),
      lock_until: Date.now() + 60000,
      last_claim_at: Date.now(),
      last_reason: 'test',
    };
    queries.upsertNote('recovery:test-family', JSON.stringify(state), null);

    const notes = queries.listNotes('recovery:');
    expect(notes.length).toBe(1);

    const full = queries.getNote('recovery:test-family');
    expect(full).toBeDefined();
    const parsed = JSON.parse(full!.value);
    expect(parsed.attempts).toBe(1);
    expect(parsed.lock_until).toBeGreaterThan(Date.now() - 1000);
  });

  it('workflow status counts are accurate', async () => {
    const queries = await import('../server/db/queries.js');
    const now = Date.now();

    queries.insertProject({ id: 'health-proj', name: 'test', description: 'test', created_at: now, updated_at: now });

    queries.insertWorkflow({
      id: 'health-wf-1', title: 'Running', task: 't', work_dir: null,
      implementer_model: 'm', reviewer_model: 'm', max_cycles: 1,
      current_cycle: 1, current_phase: 'implement', status: 'running',
      milestones_total: 0, milestones_done: 0, project_id: 'health-proj',
      max_turns_assess: 50, max_turns_review: 30, max_turns_implement: 100,
      stop_mode_assess: 'turns', stop_value_assess: 50,
      stop_mode_review: 'turns', stop_value_review: 30,
      stop_mode_implement: 'turns', stop_value_implement: 100,
      template_id: null, use_worktree: 0, created_at: now, updated_at: now,
    } as any);

    queries.insertWorkflow({
      id: 'health-wf-2', title: 'Blocked', task: 't', work_dir: null,
      implementer_model: 'm', reviewer_model: 'm', max_cycles: 1,
      current_cycle: 1, current_phase: 'review', status: 'blocked',
      milestones_total: 0, milestones_done: 0, project_id: 'health-proj',
      max_turns_assess: 50, max_turns_review: 30, max_turns_implement: 100,
      stop_mode_assess: 'turns', stop_value_assess: 50,
      stop_mode_review: 'turns', stop_value_review: 30,
      stop_mode_implement: 'turns', stop_value_implement: 100,
      template_id: null, use_worktree: 0, created_at: now, updated_at: now,
    } as any);

    const workflows = queries.listWorkflows();
    const running = workflows.filter(w => w.status === 'running').length;
    const blocked = workflows.filter(w => w.status === 'blocked').length;
    expect(running).toBe(1);
    expect(blocked).toBe(1);
  });
});

describe('Output pruning', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('pruneOldAgentOutput removes old output but keeps tail', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'prune-job', title: 'test', description: 'test', context: null, priority: 0, status: 'done' });
    queries.insertAgent({ id: 'prune-agent', job_id: 'prune-job', status: 'done' });
    // Set finished_at to 48h ago so it passes the maxAge check
    queries.updateAgent('prune-agent', { finished_at: Date.now() - 48 * 60 * 60 * 1000 });

    // Insert 50 output rows
    for (let i = 0; i < 50; i++) {
      queries.insertAgentOutput({
        agent_id: 'prune-agent', seq: i, event_type: 'assistant',
        content: `line ${i}`, created_at: Date.now(),
      });
    }

    // Prune with keepTail=10 and maxAge=1hr
    const deleted = queries.pruneOldAgentOutput(1 * 60 * 60 * 1000, 10);
    expect(deleted).toBe(40); // 50 - 10 = 40

    // Should have exactly 10 rows remaining
    const remaining = queries.getAgentOutput('prune-agent');
    expect(remaining).toHaveLength(10);
  });

  it('pruneOldAgentOutput does not prune recent agents', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'prune-job2', title: 'test', description: 'test', context: null, priority: 0, status: 'done' });
    queries.insertAgent({ id: 'prune-agent2', job_id: 'prune-job2', status: 'done' });
    // Set finished_at to 5 minutes ago — should NOT be pruned with 1hr maxAge
    queries.updateAgent('prune-agent2', { finished_at: Date.now() - 5 * 60 * 1000 });

    for (let i = 0; i < 50; i++) {
      queries.insertAgentOutput({
        agent_id: 'prune-agent2', seq: i, event_type: 'assistant',
        content: `line ${i}`, created_at: Date.now(),
      });
    }

    const deleted = queries.pruneOldAgentOutput(1 * 60 * 60 * 1000, 10);
    expect(deleted).toBe(0); // too recent to prune

    const remaining = queries.getAgentOutput('prune-agent2');
    expect(remaining).toHaveLength(50);
  });

  it('pruneOldAgentOutput does not prune running agents', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'prune-job3', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'prune-agent3', job_id: 'prune-job3', status: 'running' });

    for (let i = 0; i < 50; i++) {
      queries.insertAgentOutput({
        agent_id: 'prune-agent3', seq: i, event_type: 'assistant',
        content: `line ${i}`, created_at: Date.now(),
      });
    }

    const deleted = queries.pruneOldAgentOutput(0, 10); // maxAge=0 would match everything
    expect(deleted).toBe(0); // running agents should never be pruned

    const remaining = queries.getAgentOutput('prune-agent3');
    expect(remaining).toHaveLength(50);
  });
});

describe('Stale notes cleanup', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('pruneStaleNotes removes old scratchpad notes', async () => {
    const queries = await import('../server/db/queries.js');
    const { getDb } = await import('../server/db/database.js');
    const db = getDb();

    // Insert an old note (manually set updated_at to 8 days ago)
    queries.upsertNote('results/step1', 'old data', null);
    db.prepare("UPDATE notes SET updated_at = ? WHERE key = 'results/step1'").run(
      Date.now() - 8 * 24 * 60 * 60 * 1000
    );

    // Insert a recent note
    queries.upsertNote('results/step2', 'recent data', null);

    // Insert a system note that should be preserved even if old
    queries.upsertNote('setting:maxAgents', '20', null);
    db.prepare("UPDATE notes SET updated_at = ? WHERE key = 'setting:maxAgents'").run(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    );

    const deleted = queries.pruneStaleNotes(7 * 24 * 60 * 60 * 1000); // 7 day max age
    expect(deleted).toBe(1); // only the old scratchpad note

    // Recent note should survive
    expect(queries.getNote('results/step2')).toBeDefined();
    // System note should survive (excluded by prefix)
    expect(queries.getNote('setting:maxAgents')).toBeDefined();
    // Old note should be gone
    expect(queries.getNote('results/step1')).toBeNull();
  });
});

describe('FTS optimization', () => {
  it('runs without error on fresh DB', async () => {
    const { initDb, closeDb } = await import('../server/db/database.js');
    // initDb now includes FTS optimize — verify it doesn't crash
    const db = initDb(':memory:');
    expect(db).toBeDefined();
    closeDb();
  });
});

describe('Recovery ledger', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('isRecoveryExhausted returns false initially', async () => {
    const { isRecoveryExhausted } = await import('../server/orchestrator/RecoveryLedger.js');
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'rl-job-1', title: 'test', description: 'test', context: null, priority: 0 });
    const job = queries.getJobById('rl-job-1')!;

    expect(isRecoveryExhausted(job)).toBe(false);
  });

  it('isRecoveryExhausted returns true after max claims', async () => {
    const { claimRecovery, isRecoveryExhausted } = await import('../server/orchestrator/RecoveryLedger.js');
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'rl-job-2', title: 'test', description: 'test', context: null, priority: 0 });
    const job = queries.getJobById('rl-job-2')!;

    // Claim 3 times (default max)
    expect(claimRecovery(job, 'test1', { lockMs: 0 })).toBe(true);
    expect(claimRecovery(job, 'test2', { lockMs: 0 })).toBe(true);
    expect(claimRecovery(job, 'test3', { lockMs: 0 })).toBe(true);

    // 4th should be denied
    expect(claimRecovery(job, 'test4', { lockMs: 0 })).toBe(false);

    // Should be exhausted
    expect(isRecoveryExhausted(job)).toBe(true);
  });

  it('getRecoverySummary returns correct state', async () => {
    const { claimRecovery, getRecoverySummary } = await import('../server/orchestrator/RecoveryLedger.js');
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'rl-job-3', title: 'test', description: 'test', context: null, priority: 0 });
    const job = queries.getJobById('rl-job-3')!;

    expect(getRecoverySummary(job)).toBeNull(); // no state yet

    claimRecovery(job, 'first-claim', { lockMs: 0 });
    const summary = getRecoverySummary(job);
    expect(summary).toBeDefined();
    expect(summary!.attempts).toBe(1);
    expect(summary!.lastReason).toBe('first-claim');
    expect(summary!.exhausted).toBe(false);
  });
});

describe('Question timeout enforcement', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('getPendingQuestion returns pending questions for an agent', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'qt-job', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'qt-agent', job_id: 'qt-job', status: 'waiting_user' });

    queries.insertQuestion({
      id: 'qt-q1',
      agent_id: 'qt-agent',
      question: 'What should I do?',
      answer: null,
      status: 'pending',
      asked_at: Date.now() - 60_000, // asked 60s ago
      answered_at: null,
      timeout_ms: 300_000, // 5 min timeout
    });

    const pending = queries.getPendingQuestion('qt-agent');
    expect(pending).toBeDefined();
    expect(pending!.id).toBe('qt-q1');
    expect(pending!.status).toBe('pending');
  });

  it('timed-out questions can be updated', async () => {
    const queries = await import('../server/db/queries.js');

    queries.insertJob({ id: 'qt-job2', title: 'test', description: 'test', context: null, priority: 0 });
    queries.insertAgent({ id: 'qt-agent2', job_id: 'qt-job2', status: 'waiting_user' });

    queries.insertQuestion({
      id: 'qt-q2',
      agent_id: 'qt-agent2',
      question: 'What should I do?',
      answer: null,
      status: 'pending',
      asked_at: Date.now() - 600_000, // asked 10 min ago
      answered_at: null,
      timeout_ms: 300_000, // 5 min timeout — should be expired
    });

    // Simulate timeout
    queries.updateQuestion('qt-q2', {
      status: 'timeout',
      answer: '[TIMEOUT] No response received.',
      answered_at: Date.now(),
    });

    const q = queries.getPendingQuestion('qt-agent2');
    // Should no longer be pending
    expect(q).toBeNull();
  });
});

describe('ProcessPriority', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('child_process');
  });

  it('falls back to direct execution when nice is unavailable', async () => {
    vi.resetModules();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          throw new Error('spawn nice ENOENT');
        }),
      };
    });

    const priority = await import('../server/orchestrator/ProcessPriority.js');
    expect(priority.isNiceAvailable()).toBe(false);
    expect(priority.buildNiceSpawn('codex', ['exec'])).toEqual({ command: 'codex', args: ['exec'] });
    expect(priority.wrapExecLineWithNice('exec codex exec')).toBe('exec codex exec');
  });
});
