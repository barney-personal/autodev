/**
 * Integration test for ResolverSession with a stubbed Anthropic client.
 * Exercises the full loop: tool dispatch → tool results → terminal call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestWorkflow } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

import * as queries from '../server/db/queries.js';
import {
  runResolverSession,
  _setResolverAnthropicClient,
} from '../server/orchestrator/ResolverSession.js';
import { buildResolverContext } from '../server/orchestrator/ResolverContext.js';
import type Anthropic from '@anthropic-ai/sdk';

interface ScriptedResponse {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use';
  usage?: Partial<Anthropic.Messages.Usage>;
}

class StubAnthropic {
  private idx = 0;
  constructor(private script: ScriptedResponse[]) {}

  messages = {
    create: async () => {
      if (this.idx >= this.script.length) {
        throw new Error('StubAnthropic ran out of scripted responses');
      }
      const next = this.script[this.idx++];
      return {
        id: `msg_${this.idx}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: next.content,
        stop_reason: next.stop_reason,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          ...next.usage,
        },
      } as unknown as Anthropic.Messages.Message;
    },
  };
}

beforeEach(async () => {
  await setupTestDb();
  delete process.env.RESOLVER_MAX_COST_USD;
  delete process.env.RESOLVER_MAX_TURNS;
});

afterEach(async () => {
  _setResolverAnthropicClient(null);
  await cleanupTestDb();
});

describe('runResolverSession', () => {
  it('completes when model proposes resume', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked', work_dir: null });
    queries.updateWorkflow(wf.id, { blocked_reason: 'PTY exhausted; fork failed' });

    const stub = new StubAnthropic([
      {
        // Turn 1: model calls set_classification
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u1', name: 'set_classification',
            input: { classification: 'transient_infra', diagnosis: 'PTY pool exhausted. Retry should clear it.' } } as never,
        ],
      },
      {
        // Turn 2: model calls propose_resume (terminal)
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u2', name: 'propose_resume',
            input: { phase: 'implement', cycle: 1, confidence: 0.8, summary: 'transient infra; retry' } } as never,
        ],
      },
    ]);
    _setResolverAnthropicClient(stub as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'r1', workflow_id: wf.id, trigger_reason: fresh.blocked_reason!,
      reason_fingerprint: 'abc123', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });

    expect(outcome.status).toBe('resolved');
    expect(outcome.terminal?.kind).toBe('propose_resume');
    const persisted = queries.getResolverRunById(run.id)!;
    expect(persisted.classification).toBe('transient_infra');
    expect(persisted.diagnosis).toContain('PTY pool exhausted');
    expect(persisted.cost_usd).toBeGreaterThan(0);
    expect(persisted.turn_count).toBe(2);
  });

  it('finishes as unresolvable (distinct from escalated) when model calls mark_unresolvable', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked', work_dir: null });
    queries.updateWorkflow(wf.id, { blocked_reason: 'nothing to do' });

    const stub = new StubAnthropic([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u1', name: 'mark_unresolvable',
            input: { reason: 'workflow is in an only-human-can-fix state' } } as never,
        ],
      },
    ]);
    _setResolverAnthropicClient(stub as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'unresolvable-1', workflow_id: wf.id, trigger_reason: 'nothing to do',
      reason_fingerprint: 'fp-unr', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });
    expect(outcome.status).toBe('unresolvable');
    expect(outcome.terminal?.kind).toBe('unresolvable');
    const persisted = queries.getResolverRunById(run.id)!;
    expect(persisted.status).toBe('unresolvable');
  });

  it('finishes as escalated when model calls escalate_to_user', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked', work_dir: null });
    queries.updateWorkflow(wf.id, { blocked_reason: 'unknown failure mode' });

    const stub = new StubAnthropic([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u1', name: 'escalate_to_user',
            input: { question: 'Need help — unclear what failed', context: 'see logs', suggested_actions: ['retry manually'] } } as never,
        ],
      },
    ]);
    _setResolverAnthropicClient(stub as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'r2', workflow_id: wf.id, trigger_reason: 'unknown failure mode',
      reason_fingerprint: 'def456', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });
    expect(outcome.status).toBe('escalated');
    expect(outcome.terminal?.kind).toBe('escalated');
  });

  it('aborts cleanly on API error', async () => {
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'something' });

    const failClient = {
      messages: { create: async () => { throw new Error('429 rate limit'); } },
    };
    _setResolverAnthropicClient(failClient as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'r3', workflow_id: wf.id, trigger_reason: 'something',
      reason_fingerprint: 'ghi789', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/429/);
    const persisted = queries.getResolverRunById(run.id)!;
    expect(persisted.status).toBe('failed');
    expect(persisted.error_message).toMatch(/429/);
  });

  it('aborts when per-run cost cap is exceeded', async () => {
    process.env.RESOLVER_MAX_COST_USD = '0.0001';   // tiny cap; the first turn will blow past it
    process.env.RESOLVER_MAX_TURNS = '10';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'expensive turn' });

    const expensiveTurn: ScriptedResponse = {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'u1', name: 'read_blocked_diagnostic', input: {} } as never,
      ],
      // Big enough usage to drive cost over 0.0001 USD on the first turn.
      usage: { input_tokens: 100_000, output_tokens: 50_000 } as Partial<Anthropic.Messages.Usage>,
    };
    const stub = new StubAnthropic([expensiveTurn, expensiveTurn]);
    _setResolverAnthropicClient(stub as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'cost-cap-1', workflow_id: wf.id, trigger_reason: 'expensive turn',
      reason_fingerprint: 'fp-cost', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });
    expect(outcome.status).toBe('aborted');
    expect(outcome.error).toMatch(/cost cap/);
    const persisted = queries.getResolverRunById(run.id)!;
    expect(persisted.status).toBe('aborted');
    expect(persisted.finished_at).not.toBeNull();
    expect(persisted.cost_usd).toBeGreaterThan(0);
  });

  it('aborts when turn cap is exhausted with no terminal call', async () => {
    process.env.RESOLVER_MAX_TURNS = '2';
    const wf = await insertTestWorkflow({ status: 'blocked' });
    queries.updateWorkflow(wf.id, { blocked_reason: 'loop forever' });

    const nonTerminalTurn: ScriptedResponse = {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'uX', name: 'read_blocked_diagnostic', input: {} } as never,
      ],
    };
    const stub = new StubAnthropic([nonTerminalTurn, nonTerminalTurn]);
    _setResolverAnthropicClient(stub as unknown as Anthropic);

    const fresh = queries.getWorkflowById(wf.id)!;
    const bundle = buildResolverContext({ workflow: fresh, attemptNumber: 1 });
    const run = queries.insertResolverRun({
      id: 'r4', workflow_id: wf.id, trigger_reason: 'loop forever',
      reason_fingerprint: 'jkl012', attempt: 1, model: 'claude-opus-4-7',
    });

    const outcome = await runResolverSession({ run, bundle });
    expect(outcome.status).toBe('aborted');
    expect(outcome.error).toMatch(/turn cap/);
  });
});
