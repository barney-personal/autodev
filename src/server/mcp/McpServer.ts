import { Sentry } from '../instrument.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer as MCP, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { askUserHandler, askUserSchema } from './tools/askUser.js';
import { lockFilesHandler, lockFilesSchema } from './tools/lockFiles.js';
import { releaseFilesHandler, releaseFilesSchema } from './tools/releaseFiles.js';
import { checkFileLocksHandler, checkFileLocksSchema } from './tools/checkFileLocks.js';
import { reportStatusHandler, reportStatusSchema } from './tools/reportStatus.js';
import { createJobHandler, createJobSchema } from './tools/createJob.js';
import { createAutonomousAgentRunHandler, createAutonomousAgentRunSchema } from './tools/createAutonomousAgentRun.js';
import { waitForJobsHandler, waitForJobsSchema, activeWaits, abortAgentWait } from './tools/waitForJobs.js';
import { writeNoteHandler, writeNoteSchema, readNoteHandler, readNoteSchema, listNotesHandler, listNotesSchema } from './tools/notes.js';
import { watchNotesHandler, watchNotesSchema } from './tools/watchNotes.js';
import { searchKBHandler, searchKBSchema } from './tools/knowledgeBase.js';
import { reportLearningsHandler, reportLearningsSchema } from './tools/reportLearnings.js';
import { finishJobHandler, finishJobSchema } from './tools/finishJob.js';
import { startDiscussionHandler, startDiscussionSchema, checkDiscussionsHandler, checkDiscussionsSchema, replyDiscussionHandler, replyDiscussionSchema, createProposalHandler, createProposalSchema, checkProposalsHandler, checkProposalsSchema, replyProposalHandler, replyProposalSchema, updateProposalHandler, updateProposalSchema, reportPrHandler, reportPrSchema, reportPrReviewHandler, reportPrReviewSchema, checkPrReviewsHandler, checkPrReviewsSchema, replyPrReviewHandler, replyPrReviewSchema, updateDailySummaryHandler, updateDailySummarySchema } from './tools/eye.js';
import { queryLinearHandler, queryLinearSchema, queryLogsHandler, queryLogsSchema, queryDbHandler, queryDbSchema, queryCiLogsHandler, queryCiLogsSchema } from './tools/integrations.js';
import * as queries from '../db/queries.js';

// agentId → { sessionId → transport }
const agentTransports: Map<string, Map<string, StreamableHTTPServerTransport>> = new Map();

/**
 * Agents whose MCP connection dropped while wait_for_jobs was active.
 * agentId → { job_ids they were waiting on, timestamp of disconnect }
 * Consumed by StuckJobWatchdog to restart stuck agents once their deps complete.
 */
export const orphanedWaits = new Map<string, { job_ids: string[]; disconnected_at: number }>();

/**
 * Agents whose MCP connection dropped while NOT in wait_for_jobs.
 * agentId → timestamp of disconnect.
 * Consumed by StuckJobWatchdog: if an agent stays disconnected for more than
 * a grace period and is still "running", it's stuck (e.g. sleeping in a retry
 * loop) and should be killed + restarted.
 */
export const disconnectedAgents = new Map<string, number>();

export function hasActiveTransport(agentId: string): boolean {
  return agentTransports.has(agentId);
}

/**
 * Close all active MCP transport sessions. Call during shutdown so
 * clients get a clean disconnect instead of hanging on in-flight requests.
 */
export async function closeAllMcpSessions(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [, transportMap] of agentTransports) {
    for (const [, transport] of transportMap) {
      promises.push(transport.close().catch(() => {}));
    }
  }
  await Promise.all(promises);
  agentTransports.clear();
  disconnectedAgents.clear();
}

function makeOnClose(agentId: string, transportMap: Map<string, StreamableHTTPServerTransport>, transport: { sessionId?: string }) {
  return () => {
    const sid = transport.sessionId;
    if (sid) transportMap.delete(sid);
    if (transportMap.size === 0) agentTransports.delete(agentId);

    const waitingOn = activeWaits.get(agentId);
    if (waitingOn && waitingOn.length > 0) {
      console.warn(`[mcp] session closed while wait_for_jobs active: agent ${agentId} waiting on [${waitingOn.join(', ')}] — aborting loop, registering orphaned wait`);
      abortAgentWait(agentId);
      orphanedWaits.set(agentId, { job_ids: [...waitingOn], disconnected_at: Date.now() });
    } else {
      console.warn(`[mcp] session closed: agent ${agentId} — registering as disconnected`);
      disconnectedAgents.set(agentId, Date.now());
    }
  };
}

export function createMcpApp(): express.Application {
  const app = express();
  app.use(express.json());

  // POST — handles initialization + tool calls from agents
  app.post('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;

      // Heartbeat: refresh agent's updated_at on every MCP request so the watchdog
      // can detect agents that go idle (e.g. Claude stuck at ❯ waiting for user input).
      try { queries.updateAgent(agentId, {}); } catch { /* agent may not exist yet on init */ }

      // MCP SDK 1.26+ requires Accept header to include both application/json and
      // text/event-stream. rmcp (Codex's Rust MCP client) only sends application/json,
      // so normalize the header here to avoid 406 responses.
      //
      // IMPORTANT: The MCP SDK uses Hono's getRequestListener which reads req.rawHeaders
      // (the raw socket header array), NOT req.headers. Both must be updated.
      const accept = req.headers['accept'] ?? '';
      if (!accept.includes('text/event-stream')) {
        const newAccept = accept ? `${accept}, text/event-stream` : 'application/json, text/event-stream';
        req.headers['accept'] = newAccept;
        // Also patch rawHeaders — Hono reads rawHeaders when converting Node.js req
        // to a Web Standard Request, so req.headers changes alone are ignored.
        const ri = req.rawHeaders.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === 'accept');
        if (ri >= 0) {
          req.rawHeaders[ri + 1] = newAccept;
        } else {
          req.rawHeaders.push('Accept', newAccept);
        }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      let transportMap = agentTransports.get(agentId);
      if (!transportMap) {
        transportMap = new Map();
        agentTransports.set(agentId, transportMap);
      }

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transportMap.has(sessionId)) {
        transport = transportMap.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        console.log(`[mcp] new session: agent ${agentId}`);
        // Clear any orphaned wait / disconnect — agent has reconnected
        orphanedWaits.delete(agentId);
        disconnectedAgents.delete(agentId);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = makeOnClose(agentId, transportMap!, transport!);

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else if (isInitializeRequest(req.body)) {
        // Re-initialization with a stale session ID (e.g. after server restart) — create fresh session
        console.log(`[mcp] re-initialize: agent ${agentId} (stale session)`);
        // Clear any orphaned wait / disconnect — agent has reconnected
        orphanedWaits.delete(agentId);
        disconnectedAgents.delete(agentId);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });

        transport.onclose = makeOnClose(agentId, transportMap!, transport!);

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      } else {
        // Unknown session, non-initialize request (e.g. after server restart).
        // Claude Code won't auto-reinitialize after getting a session-not-found error —
        // it just keeps sending tool calls with the stale session ID.
        // Recover transparently: bootstrap a fresh transport using the stale session ID
        // so the agent's next tool call succeeds without any client-side reinitialize.
        if (!sessionId) {
          console.warn(`[mcp] no session ID: agent ${agentId} — returning error`);
          res.status(200).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — please re-initialize' }, id: (req.body as any)?.id ?? null });
          return;
        }

        console.warn(`[mcp] unknown session: agent ${agentId} session ${sessionId} — auto-recovering transport (server restart?)`);
        orphanedWaits.delete(agentId);
        disconnectedAgents.delete(agentId);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId!,
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transportMap!.set(sid, transport!);
          },
        });
        transport.onclose = makeOnClose(agentId, transportMap!, transport!);

        // Inject the stale session ID directly into the transport's internal state.
        // This bypasses the initialize handshake — the client already completed it
        // before the restart. The SDK's validateSession only checks that _initialized
        // is true and that the request's mcp-session-id matches sessionId, both of
        // which will now be true.
        const inner = (transport as any)._webStandardTransport as { sessionId: string; _initialized: boolean };
        inner.sessionId = sessionId;
        inner._initialized = true;
        transportMap.set(sessionId, transport);

        const server = buildMcpServer(agentId);
        await server.connect(transport);
      }

      await transport!.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp] POST error (agent ${req.params.agentId}):`, err);
      Sentry.captureException(err, { tags: { component: 'mcp', agentId: req.params.agentId } });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  // GET — SSE streaming channel (server→client notifications)
  app.get('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && agentTransports.get(agentId)?.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session' });
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[mcp] GET error (agent ${req.params.agentId}):`, err);
      Sentry.captureException(err, { tags: { component: 'mcp', agentId: req.params.agentId } });
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  // DELETE — session termination
  app.delete('/mcp/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && agentTransports.get(agentId)?.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session' });
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[mcp] DELETE error (agent ${req.params.agentId}):`, err);
      Sentry.captureException(err, { tags: { component: 'mcp', agentId: req.params.agentId } });
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  return app;
}

/**
 * Wrap an MCP tool handler with an error boundary. If the handler throws,
 * returns a structured error response instead of crashing the MCP session.
 * This prevents one buggy tool call from killing an agent's entire session.
 */
type ToolTextResponse = { content: Array<{ type: 'text'; text: string }> };

function safeTool(
  toolName: string,
  agentId: string,
  handler: (input: any) => Promise<ToolTextResponse>,
): (input: any) => Promise<ToolTextResponse> {
  return async (input: any) => {
    try {
      return await handler(input);
    } catch (err: any) {
      console.error(`[mcp] tool ${toolName} error (agent ${agentId}):`, err);
      Sentry.captureException(err, { tags: { component: 'mcp', tool: toolName, agentId } });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Internal error in ${toolName}: ${err.message ?? 'unknown'}` }),
        }],
      };
    }
  };
}

function buildMcpServer(agentId: string): MCP {
  const server = new MCP({ name: 'orchestrator', version: '1.0.0' });

  server.tool(
    'ask_user',
    'Ask the human a question and wait for their answer before continuing.',
    { question: askUserSchema.shape.question, timeout_ms: askUserSchema.shape.timeout_ms },
    safeTool('ask_user', agentId, async (input) => {
      const answer = await askUserHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: answer }] };
    })
  );

  server.tool(
    'lock_files',
    'Acquire exclusive locks on files before editing them. BLOCKS until locks are available or timeout_ms elapses. On timeout, returns success=false with timed_out=true — release your own locks then IMMEDIATELY call lock_files again (do not pause to reason first). If a deadlock cycle is detected (success=false, deadlock_detected=true), release ALL your currently held locks with release_files, then retry lock_files for all files you need in a single call. The default timeout (660s) exceeds the default TTL (600s), so with defaults you will always eventually get the lock without timing out.',
    { files: lockFilesSchema.shape.files, reason: lockFilesSchema.shape.reason, ttl_ms: lockFilesSchema.shape.ttl_ms, timeout_ms: lockFilesSchema.shape.timeout_ms },
    safeTool('lock_files', agentId, async (input) => {
      const result = await lockFilesHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'release_files',
    'Release file locks when done editing.',
    { files: releaseFilesSchema.shape.files },
    safeTool('release_files', agentId, async (input) => {
      const result = await releaseFilesHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'check_file_locks',
    'See what files other agents currently have locked.',
    {},
    safeTool('check_file_locks', agentId, async (input) => {
      const result = await checkFileLocksHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'report_status',
    'Update your status message displayed in the orchestrator dashboard.',
    { message: reportStatusSchema.shape.message },
    safeTool('report_status', agentId, async (input) => {
      const result = await reportStatusHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'create_job',
    'Create a new job that will be queued and run by another agent. Returns { job_id, title, status }. Use wait_for_jobs to block until it completes.',
    {
      description: createJobSchema.shape.description,
      title: createJobSchema.shape.title,
      priority: createJobSchema.shape.priority,
      work_dir: createJobSchema.shape.work_dir,
      max_turns: createJobSchema.shape.max_turns,
      model: createJobSchema.shape.model,
      depends_on: createJobSchema.shape.depends_on,
    },
    safeTool('create_job', agentId, async (input) => {
      const result = await createJobHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'create_autonomous_agent_run',
    'Create a structured autonomous agent run with assess, review, and implement phases. Use this instead of create_job when the work needs iterative planning, milestone tracking, shared worktree continuity, or automatic PR creation.',
    {
      task: createAutonomousAgentRunSchema.shape.task,
      title: createAutonomousAgentRunSchema.shape.title,
      workDir: createAutonomousAgentRunSchema.shape.workDir,
      implementerModel: createAutonomousAgentRunSchema.shape.implementerModel,
      reviewerModel: createAutonomousAgentRunSchema.shape.reviewerModel,
      maxCycles: createAutonomousAgentRunSchema.shape.maxCycles,
      maxTurnsAssess: createAutonomousAgentRunSchema.shape.maxTurnsAssess,
      maxTurnsReview: createAutonomousAgentRunSchema.shape.maxTurnsReview,
      maxTurnsImplement: createAutonomousAgentRunSchema.shape.maxTurnsImplement,
      stopModeAssess: createAutonomousAgentRunSchema.shape.stopModeAssess,
      stopValueAssess: createAutonomousAgentRunSchema.shape.stopValueAssess,
      stopModeReview: createAutonomousAgentRunSchema.shape.stopModeReview,
      stopValueReview: createAutonomousAgentRunSchema.shape.stopValueReview,
      stopModeImplement: createAutonomousAgentRunSchema.shape.stopModeImplement,
      stopValueImplement: createAutonomousAgentRunSchema.shape.stopValueImplement,
      templateId: createAutonomousAgentRunSchema.shape.templateId,
      useWorktree: createAutonomousAgentRunSchema.shape.useWorktree,
    },
    safeTool('create_autonomous_agent_run', agentId, async (input) => {
      const result = await createAutonomousAgentRunHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'wait_for_jobs',
    'Block until all specified jobs finish. Returns an array of { job_id, title, status, result_text } for each job. Each call returns after at most ~90s. If any jobs still have non-terminal status (queued/running/assigned), re-call wait_for_jobs with those job IDs until all reach a terminal state (done/failed/cancelled).',
    {
      job_ids: waitForJobsSchema.shape.job_ids,
      timeout_ms: waitForJobsSchema.shape.timeout_ms,
    },
    safeTool('wait_for_jobs', agentId, async (input) => {
      const result = await waitForJobsHandler(agentId, input as any);
      return { content: [{ type: 'text' as const, text: result }] };
    })
  );

  server.tool(
    'write_note',
    'Write a note to the shared scratchpad (visible to all agents). Use namespaced keys like "plan/step1". Value can be any string; JSON.stringify for structured data.',
    {
      key: writeNoteSchema.shape.key,
      value: writeNoteSchema.shape.value,
    },
    async (input) => {
      const result = await writeNoteHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'read_note',
    'Read a note from the shared scratchpad. Returns { found, key, value, updated_at }.',
    { key: readNoteSchema.shape.key },
    async (input) => {
      const result = await readNoteHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'list_notes',
    'List all note keys in the shared scratchpad. Optionally filter by prefix (e.g. "plan/").',
    { prefix: listNotesSchema.shape.prefix },
    async (input) => {
      const result = await listNotesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'watch_notes',
    'Block until specified notes exist (and optionally match a value). Use to wait for data from other agents.',
    {
      keys: watchNotesSchema.shape.keys,
      prefix: watchNotesSchema.shape.prefix,
      until_value: watchNotesSchema.shape.until_value,
      timeout_ms: watchNotesSchema.shape.timeout_ms,
    },
    async (input) => {
      const result = await watchNotesHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'search_kb',
    'Search the knowledge base for relevant memories, patterns, and past learnings. Use at the start of a task to benefit from previous agent experiences.',
    {
      query: searchKBSchema.shape.query,
      project_id: searchKBSchema.shape.project_id,
    },
    async (input) => {
      const result = await searchKBHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'report_learnings',
    'Report what you learned during this task — project conventions, build quirks, useful patterns, debugging insights. Call this near the end of your work. Max 5 learnings per call.',
    {
      learnings: reportLearningsSchema.shape.learnings,
    },
    async (input) => {
      const result = await reportLearningsHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'finish_job',
    'Signal task completion and close this session. Call this when your task prompt explicitly tells you to (automated jobs only). Do NOT call in interactive sessions.',
    {
      result: finishJobSchema.shape.result,
    },
    safeTool('finish_job', agentId, async (input) => {
      const result = await finishJobHandler(agentId, input as any);
      return { content: [{ type: 'text', text: result }] };
    })
  );

  // ─── Eye Tools ──────────────────────────────────────────────────────────────

  server.tool('start_discussion', 'Start a non-blocking discussion thread with the user. Does NOT block the agent.',
    { topic: startDiscussionSchema.shape.topic, message: startDiscussionSchema.shape.message, category: startDiscussionSchema.shape.category, priority: startDiscussionSchema.shape.priority, context: startDiscussionSchema.shape.context },
    async (input) => ({ content: [{ type: 'text', text: await startDiscussionHandler(agentId, input as any) }] }));

  server.tool('check_discussions', 'Check for new user replies on discussions.',
    { discussion_ids: checkDiscussionsSchema.shape.discussion_ids, unread_only: checkDiscussionsSchema.shape.unread_only },
    async (input) => ({ content: [{ type: 'text', text: await checkDiscussionsHandler(agentId, input as any) }] }));

  server.tool('reply_discussion', 'Reply to a discussion thread. Optionally mark it as resolved.',
    { discussion_id: replyDiscussionSchema.shape.discussion_id, message: replyDiscussionSchema.shape.message, resolve: replyDiscussionSchema.shape.resolve, requires_user_reply: replyDiscussionSchema.shape.requires_user_reply },
    async (input) => ({ content: [{ type: 'text', text: await replyDiscussionHandler(agentId, input as any) }] }));

  server.tool('create_proposal', 'Create a product/engineering proposal for the user to approve, reject, or discuss. Does NOT block.',
    { title: createProposalSchema.shape.title, summary: createProposalSchema.shape.summary, rationale: createProposalSchema.shape.rationale, confidence: createProposalSchema.shape.confidence, estimated_complexity: createProposalSchema.shape.estimated_complexity, category: createProposalSchema.shape.category, evidence: createProposalSchema.shape.evidence, implementation_plan: createProposalSchema.shape.implementation_plan, codex_confirmed: createProposalSchema.shape.codex_confirmed, codex_confidence: createProposalSchema.shape.codex_confidence, codex_reasoning: createProposalSchema.shape.codex_reasoning },
    async (input) => ({ content: [{ type: 'text', text: await createProposalHandler(agentId, input as any) }] }));

  server.tool('check_proposals', 'Check the status of proposals.',
    { proposal_ids: checkProposalsSchema.shape.proposal_ids, status_filter: checkProposalsSchema.shape.status_filter },
    async (input) => ({ content: [{ type: 'text', text: await checkProposalsHandler(agentId, input as any) }] }));

  server.tool('reply_proposal', 'Reply to a proposal discussion thread.',
    { proposal_id: replyProposalSchema.shape.proposal_id, message: replyProposalSchema.shape.message, update_plan: replyProposalSchema.shape.update_plan },
    async (input) => ({ content: [{ type: 'text', text: await replyProposalHandler(agentId, input as any) }] }));

  server.tool('update_proposal', 'Update a proposal status (in_progress, done) and/or link it to an execution job. Call this when you start working on an approved proposal and when you finish.',
    { proposal_id: updateProposalSchema.shape.proposal_id, status: updateProposalSchema.shape.status, execution_job_id: updateProposalSchema.shape.execution_job_id },
    async (input) => ({ content: [{ type: 'text', text: await updateProposalHandler(agentId, input as any) }] }));

  server.tool('report_pr', 'Record a GitHub PR that Eye created so it appears in the PRs tab of the dashboard.',
    { url: reportPrSchema.shape.url, title: reportPrSchema.shape.title, description: reportPrSchema.shape.description, proposal_id: reportPrSchema.shape.proposal_id },
    async (input) => ({ content: [{ type: 'text', text: await reportPrHandler(agentId, input as any) }] }));

  server.tool('report_pr_review', 'Submit a PR review with comments on specific files/lines. Automatically creates a pending (draft) GitHub review — visible only to you, not the PR author, until you submit it. Updates existing review if one exists for the same PR number + repo.',
    { pr_number: reportPrReviewSchema.shape.pr_number, pr_url: reportPrReviewSchema.shape.pr_url, pr_title: reportPrReviewSchema.shape.pr_title, pr_author: reportPrReviewSchema.shape.pr_author, repo: reportPrReviewSchema.shape.repo, summary: reportPrReviewSchema.shape.summary, comments: reportPrReviewSchema.shape.comments },
    async (input) => ({ content: [{ type: 'text', text: await reportPrReviewHandler(agentId, input as any) }] }));

  server.tool('check_pr_reviews', 'Check PR reviews, optionally filtered to only those with new user replies. Use this at the start of each cycle to see if the user has sent feedback on any review.',
    { unread_only: checkPrReviewsSchema.shape.unread_only, review_ids: checkPrReviewsSchema.shape.review_ids },
    async (input) => ({ content: [{ type: 'text', text: await checkPrReviewsHandler(agentId, input as any) }] }));

  server.tool('reply_pr_review', 'Reply to user feedback on a PR review. Optionally provide updated_comments to revise the review findings based on the user\'s feedback.',
    { review_id: replyPrReviewSchema.shape.review_id, message: replyPrReviewSchema.shape.message, updated_comments: replyPrReviewSchema.shape.updated_comments },
    async (input) => ({ content: [{ type: 'text', text: await replyPrReviewHandler(agentId, input as any) }] }));

  server.tool('update_daily_summary', 'Add bullet-point items to today\'s running summary. Eye should call this each cycle to record key findings and actions. At end of day, call with replace=true to compress to just the most important items.',
    { items: updateDailySummarySchema.shape.items, replace: updateDailySummarySchema.shape.replace },
    async (input) => ({ content: [{ type: 'text', text: await updateDailySummaryHandler(agentId, input as any) }] }));

  // ─── Integration Tools ────────────────────────────────────────────────────

  server.tool('query_linear', 'Query the Linear API using GraphQL.',
    { query: queryLinearSchema.shape.query, variables: queryLinearSchema.shape.variables },
    async (input) => ({ content: [{ type: 'text', text: await queryLinearHandler(agentId, input as any) }] }));

  server.tool('query_logs', 'Search OpenSearch logs. Requires AWS SSO authentication.',
    { env: queryLogsSchema.shape.env, query_string: queryLogsSchema.shape.query_string, container: queryLogsSchema.shape.container, namespace: queryLogsSchema.shape.namespace, node: queryLogsSchema.shape.node, request_id: queryLogsSchema.shape.request_id, task: queryLogsSchema.shape.task, start_time: queryLogsSchema.shape.start_time, end_time: queryLogsSchema.shape.end_time, errors_only: queryLogsSchema.shape.errors_only, size: queryLogsSchema.shape.size },
    async (input) => ({ content: [{ type: 'text', text: await queryLogsHandler(agentId, input as any) }] }));

  server.tool('query_db', 'Execute a READ-ONLY SQL query against Postgres. Write operations are blocked.',
    { sql: queryDbSchema.shape.sql, env: queryDbSchema.shape.env, database: queryDbSchema.shape.database },
    async (input) => ({ content: [{ type: 'text', text: await queryDbHandler(agentId, input as any) }] }));

  server.tool('query_ci_logs', 'Fetch GitHub Actions CI logs for a PR, branch, or specific run. Returns run status, failed jobs, and failure log output. Useful for diagnosing CI failures.',
    { pr_number: queryCiLogsSchema.shape.pr_number, run_id: queryCiLogsSchema.shape.run_id, branch: queryCiLogsSchema.shape.branch, workflow: queryCiLogsSchema.shape.workflow, failed_only: queryCiLogsSchema.shape.failed_only, include_logs: queryCiLogsSchema.shape.include_logs, repo_path: queryCiLogsSchema.shape.repo_path, limit: queryCiLogsSchema.shape.limit },
    async (input) => ({ content: [{ type: 'text', text: await queryCiLogsHandler(agentId, input as any) }] }));

  return server;
}
