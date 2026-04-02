import { spawn, execSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Sentry } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { getFileLockRegistry } from './FileLockRegistry.js';
import { onJobCompleted as debateOnJobCompleted } from './DebateManager.js';
import { onJobCompleted as workflowOnJobCompleted } from './WorkflowManager.js';
import { runCompletionChecks } from './CompletionChecks.js';
import { handleRetry } from './RetryManager.js';
import { triageLearnings } from './MemoryTriager.js';
import { claimRecovery, clearRecoveryState } from './RecoveryLedger.js';
import { createPrForJob, pushBranchForFailedJob } from './PrCreator.js';
import type { Job, ClaudeStreamEvent, CodexStreamEvent } from '../../shared/types.js';
import { isCodexModel, codexModelName, effectiveMaxTurns } from '../../shared/types.js';
import { buildEyePrompt, isEyeJob } from './EyeConfig.js';
import { ensureCodexTrusted } from './PtyManager.js';

// ─── Adaptive Eye Interval ──────────────────────────────────────────────────
const EYE_MIN_INTERVAL_MS = 120_000;   // 2 minutes
const EYE_MID_INTERVAL_MS = 300_000;   // 5 minutes
const EYE_MAX_INTERVAL_MS = 600_000;   // 10 minutes
const EYE_IDLE_THRESHOLD_MID = 3;      // idle cycles before stepping up to 5min
const EYE_IDLE_THRESHOLD_MAX = 6;      // idle cycles before stepping up to 10min

/**
 * Compute the next Eye repeat interval based on consecutive idle cycles.
 * An "idle" cycle is one where no wake events were pending when the prompt was built.
 * When events are present, reset to minimum interval.
 */
function computeAdaptiveEyeInterval(currentInterval: number): number {
  const eventCountNote = queries.getNote('setting:eye:lastCycleEventCount');
  const eventCount = eventCountNote?.value ? parseInt(eventCountNote.value, 10) : 0;

  const idleNote = queries.getNote('setting:eye:idleCycles');
  let idleCycles = idleNote?.value ? parseInt(idleNote.value, 10) : 0;

  if (eventCount > 0) {
    // Had events — reset to minimum
    idleCycles = 0;
    queries.upsertNote('setting:eye:idleCycles', '0', null);
    return EYE_MIN_INTERVAL_MS;
  }

  // No events — increment idle counter
  idleCycles++;
  queries.upsertNote('setting:eye:idleCycles', String(idleCycles), null);

  if (idleCycles >= EYE_IDLE_THRESHOLD_MAX) return EYE_MAX_INTERVAL_MS;
  if (idleCycles >= EYE_IDLE_THRESHOLD_MID) return EYE_MID_INTERVAL_MS;
  return EYE_MIN_INTERVAL_MS;
}

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const CODEX = process.env.CODEX_BIN ?? 'codex';
const MCP_PORT = process.env.MCP_PORT ?? '3947';
const LOGS_DIR = path.join(process.cwd(), 'data', 'agent-logs');

const HOOK_SCRIPT = path.resolve(process.cwd(), 'scripts/check-lock-hook.mjs');

export const HOOK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: `node ${HOOK_SCRIPT}` }]
    }]
  }
});

export const SYSTEM_PROMPT = `You are a Claude Code agent in a multi-agent orchestration system.
Use these MCP tools from the 'orchestrator' server:

FILE LOCKING (required before any edits):
  - lock_files(files, reason): Acquire exclusive locks BEFORE editing or creating files. BLOCKS until
    the locks are available — you will resume automatically once they are free. If it times out
    (success=false, timed_out=true), release any locks you currently hold then IMMEDIATELY call
    lock_files again (do not pause to reason first). If a deadlock cycle is detected
    (success=false, deadlock_detected=true), release ALL your currently held locks with release_files,
    then retry lock_files for all files you need in a single call.
  - release_files(files): Release locks when you are done with those files.
  - check_file_locks(): See what files other agents currently have locked.

COORDINATION:
  - report_status(message): Update your status message in the orchestrator dashboard.
  - ask_user(question): Ask the human a question and WAIT for their answer before continuing.

ORCHESTRATION (spawn and coordinate sub-agents):
  - create_job(description, title?, priority?, work_dir?, max_turns?, model?, depends_on?):
      Create a new job that will be run by another agent. Returns { job_id, title, status }.
      work_dir defaults to your own working directory.
  - create_autonomous_agent_run(task, title?, workDir?, implementerModel?, reviewerModel?, maxCycles?, ...):
      Create a structured multi-cycle autonomous agent run with assess, review, and implement phases.
      Use this when the work needs iterative planning, milestone tracking, shared worktree continuity,
      or an automatic PR at the end. Returns the run id, project id, and initial assess job id.
  - wait_for_jobs(job_ids, timeout_ms?):
      Block until all specified jobs finish. Returns an array of { job_id, title, status, work_dir, result_text }.
      work_dir is the actual working directory the job ran in (worktree path if use_worktree was set).
      Each call returns after at most ~90s. If some jobs still have non-terminal status (queued/running),
      re-call wait_for_jobs with those job IDs until all are done/failed/cancelled.

EYE (non-blocking discussions & proposals with the user):
  - start_discussion(topic, message, category?, priority?, context?): Start a non-blocking discussion. Does NOT block.
  - check_discussions(discussion_ids?, unread_only?): Check for new user replies.
  - reply_discussion(discussion_id, message, resolve?): Reply to a discussion.
  - create_proposal(title, summary, rationale, confidence, estimated_complexity, category, evidence?, implementation_plan?): Propose work for user approval. Does NOT block.
  - check_proposals(proposal_ids?, status_filter?): Check proposal statuses.
  - reply_proposal(proposal_id, message, update_plan?): Reply to a proposal discussion.

INTEGRATIONS (external service access — must be configured in Eye settings):
  - query_linear(query, variables?): Execute a GraphQL query against the Linear API.
  - query_logs(env?, query_string?, container?, namespace?, node?, request_id?, task?, start_time?, end_time?, errors_only?, size?): Search OpenSearch logs. Requires AWS SSO auth.
  - query_db(sql, env?, database?): Execute READ-ONLY SQL against Postgres. Write operations are blocked.

SHARED SCRATCHPAD (coordinate data between agents):
  - write_note(key, value): Write a note visible to all agents. Use namespaced keys like "results/step1".
  - read_note(key): Read a note. Returns { found, key, value, updated_at }.
  - list_notes(prefix?): List note keys, optionally filtered by prefix.
  - watch_notes(keys?, prefix?, until_value?, timeout_ms?):
      Block until notes exist. In keys mode, all listed keys must exist.
      In prefix mode, at least one note under the prefix must exist.
      If until_value is set, matched notes must have that exact value.
      Use this to wait for data from other agents instead of polling read_note.

KNOWLEDGE BASE (persistent memory across jobs):
  - search_kb(query, project_id?): Search for relevant past learnings, patterns, and conventions.
  - report_learnings(learnings): Report what you learned during this task. Each learning has a
      title, content, optional tags, and optional scope ("project" or "global").
      Call this near the end of your work with up to 5 learnings.

IMPORTANT RULES:
- Always call lock_files BEFORE modifying any file. It will wait for you automatically.
- Always call release_files as soon as you finish with each file — don't hold locks longer than needed.
- Use report_status regularly to let the human know what you are doing.
- At the START of a task, call search_kb with relevant keywords to check for existing knowledge.
- Before FINISHING a task, call report_learnings with anything useful you discovered
  (build commands, gotchas, conventions, patterns, debugging tips).

PR DESCRIPTION STYLE:
- Never include "Generated by Claude Code" or any similar attribution footer in PR descriptions.
- Never use checkboxes (- [ ] or - [x]) in PR descriptions.
- Never use emojis in PR descriptions.

ORCHESTRATION PATTERN (for decomposing large tasks):
  1. Call report_status to describe your plan.
  2. If the task needs iterative assess/review/implement cycles, prefer create_autonomous_agent_run.
  3. Otherwise use create_job for each parallel sub-task. Collect the returned job_ids.
  4. Use depends_on to express ordering if some sub-tasks depend on others.
  5. Call wait_for_jobs(job_ids) to block until all sub-tasks complete.
  6. Read result_text and diff from the results to synthesize a final answer.
  7. Optionally use write_note/read_note to pass structured data between agents.

COMPLETION (automated jobs only):
  - finish_job(result?): Signal task completion and close this session. Only call this when your
    task prompt explicitly tells you to. Do NOT call this in interactive sessions.`;

export interface RunOptions {
  agentId: string;
  job: Job;
  mcpPort?: number;
  resumeSessionId?: string;
}

// Map of agentId → active tailer cleanup handles
const _tailers = new Map<string, { watcher?: fs.FSWatcher; interval: NodeJS.Timeout }>();

// Agents that were explicitly cancelled — handleAgentExit checks this to avoid overwriting 'cancelled' status
export const cancelledAgents = new Set<string>();

export function getLogPath(agentId: string): string {
  return path.join(LOGS_DIR, `${agentId}.ndjson`);
}

export function getStderrPath(agentId: string): string {
  return path.join(LOGS_DIR, `${agentId}.stderr`);
}

export function runAgent(options: RunOptions): void {
  const { agentId, job } = options;
  const mcpPort = options.mcpPort ?? Number(MCP_PORT);

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = getLogPath(agentId);
  const errPath = getStderrPath(agentId);

  // Open file descriptors for the child to write into directly
  const logFd = fs.openSync(logPath, 'w');
  const errFd = fs.openSync(errPath, 'w');

  const workDir = (job as any).work_dir ?? process.cwd();
  const stopMode = (job as any).stop_mode ?? 'turns';
  const stopValue = (job as any).stop_value ?? null;
  const maxTurns = effectiveMaxTurns(stopMode, stopValue);
  const model: string | null = (job as any).model ?? null;
  const useCodex = isCodexModel(model);
  if (useCodex) ensureCodexTrusted(workDir);

  const mcpUrl = `http://localhost:${mcpPort}/mcp/${agentId}`;

  let binary: string;
  let args: string[];

  if (useCodex) {
    const codexSubModel = codexModelName(model);
    const codexArgs = [
      ...(options.resumeSessionId
        ? ['exec', 'resume', options.resumeSessionId]
        : ['exec']),
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', workDir,
      '--skip-git-repo-check',
      '-c', `mcp_servers.orchestrator.url="${mcpUrl}"`,
      ...(codexSubModel ? ['-m', codexSubModel] : []),
    ];
    binary = CODEX;
    args = codexArgs;
  } else {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        orchestrator: {
          url: mcpUrl,
          type: 'http',
        },
      },
    });

    args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--settings', HOOK_SETTINGS,
      '--mcp-config', mcpConfig,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--max-turns', String(maxTurns),
      ...(model ? ['--model', model] : []),
      ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
    ];
    binary = CLAUDE;
  }

  console.log(`[agent ${agentId}] spawning ${useCodex ? 'codex' : 'claude'} for job "${job.title}"${model ? ` (model: ${model})` : ''}`);

  // Spawn via `nice -n 10` so agent processes run at lower scheduling priority
  // than the orchestrator server/UI. This keeps the dashboard responsive under load.
  const child = spawn('nice', ['-n', '10', binary, ...args], {
    cwd: workDir,
    detached: true,            // becomes process group leader — survives server restart
    stdio: ['pipe', logFd, errFd],  // stdout/stderr go to files, not pipes
    env: (() => {
      const env = { ...process.env };
      delete env['CLAUDECODE'];
      env['ORCHESTRATOR_AGENT_ID'] = agentId;
      env['ORCHESTRATOR_API_URL'] = `http://localhost:${process.env.PORT ?? 3456}`;
      // Auto-activate Python virtual environment if present in the working directory,
      // so tools like pytest are on PATH when the agent runs shell commands.
      for (const venvName of ['venv', '.venv', 'env', '.env']) {
        const venvBin = path.join(workDir, venvName, 'bin');
        if (fs.existsSync(path.join(venvBin, 'activate'))) {
          env['VIRTUAL_ENV'] = path.join(workDir, venvName);
          env['PATH'] = `${venvBin}:${env['PATH'] ?? ''}`;
          break;
        }
      }
      return env;
    })(),
  });

  // Parent releases its copies of the file descriptors — child keeps its own
  fs.closeSync(logFd);
  fs.closeSync(errFd);

  // Write prompt to stdin then close (child reads it all before doing anything else)
  child.stdin!.write(buildPrompt(job));
  child.stdin!.end();

  // Capture the current git HEAD SHA so we can diff after the agent finishes
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: workDir, timeout: 5000 }).toString().trim();
    queries.updateAgent(agentId, { base_sha: sha });
  } catch { /* not a git repo or git not available */ }

  queries.updateAgent(agentId, { pid: child.pid ?? null, status: 'running' });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  // Start tailing the log file; pass the child so we know when it exits
  startTailing(agentId, job, logPath, 0, child);
}

/**
 * Called from recovery.ts when the agent's PID is still alive after a server restart.
 * Re-tails the log file from where we left off.
 */
export function reattachAgent(options: RunOptions): void {
  const { agentId, job } = options;
  const logPath = getLogPath(agentId);
  const agent = queries.getAgentById(agentId);
  // Skip lines we already stored before the restart
  const skipLines = agent ? queries.getAgentLastSeq(agentId) + 1 : 0;

  console.log(`[agent ${agentId}] reattaching (PID ${agent?.pid}, skipping ${skipLines} already-stored lines)`);
  startTailing(agentId, job, logPath, skipLines, null, agent?.pid ?? undefined);
}

export function startTailing(
  agentId: string,
  job: Job,
  logPath: string,
  skipLines: number,
  child: ChildProcess | null,
  pid?: number,
): void {
  // Stop any previous tailer for this agent (shouldn't happen, but be safe)
  stopTailing(agentId);

  let seq = skipLines;     // next seq number to assign
  let skipped = 0;         // lines consumed but not stored
  let filePos = 0;         // byte offset read so far
  let lineBuf = '';        // incomplete last line

  function readNewContent(): void {
    let size: number;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return; // file not created yet
    }
    if (size <= filePos) return;

    let buf: Buffer;
    let bytesRead: number;
    try {
      buf = Buffer.alloc(size - filePos);
      const fd = fs.openSync(logPath, 'r');
      try {
        bytesRead = fs.readSync(fd, buf, 0, buf.length, filePos);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.warn(`[agent ${agentId}] readNewContent error:`, err);
      return;
    }
    filePos += bytesRead;

    lineBuf += buf.toString('utf8');
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop() ?? ''; // keep partial last line for next read

    for (const line of parts) {
      if (!line.trim()) continue;
      if (skipped < skipLines) {
        skipped++;
        continue; // already stored in a previous session
      }
      try {
        const event: ClaudeStreamEvent = JSON.parse(line);
        handleStreamEvent(agentId, event, line, seq++);
      } catch {
        storeOutput(agentId, seq++, 'raw', line);
      }
    }
  }

  // Initial read (catches output written before we set up the watcher)
  readNewContent();

  // Watch for new data; fall back to polling every 2s in case fs.watch misses events
  let watcher: fs.FSWatcher | undefined;
  try {
    let debounce: NodeJS.Timeout | null = null;
    watcher = fs.watch(logPath, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(readNewContent, 50);
    });
  } catch { /* log file may not exist yet; the interval will catch up */ }

  const interval = setInterval(readNewContent, 2000);
  _tailers.set(agentId, { watcher, interval });

  if (child) {
    // Normal spawn: wait for the process to exit via child event
    child.on('close', (code) => {
      setTimeout(() => {
        try {
          readNewContent(); // flush any remaining output
          stopTailing(agentId);
          handleAgentExit(agentId, job, code);
        } catch (err) {
          console.error(`[agent ${agentId}] error in close handler:`, err);
          Sentry.captureException(err);
        }
      }, 500);
    });

    child.on('error', (err) => {
      try {
        console.error(`[agent ${agentId}] spawn error:`, err);
        Sentry.captureException(err);
        stopTailing(agentId);
        queries.updateAgent(agentId, { status: 'failed', error_message: err.message, finished_at: Date.now() });
        queries.updateJobStatus(job.id, 'failed');
        const updated = queries.getAgentWithJob(agentId);
        if (updated) socket.emitAgentUpdate(updated);
      } catch (innerErr) {
        console.error(`[agent ${agentId}] error in spawn error handler:`, innerErr);
        Sentry.captureException(innerErr);
      }
    });
  } else {
    // Reattach mode: poll the PID to detect when the process exits
    const agentPid = pid ?? queries.getAgentById(agentId)?.pid;
    if (!agentPid) return;

    const pidPoll = setInterval(() => {
      try {
        process.kill(agentPid, 0); // no-op signal; throws ESRCH if process is gone
      } catch {
        clearInterval(pidPoll);
        setTimeout(() => {
          try {
            readNewContent();
            stopTailing(agentId);
            // Read exit code from stderr file if available; use 0 if result event was 'success'
            handleAgentExit(agentId, job, null);
          } catch (err) {
            console.error(`[agent ${agentId}] error in reattach exit handler:`, err);
            Sentry.captureException(err);
          }
        }, 500);
      }
    }, 3000);
  }
}

export function stopTailing(agentId: string): void {
  const t = _tailers.get(agentId);
  if (t) {
    t.watcher?.close();
    clearInterval(t.interval);
    _tailers.delete(agentId);
  }
}

/**
 * Scan the agent's last output events to find a wait_for_jobs tool call.
 * Returns the job_ids it was waiting on, or null if not found.
 */
function findLastWaitForJobsIds(agentId: string): string[] | null {
  const output = queries.getAgentOutput(agentId);
  // Walk backwards — last assistant event is most recent tool call
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i].event_type !== 'assistant') continue;
    try {
      const ev = JSON.parse(output[i].content);
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (
          block.type === 'tool_use' &&
          (block.name === 'mcp__orchestrator__wait_for_jobs' || block.name === 'wait_for_jobs') &&
          Array.isArray(block.input?.job_ids)
        ) {
          return block.input.job_ids as string[];
        }
      }
      // Found the last assistant message but no wait_for_jobs in it
      break;
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Shared post-processing run after any agent finishes (tmux or stream-json).
 * Caller is responsible for already having set agent status in the DB.
 * Handles: git diff, completion checks, job status update, lock release,
 * memory triage, socket events, debate notification, repeat scheduling, retry.
 */
export async function handleJobCompletion(
  agentId: string,
  job: Job,
  status: 'done' | 'failed',
): Promise<void> {
  // Clean up git checkpoint tag created before dispatch
  const workDir = (job as any).work_dir ?? process.cwd();
  try {
    const tagName = `orchestrator/checkpoint/${agentId.slice(0, 8)}`;
    execSync(`git tag -d ${tagName} 2>/dev/null || true`, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
  } catch { /* non-fatal */ }

  // Capture git diff between base_sha and current HEAD (committed + staged changes)
  const agentRec = queries.getAgentById(agentId);
  if (agentRec?.base_sha) {
    try {
      const committed = execSync(
        `git log --patch --no-color ${agentRec.base_sha}..HEAD`,
        { cwd: workDir, timeout: 10000 }
      ).toString();
      const uncommitted = execSync(
        'git diff HEAD --no-color',
        { cwd: workDir, timeout: 10000 }
      ).toString();
      const fullDiff = [committed, uncommitted].filter(s => s.trim()).join('\n');
      if (fullDiff.trim()) {
        queries.updateAgent(agentId, { diff: fullDiff.slice(0, 524288) });
      }
    } catch { /* not a git repo, no changes, or git not available */ }
  }

  // Run completion checks if the agent reported success and checks are configured
  let finalStatus = status;
  if (status === 'done' && job.completion_checks) {
    try {
      const freshAgent = queries.getAgentById(agentId);
      if (freshAgent) {
        const checkFailure = runCompletionChecks(job, freshAgent);
        if (checkFailure) {
          console.log(`[agent ${agentId}] completion checks failed: ${checkFailure}`);
          finalStatus = 'failed';
          queries.updateAgent(agentId, { status: 'failed', error_message: `Completion check failed: ${checkFailure}` });
        }
      }
    } catch (err) { console.error(`[agent ${agentId}] completion check error:`, err); Sentry.captureException(err); }
  }

  queries.updateJobStatus(job.id, finalStatus);
  if (finalStatus === 'done') clearRecoveryState(job);
  getFileLockRegistry().releaseAll(agentId);

  // Triage any learnings the agent reported
  if (finalStatus === 'done') {
    triageLearnings(agentId, job).catch(err => {
      console.error(`[agent ${agentId}] memory triage error:`, err);
      Sentry.captureException(err);
    });
  }

  const updated = queries.getAgentWithJob(agentId);
  if (updated) socket.emitAgentUpdate(updated);
  const updatedJob = queries.getJobById(job.id);
  if (updatedJob) {
    try { socket.emitJobUpdate(updatedJob); } catch (err) { console.error(`[agent ${agentId}] emitJobUpdate error:`, err); Sentry.captureException(err); }
    // If this job is part of a debate, check if the round is complete
    try { debateOnJobCompleted(updatedJob); } catch (err) { console.error(`[agent ${agentId}] debateOnJobCompleted error:`, err); Sentry.captureException(err); }
    try { workflowOnJobCompleted(updatedJob); } catch (err) { console.error(`[agent ${agentId}] workflowOnJobCompleted error:`, err); Sentry.captureException(err); }
    // Create PR for worktree jobs that completed with commits (async, non-blocking).
    // Skip workflow jobs — those are handled by WorkflowManager.finalizeWorkflow.
    if (updatedJob.use_worktree === 1 && !updatedJob.workflow_id) {
      if (updatedJob.status === 'done') {
        createPrForJob(updatedJob).then(prUrl => {
          if (prUrl) {
            queries.updateJobPrUrl(updatedJob.id, prUrl);
            const refreshed = queries.getJobById(updatedJob.id);
            if (refreshed) socket.emitJobUpdate(refreshed);
          }
        }).catch(err => {
          console.error(`[agent ${agentId}] PR creation error:`, err);
          Sentry.captureException(err);
        });
      } else if (updatedJob.status === 'failed') {
        // Push branch for failed jobs to preserve work (sync, best-effort)
        try { pushBranchForFailedJob(updatedJob); } catch (err) {
          console.error(`[agent ${agentId}] failed-job branch push error:`, err);
        }
      }
    }
    // If the job has a repeat interval, queue the next run regardless of success/failure
    if (updatedJob.repeat_interval_ms) {
      try {
        // For Eye jobs, rebuild the prompt fresh so config changes (target dirs etc) take effect
        const descriptionOverride = isEyeJob(updatedJob.context) ? buildEyePrompt() : undefined;
        // Adaptive interval for Eye: increase interval when idle, reset when busy
        let intervalOverride: number | undefined;
        if (isEyeJob(updatedJob.context)) {
          intervalOverride = computeAdaptiveEyeInterval(updatedJob.repeat_interval_ms);
        }
        const nextJob = queries.scheduleRepeatJob(updatedJob, descriptionOverride, intervalOverride);
        socket.emitJobNew(nextJob);
      } catch (err) { console.error(`[agent ${agentId}] scheduleRepeatJob error:`, err); Sentry.captureException(err); }
    }
    // If the job failed, also attempt retry (independent of repeat scheduling)
    if (updatedJob.status === 'failed') {
      try { handleRetry(updatedJob, agentId); } catch (err) { console.error(`[agent ${agentId}] handleRetry error:`, err); Sentry.captureException(err); }
      // If this job was executing a proposal, mark the proposal as failed so Eye can handle it
      try {
        const linkedProposal = queries.listProposals('in_progress').find(p => p.execution_job_id === updatedJob.id);
        if (linkedProposal) {
          queries.updateProposal(linkedProposal.id, { status: 'failed' });
          const updatedProp = queries.getProposalById(linkedProposal.id)!;
          socket.emitProposalUpdate(updatedProp);
          console.log(`[agent ${agentId}] marked proposal ${linkedProposal.id} as failed`);
        }
      } catch (err) { console.error(`[agent ${agentId}] proposal fail-update error:`, err); Sentry.captureException(err); }
    }
  }
}

function handleAgentExit(agentId: string, job: Job, exitCode: number | null): void {
  console.log(`[agent ${agentId}] exited (code ${exitCode ?? 'unknown'})`);

  // If the agent is already in a terminal state, another exit path already handled it
  // (e.g. PTY onExit vs PID poll race for debate-stage agents). Don't double-process.
  const current = queries.getAgentById(agentId);
  const TERMINAL = ['done', 'failed', 'cancelled'];
  if (current && TERMINAL.includes(current.status)) {
    console.log(`[agent ${agentId}] already ${current.status}, skipping duplicate exit handler`);
    return;
  }

  // If the agent was cancelled, the cancel endpoint already updated DB + emitted socket events
  if (cancelledAgents.has(agentId)) {
    cancelledAgents.delete(agentId);
    return;
  }

  // Try to determine success/failure from the last result event in the log
  let statusFromLog: 'done' | 'failed' | null = null;
  let logErrorMsg: string | null = null;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  try {
    const content = fs.readFileSync(getLogPath(agentId), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        // Claude result event
        if (ev.type === 'result') {
          statusFromLog = ev.is_error ? 'failed' : 'done';
          costUsd = ev.total_cost_usd ?? null;
          durationMs = ev.duration_ms ?? null;
          numTurns = ev.num_turns ?? null;
          break;
        }
        // Codex turn events
        if (ev.type === 'turn.completed') {
          statusFromLog = 'done';
          break;
        }
        if (ev.type === 'turn.failed') {
          statusFromLog = 'failed';
          logErrorMsg = ev.error?.message ?? null;
          break;
        }
        // Codex inline error event (captured before turn.failed)
        if (ev.type === 'error' && ev.message && !logErrorMsg) {
          logErrorMsg = ev.message;
        }
      } catch { /* skip */ }
    }
  } catch { /* log file may be gone */ }

  const status = statusFromLog ?? (exitCode === 0 ? 'done' : 'failed');

  // Prefer the error message extracted from the log (meaningful for Codex);
  // fall back to stderr only when the log has no useful message.
  let stderrMsg: string | null = logErrorMsg;
  if (!stderrMsg && status === 'failed') {
    try {
      const lines = fs.readFileSync(getStderrPath(agentId), 'utf8').split('\n').filter(Boolean);
      stderrMsg = lines.slice(-10).join('\n') || null;
    } catch { /* no stderr file */ }
  }

  queries.updateAgent(agentId, {
    status,
    exit_code: exitCode ?? -1,
    error_message: stderrMsg,
    cost_usd: costUsd,
    duration_ms: durationMs,
    num_turns: numTurns,
    finished_at: Date.now(),
  });

  // Auto-resume: if the agent marked itself done but sub-jobs it spawned are
  // still running, it finished prematurely — re-spawn with --resume.
  if (status === 'done') {
    const waitedIds = findLastWaitForJobsIds(agentId);
    if (waitedIds && waitedIds.length > 0) {
      const TERMINAL_S = ['done', 'failed', 'cancelled'];
      const waitedJobs = waitedIds.map(id => queries.getJobById(id));
      const stillPending = waitedJobs.filter(j => j && !TERMINAL_S.includes(j.status));
      if (stillPending.length > 0) {
        if (!claimRecovery(job, 'premature-done-auto-resume')) return;
        console.log(`[agent ${agentId}] marked done but ${stillPending.length} sub-jobs still pending: [${stillPending.map(j => j!.id).join(', ')}] — auto-resuming`);
        const agentRec2 = queries.getAgentById(agentId);
        const sessionId = agentRec2?.session_id ?? null;

        queries.updateAgent(agentId, {
          status: 'failed',
          exit_code: exitCode ?? -1,
          error_message: 'Agent finished prematurely while sub-jobs still pending; watchdog auto-resumed.',
          finished_at: Date.now(),
        });
        queries.releaseLocksForAgent(agentId);
        getFileLockRegistry().releaseAll(agentId);

        const newAgentId = randomUUID();
        queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
        queries.updateJobStatus(job.id, 'assigned');

        const newAgentWithJob = queries.getAgentWithJob(newAgentId);
        if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
        const updatedJob2 = queries.getJobById(job.id);
        if (updatedJob2) socket.emitJobUpdate(updatedJob2);

        runAgent({ agentId: newAgentId, job, resumeSessionId: sessionId ?? undefined });
        return;
      }
    }
  }

  // Auto-resume: if the agent died while stuck in wait_for_jobs and all the
  // awaited jobs are now done, re-spawn with --resume rather than failing.
  if (status === 'failed') {
    const waitedIds = findLastWaitForJobsIds(agentId);
    if (waitedIds && waitedIds.length > 0) {
      const TERMINAL_S = ['done', 'failed', 'cancelled'];
      const waitedJobs = waitedIds.map(id => queries.getJobById(id));
      const allDone = waitedJobs.every(j => j && j.status === 'done');
      if (allDone) {
        if (!claimRecovery(job, 'wait-for-jobs-auto-resume')) return;
        console.log(`[agent ${agentId}] died in wait_for_jobs with all deps done — auto-resuming job ${job.id}`);
        const agentRec2 = queries.getAgentById(agentId);
        const sessionId = agentRec2?.session_id ?? null;

        queries.updateAgent(agentId, {
          status: 'failed',
          exit_code: exitCode ?? -1,
          error_message: 'Process exited during wait_for_jobs; watchdog auto-resumed.',
          finished_at: Date.now(),
        });
        queries.releaseLocksForAgent(agentId);
        getFileLockRegistry().releaseAll(agentId);

        const newAgentId = randomUUID();
        queries.insertAgent({ id: newAgentId, job_id: job.id, status: 'starting' });
        queries.updateJobStatus(job.id, 'assigned');

        const newAgentWithJob = queries.getAgentWithJob(newAgentId);
        if (newAgentWithJob) socket.emitAgentNew(newAgentWithJob);
        const updatedJob = queries.getJobById(job.id);
        if (updatedJob) socket.emitJobUpdate(updatedJob);

        runAgent({ agentId: newAgentId, job, resumeSessionId: sessionId ?? undefined });
        return;
      } else {
        const stillPending = waitedJobs.filter(j => j && !TERMINAL_S.includes(j.status)).map(j => j!.id);
        console.log(`[agent ${agentId}] died in wait_for_jobs but ${stillPending.length} deps still pending: [${stillPending.join(', ')}] — not auto-resuming`);
      }
    }
  }

  // Shared post-processing (git diff, completion checks, learnings, debate, retry, etc.)
  handleJobCompletion(agentId, job, status).catch(err => {
    console.error(`[agent ${agentId}] handleJobCompletion error:`, err);
    Sentry.captureException(err);
  });
}

function handleStreamEvent(agentId: string, event: ClaudeStreamEvent | CodexStreamEvent, raw: string, seq: number): void {
  storeOutput(agentId, seq, event.type, raw);

  // Claude: capture session_id from system init event
  if (event.type === 'system' && (event as ClaudeStreamEvent).session_id) {
    queries.updateAgent(agentId, { session_id: (event as ClaudeStreamEvent).session_id });
  }

  // Codex: capture thread_id as session_id from thread.started event
  if (event.type === 'thread.started' && (event as CodexStreamEvent).thread_id) {
    queries.updateAgent(agentId, { session_id: (event as CodexStreamEvent).thread_id });
  }

  // Token accumulation for cost estimation (budget stop mode)
  extractAndAccumulateTokens(agentId, event, raw);

  const latestRow = queries.getLatestAgentOutput(agentId);
  if (latestRow) socket.emitAgentOutput(agentId, latestRow);
}

/**
 * Extract token usage from Claude assistant events and Codex usage events,
 * then accumulate on the agent row for cost estimation.
 */
function extractAndAccumulateTokens(agentId: string, event: ClaudeStreamEvent | CodexStreamEvent, raw: string): void {
  let inputTokens = 0;
  let outputTokens = 0;

  if (event.type === 'assistant') {
    // Claude assistant events carry usage in the raw JSON (not on the typed interface)
    try {
      const parsed = JSON.parse(raw);
      const usage = parsed.usage;
      if (usage) {
        inputTokens = (usage.input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0);
        outputTokens = usage.output_tokens ?? 0;
      }
    } catch { /* malformed JSON — skip */ }
  }

  // Codex emits a top-level usage object on certain events
  const codexUsage = (event as CodexStreamEvent).usage;
  if (codexUsage) {
    inputTokens = (codexUsage.input_tokens ?? 0) + (codexUsage.cached_input_tokens ?? 0);
    outputTokens = codexUsage.output_tokens ?? 0;
  }

  if (inputTokens > 0 || outputTokens > 0) {
    queries.accumulateAgentTokens(agentId, inputTokens, outputTokens);
  }
}

function storeOutput(agentId: string, seq: number, eventType: string, content: string): void {
  queries.insertAgentOutput({
    agent_id: agentId,
    seq,
    event_type: eventType,
    content,
    created_at: Date.now(),
  });
}

/**
 * Read CLAUDE.md and any docs it references from .claude/docs/ in the given directory.
 * Claude Code reads these natively; Codex does not, so we inject them into the prompt.
 */
export function readClaudeMd(workDir: string): string | null {
  const claudeMdPath = path.join(workDir, 'CLAUDE.md');
  let content: string;
  try {
    content = fs.readFileSync(claudeMdPath, 'utf8');
  } catch {
    return null;
  }

  // Also read any .claude/docs/ files referenced in CLAUDE.md
  const docsDir = path.join(workDir, '.claude', 'docs');
  try {
    const docFiles = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
    if (docFiles.length > 0) {
      content += '\n\n---\n\n# Referenced Documentation\n';
      for (const docFile of docFiles) {
        try {
          const docContent = fs.readFileSync(path.join(docsDir, docFile), 'utf8');
          content += `\n## ${docFile}\n\n${docContent}\n`;
        } catch { /* skip unreadable docs */ }
      }
    }
  } catch { /* no .claude/docs directory */ }

  return content;
}

function buildPrompt(job: Job): string {
  const model: string | null = (job as any).model ?? null;
  let prompt = '';

  // Codex has no --append-system-prompt flag, so prepend it to the prompt
  if (isCodexModel(model)) {
    prompt += SYSTEM_PROMPT + '\n\n---\n\n';
  }

  prompt += `# Task: ${job.title}\n\n`;

  // Pre-debate summary (stored separately from description)
  if (job.pre_debate_summary) {
    prompt += job.pre_debate_summary + '\n\n## Original Task\n';
  }

  const templateId = (job as any).template_id as string | null;
  if (templateId) {
    const template = queries.getTemplateById(templateId);
    if (template) {
      prompt += `## Guidelines\n\n${template.content}`;
      if (job.description.trim()) {
        prompt += `\n\n## Task Description\n\n`;
      }
    }
  }

  if (job.description.trim()) {
    prompt += job.description;
  }

  if (job.context) {
    try {
      const ctx = JSON.parse(job.context);
      prompt += '\n\n## Additional Context\n';
      for (const [k, v] of Object.entries(ctx)) {
        prompt += `- **${k}**: ${v}\n`;
      }
    } catch { /* ignore */ }
  }

  // Inject CLAUDE.md for Codex agents (Claude reads it natively)
  const workDir = (job as any).work_dir ?? process.cwd();
  if (isCodexModel(model)) {
    const claudeMd = readClaudeMd(workDir);
    if (claudeMd) {
      prompt += `\n\n## Project Instructions (from CLAUDE.md)\n\n${claudeMd}`;
    }
  }

  // Inject relevant memories from knowledge base (2000-char budget)
  prompt += buildMemorySection(job);

  return prompt;
}

export const MEMORY_BUDGET = 2000;

export function buildMemorySection(job: Job): string {
  const projectId: string | null = (job as any).project_id ?? null;
  const workDir: string | null = (job as any).work_dir ?? null;
  const effectiveProjectId: string | null = projectId ?? workDir ?? null;
  const memories = queries.getMemoryForJob(effectiveProjectId, job.title, job.description);
  if (memories.length === 0) return '';

  let section = '\n\n## Memory\nRelevant learnings from previous tasks:\n';
  let budget = MEMORY_BUDGET - section.length;

  for (const m of memories) {
    const scope = m.project_id ? 'project' : 'global';
    const header = `\n### ${m.title} [${scope}]\n`;
    const remaining = budget - header.length - 5; // 5 for "...\n"
    if (remaining <= 0) break;
    const content = m.content.length > remaining ? m.content.slice(0, remaining) + '...' : m.content;
    const entry = header + content + '\n';
    budget -= entry.length;
    section += entry;
    if (budget <= 0) break;
  }

  return section;
}
