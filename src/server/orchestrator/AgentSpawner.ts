/**
 * AgentSpawner — tmux session creation, script generation, prompt building.
 *
 * Extracted from PtyManager to isolate the agent spawn pipeline into focused,
 * testable functions. The main entrypoint `startInteractiveAgent` is a thin
 * orchestrator calling:
 *   1. buildInteractivePrompt — pure function, builds prompt text
 *   2. buildAgentScript — pure function, returns shell script string
 *   3. spawnTmuxSession — side-effectful, creates tmux session
 *   4. post-spawn setup (prompt delivery, PTY attach)
 */

import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { SYSTEM_PROMPT, HOOK_SETTINGS, CLAUDE, CODEX, MCP_PORT, readClaudeMd, buildMemorySection, ensureCodexTrusted, sessionName, getExistingCwd } from './AgentConfig.js';
import { AgentState } from './AgentLifecycle.js';
import { markJobRunning } from './JobLifecycle.js';
import { wrapExecLineWithNice } from './ProcessPriority.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { errMsg } from '../../shared/errors.js';
import { isCodexModel, codexModelName, isAutoExitJob } from '../../shared/types.js';
import { getClaudeEffort, getCodexReasoningEffort } from '../../shared/models.js';
import { checkResources, escalateBackoff, resetBackoff, getBackoffMs, setLastResourceErrorTime, MAX_PTY_SESSIONS } from './PtyResourceManager.js';
import { PTY_LOG_DIR, getNdjsonPath, getPtyStderrPath, getSnapshotPath, clearAgentLogFiles } from './PtyDiskLogger.js';
import { isStandalonePrintJob } from './JobFinalizer.js';
import type { Job } from '../../shared/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCRIPTS_DIR = path.join(process.cwd(), 'data', 'agent-scripts');
const TMUX = process.env.TMUX_BIN ?? 'tmux';

// ── Path helpers ──────────────────────────────────────────────────────────────

export function scriptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}.sh`);
}

export function promptPath(agentId: string): string {
  return path.join(SCRIPTS_DIR, `${agentId}-prompt.txt`);
}

// ── Re-exports from AgentConfig (backward compatibility) ─────────────────────
export { sessionName, getExistingCwd } from './AgentConfig.js';

// ── Logging helper ────────────────────────────────────────────────────────────

export function logPtyLifecycleEvent(
  eventType: string,
  agentId: string,
  job: Pick<Job, 'id' | 'title' | 'model' | 'work_dir'>,
  details?: Record<string, unknown>,
): void {
  logResilienceEvent(eventType, 'agent', agentId, {
    job_id: job.id,
    job_title: job.title,
    model: job.model ?? null,
    work_dir: job.work_dir ?? null,
    ndjson_path: path.join(PTY_LOG_DIR, `${agentId}.ndjson`),
    snapshot_path: getSnapshotPath(agentId),
    ...details,
  });
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Build the interactive prompt text for an agent from its job metadata.
 * Pure function — no side effects beyond reading CLAUDE.md from disk for Codex agents.
 */
export function buildInteractivePrompt(job: Job): string {
  const model: string | null = job.model ?? null;
  let prompt = '';

  // Codex has no --append-system-prompt flag, so prepend it to the prompt
  if (isCodexModel(model)) {
    prompt += SYSTEM_PROMPT + '\n\n---\n\n';
  }

  prompt += `# Task: ${job.title}\n\n`;

  const templateId = job.template_id;
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
  const workDir = job.work_dir ?? process.cwd();
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

export interface BuildAgentScriptOptions {
  agentId: string;
  job: Job;
  workDir: string;
  mcpConfig: string;
  promptFilePath: string;
  useCodex: boolean;
  usePrintMode: boolean;
  resumeSessionId?: string;
  expectedBranch: string | null;
}

/**
 * Build the shell launcher script for an agent. Pure function — returns the
 * script content as a string without writing it to disk.
 */
export function buildAgentScript(opts: BuildAgentScriptOptions): string {
  const { agentId, job, workDir, mcpConfig, promptFilePath, useCodex, usePrintMode, resumeSessionId, expectedBranch } = opts;
  const model: string | null = job.model ?? null;
  const codexReasoningEffort = getCodexReasoningEffort(model);
  const claudeEffort = getClaudeEffort(model);

  let execLine: string;
  if (useCodex) {
    const mcpUrl = `http://localhost:${Number(MCP_PORT)}/mcp/${agentId}`;
    const codexSubModel = codexModelName(model);
    const modelFlag = codexSubModel ? ` -m ${JSON.stringify(codexSubModel)}` : '';
    const reasoningFlag = codexReasoningEffort
      ? ` -c ${JSON.stringify(`model_reasoning_effort="${codexReasoningEffort}"`)}`
      : '';
    execLine = `exec ${JSON.stringify(CODEX)} --dangerously-bypass-approvals-and-sandbox -C ${JSON.stringify(workDir)} -c 'mcp_servers.orchestrator.url="${mcpUrl}"'${modelFlag}${reasoningFlag}`;
  } else {
    const resumeFlag = resumeSessionId ? ` --resume ${JSON.stringify(resumeSessionId)}` : '';
    const effortFlag = claudeEffort ? ` --effort ${JSON.stringify(claudeEffort)}` : '';
    if (usePrintMode) {
      const ndjsonPath = getNdjsonPath(agentId);
      const stderrPath = getPtyStderrPath(agentId);
      execLine = `${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''}${effortFlag} --print --output-format stream-json --verbose${resumeFlag} "$(cat ${JSON.stringify(promptFilePath)})" 2>> ${JSON.stringify(stderrPath)} | tee ${JSON.stringify(ndjsonPath)}`;
    } else {
      execLine = `exec ${JSON.stringify(CLAUDE)} --dangerously-skip-permissions --settings ${JSON.stringify(HOOK_SETTINGS)} --mcp-config ${JSON.stringify(mcpConfig)} --append-system-prompt ${JSON.stringify(SYSTEM_PROMPT)}${model ? ` --model ${JSON.stringify(model)}` : ''}${effortFlag}${resumeFlag} "$(cat ${JSON.stringify(promptFilePath)})"`;
    }
  }

  // Lower priority when available, but do not fail the launch if `nice` is missing.
  const nicedExecLine = wrapExecLineWithNice(execLine);

  const scriptLines = [
    '#!/bin/sh',
    `export ORCHESTRATOR_AGENT_ID=${JSON.stringify(agentId)}`,
    `export ORCHESTRATOR_API_URL=${JSON.stringify(`http://localhost:${process.env.PORT ?? 3456}`)}`,
    `unset CLAUDECODE`,
    `unset SENTRY_DSN`,
    `unset SENTRY_RELEASE`,
    `unset SENTRY_ENVIRONMENT`,
    `cd ${JSON.stringify(workDir)} || { echo "[agent] FATAL: working directory does not exist: ${workDir}" >&2; exit 1; }`,
    ...(expectedBranch ? [
      `_current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)`,
      `if [ "$_current_branch" != ${JSON.stringify(expectedBranch)} ]; then`,
      `  git checkout ${JSON.stringify(expectedBranch)} 2>/dev/null || true`,
      `fi`,
      `unset _current_branch`,
    ] : []),
    `for _venv in venv .venv env .env; do`,
    `  if [ -f "${workDir}/$_venv/bin/activate" ]; then . "${workDir}/$_venv/bin/activate"; break; fi`,
    `done`,
    `unset _venv`,
    nicedExecLine,
  ].join('\n') + '\n';

  return scriptLines;
}

export interface SpawnTmuxSessionOptions {
  agentId: string;
  scriptFile: string;
  workDir: string;
  cols: number;
  rows: number;
}

/**
 * Create a detached tmux session running the given launcher script.
 * Side-effectful: creates a tmux session and configures it.
 * Throws on failure.
 */
export function spawnTmuxSession({ agentId, scriptFile, workDir, cols, rows }: SpawnTmuxSessionOptions): void {
  const sName = sessionName(agentId);

  // Kill any existing session with this name
  try {
    execFileSync(TMUX, ['kill-session', '-t', sName], { stdio: 'pipe' });
  } catch { /* no existing session — fine */ }

  // Set ANTHROPIC_API_KEY in the tmux global environment BEFORE creating
  // the session, so the initial shell process inherits it immediately.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      execFileSync(TMUX, ['setenv', '-g', 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY], { stdio: 'pipe' });
    } catch { /* non-fatal — agent may fall back to OAuth */ }
  }

  // Create a new detached tmux session running our launcher script
  execFileSync(TMUX, [
    'new-session', '-d',
    '-s', sName,
    '-x', String(cols),
    '-y', String(rows),
    scriptFile,
  ], {
    cwd: workDir,
    stdio: 'pipe',
    env: (() => {
      const e = { ...process.env };
      delete e['SENTRY_DSN'];
      delete e['SENTRY_RELEASE'];
      delete e['SENTRY_ENVIRONMENT'];
      return e;
    })(),
  });

  // Set large scrollback so capture-pane -S - returns full history
  try {
    execFileSync(TMUX, ['set-option', '-t', sName, 'history-limit', '50000'], { stdio: 'pipe' });
  } catch { /* ignore */ }

  // Enable mouse mode so scroll wheel enters tmux copy mode for history scrolling
  try {
    execFileSync(TMUX, ['set-option', '-t', sName, 'mouse', 'on'], { stdio: 'pipe' });
  } catch { /* ignore — older tmux may not support per-session mouse */ }
}

// ── Orchestrator context (passed from PtyManager) ─────────────────────────────

export interface SpawnerContext {
  /** Number of currently attached PTY sessions */
  getAttachedCount: () => number;
  /** Count agents in the given state */
  countInState: (state: AgentState) => number;
  /** Transition agent to a new lifecycle state */
  transition: (agentId: string, state: AgentState) => void;
  /** Check if tmux session is alive */
  isTmuxSessionAlive: (agentId: string) => boolean;
  /** Clean up stale tmux sessions */
  cleanupStaleTmuxSessions: () => void;
  /** Attach PTY to tmux session */
  attachPty: (agentId: string, job: Job, cols: number, rows: number) => Promise<void>;
}

export interface StartInteractiveOptions {
  agentId: string;
  job: Job;
  cols?: number;
  rows?: number;
  resumeSessionId?: string;
  /** When true, appends finish_job instruction to prompt and treats session exit as completion */
  autoFinish?: boolean;
}

/**
 * Start an interactive agent: validate work_dir, build prompt and script,
 * spawn a tmux session, then schedule post-spawn setup (prompt delivery + PTY attach).
 *
 * This is the thin orchestrator that ties together the pure functions above
 * with side-effectful resource checks and state transitions.
 */
export function startInteractiveAgent(
  opts: StartInteractiveOptions,
  ctx: SpawnerContext,
): void {
  const { agentId, job, cols = 100, rows = 50, resumeSessionId, autoFinish = false } = opts;

  // ── 1. Validate work_dir ──────────────────────────────────────────────────
  if (job.work_dir) {
    try {
      if (!fs.statSync(job.work_dir).isDirectory()) throw new Error('not a directory');
    } catch {
      const msg = `work_dir does not exist: ${job.work_dir}`;
      console.warn(`[pty ${agentId}] ${msg} — marking job failed`);
      captureWithContext(new Error(msg), { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      logPtyLifecycleEvent('pty_work_dir_rejected', agentId, job, {
        reason: 'work_dir_does_not_exist',
        rejected_path: job.work_dir,
      });
      queries.updateAgent(agentId, { status: 'failed', error_message: msg, finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
      return;
    }
  }

  const workDir = getExistingCwd(job.work_dir ?? process.cwd());
  const model: string | null = job.model ?? null;

  // ── 2. Build MCP config ───────────────────────────────────────────────────
  const mcpPort = Number(MCP_PORT);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      orchestrator: {
        url: `http://localhost:${mcpPort}/mcp/${agentId}`,
        type: 'http',
      },
    },
  });

  // ── 3. Build and write prompt ─────────────────────────────────────────────
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const pFile = promptPath(agentId);
  let promptText = buildInteractivePrompt(job);
  if (autoFinish) {
    promptText += '\n\nIMPORTANT: When you have completed this task, call the finish_job MCP tool with a summary of what was accomplished.';
  }
  fs.writeFileSync(pFile, promptText, 'utf8');

  // ── 4. Capture git HEAD SHA for post-agent diffing ────────────────────────
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: workDir, timeout: 5000 }).toString().trim();
    queries.updateAgent(agentId, { base_sha: sha });
  } catch { /* not a git repo or git not available */ }

  // ── 5. Build launcher script ──────────────────────────────────────────────
  const useCodex = isCodexModel(model);
  if (useCodex) ensureCodexTrusted(workDir);

  const usePrintMode = !useCodex && (isAutoExitJob(job) || !job.is_interactive);

  // Determine the expected branch for this job (if any)
  let expectedBranch: string | null = null;
  if (job.workflow_id) {
    expectedBranch = queries.getWorkflowById(job.workflow_id)?.worktree_branch ?? null;
  }
  if (!expectedBranch) {
    try {
      const wt = queries.listActiveWorktrees().find(w => w.path === workDir);
      if (wt) expectedBranch = wt.branch;
    } catch { /* ignore */ }
  }

  const scriptContent = buildAgentScript({
    agentId,
    job,
    workDir,
    mcpConfig,
    promptFilePath: pFile,
    useCodex,
    usePrintMode,
    resumeSessionId,
    expectedBranch,
  });

  const sFile = scriptPath(agentId);
  fs.writeFileSync(sFile, scriptContent, { mode: 0o755 });

  // ── 6. Clean up stale sessions + resource check ───────────────────────────
  ctx.cleanupStaleTmuxSessions();

  const attached = ctx.getAttachedCount();
  const spawning = ctx.countInState(AgentState.Spawning) + ctx.countInState(AgentState.Attaching);
  const resourceCheck = checkResources(attached, spawning);
  if (!resourceCheck.ok) {
    const msg = `PTY resource check failed: ${resourceCheck.reason}`;
    console.warn(`[pty ${agentId}] ${msg} — marking job failed with cooldown`);
    logPtyLifecycleEvent('pty_resource_check_failed', agentId, job, {
      reason: resourceCheck.reason,
      active_pty_sessions: attached,
      resource_backoff_ms: getBackoffMs(),
      max_pty_sessions: MAX_PTY_SESSIONS,
    });
    queries.updateAgent(agentId, { status: 'failed', error_message: msg, finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  // ── 7. Clear previous logs and mark as Spawning ───────────────────────────
  clearAgentLogFiles(agentId);
  ctx.transition(agentId, AgentState.Spawning);

  // ── 8. Spawn tmux session ─────────────────────────────────────────────────
  try {
    spawnTmuxSession({ agentId, scriptFile: sFile, workDir, cols, rows });
    resetBackoff();
  } catch (err) {
    ctx.transition(agentId, AgentState.Failed);
    console.error(`[pty ${agentId}] failed to create tmux session:`, errMsg(err));
    captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    logPtyLifecycleEvent('pty_tmux_session_create_failed', agentId, job, {
      error: errMsg(err),
      cols,
      rows,
      work_dir_exists: fs.existsSync(workDir),
    });
    queries.updateAgent(agentId, { status: 'failed', error_message: errMsg(err), finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');

    // Detect resource exhaustion errors and escalate backoff
    const isResourceError = /posix_spawnp|EMFILE|ENFILE|EAGAIN|resource|Device not configured|fork failed/i.test(errMsg(err));
    if (isResourceError) {
      setLastResourceErrorTime(Date.now());
      escalateBackoff();
      console.warn(`[pty ${agentId}] resource exhaustion detected — backoff now ${getBackoffMs() / 1000}s`);
      logPtyLifecycleEvent('pty_resource_backoff_escalated', agentId, job, {
        error: errMsg(err),
        backoff_ms: getBackoffMs(),
      });
    }

    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  // ── 9. Post-spawn setup (delayed to allow TUI initialisation) ─────────────
  try {
    queries.updateAgent(agentId, { status: 'starting' });
    const agentWithJob = queries.getAgentWithJob(agentId);
    if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
  } catch (err) {
    try { ctx.transition(agentId, AgentState.Failed); } catch { /* already past Spawning */ }
    console.error(`[pty ${agentId}] failed to update agent to starting state:`, errMsg(err));
    captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
    queries.updateAgent(agentId, { status: 'failed', error_message: errMsg(err), finished_at: Date.now() });
    queries.updateJobStatus(job.id, 'failed');
    const updated = queries.getAgentWithJob(agentId);
    if (updated) socket.emitAgentUpdate(updated);
    return;
  }

  setTimeout(async () => {
    try {
      if (ctx.isTmuxSessionAlive(agentId)) {
        if (useCodex) {
          try {
            execFileSync(TMUX, ['load-buffer', '-b', `agent-${agentId}`, pFile], { stdio: 'pipe' });
            execFileSync(TMUX, ['paste-buffer', '-b', `agent-${agentId}`, '-t', sessionName(agentId)], { stdio: 'pipe' });
          } catch (err) {
            console.warn(`[pty ${agentId}] failed to paste codex prompt:`, errMsg(err));
          }
          // paste-buffer returns before tmux finishes feeding content into the terminal;
          // give it a moment to settle so Enter arrives after the full paste is processed.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
          execFileSync(TMUX, ['send-keys', '-t', sessionName(agentId), 'Enter'], { stdio: 'pipe' });
        } catch (err) {
          console.warn(`[pty ${agentId}] failed to send Enter:`, errMsg(err));
        }
      }

      // Guard: agent may have already finished during the 4s startup delay
      const currentAgent = queries.getAgentById(agentId);
      const TERMINAL = ['done', 'failed', 'cancelled'];
      if (currentAgent && TERMINAL.includes(currentAgent.status)) return;

      queries.updateAgent(agentId, { status: 'running' });
      markJobRunning(job.id);
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
      logPtyLifecycleEvent('pty_agent_running', agentId, job, {
        transport: isStandalonePrintJob(job) ? 'ndjson_tail_poll' : 'pty_attach',
      });

      // Attach node-pty to the tmux session
      ctx.attachPty(agentId, job, cols, rows);
    } catch (err) {
      try { ctx.transition(agentId, AgentState.Failed); } catch { /* already transitioned */ }
      console.error(`[pty ${agentId}] error in post-start setup:`, errMsg(err));
      captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'PtyManager' });
      logPtyLifecycleEvent('pty_post_start_setup_failed', agentId, job, {
        error: errMsg(err),
      });
      queries.updateAgent(agentId, { status: 'failed', error_message: errMsg(err), finished_at: Date.now() });
      queries.updateJobStatus(job.id, 'failed');
      const updated = queries.getAgentWithJob(agentId);
      if (updated) socket.emitAgentUpdate(updated);
    }
  }, 4000);
}
