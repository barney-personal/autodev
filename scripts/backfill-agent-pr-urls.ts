/**
 * Backfill workflows.pr_url for completed workflows whose implementer agent
 * ran `gh pr create` themselves (so the orchestrator never recorded the URL).
 *
 * Reuses the same finder/validator that `captureAgentCreatedPrUrl` uses, in
 * pure dry-run mode by default. Pass `--apply` to actually write.
 *
 * Usage:
 *   tsx scripts/backfill-agent-pr-urls.ts [--db <path>] [--apply]
 *
 * Defaults:
 *   --db data/orchestrator.db
 *   dry-run (no DB writes)
 *
 * Output: a table on stdout with one row per candidate workflow:
 *   workflow id | branch | candidate URL | validation result | action
 */

import path from 'node:path';
import { initDb, closeDb, getDb } from '../src/server/db/database.js';
import * as queries from '../src/server/db/queries.js';
import {
  findAgentCreatedPrUrl,
  validateAgentCreatedPrUrl,
  extractGithubPullUrls,
  getWorkflowOriginOwnerRepo,
  type ParsedPrUrl,
} from '../src/server/orchestrator/AgentPrUrlCapture.js';
import type { Workflow } from '../src/shared/types.js';

interface Args {
  dbPath: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dbPath: 'data/orchestrator.db', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--db') { args.dbPath = argv[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx scripts/backfill-agent-pr-urls.ts [--db <path>] [--apply]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

interface Row {
  workflowId: string;
  branch: string | null;
  candidate: string;
  validation: string;
  action: string;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function printTable(rows: Row[]): void {
  const headers = ['workflow id', 'branch', 'candidate URL', 'validation', 'action'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => Object.values(r)[i]?.toString().length ?? 0)));
  console.log('| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |');
  console.log('|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|');
  for (const r of rows) {
    const cells = [r.workflowId, r.branch ?? '(null)', r.candidate, r.validation, r.action];
    console.log('| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |');
  }
}

/**
 * Pure helper for tests: given a workflow + an injectable URL/validation seam,
 * decide what the backfill would do and return one summary row.
 */
export function evaluateWorkflow(
  workflow: Workflow,
  deps: {
    findUrl: (wf: Workflow) => { url: string; parsed: ParsedPrUrl } | null;
    apply: boolean;
    writePrUrl?: (id: string, url: string) => void;
  },
): Row {
  if (workflow.pr_url) {
    return {
      workflowId: workflow.id,
      branch: workflow.worktree_branch,
      candidate: workflow.pr_url,
      validation: 'already-set',
      action: 'skip',
    };
  }
  const found = deps.findUrl(workflow);
  if (!found) {
    return {
      workflowId: workflow.id,
      branch: workflow.worktree_branch,
      candidate: '(none)',
      validation: 'no candidate',
      action: 'skip',
    };
  }
  if (!deps.apply) {
    return {
      workflowId: workflow.id,
      branch: workflow.worktree_branch,
      candidate: found.url,
      validation: 'OPEN+match',
      action: 'would-store (dry-run)',
    };
  }
  deps.writePrUrl?.(workflow.id, found.url);
  return {
    workflowId: workflow.id,
    branch: workflow.worktree_branch,
    candidate: found.url,
    validation: 'OPEN+match',
    action: 'stored',
  };
}

/**
 * Read-only probe used for dry-run reporting only: extracts PR URLs from the
 * most recent done implementer agent's output, intersects with the workflow's
 * resolved origin owner/repo, and returns the first match. Never writes.
 */
function probeRawCandidates(workflow: Workflow): { url: string; reason: string } | null {
  const origin = (() => {
    try { return getWorkflowOriginOwnerRepo(workflow); } catch { return null; }
  })();
  if (!origin) return null;
  // Reuse the public lister via findAgentCreatedPrUrl by passing a no-op exec
  // that simulates a gh failure — but we want the candidate URLs, so call the
  // queries directly here.
  const jobs = queries.getJobsForWorkflow(workflow.id)
    .filter(j => j.workflow_phase === 'implement' && j.status === 'done');
  if (jobs.length === 0) return null;
  const jobIdToCycle = new Map(jobs.map(j => [j.id, j.workflow_cycle ?? 0]));
  const agents = queries.listAgents()
    .filter(a => a.status === 'done' && jobIdToCycle.has(a.job_id))
    .map(a => ({ agent: a, cycle: jobIdToCycle.get(a.job_id) ?? 0 }))
    .sort((x, y) => {
      if (y.cycle !== x.cycle) return y.cycle - x.cycle;
      return (y.agent.finished_at ?? 0) - (x.agent.finished_at ?? 0);
    });
  for (const { agent } of agents) {
    const output = queries.getAgentOutput(agent.id, 50);
    if (output.length === 0) continue;
    const seen = new Set<string>();
    for (const row of output) {
      for (const url of extractGithubPullUrls(row.content)) {
        if (seen.has(url.url)) continue;
        seen.add(url.url);
        if (url.owner === origin.owner && url.repo === origin.repo) {
          return { url: url.url, reason: 'matches origin (gh unverified)' };
        }
      }
    }
    return null; // first agent with output wins
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const absDb = path.resolve(args.dbPath);
  console.log(`[backfill] db=${absDb} apply=${args.apply}`);
  initDb(absDb);

  const candidates = getDb()
    .prepare("SELECT id FROM workflows WHERE pr_url IS NULL AND status = 'complete'")
    .all() as Array<{ id: string }>;
  console.log(`[backfill] ${candidates.length} workflow(s) with pr_url IS NULL AND status='complete'`);

  const rows: Row[] = [];
  for (const { id } of candidates) {
    const wf = queries.getWorkflowById(id);
    if (!wf) continue;
    const row = evaluateWorkflow(wf, {
      apply: args.apply,
      findUrl: (w) => {
        try {
          const found = findAgentCreatedPrUrl(w);
          return found ? { url: found.url, parsed: found.parsed } : null;
        } catch (err) {
          console.error(`[backfill] workflow ${w.id}: find failed: ${(err as Error).message}`);
          return null;
        }
      },
      writePrUrl: (wfId, url) => {
        queries.updateWorkflow(wfId, { pr_url: url });
        console.log(`[backfill] stored pr_url for ${wfId}: ${url}`);
      },
    });
    if (row.action === 'skip' && row.validation === 'no candidate') {
      // For dry-run visibility: surface raw URL candidates that match the
      // workflow's origin even when full validation could not run (e.g. gh
      // not authenticated, PR closed/merged). Validation still gates writes
      // — `--apply` never stores these.
      const probe = probeRawCandidates(wf);
      if (probe) {
        row.candidate = probe.url;
        row.validation = probe.reason;
        row.action = 'manual-review';
      }
    }
    rows.push(row);
  }

  printTable(rows);
  const wouldStore = rows.filter(r => r.action.startsWith('would-store')).length;
  const stored = rows.filter(r => r.action === 'stored').length;
  console.log('');
  console.log(`[backfill] summary: ${rows.length} candidates, ${wouldStore} would-store, ${stored} stored, ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  closeDb();
}

// Only run if invoked directly. Allows the helpers above to be imported from tests.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backfill-agent-pr-urls.ts');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  }
}

// Silence unused-import warning when the script is imported purely for tests.
export const _internal = { extractGithubPullUrls, validateAgentCreatedPrUrl };
