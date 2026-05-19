/**
 * ResolverContext — gathers the read-only bundle that the Resolver LLM
 * receives at session start. Everything in here is data; tools later in
 * the loop may pull more on demand (e.g. read_diff, read_worktree_file).
 *
 * Cap sizes are aggressive: the goal is for the whole bundle to fit
 * comfortably under ~80 KB so the system prompt + tools cache hit holds
 * and the per-tick token cost stays bounded.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import { RecoveryKeys } from './WorkflowRecovery.js';
import { BLOCKED_LOG_DIR } from './WorkflowBlockedDiagnostics.js';
import { PTY_LOG_DIR } from './PtyDiskLogger.js';
import type {
  Workflow,
  Job,
  AgentWithJob,
  WatcherCommentary,
  ResolverRun,
} from '../../shared/types.js';
import type { ResilienceEvent } from '../db/workflowQueries.js';

export interface ResolverFailedAgentSummary {
  agent_id: string;
  job_id: string;
  job_title: string | null;
  job_phase: string | null;
  exit_code: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  error_message: string | null;
  ndjson_tail: string;
  stderr_tail: string;
  snapshot_tail: string;
}

export interface ResolverContextBundle {
  workflow: Workflow;
  attempt_number: number;
  blocked_diagnostic_md: string | null;
  last_failed_agent: ResolverFailedAgentSummary | null;
  recent_resilience_events: ResilienceEvent[];
  recent_watcher_commentary: WatcherCommentary[];
  notes: {
    plan: string | null;
    contract: string | null;
    worklogs: Array<{ cycle: number; content: string }>;
    review_feedback: Array<{ cycle: number; content: string }>;
  };
  git: {
    status: string | null;
    log_oneline: string | null;
    diff_stat: string | null;
    has_uncommitted: boolean;
  } | null;
  prior_resolver_runs: ResolverRun[];
}

const NDJSON_TAIL_BYTES = 32 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;
const SNAPSHOT_TAIL_BYTES = 4 * 1024;
const FILE_TAIL_BYTES = 32 * 1024;

export interface BuildBundleInput {
  workflow: Workflow;
  attemptNumber: number;
}

export function buildResolverContext(input: BuildBundleInput): ResolverContextBundle {
  const { workflow, attemptNumber } = input;

  return {
    workflow,
    attempt_number: attemptNumber,
    blocked_diagnostic_md: loadLatestBlockedDiagnostic(workflow.id),
    last_failed_agent: loadLastFailedAgentSummary(workflow.id),
    recent_resilience_events: queries.listResilienceEventsForEntity('workflow', workflow.id, 30),
    recent_watcher_commentary: loadWatcherCommentary(workflow.id, 20),
    notes: loadNotes(workflow),
    git: loadGitState(workflow),
    prior_resolver_runs: queries.listResolverRunsForWorkflow(workflow.id, 10),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function loadLatestBlockedDiagnostic(workflowId: string): string | null {
  if (!existsSync(BLOCKED_LOG_DIR)) return null;
  const short = workflowId.slice(0, 8);
  try {
    const files = readdirSync(BLOCKED_LOG_DIR)
      .filter(f => f.endsWith(`_${short}.md`))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const latest = path.join(BLOCKED_LOG_DIR, files[0]);
    return tailFile(latest, FILE_TAIL_BYTES);
  } catch {
    return null;
  }
}

function loadLastFailedAgentSummary(workflowId: string): ResolverFailedAgentSummary | null {
  let jobs: Job[];
  try {
    jobs = queries.getJobsForWorkflow(workflowId);
  } catch {
    return null;
  }
  const lastFailed = [...jobs].reverse().find(j => j.status === 'failed');
  if (!lastFailed) return null;

  let agents: AgentWithJob[];
  try {
    agents = queries.getAgentsWithJobByJobId(lastFailed.id);
  } catch {
    return null;
  }
  const agent = agents[0];
  if (!agent) return null;

  return {
    agent_id: agent.id,
    job_id: lastFailed.id,
    job_title: lastFailed.title ?? null,
    job_phase: lastFailed.workflow_phase ?? null,
    exit_code: agent.exit_code ?? null,
    num_turns: agent.num_turns ?? null,
    cost_usd: agent.cost_usd ?? null,
    error_message: agent.error_message ?? null,
    ndjson_tail: tailFile(path.join(PTY_LOG_DIR, `${agent.id}.ndjson`), NDJSON_TAIL_BYTES) ?? '',
    stderr_tail: tailFile(path.join(PTY_LOG_DIR, `${agent.id}.stderr`), STDERR_TAIL_BYTES) ?? '',
    snapshot_tail: tailFile(path.join(PTY_LOG_DIR, `${agent.id}.snapshot`), SNAPSHOT_TAIL_BYTES) ?? '',
  };
}

function loadWatcherCommentary(workflowId: string, limit: number): WatcherCommentary[] {
  // Walk jobs → agents → commentary so we don't depend on a workflow-level view.
  try {
    const jobs = queries.getJobsForWorkflow(workflowId);
    const out: WatcherCommentary[] = [];
    for (const job of jobs.slice(-5)) {
      const agents = queries.getAgentsWithJobByJobId(job.id);
      for (const agent of agents) {
        try {
          out.push(...queries.getRecentCommentaryForAgent(agent.id, 8));
        } catch { /* tolerate stale agent rows */ }
      }
    }
    return out.sort((a, b) => a.created_at - b.created_at).slice(-limit);
  } catch {
    return [];
  }
}

function loadNotes(workflow: Workflow): ResolverContextBundle['notes'] {
  const planNote = queries.getNote(RecoveryKeys.plan(workflow.id));
  const contractNote = queries.getNote(RecoveryKeys.contract(workflow.id));

  const worklogs: Array<{ cycle: number; content: string }> = [];
  const reviews: Array<{ cycle: number; content: string }> = [];
  const maxCycle = workflow.current_cycle;
  for (let c = Math.max(1, maxCycle - 2); c <= maxCycle; c++) {
    const w = queries.getNote(RecoveryKeys.worklog(workflow.id, c));
    if (w) worklogs.push({ cycle: c, content: w.value });
    const r = queries.getNote(RecoveryKeys.reviewFeedback(workflow.id, c));
    if (r) reviews.push({ cycle: c, content: r.value });
  }

  return {
    plan: planNote?.value ?? null,
    contract: contractNote?.value ?? null,
    worklogs,
    review_feedback: reviews,
  };
}

function loadGitState(workflow: Workflow): ResolverContextBundle['git'] {
  const dir = workflow.worktree_path ?? workflow.work_dir;
  if (!dir || !existsSync(dir)) return null;
  return {
    status: runGit(dir, ['status', '--short']),
    log_oneline: runGit(dir, ['log', '--oneline', '-n', '20']),
    diff_stat: runGit(dir, ['diff', '--stat']),
    has_uncommitted: !!runGit(dir, ['status', '--porcelain']),
  };
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function tailFile(filePath: string, maxBytes: number): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (stat.size === 0) return '';
    if (stat.size <= maxBytes) return readFileSync(filePath, 'utf8');
    const fd = require('fs').openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      require('fs').readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      const text = buf.toString('utf8');
      // Drop the leading partial line so we don't emit a malformed JSON fragment.
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : text;
    } finally {
      require('fs').closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Render the bundle as a single user-message string the LLM can read.
 *  Keep this tight and structured — the Resolver leans on the section headers. */
export function renderResolverContext(bundle: ResolverContextBundle): string {
  const wf = bundle.workflow;
  const parts: string[] = [];
  parts.push(`# Workflow ${wf.id.slice(0, 8)} — blocked`);
  parts.push(`Title: ${wf.title}`);
  parts.push(`Phase: ${wf.current_phase} / Cycle: ${wf.current_cycle} of ${wf.max_cycles}`);
  parts.push(`Milestones: ${wf.milestones_done}/${wf.milestones_total}`);
  parts.push(`Implementer: ${wf.implementer_model} | Reviewer: ${wf.reviewer_model}`);
  if (wf.worktree_path) parts.push(`Worktree: ${wf.worktree_path} (branch ${wf.worktree_branch ?? 'unknown'})`);
  parts.push(`Resolver attempt: ${bundle.attempt_number}`);
  parts.push('');
  parts.push(`## blocked_reason`);
  parts.push(`<blocked-reason>${wf.blocked_reason ?? 'unknown'}</blocked-reason>`);
  parts.push('');

  if (bundle.blocked_diagnostic_md) {
    parts.push(`## blocked-diagnostic file`);
    parts.push('<diagnostic>');
    parts.push(bundle.blocked_diagnostic_md.slice(-12_000));
    parts.push('</diagnostic>');
    parts.push('');
  }

  if (bundle.last_failed_agent) {
    const a = bundle.last_failed_agent;
    parts.push(`## last failed agent ${a.agent_id.slice(0, 8)}`);
    parts.push(`phase=${a.job_phase} exit_code=${a.exit_code} turns=${a.num_turns} cost=$${a.cost_usd ?? 0}`);
    if (a.error_message) parts.push(`error: ${a.error_message.slice(0, 500)}`);
    if (a.ndjson_tail) {
      parts.push('<agent-ndjson-tail>');
      parts.push(a.ndjson_tail.slice(-8_000));
      parts.push('</agent-ndjson-tail>');
    }
    if (a.stderr_tail) {
      parts.push('<agent-stderr-tail>');
      parts.push(a.stderr_tail.slice(-2_000));
      parts.push('</agent-stderr-tail>');
    }
    if (a.snapshot_tail) {
      parts.push('<agent-snapshot-tail>');
      parts.push(a.snapshot_tail.slice(-2_000));
      parts.push('</agent-snapshot-tail>');
    }
    parts.push('');
  }

  if (bundle.notes.plan) {
    parts.push(`## workflow plan note`);
    parts.push('<plan>');
    parts.push(bundle.notes.plan.slice(0, 6_000));
    parts.push('</plan>');
    parts.push('');
  }
  if (bundle.notes.contract) {
    parts.push(`## workflow contract note`);
    parts.push('<contract>');
    parts.push(bundle.notes.contract.slice(0, 3_000));
    parts.push('</contract>');
    parts.push('');
  }
  if (bundle.notes.worklogs.length > 0) {
    parts.push(`## recent worklogs`);
    for (const w of bundle.notes.worklogs) {
      parts.push(`### cycle ${w.cycle}`);
      parts.push(w.content.slice(-2_000));
    }
    parts.push('');
  }
  if (bundle.notes.review_feedback.length > 0) {
    parts.push(`## recent review feedback`);
    for (const r of bundle.notes.review_feedback) {
      parts.push(`### cycle ${r.cycle}`);
      parts.push(r.content.slice(-2_000));
    }
    parts.push('');
  }

  if (bundle.git) {
    parts.push(`## git`);
    parts.push(`<git-status>${bundle.git.status ?? '(none)'}</git-status>`);
    parts.push(`<git-log>${bundle.git.log_oneline ?? '(none)'}</git-log>`);
    parts.push(`<git-diff-stat>${bundle.git.diff_stat ?? '(none)'}</git-diff-stat>`);
    parts.push('');
  }

  if (bundle.recent_resilience_events.length > 0) {
    parts.push(`## recent resilience events`);
    for (const e of bundle.recent_resilience_events.slice(0, 15)) {
      parts.push(`- ${new Date(e.created_at).toISOString()} ${e.event_type}: ${e.details ?? ''}`.slice(0, 240));
    }
    parts.push('');
  }

  if (bundle.recent_watcher_commentary.length > 0) {
    parts.push(`## recent live-watcher commentary`);
    for (const c of bundle.recent_watcher_commentary.slice(-12)) {
      parts.push(`- [${c.severity}] ${c.headline}${c.detail ? ' — ' + c.detail.slice(0, 200) : ''}`);
    }
    parts.push('');
  }

  if (bundle.prior_resolver_runs.length > 0) {
    parts.push(`## prior resolver attempts on this workflow`);
    for (const r of bundle.prior_resolver_runs.slice(0, 5)) {
      parts.push(`- attempt ${r.attempt} (${r.status}) classification=${r.classification ?? 'n/a'} resume=${r.resume_outcome ?? 'n/a'}`);
      if (r.diagnosis) parts.push(`  diagnosis: ${r.diagnosis.slice(0, 280)}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('Diagnose this block. Classify it, then choose ONE of: propose_resume, mark_resolved, escalate_to_user, or mark_unresolvable.');
  return parts.join('\n');
}
