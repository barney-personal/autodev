/**
 * Tests for diagnoseWriteNoteInOutput — NDJSON write_note diagnostic helper.
 *
 * Verifies:
 * 1. Returns 'never_called' when no agents or no write_note tool_use events
 * 2. Returns 'called_successfully' when write_note was called without an error result
 * 3. Returns 'called_but_failed' with a summary when write_note has an error tool_result
 * 4. Tolerates malformed / partial NDJSON rows without throwing
 * 5. Recognises both 'write_note' and 'mcp__orchestrator__write_note' tool names
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupTestDb,
  cleanupTestDb,
} from './helpers.js';

// Minimal mocks so WorkflowManager can be imported in isolation
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../server/socket/SocketManager.js', () => ({
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
  emitDeadlockResolved: vi.fn(),
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
}));

vi.mock('../server/orchestrator/WorkflowPrompts.js', () => ({
  buildAssessPrompt: vi.fn(() => 'mock assess prompt'),
  buildReviewPrompt: vi.fn(() => 'mock review prompt'),
  buildImplementPrompt: vi.fn(() => 'mock implement prompt'),
  buildWorkflowRepairPrompt: vi.fn(() => 'mock repair prompt'),
  buildSimplifiedAssessRepairPrompt: vi.fn(() => 'mock simplified assess repair prompt'),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAssistantWriteNoteRow(agentId: string, seq: number, toolId: string, toolName = 'write_note') {
  return {
    agent_id: agentId,
    seq,
    event_type: 'assistant' as const,
    content: JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: toolName,
            id: toolId,
            input: { key: 'workflow/test-id/plan', value: '# Plan\n\n- [ ] **M1**' },
          },
        ],
      },
    }),
    created_at: Date.now(),
  };
}

function makeSuccessToolResultRow(agentId: string, seq: number, toolId: string) {
  return {
    agent_id: agentId,
    seq,
    event_type: 'user' as const,
    content: JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: false,
            content: 'Note written successfully',
          },
        ],
      },
    }),
    created_at: Date.now(),
  };
}

function makeErrorToolResultRow(agentId: string, seq: number, toolId: string, errorMsg: string) {
  return {
    agent_id: agentId,
    seq,
    event_type: 'user' as const,
    content: JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: true,
            content: errorMsg,
          },
        ],
      },
    }),
    created_at: Date.now(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('diagnoseWriteNoteInOutput', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('returns never_called when no agents exist for the job', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob } = await import('../server/db/queries.js');

    const job = insertJob({
      id: randomUUID(),
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('never_called');
  });

  it('returns never_called when agent exists but has no write_note tool_use events', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    // Insert output rows that don't contain write_note
    insertAgentOutput({
      agent_id: agentId,
      seq: 1,
      event_type: 'assistant',
      content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will assess the codebase.' }] } }),
      created_at: Date.now(),
    });

    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('never_called');
  });

  it('returns called_successfully when write_note was called without an error result', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    const toolId = randomUUID();
    insertAgentOutput(makeAssistantWriteNoteRow(agentId, 1, toolId));
    insertAgentOutput(makeSuccessToolResultRow(agentId, 2, toolId));

    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('called_successfully');
  });

  it('returns called_but_failed with summary when write_note returns an error result', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    const toolId = randomUUID();
    const errorMsg = 'MCP connection error: Failed to reach orchestrator';
    insertAgentOutput(makeAssistantWriteNoteRow(agentId, 1, toolId));
    insertAgentOutput(makeErrorToolResultRow(agentId, 2, toolId, errorMsg));

    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('called_but_failed');
    if (result.status === 'called_but_failed') {
      expect(result.failureSummary).toContain('MCP connection error');
    }
  });

  it('recognises mcp__orchestrator__write_note tool name as a write_note call', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    const toolId = randomUUID();
    // Use the namespaced MCP tool name
    insertAgentOutput(makeAssistantWriteNoteRow(agentId, 1, toolId, 'mcp__orchestrator__write_note'));
    insertAgentOutput(makeSuccessToolResultRow(agentId, 2, toolId));

    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('called_successfully');
  });

  it('tolerates malformed NDJSON rows without throwing', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    // Malformed rows: invalid JSON, truncated, and empty content
    insertAgentOutput({ agent_id: agentId, seq: 1, event_type: 'assistant', content: '{not valid json', created_at: Date.now() });
    insertAgentOutput({ agent_id: agentId, seq: 2, event_type: 'assistant', content: '', created_at: Date.now() });
    insertAgentOutput({ agent_id: agentId, seq: 3, event_type: 'user', content: '{"type":"user","message":{"content":null}}', created_at: Date.now() });

    // Should not throw, should degrade to never_called
    expect(() => diagnoseWriteNoteInOutput(job)).not.toThrow();
    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('never_called');
  });

  it('uses last error result when write_note is called multiple times and one fails', async () => {
    const { diagnoseWriteNoteInOutput } = await import('../server/orchestrator/WorkflowManager.js');
    const { insertJob, insertAgent, insertAgentOutput } = await import('../server/db/queries.js');

    const jobId = randomUUID();
    const job = insertJob({
      id: jobId,
      title: 'test job',
      description: 'test',
      context: null,
      priority: 0,
      status: 'done' as any,
      workflow_id: null,
      workflow_cycle: null,
      workflow_phase: null as any,
      project_id: null,
      work_dir: null,
      model: null,
    });

    const agentId = randomUUID();
    insertAgent({ id: agentId, job_id: jobId });

    // First call succeeds
    const toolId1 = randomUUID();
    insertAgentOutput(makeAssistantWriteNoteRow(agentId, 1, toolId1));
    insertAgentOutput(makeSuccessToolResultRow(agentId, 2, toolId1));

    // Second call fails
    const toolId2 = randomUUID();
    const errorMsg = 'Timeout writing to orchestrator';
    insertAgentOutput(makeAssistantWriteNoteRow(agentId, 3, toolId2));
    insertAgentOutput(makeErrorToolResultRow(agentId, 4, toolId2, errorMsg));

    // Any error → called_but_failed
    const result = diagnoseWriteNoteInOutput(job);
    expect(result.status).toBe('called_but_failed');
    if (result.status === 'called_but_failed') {
      expect(result.failureSummary).toContain('Timeout');
    }
  });
});
