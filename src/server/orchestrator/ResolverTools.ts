/**
 * ResolverTools — the surface the Resolver LLM can call.
 *
 * Tools are partitioned into:
 *   - READ tools: return data, never mutate
 *   - MUTATING tools: change DB rows or worktree files; each one is journaled
 *     to resolver_actions with a payload + outcome before/after execution
 *   - TERMINAL tools: end the run (propose_resume, escalate_to_user,
 *     mark_unresolvable). The session loop stops when one of these is called.
 *
 * Safety guarantees enforced here:
 *   - All file paths are resolved + verified to stay inside workflow.worktree_path
 *   - All git commands are an allowlist; no push, no destructive resets, no PR ops
 *   - All free-text inputs (diagnosis, reason, escalation question) pass through
 *     stripControlChars + length caps before being persisted or surfaced
 *   - update_workflow_field accepts only safe fields the watchdog already touches
 *   - write_note keys must match RecoveryKeys (plan/contract/worklog/review)
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type Anthropic from '@anthropic-ai/sdk';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { stripControlChars } from './watcherTools.js';
import { normalizeLockPath } from './FileLockRegistry.js';
import { RecoveryKeys } from './WorkflowRecovery.js';
import { PTY_LOG_DIR } from './PtyDiskLogger.js';
import type {
  ResolverRun,
  ResolverActionType,
  ResolverActionOutcome,
  ResolverClassification,
  Workflow,
  Discussion,
} from '../../shared/types.js';

// ─── Caps & limits ──────────────────────────────────────────────────────────

const TEXT_CAP_SHORT = 1_000;            // headlines, reasons, short fields
const TEXT_CAP_MEDIUM = 4_000;           // diagnosis bodies
const TEXT_CAP_LONG = 16_000;            // file edit contents

const FILE_TAIL_BYTES = 32 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;

// Intentionally narrow. `work_dir` is NOT in this set even though the watchdog
// touches it — there's no safe "stays under the original" constraint we can
// apply (the legitimate auto-fix case is precisely when the current value is
// null), and a Resolver that points work_dir at an arbitrary host directory
// would spawn the next phase's agents into that directory. The watchdog's
// inferWorkspaceRepoFromTitle path already handles null work_dir recovery;
// any other case should escalate with the inferred path as a suggestion.
const ALLOWED_WORKFLOW_FIELDS = new Set([
  'implementer_model',
  'reviewer_model',
  'blocked_reason',
]);

// Git subcommand allowlist. No 'push', no 'reset --hard', no 'clean -f',
// no 'branch -D', no 'rebase', no 'merge', no 'checkout'.
const ALLOWED_GIT_VERBS = new Set([
  'add',
  'commit',
  'restore',
  'stash',
  'status',
  'diff',
  'log',
]);


// ─── Tool definitions for the Anthropic Messages API ───────────────────────

export const RESOLVER_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    name: 'read_blocked_diagnostic',
    description: "Re-read the latest data/blocked-diagnostics/*.md file for this workflow. Returns the full file content. Use only if you need it again — the file is already included in your initial context.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_agent_log',
    description: "Read a tail of an agent's log file. kind = 'ndjson' for the parsed stream, 'stderr' for subprocess stderr, 'snapshot' for the last tmux capture.",
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        kind: { type: 'string', enum: ['ndjson', 'stderr', 'snapshot'] },
        max_bytes: { type: 'number', description: `Defaults to ${LOG_TAIL_BYTES}; clamped.` },
      },
      required: ['agent_id', 'kind'],
    },
  },
  {
    name: 'read_workflow_note',
    description: 'Read a workflow note (plan, contract, worklog/cycle-N, review-feedback/cycle-N).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'read_worktree_file',
    description: 'Read a tail of a file inside the workflow worktree. Path is relative to the worktree root; absolute paths and `..` are rejected.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        max_bytes: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'git_command',
    description: `Run a git subcommand in the worktree. Allowed verbs: ${[...ALLOWED_GIT_VERBS].join(', ')}. Returns combined stdout/stderr (capped). Refuses push/reset --hard/clean -f/branch -D/checkout.`,
    input_schema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'argv after the literal "git" — e.g. ["status", "--short"].' },
        reason: { type: 'string' },
      },
      required: ['args', 'reason'],
    },
  },
  {
    name: 'edit_worktree_file',
    description: 'Overwrite a file inside the workflow worktree. Path must be relative to worktree root. Refuses .git, node_modules, and dotfile directories. Reason is required.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        contents: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['path', 'contents', 'reason'],
    },
  },
  {
    name: 'update_workflow_field',
    description: `Update one of the safe workflow fields: ${[...ALLOWED_WORKFLOW_FIELDS].join(', ')}. Reason is required and journaled.`,
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: [...ALLOWED_WORKFLOW_FIELDS] },
        value: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['field', 'value', 'reason'],
    },
  },
  {
    name: 'write_note',
    description: "Write or overwrite a workflow note. Allowed keys: plan, contract, worklog/cycle-N, review-feedback/cycle-N (where N is the workflow's current_cycle).",
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "One of: 'plan', 'contract', 'worklog/cycle-N', 'review-feedback/cycle-N'." },
        value: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['key', 'value', 'reason'],
    },
  },
  {
    name: 'set_classification',
    description: 'Set or update the classification for this resolver run. Call this once before mutating actions so the dashboard shows your diagnosis even if you escalate.',
    input_schema: {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: ['transient_infra', 'code_bug', 'config_drift', 'model_capability', 'external_service', 'unknown'] },
        diagnosis: { type: 'string' },
      },
      required: ['classification', 'diagnosis'],
    },
  },
  {
    name: 'propose_resume',
    description: 'Propose resuming the workflow at the given phase + cycle. Confidence is 0..1 — the dispatcher compares against a per-classification threshold and decides whether to auto-resume or escalate. This is a TERMINAL tool: the run ends after this call.',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['assess', 'review', 'implement', 'verify'] },
        cycle: { type: 'number' },
        confidence: { type: 'number', description: '0..1 confidence the resume will succeed.' },
        summary: { type: 'string' },
      },
      required: ['phase', 'cycle', 'confidence', 'summary'],
    },
  },
  {
    name: 'escalate_to_user',
    description: 'TERMINAL. Open a discussion thread asking the user to intervene. Use when you cannot fix the block.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        suggested_actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['question'],
    },
  },
  {
    name: 'mark_unresolvable',
    description: 'TERMINAL. Mark this Resolver run as unresolvable without escalating (e.g. the workflow is in a state only the user can fix and you have nothing useful to ask). Workflow stays in its current blocked state.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

// ─── Tool input types ──────────────────────────────────────────────────────

export interface ReadAgentLogInput { agent_id: string; kind: 'ndjson' | 'stderr' | 'snapshot'; max_bytes?: number; }
export interface ReadNoteInput { key: string; }
export interface ReadWorktreeFileInput { path: string; max_bytes?: number; }
export interface GitCommandInput { args: string[]; reason: string; }
export interface EditWorktreeFileInput { path: string; contents: string; reason: string; }
export interface UpdateWorkflowFieldInput { field: string; value: string; reason: string; }
export interface WriteNoteInput { key: string; value: string; reason: string; }
export interface SetClassificationInput { classification: ResolverClassification; diagnosis: string; }
export interface ProposeResumeInput { phase: 'assess' | 'review' | 'implement' | 'verify'; cycle: number; confidence: number; summary: string; }
export interface EscalateInput { question: string; context?: string; suggested_actions?: string[]; }
export interface MarkUnresolvableInput { reason: string; }

// ─── Tool result ───────────────────────────────────────────────────────────

export interface ResolverToolResult {
  ok: boolean;
  message: string;          // human-readable, fed back as tool_result to the LLM
  action_id?: string;
  terminal?: { kind: 'propose_resume' | 'escalated' | 'unresolvable'; payload: unknown };
}

// ─── Read tools ────────────────────────────────────────────────────────────

export function execReadBlockedDiagnostic(run: ResolverRun): ResolverToolResult {
  recordAction(run, 'read_blocked_diagnostic', {}, 'applied', null);
  // The actual content is loaded by ResolverContext.loadLatestBlockedDiagnostic
  // — we surface it via the session, not here. Returning a pointer keeps the
  // tool predictable; the session decides whether to re-attach the file.
  return { ok: true, message: 'see <diagnostic> block in initial context; re-fetch by reading blocked-diagnostics/' };
}

// Agent IDs are UUIDv4 in this codebase; constrain to that shape so a value
// like '../../etc/passwd' can't escape PTY_LOG_DIR via path.join.
const AGENT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function execReadAgentLog(run: ResolverRun, input: ReadAgentLogInput): ResolverToolResult {
  if (!input.agent_id || typeof input.agent_id !== 'string') {
    return failAction(run, 'read_agent_log', input, 'agent_id required');
  }
  // Strip control chars first — the UUID regex below would reject anything
  // sneaky anyway, but if it didn't (loosened in future) we don't want raw
  // bytes from the LLM landing in the resolver_actions payload.
  const cleanAgentId = capUntrustedText(input.agent_id, 128);
  if (!AGENT_ID_RE.test(cleanAgentId)) {
    return failAction(run, 'read_agent_log', { ...input, agent_id: cleanAgentId }, 'agent_id must be a UUID');
  }
  if (input.kind !== 'ndjson' && input.kind !== 'stderr' && input.kind !== 'snapshot') {
    return failAction(run, 'read_agent_log', { ...input, agent_id: cleanAgentId }, `invalid kind '${input.kind}'`);
  }
  // Use cleanAgentId for all downstream operations.
  const agentId = cleanAgentId;

  // Ownership check: the agent must belong to a job in this workflow. Without
  // this an LLM could ask for any other workflow's agent log by guessing a
  // UUID, leaking logs from unrelated runs even though the path is safe.
  const agent = queries.getAgentById(agentId);
  if (!agent) {
    return failAction(run, 'read_agent_log', { ...input, agent_id: agentId }, `agent ${agentId} not found`);
  }
  const job = queries.getJobById(agent.job_id);
  if (!job || job.workflow_id !== run.workflow_id) {
    return failAction(run, 'read_agent_log', { ...input, agent_id: agentId }, `agent ${agentId} does not belong to workflow ${run.workflow_id}`);
  }

  const max = clamp(input.max_bytes ?? LOG_TAIL_BYTES, 1024, LOG_TAIL_BYTES);
  const file = path.resolve(PTY_LOG_DIR, `${agentId}.${input.kind}`);
  // Defence-in-depth: even with the UUID + ownership guards above, verify
  // the resolved path stays inside PTY_LOG_DIR. Catches future regressions
  // if either regex is loosened or PTY_LOG_DIR is moved.
  const root = path.resolve(PTY_LOG_DIR) + path.sep;
  if (!file.startsWith(root)) {
    return failAction(run, 'read_agent_log', { ...input, agent_id: agentId }, 'resolved path escapes PTY_LOG_DIR');
  }
  const body = tailFile(file, max);
  recordAction(run, 'read_agent_log', { agent_id: agentId, kind: input.kind, bytes: body?.length ?? 0 }, 'applied', null);
  if (body == null) return { ok: false, message: `agent log not found: ${path.basename(file)}` };
  return { ok: true, message: body };
}

export function execReadNote(run: ResolverRun, input: ReadNoteInput): ResolverToolResult {
  const key = resolveNoteKey(run.workflow_id, input.key);
  if (!key) return failAction(run, 'read_workflow_note', input, `unrecognized note key '${input.key}'`);
  const note = queries.getNote(key);
  recordAction(run, 'read_workflow_note', { key }, 'applied', null);
  return note
    ? { ok: true, message: note.value }
    : { ok: false, message: `note '${key}' not found` };
}

export function execReadWorktreeFile(run: ResolverRun, input: ReadWorktreeFileInput): ResolverToolResult {
  const wf = queries.getWorkflowById(run.workflow_id);
  if (!wf) return failAction(run, 'read_worktree_file', input, 'workflow not found');
  const resolved = resolveWorktreeRelativePath(wf, input.path);
  if (!resolved.ok) return failAction(run, 'read_worktree_file', input, resolved.error);
  const max = clamp(input.max_bytes ?? FILE_TAIL_BYTES, 256, FILE_TAIL_BYTES);
  const body = tailFile(resolved.absolute, max);
  recordAction(run, 'read_worktree_file', { path: resolved.relative, bytes: body?.length ?? 0 }, 'applied', null);
  if (body == null) return { ok: false, message: `file not found or unreadable: ${resolved.relative}` };
  return { ok: true, message: body };
}

// ─── Mutating tools ────────────────────────────────────────────────────────

export function execGitCommand(run: ResolverRun, input: GitCommandInput): ResolverToolResult {
  const wf = queries.getWorkflowById(run.workflow_id);
  if (!wf) return failAction(run, 'git_command', input, 'workflow not found');
  const dir = wf.worktree_path ?? wf.work_dir;
  if (!dir) return failAction(run, 'git_command', input, 'workflow has no worktree_path or work_dir');
  if (!fs.existsSync(dir)) return failAction(run, 'git_command', input, `worktree directory does not exist: ${dir}`);

  const args = Array.isArray(input.args) ? input.args.map(a => String(a)) : [];
  if (args.length === 0) return failAction(run, 'git_command', input, 'args[] cannot be empty');

  const verb = args[0];
  if (!ALLOWED_GIT_VERBS.has(verb)) {
    return failAction(run, 'git_command', input, `git verb '${verb}' is not in the allowlist`);
  }

  // Block known-destructive option combinations even within allowed verbs.
  if (verb === 'restore' && args.includes('--source')) {
    return failAction(run, 'git_command', input, 'git restore --source is not allowed (could pull from arbitrary refs)');
  }
  if (verb === 'commit' && (args.includes('--amend') || args.includes('-a'))) {
    return failAction(run, 'git_command', input, 'git commit --amend / -a not allowed (use explicit add + commit)');
  }
  // Block destructive stash subcommands. `git stash` and `git stash push` save
  // work; `git stash pop` / `apply` restore it. `drop` and `clear` permanently
  // discard stashed entries, which can lose Resolver-pushed work or anything
  // the workflow already had stashed.
  if (verb === 'stash' && (args[1] === 'drop' || args[1] === 'clear')) {
    return failAction(run, 'git_command', input, `git stash ${args[1]} is not allowed (would discard stashed work)`);
  }

  const action = recordAction(run, 'git_command', { args, reason: sanitizeShort(input.reason) }, 'pending', null);
  try {
    const out = execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    });
    const body = stripControlChars(out).slice(0, 4_000);
    queries.updateResolverActionOutcome(action.id, 'applied', body.slice(0, 200));
    emitAction(action.id);
    return { ok: true, message: body || '(no output)', action_id: action.id };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    queries.updateResolverActionOutcome(action.id, 'error', msg.slice(0, 500));
    emitAction(action.id);
    return { ok: false, message: `git ${verb} failed: ${msg.slice(0, 500)}`, action_id: action.id };
  }
}

export function execEditWorktreeFile(run: ResolverRun, input: EditWorktreeFileInput): ResolverToolResult {
  const wf = queries.getWorkflowById(run.workflow_id);
  if (!wf) return failAction(run, 'edit_worktree_file', { path: input.path }, 'workflow not found');
  const resolved = resolveWorktreeRelativePath(wf, input.path);
  if (!resolved.ok) return failAction(run, 'edit_worktree_file', { path: input.path }, resolved.error);

  if (typeof input.contents !== 'string') {
    return failAction(run, 'edit_worktree_file', { path: input.path }, 'contents must be a string');
  }
  if (input.contents.length > TEXT_CAP_LONG * 4) {
    return failAction(run, 'edit_worktree_file', { path: input.path }, `contents exceeds cap (${TEXT_CAP_LONG * 4} chars)`);
  }

  // File-lock check. The Resolver only fires on status='blocked' workflows
  // (which have no running agents in the normal case), but a race at the
  // moment of transition is possible: an agent's final turn writes the file
  // while the Resolver also tries to edit it. Yield to any active lock —
  // the operator can re-dispatch once the lock is released.
  const normFile = normalizeLockPath(resolved.absolute);
  // Scan all active direct rows and re-normalize so legacy non-canonical lock
  // rows are still treated as a conflict by the Resolver.
  const activeLocks = queries
    .getAllActiveDirectFileLocks()
    .filter(l => normalizeLockPath(l.file_path) === normFile);
  if (activeLocks.length > 0) {
    const lock = activeLocks[0];
    return failAction(
      run,
      'edit_worktree_file',
      { path: resolved.relative, conflicting_agent: lock.agent_id },
      `file is locked by agent ${lock.agent_id.slice(0, 8)}${lock.reason ? ` (${lock.reason})` : ''}`,
    );
  }

  const action = recordAction(run, 'edit_worktree_file', {
    path: resolved.relative,
    bytes: input.contents.length,
    reason: sanitizeShort(input.reason),
  }, 'pending', null);

  try {
    fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
    fs.writeFileSync(resolved.absolute, input.contents, 'utf8');
    queries.updateResolverActionOutcome(action.id, 'applied', null);
    emitAction(action.id);
    return { ok: true, message: `wrote ${resolved.relative} (${input.contents.length} bytes)`, action_id: action.id };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    queries.updateResolverActionOutcome(action.id, 'error', msg.slice(0, 500));
    emitAction(action.id);
    return { ok: false, message: `write failed: ${msg.slice(0, 300)}`, action_id: action.id };
  }
}

export function execUpdateWorkflowField(run: ResolverRun, input: UpdateWorkflowFieldInput): ResolverToolResult {
  if (!ALLOWED_WORKFLOW_FIELDS.has(input.field)) {
    return failAction(run, 'update_workflow_field', input, `field '${input.field}' not allowed`);
  }
  if (typeof input.value !== 'string') {
    return failAction(run, 'update_workflow_field', input, 'value must be a string');
  }
  const wf = queries.getWorkflowById(run.workflow_id);
  if (!wf) return failAction(run, 'update_workflow_field', input, 'workflow not found');

  // Sanitize the value before BOTH the journal AND the DB write — the
  // value gets re-loaded into Resolver context bundles and shown in the
  // dashboard, so control chars or ANSI escapes here would propagate.
  // Cap is field-aware: blocked_reason can be longer than the model field
  // values, but all three are bounded.
  const cleanValue = capUntrustedText(input.value, input.field === 'blocked_reason' ? TEXT_CAP_MEDIUM : TEXT_CAP_SHORT);

  const action = recordAction(run, 'update_workflow_field', {
    field: input.field,
    value: cleanValue,
    reason: sanitizeShort(input.reason),
  }, 'pending', null);

  try {
    const fields: Record<string, unknown> = {};
    fields[input.field] = cleanValue;
    queries.updateWorkflow(run.workflow_id, fields as Parameters<typeof queries.updateWorkflow>[1]);
    const updated = queries.getWorkflowById(run.workflow_id);
    if (updated) socket.emitWorkflowUpdate(updated);
    queries.updateResolverActionOutcome(action.id, 'applied', null);
    emitAction(action.id);
    logResilienceEvent('resolver_update_workflow_field', 'workflow', run.workflow_id, {
      field: input.field, resolver_id: run.id,
    });
    return { ok: true, message: `updated ${input.field}`, action_id: action.id };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    queries.updateResolverActionOutcome(action.id, 'error', msg.slice(0, 500));
    emitAction(action.id);
    return { ok: false, message: `update failed: ${msg.slice(0, 300)}`, action_id: action.id };
  }
}

export function execWriteNote(run: ResolverRun, input: WriteNoteInput): ResolverToolResult {
  const key = resolveNoteKey(run.workflow_id, input.key);
  if (!key) return failAction(run, 'write_note', input, `unrecognized note key '${input.key}'`);

  if (typeof input.value !== 'string') {
    return failAction(run, 'write_note', input, 'value must be a string');
  }
  if (input.value.length > TEXT_CAP_LONG * 2) {
    return failAction(run, 'write_note', input, `value exceeds cap (${TEXT_CAP_LONG * 2} chars)`);
  }

  // Notes feed directly into future phase prompts (plan, contract) and into
  // Resolver context bundles for subsequent runs. Strip control chars before
  // persistence so injected ANSI escapes can't reach downstream agents.
  const cleanValue = capUntrustedText(input.value, TEXT_CAP_LONG * 2);

  const action = recordAction(run, 'write_note', { key, bytes: cleanValue.length, reason: sanitizeShort(input.reason) }, 'pending', null);
  try {
    queries.upsertNote(key, cleanValue, null);
    queries.updateResolverActionOutcome(action.id, 'applied', null);
    emitAction(action.id);
    return { ok: true, message: `wrote note ${key} (${cleanValue.length} bytes)`, action_id: action.id };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    queries.updateResolverActionOutcome(action.id, 'error', msg.slice(0, 500));
    emitAction(action.id);
    return { ok: false, message: `note write failed: ${msg}`, action_id: action.id };
  }
}

export function execSetClassification(run: ResolverRun, input: SetClassificationInput): ResolverToolResult {
  const classification = sanitizeClassification(input.classification);
  if (!classification) return failAction(run, 'set_classification', input, `invalid classification '${input.classification}'`);
  const diagnosis = capUntrustedText(input.diagnosis, TEXT_CAP_MEDIUM);
  queries.updateResolverRun(run.id, { classification, diagnosis });
  const fresh = queries.getResolverRunById(run.id);
  if (fresh) socket.emitResolverRunUpdate(fresh);
  return { ok: true, message: `classification set to ${classification}` };
}

// ─── Terminal tools ─────────────────────────────────────────────────────────

export function execProposeResume(run: ResolverRun, input: ProposeResumeInput): ResolverToolResult {
  const summary = capUntrustedText(input.summary, TEXT_CAP_MEDIUM);
  const confidence = clampNumber(input.confidence, 0, 1);
  const payload = { phase: input.phase, cycle: Math.max(0, Math.floor(input.cycle)), confidence, summary };
  const action = recordAction(run, 'propose_resume', payload, 'applied', `confidence=${confidence.toFixed(2)}`);
  queries.updateResolverRun(run.id, { recommended_action: JSON.stringify(payload) });
  const fresh = queries.getResolverRunById(run.id);
  if (fresh) socket.emitResolverRunUpdate(fresh);
  emitAction(action.id);
  return {
    ok: true,
    message: `proposed resume at ${input.phase}/${input.cycle} (confidence ${confidence.toFixed(2)}). Run will end and dispatcher will decide.`,
    action_id: action.id,
    terminal: { kind: 'propose_resume', payload },
  };
}

export function execEscalate(run: ResolverRun, input: EscalateInput): ResolverToolResult {
  const question = capUntrustedText((input.question ?? '').trim(), TEXT_CAP_SHORT);
  if (!question) return failAction(run, 'escalate_to_user', input, 'question is required');
  const context = input.context ? capUntrustedText(input.context, TEXT_CAP_MEDIUM) : null;
  const suggested = (input.suggested_actions ?? [])
    .map(a => capUntrustedText(String(a), 200))
    .filter(a => a.length > 0)
    .slice(0, 5);

  // discussions.agent_id is NOT NULL but has no foreign key, so the
  // `wf-<id>` synthetic fallback inserts cleanly when no agent has run yet
  // (e.g. the very first phase failed before spawning). The dashboard groups
  // discussions by agent and falls through to "no agent" for unmatched IDs.
  const anchorAgentId = findEscalationAnchorAgentId(run.workflow_id) ?? `wf-${run.workflow_id}`;

  const action = recordAction(run, 'escalate_to_user', {
    question, has_context: !!context, suggested: suggested.length, anchor_agent_id: anchorAgentId,
  }, 'pending', null);

  try {
    const discussion: Discussion = queries.insertDiscussion({
      id: randomUUID(),
      agent_id: anchorAgentId,
      topic: `Auto Resolver: ${truncate(question, 60)}`,
      category: 'alert',
      priority: 'high',
      context,
    });
    const body = suggested.length > 0
      ? `${question}\n\n**Suggested actions:**\n${suggested.map(a => `- ${a}`).join('\n')}`
      : question;
    queries.insertDiscussionMessage({
      id: randomUUID(),
      discussion_id: discussion.id,
      role: 'eye',
      content: body,
      requires_reply: true,
    });
    const firstMsg = queries.getDiscussionMessages(discussion.id)[0];
    socket.emitDiscussionNew(discussion, firstMsg);
    queries.updateResolverActionOutcome(action.id, 'applied', `discussion ${discussion.id.slice(0, 8)}`);
    emitAction(action.id);

    queries.updateResolverRun(run.id, {
      recommended_action: JSON.stringify({ kind: 'escalate', question, context, suggested_actions: suggested, discussion_id: discussion.id }),
    });

    return {
      ok: true,
      message: `escalation posted as discussion ${discussion.id.slice(0, 8)}`,
      action_id: action.id,
      terminal: { kind: 'escalated', payload: { discussion_id: discussion.id } },
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    queries.updateResolverActionOutcome(action.id, 'error', msg.slice(0, 500));
    emitAction(action.id);
    return { ok: false, message: `escalation failed: ${msg.slice(0, 500)}`, action_id: action.id };
  }
}

export function execMarkUnresolvable(run: ResolverRun, input: MarkUnresolvableInput): ResolverToolResult {
  const reason = capUntrustedText(input.reason, TEXT_CAP_MEDIUM);
  const action = recordAction(run, 'mark_unresolvable', { reason }, 'applied', null);
  queries.updateResolverRun(run.id, {
    recommended_action: JSON.stringify({ kind: 'unresolvable', reason }),
  });
  emitAction(action.id);
  return {
    ok: true,
    message: 'marked unresolvable; workflow remains blocked',
    action_id: action.id,
    terminal: { kind: 'unresolvable', payload: { reason } },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function recordAction(
  run: ResolverRun,
  type: ResolverActionType,
  payload: unknown,
  outcome: ResolverActionOutcome,
  outcomeDetail: string | null,
) {
  const action = queries.insertResolverAction({
    id: randomUUID(),
    resolver_id: run.id,
    workflow_id: run.workflow_id,
    type,
    payload: JSON.stringify(payload).slice(0, 4_000),
    outcome,
    outcome_detail: outcomeDetail,
  });
  // For 'applied'/'rejected'/'error' inserts emit immediately; 'pending' rows
  // are emitted via emitAction(id) once the outcome flips.
  if (outcome !== 'pending') {
    try { socket.emitResolverActionNew(action); } catch { /* ignore */ }
  }
  return action;
}

function emitAction(id: string): void {
  try {
    const fresh = queries.getResolverActionById(id);
    if (fresh) socket.emitResolverActionNew(fresh);
  } catch { /* ignore */ }
}

function failAction(run: ResolverRun, type: ResolverActionType, payload: unknown, message: string): ResolverToolResult {
  const action = recordAction(run, type, payload, 'rejected', message.slice(0, 300));
  return { ok: false, message, action_id: action.id };
}

interface ResolvedPath { ok: true; relative: string; absolute: string }
interface ResolvedPathErr { ok: false; error: string }

function resolveWorktreeRelativePath(wf: Workflow, p: string): ResolvedPath | ResolvedPathErr {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, error: 'path required' };
  if (path.isAbsolute(p)) return { ok: false, error: 'absolute paths are not allowed' };
  // Reject parent-traversal attempts before path.resolve normalizes them
  // (defence-in-depth — the post-resolve startsWith check is the real guard).
  if (p.split(/[\\/]/).some(seg => seg === '..')) return { ok: false, error: 'path traversal (..) is not allowed' };

  const root = wf.worktree_path ?? wf.work_dir;
  if (!root) return { ok: false, error: 'workflow has no worktree_path or work_dir' };

  const absolute = path.resolve(root, p);
  const rootResolved = path.resolve(root);
  const rootWithSep = rootResolved + path.sep;
  if (!(absolute + path.sep).startsWith(rootWithSep)) {
    return { ok: false, error: `path escapes worktree root ${root}` };
  }

  // path.relative receives the resolved root WITHOUT a trailing separator —
  // posix tolerates the trailing slash, but on Windows path.sep is `\` and
  // path.relative treats it as a directory anchor.
  const rel = path.relative(rootResolved, absolute);
  const segs = rel.split(path.sep);
  const first = segs[0] ?? '';
  if (first === '.git' || first === 'node_modules' || first.startsWith('.claude')) {
    return { ok: false, error: `editing under ${first} is not allowed` };
  }

  // Symlink defence (TOCTOU): the lexical containment check above does NOT
  // follow symlinks, but fs.writeFileSync / fs.readFileSync do. If a previous
  // tool call or an adversarial agent created a symlink inside the worktree
  // pointing outside it, the lexical check passes but the actual IO escapes.
  // Resolve the real path of (a) the parent of the target — present even if
  // the file is new — and (b) the root, then verify containment again.
  //
  // Best-effort when the root doesn't exist on disk: skip the check rather
  // than fail. The real fs.writeFileSync will surface ENOENT itself, so a
  // missing root can't be exploited — there's nothing to escape from.
  if (fs.existsSync(rootResolved)) {
    try {
      const realRoot = fs.realpathSync(rootResolved) + path.sep;
      const parent = path.dirname(absolute);
      // Walk upward until we find an existing ancestor we can realpath. For
      // new files in new directories the immediate parent may not exist yet.
      let probe = parent;
      while (probe.length >= rootResolved.length && !fs.existsSync(probe)) {
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
      if (fs.existsSync(probe)) {
        const realProbe = fs.realpathSync(probe);
        if (!(realProbe + path.sep).startsWith(realRoot) && realProbe + path.sep !== realRoot) {
          return { ok: false, error: 'symlink escapes worktree root' };
        }
      }
      // If the file itself exists, realpath it too — catches the case where
      // the file is a symlink to outside.
      if (fs.existsSync(absolute)) {
        const realAbs = fs.realpathSync(absolute);
        if (!(realAbs + path.sep).startsWith(realRoot) && realAbs + path.sep !== realRoot) {
          return { ok: false, error: 'symlink target escapes worktree root' };
        }
      }
    } catch (err) {
      return { ok: false, error: `realpath check failed: ${(err as Error).message}` };
    }
  }

  return { ok: true, relative: rel, absolute };
}

function resolveNoteKey(workflowId: string, key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  // Only short-form keys are accepted — the regexes below enforce the cycle
  // shape so an LLM can't write to `workflow/<id>/worklog/cycle-999` or any
  // other never-run cycle. The full-form passthrough that previously lived
  // here bypassed that validation; it was unnecessary because the short
  // forms cover every legitimate access pattern.
  if (key === 'plan' || key === RecoveryKeys.plan(workflowId)) return RecoveryKeys.plan(workflowId);
  if (key === 'contract' || key === RecoveryKeys.contract(workflowId)) return RecoveryKeys.contract(workflowId);

  const worklog = key.match(/^worklog\/cycle-(\d+)$/) ?? key.match(/^worklog-(\d+)$/);
  if (worklog) {
    const c = parseInt(worklog[1], 10);
    return cycleIsValid(workflowId, c) ? RecoveryKeys.worklog(workflowId, c) : null;
  }
  const review = key.match(/^review-feedback\/cycle-(\d+)$/) ?? key.match(/^review-(\d+)$/);
  if (review) {
    const c = parseInt(review[1], 10);
    return cycleIsValid(workflowId, c) ? RecoveryKeys.reviewFeedback(workflowId, c) : null;
  }

  return null;
}

/**
 * A cycle number is valid for a workflow if it falls within [1, max_cycles].
 * Reject anything outside so a Resolver that misreads context can't write to
 * `worklog/cycle-999` (which no downstream code will ever read).
 *
 * Tightened from "fall back to permissive when workflow row is missing" to
 * "reject when the workflow doesn't exist" — a dangling workflow_id should
 * never produce a note write. The previous lenient fallback was defence-in-
 * depth for a case that shouldn't occur in production (the run row already
 * carries a verified workflow_id).
 */
function cycleIsValid(workflowId: string, cycle: number): boolean {
  if (!Number.isInteger(cycle) || cycle < 1) return false;
  const wf = queries.getWorkflowById(workflowId);
  if (!wf) return false;
  return cycle <= wf.max_cycles;
}

function findEscalationAnchorAgentId(workflowId: string): string | null {
  try {
    const jobs = queries.getJobsForWorkflow(workflowId);
    for (let i = jobs.length - 1; i >= 0; i--) {
      const agents = queries.getAgentsWithJobByJobId(jobs[i].id);
      if (agents[0]) return agents[0].id;
    }
  } catch { /* ignore */ }
  return null;
}

function sanitizeClassification(c: string): ResolverClassification | null {
  const valid: ResolverClassification[] = [
    'transient_infra', 'code_bug', 'config_drift', 'model_capability', 'external_service', 'unknown',
  ];
  return (valid as string[]).includes(c) ? (c as ResolverClassification) : null;
}

function sanitizeShort(s: string | undefined): string {
  return capUntrustedText(s ?? '', TEXT_CAP_SHORT);
}

/**
 * Sanitize and cap a string of LLM- or agent-authored text.
 *
 * Two steps in one call:
 *   1. stripControlChars — drop C0/C1 control bytes + bidi marks (matches the
 *      Watcher's sanitization pipeline).
 *   2. cap to `max` characters with an ellipsis suffix.
 *
 * Used for every persistence + tool-result path the LLM can touch, so the
 * dashboard + downstream agent prompts never receive un-stripped bytes.
 */
export function capUntrustedText(s: string, max: number): string {
  const stripped = stripControlChars(String(s ?? ''));
  return stripped.length > max ? stripped.slice(0, max - 1) + '…' : stripped;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return hi;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function clampNumber(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function tailFile(filePath: string, maxBytes: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    if (stat.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      const text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Map a tool_use block from the Anthropic API into one of the exec* functions
 * above. Unknown tool names produce an error-result rather than throwing so
 * the conversation can recover.
 */
export function dispatchResolverTool(
  run: ResolverRun,
  use: Anthropic.Messages.ToolUseBlock,
): ResolverToolResult {
  const name = use.name;
  const input = use.input as Record<string, unknown>;
  try {
    switch (name) {
      case 'read_blocked_diagnostic': return execReadBlockedDiagnostic(run);
      case 'read_agent_log':          return execReadAgentLog(run, input as unknown as ReadAgentLogInput);
      case 'read_workflow_note':      return execReadNote(run, input as unknown as ReadNoteInput);
      case 'read_worktree_file':      return execReadWorktreeFile(run, input as unknown as ReadWorktreeFileInput);
      case 'git_command':             return execGitCommand(run, input as unknown as GitCommandInput);
      case 'edit_worktree_file':      return execEditWorktreeFile(run, input as unknown as EditWorktreeFileInput);
      case 'update_workflow_field':   return execUpdateWorkflowField(run, input as unknown as UpdateWorkflowFieldInput);
      case 'write_note':              return execWriteNote(run, input as unknown as WriteNoteInput);
      case 'set_classification':      return execSetClassification(run, input as unknown as SetClassificationInput);
      case 'propose_resume':          return execProposeResume(run, input as unknown as ProposeResumeInput);
      case 'escalate_to_user':        return execEscalate(run, input as unknown as EscalateInput);
      case 'mark_unresolvable':       return execMarkUnresolvable(run, input as unknown as MarkUnresolvableInput);
      default:                        return { ok: false, message: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, message: `tool '${name}' threw: ${(err as Error).message ?? String(err)}` };
  }
}

// ─── exports for tests ──────────────────────────────────────────────────────
export const _internal = {
  resolveWorktreeRelativePath,
  resolveNoteKey,
  capUntrustedText,
  ALLOWED_GIT_VERBS,
  ALLOWED_WORKFLOW_FIELDS,
};
