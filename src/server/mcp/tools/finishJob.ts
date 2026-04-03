import { z } from 'zod';
import * as queries from '../../db/queries.js';
import { runJobCompletion } from '../../orchestrator/JobCompletionNotifier.js';
import { disconnectAgent } from '../../orchestrator/PtyManager.js';

export const finishJobSchema = z.object({
  result: z.string().optional().describe('Summary of what was accomplished'),
});

export async function finishJobHandler(
  agentId: string,
  input: z.infer<typeof finishJobSchema>,
): Promise<string> {
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (!agentWithJob) return JSON.stringify({ error: 'Agent not found' });

  const { job } = agentWithJob;

  // Store result as a synthetic result event so getAgentResultText can find it.
  // Always store first — even if already terminal — so result text is never lost.
  if (input.result) {
    const seq = queries.getAgentLastSeq(agentId) + 1;
    queries.insertAgentOutput({
      agent_id: agentId,
      seq,
      event_type: 'result',
      content: JSON.stringify({ type: 'result', result: input.result, is_error: false }),
      created_at: Date.now(),
    });
  }

  // Idempotency: if agent is already in a terminal state, skip processing.
  // The result event above is still stored so we never lose result text.
  const TERMINAL = ['done', 'failed', 'cancelled'];
  if (TERMINAL.includes(agentWithJob.status)) {
    return JSON.stringify({ ok: true, message: 'Already completed.' });
  }

  // Mark agent done before running post-processing
  queries.updateAgent(agentId, { status: 'done', finished_at: Date.now() });

  // Run shared post-processing (git diff, completion checks, learnings, debate, retry, etc.)
  await runJobCompletion(agentId, job, 'done');

  // Kill the tmux session after a brief delay so this tool response can be delivered first
  setTimeout(() => disconnectAgent(agentId), 500);

  return JSON.stringify({ ok: true, message: 'Task complete. Session closing.' });
}
