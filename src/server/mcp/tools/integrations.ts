import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as queries from '../../db/queries.js';
import { Sentry } from '../../instrument.js';

const execFileAsync = promisify(execFile);

// ─── Linear ───────────────────────────────────────────────────────────────────

export const queryLinearSchema = z.object({
  query: z.string().describe('GraphQL query to execute against the Linear API'),
  variables: z.string().optional().describe('JSON-encoded variables for the query'),
});

export async function queryLinearHandler(_agentId: string, input: z.infer<typeof queryLinearSchema>): Promise<string> {
  const apiKey = getConfig('linearApiKey');
  if (!apiKey) return JSON.stringify({ error: 'Linear API key not configured. Set it in Eye > Configure.' });

  const { query, variables } = input;
  let parsedVars = {};
  if (variables) {
    try { parsedVars = JSON.parse(variables); } catch { return JSON.stringify({ error: 'Invalid JSON in variables' }); }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query, variables: parsedVars }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return JSON.stringify({ error: `Linear API ${response.status}: ${await response.text()}` });
    }

    const data = await response.json();
    return JSON.stringify(data, null, 2);
  } catch (err: any) {
    Sentry.captureException(err);
    return JSON.stringify({ error: `Linear API error: ${err.message}` });
  }
}

// ─── OpenSearch Logs ──────────────────────────────────────────────────────────

export const queryLogsSchema = z.object({
  env: z.enum(['dev', 'loadtest', 'prod']).optional().describe('Environment (default: prod)'),
  query_string: z.string().optional().describe('Lucene query string (e.g. "level:ERROR AND message:timeout")'),
  container: z.string().optional().describe('Filter by container name (e.g. "api", "worker")'),
  namespace: z.string().optional().describe('Filter by Kubernetes namespace'),
  node: z.string().optional().describe('Filter by node ID'),
  request_id: z.string().optional().describe('Filter by request ID'),
  task: z.string().optional().describe('Filter by Celery task ID'),
  start_time: z.string().optional().describe('Start time: ISO 8601, relative (e.g. "1h", "3d"), or keyword. Default: 1h'),
  end_time: z.string().optional().describe('End time. Default: now'),
  errors_only: z.boolean().optional().describe('Only return ERROR level logs'),
  size: z.number().optional().describe('Max results (default: 100)'),
});

export async function queryLogsHandler(_agentId: string, input: z.infer<typeof queryLogsSchema>): Promise<string> {
  const scriptsPath = getConfig('scriptsPath');
  if (!scriptsPath) return JSON.stringify({ error: 'scriptsPath not configured. Set it in Eye > Configure.' });

  const args = [
    'scripts/opensearch-curl.py',
    '--env', input.env ?? 'prod',
    '--start_time', input.start_time ?? '1h',
    '--end_time', input.end_time ?? 'now',
    '--size', String(input.size ?? 100),
    '--format', 'json',
  ];

  if (input.query_string) args.push('--query_string', input.query_string);
  if (input.container) args.push('--container', input.container);
  if (input.namespace) args.push('--namespace', input.namespace);
  if (input.node) args.push('--node', input.node);
  if (input.request_id) args.push('--request_id', input.request_id);
  if (input.task) args.push('--task', input.task);
  if (input.errors_only) args.push('--errors');

  try {
    const { stdout, stderr } = await execFileAsync('uv', ['run', 'python', ...args], {
      cwd: scriptsPath,
      timeout: 60_000,
      env: { ...process.env, PYTHONPATH: '.' },
    });

    if (stderr && !stdout.trim()) {
      return JSON.stringify({ error: `OpenSearch query failed: ${stderr.slice(0, 500)}` });
    }

    // Parse and truncate results for context window sanity
    try {
      const results = JSON.parse(stdout);
      const entries = Array.isArray(results) ? results : [];
      const truncated = entries.slice(0, input.size ?? 100).map((entry: any) => {
        const src = entry._source ?? entry;
        return {
          timestamp: src.timestamp ?? src['@timestamp'],
          level: src.level,
          container: src.kubernetes?.container?.name,
          logger: src.logger,
          message: src.message?.slice(0, 500),
          exception: src.exception?.type ? `${src.exception.type}: ${src.exception.message?.slice(0, 200)}` : undefined,
          context: src.context,
        };
      });
      return JSON.stringify({ count: entries.length, logs: truncated }, null, 2);
    } catch {
      // Return raw if can't parse
      return stdout.slice(0, 10000);
    }
  } catch (err: any) {
    Sentry.captureException(err);
    const msg = err.stderr?.slice(0, 500) || err.message;
    if (msg.includes('Authentication') || msg.includes('credentials') || msg.includes('NoCredentials')) {
      return JSON.stringify({ error: 'AWS authentication required. Run "aws sso login" first.' });
    }
    return JSON.stringify({ error: `OpenSearch query failed: ${msg}` });
  }
}

// ─── Database ─────────────────────────────────────────────────────────────────

export const queryDbSchema = z.object({
  sql: z.string().describe('SQL query to execute (READ-ONLY). Use PostgreSQL syntax.'),
  env: z.enum(['dev', 'loadtest', 'prod']).optional().describe('Environment (default: dev)'),
  database: z.string().optional().describe('Database name (default: web)'),
});

/**
 * Validates a SQL string for safe read-only use.
 * Returns null if valid, or an error message string if invalid.
 * Exported for testing.
 */
export function validateQueryDbSql(sql: string): string | null {
  // SECURITY: Check for semicolons on the ORIGINAL input BEFORE stripping comments.
  // Comment stripping can remove content inside SQL string literals (e.g. '--'),
  // which would hide semicolons from the post-strip check. For example:
  //   SELECT '--'; DELETE FROM users
  // After stripping, the "--'"; DELETE... part disappears, leaving just "SELECT "
  // with no semicolons. Checking the original input first prevents this bypass.
  if (sql.includes(';')) {
    return 'Semicolons are not allowed in queries (prevents statement chaining).';
  }

  // Strip single-line comments (-- to end of line)
  let stripped = sql.replace(/--[^\n]*/g, '');
  // Strip block comments (/* ... */)
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
  stripped = stripped.trim();

  // Require statement to start with SELECT (whitelist approach)
  if (!/^SELECT\b/i.test(stripped)) {
    return 'Only SELECT statements are allowed. This tool is read-only.';
  }

  return null;
}

export async function queryDbHandler(_agentId: string, input: z.infer<typeof queryDbSchema>): Promise<string> {
  const scriptsPath = getConfig('scriptsPath');
  if (!scriptsPath) return JSON.stringify({ error: 'scriptsPath not configured. Set it in Eye > Configure.' });

  // Safety: enforce SELECT-only whitelist (strip comments first, reject semicolons)
  const validationError = validateQueryDbSql(input.sql);
  if (validationError) {
    return JSON.stringify({ error: `Write operations are not allowed. This tool is read-only. ${validationError}` });
  }

  const env = input.env ?? 'dev';
  const db = input.database ?? 'web';

  try {
    // Use rds.sh -c to run a single command and exit
    const { stdout, stderr } = await execFileAsync(
      'bash',
      ['scripts/rds.sh', '-d', db, '-c', input.sql, env],
      {
        cwd: scriptsPath,
        timeout: 120_000,
        env: { ...process.env, RDS_PSQL_OPTS: '--csv --pset=pager=off' },
      }
    );

    if (stderr && !stdout.trim()) {
      return JSON.stringify({ error: `Database query failed: ${stderr.slice(0, 500)}` });
    }

    // Truncate large results
    const result = stdout.trim();
    if (result.length > 50000) {
      return result.slice(0, 50000) + '\n\n[TRUNCATED — result exceeded 50KB]';
    }
    return result || '(no rows returned)';
  } catch (err: any) {
    Sentry.captureException(err);
    const msg = err.stderr?.slice(0, 500) || err.message;
    if (msg.includes('kubeconfig') || msg.includes('kubectl')) {
      return JSON.stringify({ error: `Kubernetes access required. Run "aws eks update-kubeconfig --name ${env} --alias ${env}" first.` });
    }
    return JSON.stringify({ error: `Database query failed: ${msg}` });
  }
}

// ─── CI Logs (GitHub Actions) ─────────────────────────────────────────────────

export const queryCiLogsSchema = z.object({
  pr_number: z.number().optional().describe('PR number to fetch CI runs for'),
  run_id: z.number().optional().describe('Specific GitHub Actions run ID'),
  branch: z.string().optional().describe('Filter by branch name'),
  workflow: z.string().optional().describe('Filter by workflow name (e.g. "CI", "backend")'),
  failed_only: z.boolean().optional().describe('Only show failed runs (default: true)'),
  include_logs: z.boolean().optional().describe('Include failure log output (default: true). Set false for just run/job listing.'),
  repo_path: z.string().optional().describe('Path to the git repo (default: repoPath from config)'),
  limit: z.number().optional().describe('Max runs to return (default: 5)'),
});

export async function queryCiLogsHandler(_agentId: string, input: z.infer<typeof queryCiLogsSchema>): Promise<string> {
  const repoPath = input.repo_path || getConfig('repoPath');
  if (!repoPath) return JSON.stringify({ error: 'No repo path. Set repoPath in Eye > Configure, or pass repo_path.' });

  const failedOnly = input.failed_only !== false;
  const includeLogs = input.include_logs !== false;
  const limit = input.limit ?? 5;

  try {
    // Step 1: Find relevant runs
    let runs: any[];

    if (input.run_id) {
      // Fetch a specific run
      const { stdout } = await execFileAsync('gh', [
        'run', 'view', String(input.run_id),
        '--json', 'databaseId,name,status,conclusion,headBranch,event,createdAt,updatedAt,jobs',
      ], { cwd: repoPath, timeout: 30_000 });
      const run = JSON.parse(stdout);
      runs = [run];
    } else {
      // List runs with filters
      const args = ['run', 'list', '--json', 'databaseId,name,status,conclusion,headBranch,event,createdAt,updatedAt', '-L', String(limit)];
      if (input.pr_number) {
        // Get the PR's head branch first
        const { stdout: prJson } = await execFileAsync('gh', [
          'pr', 'view', String(input.pr_number), '--json', 'headRefName',
        ], { cwd: repoPath, timeout: 15_000 });
        const pr = JSON.parse(prJson);
        args.push('-b', pr.headRefName);
      } else if (input.branch) {
        args.push('-b', input.branch);
      }
      if (input.workflow) args.push('-w', input.workflow);
      if (failedOnly) args.push('-s', 'failure');

      const { stdout } = await execFileAsync('gh', args, { cwd: repoPath, timeout: 30_000 });
      runs = JSON.parse(stdout);
    }

    if (runs.length === 0) {
      return JSON.stringify({ count: 0, runs: [], message: 'No matching CI runs found.' });
    }

    // Step 2: For each failed run, get job details and optionally fetch logs
    const results = [];
    for (const run of runs.slice(0, limit)) {
      const runId = run.databaseId;
      const entry: any = {
        run_id: runId,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.headBranch,
        created_at: run.createdAt,
      };

      // Get job-level details if the run failed
      if (run.conclusion === 'failure' || run.status === 'failure') {
        try {
          const { stdout: jobsJson } = await execFileAsync('gh', [
            'run', 'view', String(runId), '--json', 'jobs',
          ], { cwd: repoPath, timeout: 30_000 });
          const { jobs } = JSON.parse(jobsJson);
          const failedJobs = (jobs ?? []).filter((j: any) => j.conclusion === 'failure');
          entry.failed_jobs = failedJobs.map((j: any) => ({
            name: j.name,
            conclusion: j.conclusion,
            steps: (j.steps ?? []).filter((s: any) => s.conclusion === 'failure').map((s: any) => s.name),
          }));

          // Fetch failure logs
          if (includeLogs && failedJobs.length > 0) {
            try {
              const { stdout: logOutput } = await execFileAsync('gh', [
                'run', 'view', String(runId), '--log-failed',
              ], { cwd: repoPath, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });

              // Truncate logs to avoid context window bloat — keep last N lines per job
              const logLines = logOutput.split('\n');
              if (logLines.length > 200) {
                entry.logs = logLines.slice(-200).join('\n');
                entry.logs_truncated = true;
                entry.total_log_lines = logLines.length;
              } else {
                entry.logs = logOutput;
              }
            } catch (logErr: any) {
              Sentry.captureException(logErr);
              entry.logs_error = `Could not fetch logs: ${logErr.message?.slice(0, 200)}`;
            }
          }
        } catch (jobErr: any) {
          Sentry.captureException(jobErr);
          entry.jobs_error = `Could not fetch job details: ${jobErr.message?.slice(0, 200)}`;
        }
      }

      results.push(entry);
    }

    return JSON.stringify({ count: results.length, runs: results }, null, 2);
  } catch (err: any) {
    Sentry.captureException(err);
    const msg = err.stderr?.slice(0, 500) || err.message;
    return JSON.stringify({ error: `CI logs query failed: ${msg}` });
  }
}

// ─── Config helper ────────────────────────────────────────────────────────────

function getConfig(key: string): string | null {
  const note = queries.getNote(`setting:eye:${key}`);
  return note?.value || null;
}
