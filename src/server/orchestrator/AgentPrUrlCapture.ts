/**
 * Safety-net capture of agent-created PR URLs.
 *
 * The orchestrator's primary PR path is `createWorkflowPr` (gh pr create from
 * the server). But implementers often run `gh pr create` themselves as part of
 * their final milestone — and on 2026-05-17 three polymarket-agent workflows
 * landed real PRs that way without `workflows.pr_url` ever being set, because
 * the wrap-up flow only knows about server-created PRs.
 *
 * This module provides four pure-ish helpers used by both `finalizeWorkflow`
 * and the wrap-up endpoint, plus a `captureAgentCreatedPrUrl` wrapper that
 * mutates the DB. The pure helpers are dry-run-safe so M5's backfill script
 * can reuse them without any write paths.
 */

import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import type { Workflow } from '../../shared/types.js';

const PR_URL_REGEX = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/pull\/(\d+)/g;

export interface ParsedPrUrl {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/** Pull every `https://github.com/<owner>/<repo>/pull/<N>` URL out of free text, deduped in order. */
export function extractGithubPullUrls(text: string): ParsedPrUrl[] {
  const out: ParsedPrUrl[] = [];
  if (!text) return out;
  const seen = new Set<string>();
  // Reset regex state between calls (matchAll is fine — we use a fresh regex each call below).
  const re = new RegExp(PR_URL_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const number = parseInt(m[3], 10);
    if (!Number.isFinite(number)) continue;
    out.push({ url, owner: m[1], repo: m[2].replace(/\.git$/, ''), number });
  }
  return out;
}

export type ExecFn = (cmd: string, args: string[], cwd: string) => string;

function defaultExec(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  }).toString();
}

function errMessage(err: unknown): string {
  return String((err as { message?: string } | null)?.message ?? err ?? '');
}

/** Parse `owner/repo` from a `git remote get-url origin` value. Supports https, ssh, and git@ forms. */
export function parseOwnerRepoFromOriginUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  // git@github.com:owner/repo(.git)
  let m = trimmed.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo(.git)/
  m = trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // ssh://git@github.com/owner/repo(.git)
  m = trimmed.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** Resolve the workflow's GitHub owner/repo by reading `origin` in the worktree. */
export function getWorkflowOriginOwnerRepo(
  workflow: Workflow,
  exec: ExecFn = defaultExec,
): { owner: string; repo: string } | null {
  if (!workflow.worktree_path) return null;
  let raw: string;
  try {
    raw = exec('git', ['remote', 'get-url', 'origin'], workflow.worktree_path);
  } catch {
    return null;
  }
  return parseOwnerRepoFromOriginUrl(raw);
}

export interface PrViewResult {
  url?: string;
  state?: string;
  headRefName?: string;
  headRepository?: { name?: string; owner?: { login?: string } };
  baseRepository?: { name?: string; owner?: { login?: string } };
}

export interface PrUrlValidationDeps {
  exec?: ExecFn;
}

export type PrUrlValidationResult =
  | { ok: true; pr: PrViewResult }
  | { ok: false; reason: string; pr?: PrViewResult };

/**
 * Validate a candidate `gh pr view`-style URL belongs to the workflow.
 *
 * Pure read-only — never stores anything. Callers wrap this in
 * `captureAgentCreatedPrUrl` to mutate. Used unchanged by M5's dry-run backfill.
 */
export function validateAgentCreatedPrUrl(
  workflow: Workflow,
  parsed: ParsedPrUrl,
  deps: PrUrlValidationDeps = {},
): PrUrlValidationResult {
  const exec = deps.exec ?? defaultExec;
  if (!workflow.worktree_path) return { ok: false, reason: 'workflow has no worktree_path' };
  if (!workflow.worktree_branch) return { ok: false, reason: 'workflow has no worktree_branch' };
  const ownerRepo = getWorkflowOriginOwnerRepo(workflow, exec);
  if (!ownerRepo) return { ok: false, reason: 'cannot resolve workflow origin owner/repo' };
  if (parsed.owner !== ownerRepo.owner || parsed.repo !== ownerRepo.repo) {
    return {
      ok: false,
      reason: `URL repo ${parsed.owner}/${parsed.repo} does not match workflow origin ${ownerRepo.owner}/${ownerRepo.repo}`,
    };
  }

  let raw: string;
  try {
    raw = exec(
      'gh',
      [
        'pr', 'view', String(parsed.number),
        '-R', `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--json', 'url,state,headRefName,headRepository,baseRepository',
      ],
      workflow.worktree_path,
    );
  } catch (err) {
    return { ok: false, reason: `gh pr view failed: ${errMessage(err)}` };
  }
  let pr: PrViewResult;
  try {
    pr = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `gh pr view returned malformed JSON: ${errMessage(err)}` };
  }

  if (pr.state !== 'OPEN' && pr.state !== 'MERGED') {
    return { ok: false, reason: `PR state is ${pr.state ?? '(unknown)'}, not OPEN or MERGED`, pr };
  }
  if (pr.headRefName !== workflow.worktree_branch) {
    return {
      ok: false,
      reason: `PR head ref '${pr.headRefName ?? '(unknown)'}' does not match workflow branch '${workflow.worktree_branch}'`,
      pr,
    };
  }
  // headRepository owner sometimes missing in fork PRs; only assert when present.
  const headOwner = pr.headRepository?.owner?.login;
  if (headOwner && headOwner !== ownerRepo.owner) {
    return {
      ok: false,
      reason: `PR head repo owner '${headOwner}' does not match origin owner '${ownerRepo.owner}'`,
      pr,
    };
  }
  return { ok: true, pr };
}

/** Best-effort extract human-readable text from a stream-json content row. Falls back to raw text on parse failure. */
function extractTextFromMaybeStreamJson(content: string): string {
  try {
    const ev = JSON.parse(content);
    const parts: string[] = [];
    // Claude: assistant message with content blocks
    if (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    // Claude: final result block
    if (ev && typeof ev.result === 'string') parts.push(ev.result);
    // Codex: item.completed agent_message / reasoning
    if (ev && ev.type === 'item.completed' && ev.item && typeof ev.item.text === 'string') {
      parts.push(ev.item.text);
    }
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : '';
  } catch {
    // Not JSON — treat the whole row as raw text.
    return content;
  }
}

export interface FindOptions extends PrUrlValidationDeps {
  /** Override which agent output rows the finder scans. Defaults to the latest done implement-phase agent's last 50 rows. */
  listOutputsForLatestImplementer?: (workflow: Workflow) => string[];
}

/**
 * Inspect the latest successful implement-phase agent's recent output for
 * a `https://github.com/.../pull/N` URL that points at this workflow's branch.
 *
 * Returns the first validated candidate, or `null` if nothing checks out.
 */
export function findAgentCreatedPrUrl(
  workflow: Workflow,
  options: FindOptions = {},
): { url: string; parsed: ParsedPrUrl; pr: PrViewResult } | null {
  const lister = options.listOutputsForLatestImplementer ?? defaultListOutputsForLatestImplementer;
  const rows = lister(workflow);
  const seen = new Set<string>();
  const candidates: ParsedPrUrl[] = [];
  for (const row of rows) {
    const text = extractTextFromMaybeStreamJson(row);
    if (!text) continue;
    for (const parsed of extractGithubPullUrls(text)) {
      if (seen.has(parsed.url)) continue;
      seen.add(parsed.url);
      candidates.push(parsed);
    }
  }
  for (const cand of candidates) {
    const validation = validateAgentCreatedPrUrl(workflow, cand, options);
    if (validation.ok) return { url: cand.url, parsed: cand, pr: validation.pr };
  }
  return null;
}

function defaultListOutputsForLatestImplementer(workflow: Workflow): string[] {
  const jobs = queries.getJobsForWorkflow(workflow.id);
  const implementJobs = jobs
    .filter(j => j.workflow_phase === 'implement' && j.status === 'done')
    .sort((a, b) => (b.workflow_cycle ?? 0) - (a.workflow_cycle ?? 0));
  for (const job of implementJobs) {
    const agents = queries.listAgents()
      .filter((a) => a.job_id === job.id && a.status === 'done')
      .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
    if (agents.length === 0) continue;
    const agent = agents[0];
    const output = queries.getAgentOutput(agent.id, 50);
    if (output.length === 0) continue;
    return output.map(o => o.content);
  }
  return [];
}

export interface CaptureOptions extends FindOptions {
  /** Skip the DB write (used by the M5 backfill script). */
  dryRun?: boolean;
  /** Override updateWorkflow + socket emit (used by callers that already wrap both, e.g. finalizeWorkflow). */
  updateAndEmit?: (id: string, fields: Parameters<typeof queries.updateWorkflow>[1]) => void;
}

export type CaptureResult =
  | { found: false; reason?: string }
  | { found: true; url: string; stored: boolean; pr: PrViewResult };

/**
 * Capture an agent-created PR URL onto `workflows.pr_url` when it is still NULL.
 *
 * Returns a structured result for logging/backfill use. Idempotent in the
 * common case — refuses to overwrite an existing `pr_url`.
 */
export function captureAgentCreatedPrUrl(
  workflow: Workflow,
  options: CaptureOptions = {},
): CaptureResult {
  if (workflow.pr_url) {
    return { found: false, reason: 'workflow already has pr_url' };
  }
  const found = findAgentCreatedPrUrl(workflow, options);
  if (!found) return { found: false };
  if (options.dryRun) {
    return { found: true, url: found.url, stored: false, pr: found.pr };
  }
  const update = options.updateAndEmit ?? ((id, fields) => { queries.updateWorkflow(id, fields); });
  update(workflow.id, { pr_url: found.url });
  console.log(`[workflow ${workflow.id}] agent-created PR URL captured: ${found.url}`);
  return { found: true, url: found.url, stored: true, pr: found.pr };
}
