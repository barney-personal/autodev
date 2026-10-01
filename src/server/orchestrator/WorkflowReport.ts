/**
 * Downloadable Markdown report for an autonomous workflow.
 *
 * `buildWorkflowReportData` composes existing persisted queries into an
 * explicit allowlisted shape (no prompts, transcripts, diffs, verify output,
 * env or filesystem paths). `renderWorkflowReport` is a pure formatter that
 * treats every saved string as untrusted Markdown and keeps output bounded.
 *
 * Intentionally free of socket/queue/WorkflowManager imports so it can be
 * used from the API route and tested in isolation.
 */
import * as queries from '../db/queries.js';
import { isCodexModel } from '../../shared/types.js';

// ─── Allowlisted data shape ──────────────────────────────────────────────────

export interface ReportAttempt {
  agent_id: string;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number | null;
}

export interface ReportJob {
  id: string;
  cycle: number | null;
  phase: string | null;
  status: string | null;
  model: string | null;
  is_repair: boolean;
  created_at: number | null;
  attempts: ReportAttempt[];
}

export interface ReportVerifyRun {
  id: string;
  cycle: number | null;
  attempt: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  created_at: number | null;
}

export interface WorkflowReportData {
  id: string;
  title: string | null;
  task: string | null;
  status: string | null;
  current_phase: string | null;
  current_cycle: number | null;
  max_cycles: number | null;
  milestones_done: number | null;
  milestones_total: number | null;
  implementer_model: string | null;
  reviewer_model: string | null;
  worktree_branch: string | null;
  pr_url: string | null;
  blocked_reason: string | null;
  created_at: number | null;
  updated_at: number | null;
  plan: string | null;
  jobs: ReportJob[];
  verify_runs: ReportVerifyRun[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Repair flag from job context JSON; malformed or non-boolean context means not known to be a repair. */
export function parseRepairFlag(context: unknown): boolean {
  if (typeof context !== 'string' || !context) return false;
  try {
    const parsed: unknown = JSON.parse(context);
    return !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).is_repair === true;
  } catch {
    return false;
  }
}

/** Compose persisted workflow data into the report shape. Null for unknown IDs. */
export function buildWorkflowReportData(workflowId: string): WorkflowReportData | null {
  const workflow = queries.getWorkflowById(workflowId);
  if (!workflow) return null;

  const plan = queries.getNote(`workflow/${workflow.id}/plan`);
  const jobs = queries.getJobsForWorkflow(workflow.id);
  const metrics = queries.getWorkflowMetrics(workflow.id);
  const verifyRuns = queries.getVerifyRunsForWorkflow(workflow.id);

  // One metric row per agent attempt plus a placeholder (agent_id null) for
  // jobs with no agents. Only identified agents count, each exactly once.
  const attemptsByJob = new Map<string, Map<string, ReportAttempt>>();
  for (const row of metrics?.phases ?? []) {
    const agentId = str(row.agent_id);
    if (!agentId) continue;
    let forJob = attemptsByJob.get(row.job_id);
    if (!forJob) { forJob = new Map(); attemptsByJob.set(row.job_id, forJob); }
    if (forJob.has(agentId)) continue;
    forJob.set(agentId, {
      agent_id: agentId,
      started_at: num(row.agent_started_at),
      finished_at: num(row.agent_finished_at),
      cost_usd: num(row.agent_cost_usd),
    });
  }

  return {
    id: workflow.id,
    title: str(workflow.title),
    task: str(workflow.task),
    status: str(workflow.status),
    current_phase: str(workflow.current_phase),
    current_cycle: num(workflow.current_cycle),
    max_cycles: num(workflow.max_cycles),
    milestones_done: num(workflow.milestones_done),
    milestones_total: num(workflow.milestones_total),
    implementer_model: str(workflow.implementer_model),
    reviewer_model: str(workflow.reviewer_model),
    worktree_branch: str(workflow.worktree_branch),
    pr_url: str(workflow.pr_url),
    blocked_reason: str(workflow.blocked_reason),
    created_at: num(workflow.created_at),
    updated_at: num(workflow.updated_at),
    plan: str(plan?.value),
    jobs: jobs.map(job => ({
      id: job.id,
      cycle: num(job.workflow_cycle),
      phase: str(job.workflow_phase),
      status: str(job.status),
      model: str(job.model),
      is_repair: parseRepairFlag(job.context),
      created_at: num(job.created_at),
      attempts: [...(attemptsByJob.get(job.id)?.values() ?? [])],
    })),
    verify_runs: verifyRuns.map(run => ({
      id: run.id,
      cycle: num(run.cycle),
      attempt: num(run.attempt),
      exit_code: num(run.exit_code),
      duration_ms: num(run.duration_ms),
      created_at: num(run.created_at),
    })),
  };
}

// ─── Text safety ─────────────────────────────────────────────────────────────

export const REPORT_LIMITS = {
  textChars: 20_000,
  blockedReasonChars: 2_000,
  cellChars: 200,
  prUrlChars: 2_000,
  tableRows: 100,
  maxBytes: 512 * 1024,
};

interface RenderLimits {
  textChars: number;
  blockedReasonChars: number;
  cellChars: number;
  tableRows: number;
}

// C0 (except TAB/LF), DEL, C1, bidi embeddings/overrides/isolates and marks,
// plus line/paragraph separators (normalized to LF first).
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function cleanText(s: string): string {
  return s.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(UNSAFE_CONTROLS, '');
}

/** Clip to `cap` code points (never splitting surrogate pairs). */
function clip(s: string, cap: number): { text: string; truncated: boolean; length: number } {
  const chars = Array.from(s);
  if (chars.length <= cap) return { text: s, truncated: false, length: chars.length };
  return { text: chars.slice(0, cap).join(''), truncated: true, length: chars.length };
}

const INLINE_ESCAPE = /[\\`*_[\]<>|!~&#$]/g;

/** Single-line, escaped, bounded Markdown text for table cells and labels. */
function inline(value: string | null | undefined, cap: number, fallback = 'unavailable'): string {
  if (value == null) return fallback;
  const flat = cleanText(value).replace(/\s+/g, ' ').trim();
  if (!flat) return fallback;
  const { text, truncated } = clip(flat, cap);
  const escaped = text.replace(INLINE_ESCAPE, ch => `\\${ch}`);
  return truncated ? `${escaped}… (truncated)` : escaped;
}

/** Multi-line untrusted text in a fence longer than any backtick run inside. */
function fenced(value: string, cap: number): string {
  const cleaned = cleanText(value);
  const { text, truncated, length } = clip(cleaned, cap);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const out = `${fence}text\n${body}${fence}`;
  return truncated
    ? `${out}\n\n_Truncated: showing the first ${cap.toLocaleString('en-US')} of ${length.toLocaleString('en-US')} characters._`
    : out;
}

/**
 * PR link as a Markdown destination. Only http(s) URLs without credentials are
 * linked; Markdown-significant characters are percent-encoded.
 */
function prLink(raw: string | null): string {
  if (raw == null || !raw.trim()) return 'None recorded';
  const invalid = 'Unavailable — invalid PR link';
  const trimmed = cleanText(raw).trim();
  if (trimmed.length > REPORT_LIMITS.prUrlChars) return invalid;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return invalid; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid;
  if (parsed.username || parsed.password) return invalid;
  const dest = parsed.href.replace(/[\s()<>\\[\]`|"'*_]/g, ch =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `[Open pull request](${dest}) — \`${dest}\``;
}

// ─── Value formatting ────────────────────────────────────────────────────────

const MAX_DATE_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

function validTime(v: number | null): v is number {
  return v != null && Number.isFinite(v) && v > 0 && v <= MAX_DATE_MS;
}

function iso(v: number | null): string {
  return validTime(v) ? new Date(v).toISOString() : 'unavailable';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatUsd(v: number): string {
  return `USD ${v.toFixed(v >= 1 ? 2 : 4)}`;
}

function validCost(v: number | null): v is number {
  return v != null && Number.isFinite(v) && v >= 0;
}

function attemptInterval(a: ReportAttempt): number | null {
  if (!validTime(a.started_at) || !validTime(a.finished_at)) return null;
  const d = a.finished_at - a.started_at;
  return d >= 0 ? d : null;
}

interface Totals {
  attempts: number;
  costCount: number;
  cost: number;
  durationCount: number;
  duration: number;
}

function totalsFor(jobs: ReportJob[]): Totals {
  const t: Totals = { attempts: 0, costCount: 0, cost: 0, durationCount: 0, duration: 0 };
  for (const job of jobs) {
    for (const a of job.attempts) {
      t.attempts++;
      if (validCost(a.cost_usd)) { t.costCount++; t.cost += a.cost_usd; }
      const d = attemptInterval(a);
      if (d != null) { t.durationCount++; t.duration += d; }
    }
  }
  return t;
}

function costSummary(t: Totals): string {
  if (t.attempts === 0) return 'Unavailable — no agent attempts recorded';
  if (t.costCount === 0) return `Unavailable — no cost recorded (0 of ${t.attempts} attempts had recorded cost)`;
  return `${formatUsd(t.cost)} (${t.costCount} of ${t.attempts} attempts had recorded cost${t.costCount < t.attempts ? '; partial coverage' : ''})`;
}

function durationSummary(t: Totals): string {
  if (t.attempts === 0) return 'Unavailable — no agent attempts recorded';
  if (t.durationCount === 0) return `Unavailable — no attempt had a valid start and finish time (0 of ${t.attempts})`;
  return `${formatDuration(t.duration)} (${t.durationCount} of ${t.attempts} attempts had a valid start and finish time${t.durationCount < t.attempts ? '; partial coverage' : ''})`;
}

function cellCost(t: Totals): string {
  if (t.attempts === 0 || t.costCount === 0) return 'unavailable';
  return t.costCount < t.attempts ? `${formatUsd(t.cost)} (${t.costCount}/${t.attempts})` : formatUsd(t.cost);
}

function cellDuration(t: Totals): string {
  if (t.attempts === 0 || t.durationCount === 0) return 'unavailable';
  return t.durationCount < t.attempts ? `${formatDuration(t.duration)} (${t.durationCount}/${t.attempts})` : formatDuration(t.duration);
}

function intOrNull(v: number | null): number | null {
  return v != null && Number.isInteger(v) && v >= 0 ? v : null;
}

const RUNNING_STATUSES = new Set(['running', 'blocked']);
const TERMINAL_STATUSES = new Set(['complete', 'cancelled', 'failed']);
const KNOWN_PHASES = ['assess', 'review', 'implement', 'verify'] as const;

function elapsed(data: WorkflowReportData, now: number): string {
  if (!validTime(data.created_at)) return 'Unavailable — creation time not recorded';
  const status = data.status ?? '';
  if (RUNNING_STATUSES.has(status)) {
    const d = now - data.created_at;
    return d >= 0 ? `${formatDuration(d)} so far` : 'Unavailable — creation time is after the snapshot time';
  }
  if (TERMINAL_STATUSES.has(status)) {
    if (!validTime(data.updated_at)) return 'Unavailable — last update time not recorded';
    const d = data.updated_at - data.created_at;
    return d >= 0
      ? `${formatDuration(d)} through last recorded update (completion time unavailable)`
      : 'Unavailable — last update time is before the creation time';
  }
  return 'Unavailable — status not recognized';
}

function milestoneProgress(data: WorkflowReportData): string {
  const done = intOrNull(data.milestones_done);
  const total = intOrNull(data.milestones_total);
  if (done == null || total == null) return 'Unavailable — milestone counts not recorded';
  if (total === 0 && done === 0) return 'No milestones recorded (0/0)';
  return `${done}/${total} milestones done`;
}

/** Configured model for a phase, or undefined when the phase has no per-workflow setting. */
function configuredModel(data: WorkflowReportData, phase: string | null): string | null | undefined {
  if (phase === 'assess' || phase === 'implement') return data.implementer_model;
  if (phase === 'review') return data.reviewer_model;
  return undefined;
}

function capRows<T>(rows: T[], cap: number): { head: T[]; tail: T[]; omitted: number } {
  if (rows.length <= cap) return { head: rows, tail: [], omitted: 0 };
  const half = Math.max(1, Math.floor(cap / 2));
  return { head: rows.slice(0, half), tail: rows.slice(rows.length - half), omitted: rows.length - half * 2 };
}

function byTimeThenId<T extends { created_at: number | null; id: string }>(a: T, b: T): number {
  const at = validTime(a.created_at), bt = validTime(b.created_at);
  if (at && bt && a.created_at !== b.created_at) return (a.created_at as number) - (b.created_at as number);
  if (at !== bt) return at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

function renderWithLimits(data: WorkflowReportData, now: number, lim: RenderLimits, reduced: boolean): string {
  const c = lim.cellChars;
  const out: string[] = [];

  out.push(`# Workflow report: ${inline(data.title, c, 'Untitled workflow')}`);
  out.push('');
  out.push(`- **Workflow ID:** ${inline(data.id, c)}`);
  out.push(`- **Snapshot generated:** ${iso(now)}`);
  out.push('');
  out.push('> This report is a point-in-time snapshot of persisted AutoDev data. The workflow may have changed since it was generated. Values shown as "unavailable" were not recorded.');
  if (reduced) {
    out.push('>');
    out.push('> Some sections were shortened further to keep this report within its size limit.');
  }
  out.push('');

  out.push('## Status');
  out.push('');
  const status = data.status;
  const statusKnown = status != null && (RUNNING_STATUSES.has(status) || TERMINAL_STATUSES.has(status));
  out.push(`- **Status:** ${inline(status, c)}${status != null && !statusKnown ? ' (unrecognized status)' : ''}`);
  out.push(`- **Current phase:** ${inline(data.current_phase, c)}`);
  const cycle = intOrNull(data.current_cycle), maxCycles = intOrNull(data.max_cycles);
  out.push(`- **Current cycle:** ${cycle ?? 'unavailable'} (max cycles: ${maxCycles ?? 'unavailable'})`);
  out.push(`- **Milestone progress:** ${milestoneProgress(data)}`);
  out.push(`- **Created:** ${iso(data.created_at)}`);
  out.push(`- **Last updated (any recorded change):** ${iso(data.updated_at)}`);
  out.push(`- **Elapsed wall-clock:** ${elapsed(data, now)}`);
  out.push(`- **Branch:** ${inline(data.worktree_branch, c, 'None recorded')}`);
  out.push(`- **Pull request:** ${prLink(data.pr_url)}`);
  out.push('');

  if (data.blocked_reason != null && data.blocked_reason.trim()) {
    out.push('## Blocked reason');
    out.push('');
    out.push(fenced(data.blocked_reason, lim.blockedReasonChars));
    out.push('');
  }

  out.push('## Original goal');
  out.push('');
  out.push(data.task != null && data.task.trim() ? fenced(data.task, lim.textChars) : 'Unavailable — no goal recorded');
  out.push('');

  out.push('## Saved plan');
  out.push('');
  out.push(data.plan != null && data.plan.trim() ? fenced(data.plan, lim.textChars) : 'No plan saved');
  out.push('');

  // Models
  out.push('## Models');
  out.push('');
  out.push(`- **Configured implementer:** ${inline(data.implementer_model, c)}`);
  out.push(`- **Configured reviewer:** ${inline(data.reviewer_model, c)}`);
  out.push('');
  out.push('Phase jobs whose last recorded model differs from the configured model. Job models are the last model persisted on each job, not a per-attempt history. Verify jobs have no per-workflow configured model.');
  out.push('');
  const groups = new Map<string, { phase: string | null; configured: string | null | undefined; actual: string | null; jobs: number; firstJob: string }>();
  for (const job of [...data.jobs].sort(byTimeThenId)) {
    const configured = configuredModel(data, job.phase);
    if (configured !== undefined && configured != null && job.model === configured) continue;
    const key = JSON.stringify([job.phase, configured ?? null, job.model]);
    const g = groups.get(key);
    if (g) g.jobs++;
    else groups.set(key, { phase: job.phase, configured, actual: job.model, jobs: 1, firstJob: job.id });
  }
  if (groups.size === 0) {
    out.push(data.jobs.length === 0 ? 'No phase jobs recorded.' : 'None — every phase job recorded its configured model.');
  } else {
    const entries = [...groups.values()];
    const { head, tail, omitted } = capRows(entries, lim.tableRows);
    const line = (g: typeof entries[number]) => {
      const phase = inline(g.phase, c);
      const configured = g.configured === undefined
        ? 'no per-workflow configured model'
        : `configured ${inline(g.configured, c)}`;
      const note = g.phase === 'assess' && g.configured != null && isCodexModel(g.configured)
        ? ' (assess intentionally uses a Claude model when the implementer is Codex)'
        : '';
      return `- ${phase}: ${configured}; last recorded job model ${inline(g.actual, c)} on ${g.jobs} job${g.jobs === 1 ? '' : 's'} (first: ${inline(g.firstJob, c)})${note}`;
    };
    for (const g of head) out.push(line(g));
    if (omitted > 0) out.push(`- _${omitted} model-difference entries omitted._`);
    for (const g of tail) out.push(line(g));
  }
  out.push('');

  // Usage
  const all = totalsFor(data.jobs);
  out.push('## Recorded usage');
  out.push('');
  out.push('Recorded/estimated cost is not a billing guarantee. Figures are provider-reported totals and local estimates persisted per agent attempt. Each persisted attempt is summed once; provider resume accounting may be cumulative. Scope: agents of this workflow\'s phase jobs only, excluding unassociated retries, watcher/resolver sessions and other services.');
  out.push('');
  out.push(`- **Phase jobs:** ${data.jobs.length}`);
  out.push(`- **Agent attempts:** ${all.attempts}`);
  out.push(`- **Recorded/estimated cost:** ${costSummary(all)}`);
  out.push(`- **Recorded agent time (sum of attempt intervals, may overlap; not wall-clock):** ${durationSummary(all)}`);
  out.push('');
  if (data.jobs.length > 0) {
    out.push(row(['Phase', 'Jobs', 'Attempts', 'Recorded/estimated cost', 'Recorded agent time']));
    out.push(row(['---', '---:', '---:', '---:', '---:']));
    const phaseGroups: Array<[string, ReportJob[]]> = KNOWN_PHASES.map(p => [p, data.jobs.filter(j => j.phase === p)]);
    phaseGroups.push(['other or unavailable', data.jobs.filter(j => !(KNOWN_PHASES as readonly string[]).includes(j.phase ?? ''))]);
    for (const [phase, jobs] of phaseGroups) {
      if (jobs.length === 0) continue;
      const t = totalsFor(jobs);
      out.push(row([phase, String(jobs.length), String(t.attempts), cellCost(t), cellDuration(t)]));
    }
    out.push('');
  }

  // Verification
  out.push('## Verification');
  out.push('');
  if (data.verify_runs.length === 0) {
    out.push('No verification runs recorded. Workflow status alone does not indicate that verification passed.');
  } else {
    const runs = [...data.verify_runs].sort(byTimeThenId);
    const passed = runs.filter(r => r.exit_code === 0).length;
    const failed = runs.filter(r => r.exit_code != null && r.exit_code !== 0).length;
    const unknown = runs.length - passed - failed;
    out.push(`${runs.length} verification run${runs.length === 1 ? '' : 's'}: ${passed} passed, ${failed} failed, ${unknown} unknown outcome.`);
    out.push('');
    out.push(row(['Cycle', 'Attempt', 'Outcome', 'Duration', 'Recorded at']));
    out.push(row(['---:', '---:', '---', '---:', '---']));
    const { head, tail, omitted } = capRows(runs, lim.tableRows);
    const vrow = (r: ReportVerifyRun) => row([
      String(intOrNull(r.cycle) ?? 'unavailable'),
      String(intOrNull(r.attempt) ?? 'unavailable'),
      r.exit_code == null ? 'unknown' : r.exit_code === 0 ? 'passed' : `failed (exit ${r.exit_code})`,
      r.duration_ms != null && r.duration_ms >= 0 ? formatDuration(r.duration_ms) : 'unavailable',
      iso(r.created_at),
    ]);
    for (const r of head) out.push(vrow(r));
    if (omitted > 0) out.push(row([`_${omitted} verification runs omitted_`, '', '', '', '']));
    for (const r of tail) out.push(vrow(r));
  }
  out.push('');

  // Jobs
  out.push('## Phase jobs');
  out.push('');
  if (data.jobs.length === 0) {
    out.push('No phase jobs recorded.');
  } else {
    out.push('Chronological by job creation time. "Repeated phase/cycle" marks a later job for the same phase and cycle; it is not proof of a causal retry. "Repair" is shown only when the job recorded it.');
    out.push('');
    out.push(row(['#', 'Job ID', 'Cycle', 'Phase', 'Status', 'Last recorded model', 'Attempts', 'Started', 'Recorded agent time', 'Recorded/estimated cost', 'Notes']));
    out.push(row(['---:', '---', '---:', '---', '---', '---', '---:', '---', '---:', '---:', '---']));
    const sorted = [...data.jobs].sort(byTimeThenId);
    const seen = new Map<string, number>();
    const notes = new Map<string, string>();
    for (const job of sorted) {
      const key = JSON.stringify([job.phase, job.cycle]);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const parts: string[] = [];
      if (job.is_repair) parts.push('repair');
      if (n > 1) parts.push(`repeated phase/cycle (#${n})`);
      notes.set(job.id, parts.join(', '));
    }
    const indexed = sorted.map((job, i) => ({ job, i }));
    const { head, tail, omitted } = capRows(indexed, lim.tableRows);
    const jrow = ({ job, i }: { job: ReportJob; i: number }) => {
      const t = totalsFor([job]);
      const starts = job.attempts.map(a => a.started_at).filter(validTime);
      return row([
        String(i + 1),
        inline(job.id, c),
        String(intOrNull(job.cycle) ?? 'unavailable'),
        inline(job.phase, c),
        inline(job.status, c),
        inline(job.model, c),
        String(t.attempts),
        starts.length > 0 ? iso(Math.min(...starts)) : 'unavailable',
        cellDuration(t),
        cellCost(t),
        notes.get(job.id) ?? '',
      ]);
    };
    for (const r of head) out.push(jrow(r));
    if (omitted > 0) out.push(row(['', `_${omitted} jobs omitted (totals above include them)_`, '', '', '', '', '', '', '', '', '']));
    for (const r of tail) out.push(jrow(r));
  }
  out.push('');

  return out.join('\n');
}

/** Render the Markdown report, shrinking section budgets until it fits the byte cap. */
export function renderWorkflowReport(data: WorkflowReportData, now: number = Date.now()): string {
  let lim: RenderLimits = {
    textChars: REPORT_LIMITS.textChars,
    blockedReasonChars: REPORT_LIMITS.blockedReasonChars,
    cellChars: REPORT_LIMITS.cellChars,
    tableRows: REPORT_LIMITS.tableRows,
  };
  let reduced = false;
  for (let i = 0; i < 8; i++) {
    const md = renderWithLimits(data, now, lim, reduced);
    if (Buffer.byteLength(md, 'utf8') <= REPORT_LIMITS.maxBytes) return md;
    reduced = true;
    lim = {
      textChars: Math.max(500, Math.floor(lim.textChars / 2)),
      blockedReasonChars: Math.max(200, Math.floor(lim.blockedReasonChars / 2)),
      cellChars: Math.max(40, Math.floor(lim.cellChars / 2)),
      tableRows: Math.max(4, Math.floor(lim.tableRows / 2)),
    };
  }
  return renderWithLimits(data, now, lim, true);
}
