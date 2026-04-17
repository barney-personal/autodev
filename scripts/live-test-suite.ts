#!/usr/bin/env tsx
/**
 * Autodev Live Integration Test Suite
 *
 * Submits real jobs to the running orchestrator and monitors their completion
 * to find edge cases in concurrency, resource management, and failure handling.
 *
 * Usage:
 *   npx tsx scripts/live-test-suite.ts
 *   npx tsx scripts/live-test-suite.ts --verbose
 *   npx tsx scripts/live-test-suite.ts --skip=13,14      # skip stress tests
 *   npx tsx scripts/live-test-suite.ts --only=4,5,6       # run only these
 *   npx tsx scripts/live-test-suite.ts --url=http://host:3456
 *
 * Prerequisites:
 *   - Autodev server running on the target URL (default localhost:3456)
 *   - No jobs currently running (clean baseline)
 *
 * The suite creates real Claude agent sessions. Each test uses minimal prompts
 * (maxTurns=2, haiku model) to keep cost and time low.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string) => args.some(a => a === `--${name}`);
const flagVal = (name: string) => {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
};

const BASE_URL = flagVal('url') ?? process.env.AUTODEV_URL ?? process.env.HURLICANE_URL ?? 'http://localhost:3456';
const API = `${BASE_URL}/api`;
const VERBOSE = flag('verbose');
const SKIP = new Set((flagVal('skip') ?? '').split(',').filter(Boolean).map(Number));
const ONLY = new Set((flagVal('only') ?? '').split(',').filter(Boolean).map(Number));
const WORK_DIR = process.cwd();
const POLL_MS = 2000;
const FAST_MODEL = 'claude-haiku-4-5-20251001';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  title: string;
  status: string;
  created_at: number;
  updated_at: number;
  work_dir: string | null;
  model: string | null;
  error?: string;
}

interface TestResult {
  num: number;
  name: string;
  category: string;
  passed: boolean;
  skipped: boolean;
  observational: boolean;
  elapsedMs: number;
  error?: string;
  details: Record<string, unknown>;
}

const results: TestResult[] = [];
const startTime = Date.now();

// ─── API Helpers ────────────────────────────────────────────────────────────

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

async function submitTask(payload: Record<string, unknown>): Promise<{ jobId: string; status: number; data: any }> {
  const { status, data } = await post('/tasks', payload);
  const jobId = data?.job?.id ?? '';
  return { jobId, status, data };
}

async function getJob(id: string): Promise<Job> {
  return get(`/jobs/${id}`);
}

async function waitForJob(id: string, timeoutMs: number): Promise<{ job: Job; timedOut: boolean; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(id);
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return { job, timedOut: false, elapsedMs: Date.now() - start };
    }
    if (VERBOSE) process.stdout.write(`  [${id.slice(0, 8)}] ${job.status} (${Math.round((Date.now() - start) / 1000)}s)\n`);
    await sleep(POLL_MS);
  }
  const job = await getJob(id);
  return { job, timedOut: true, elapsedMs: Date.now() - start };
}

async function waitForJobs(ids: string[], timeoutMs: number): Promise<{ jobs: Job[]; timedOut: string[]; elapsedMs: number }> {
  const start = Date.now();
  const completed = new Map<string, Job>();
  const timedOut: string[] = [];

  while (Date.now() - start < timeoutMs) {
    const pending = ids.filter(id => !completed.has(id));
    if (pending.length === 0) break;

    await Promise.all(pending.map(async id => {
      const job = await getJob(id);
      if (['done', 'failed', 'cancelled'].includes(job.status)) {
        completed.set(id, job);
        if (VERBOSE) console.log(`  [${id.slice(0, 8)}] ${job.status} (${Math.round((Date.now() - start) / 1000)}s)`);
      }
    }));

    if (completed.size < ids.length) await sleep(POLL_MS);
  }

  for (const id of ids) {
    if (!completed.has(id)) {
      timedOut.push(id);
      completed.set(id, await getJob(id));
    }
  }

  return { jobs: ids.map(id => completed.get(id)!), timedOut, elapsedMs: Date.now() - start };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function taskPayload(desc: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: `LIVE TEST: ${desc} Do not create, modify, or delete any files.`,
    preset: 'quick',
    workDir: WORK_DIR,
    model: FAST_MODEL,
    maxTurns: 2,
    ...overrides,
  };
}

// ─── Test Runner ────────────────────────────────────────────────────────────

async function runTest(
  num: number,
  name: string,
  category: string,
  fn: () => Promise<{ passed: boolean; error?: string; details?: Record<string, unknown> }>,
  observational = false,
): Promise<void> {
  if (SKIP.has(num) || (ONLY.size > 0 && !ONLY.has(num))) {
    results.push({ num, name, category, passed: true, skipped: true, observational, elapsedMs: 0, details: {} });
    console.log(`  ${String(num).padStart(2)}. ${name} — SKIP`);
    return;
  }

  const start = Date.now();
  console.log(`\n  ${String(num).padStart(2)}. ${name}...`);

  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    const icon = result.passed ? '✓' : '✗';
    console.log(`  ${String(num).padStart(2)}. ${name} — ${icon} ${result.passed ? 'PASS' : 'FAIL'} (${fmtMs(elapsed)})${result.error ? ` — ${result.error}` : ''}`);
    results.push({ num, name, category, passed: result.passed, skipped: false, observational, elapsedMs: elapsed, error: result.error, details: result.details ?? {} });
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.log(`  ${String(num).padStart(2)}. ${name} — ✗ ERROR (${fmtMs(elapsed)}) — ${err.message}`);
    results.push({ num, name, category, passed: false, skipped: false, observational, elapsedMs: elapsed, error: err.message, details: {} });
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// ─── Test Definitions ───────────────────────────────────────────────────────

// 1. Single job baseline
async function test01() {
  const { jobId, status } = await submitTask(taskPayload('Read README.md and report its first heading. Then call finish_job.'));
  if (status !== 201) return { passed: false, error: `POST returned ${status}` };
  const { job, timedOut } = await waitForJob(jobId, 180_000);
  if (timedOut) return { passed: false, error: `Timed out in status: ${job.status}` };
  return { passed: job.status === 'done', error: job.status !== 'done' ? `Final status: ${job.status}` : undefined, details: { jobId, status: job.status } };
}

// 2. Input validation — missing description
async function test02() {
  const { status, data } = await post('/tasks', {});
  return {
    passed: status === 400,
    error: status !== 400 ? `Expected 400, got ${status}` : undefined,
    details: { status, error: data?.error?.slice(0, 100) },
  };
}

// 3. Bad work_dir — should fail gracefully
async function test03() {
  const { jobId, status } = await submitTask(taskPayload('List files.', { workDir: '/nonexistent/path/that/does/not/exist' }));
  if (status !== 201) return { passed: false, error: `POST returned ${status}` };
  const { job, timedOut } = await waitForJob(jobId, 180_000);
  if (timedOut) return { passed: false, error: `Timed out in status: ${job.status}` };
  return { passed: job.status === 'failed', error: job.status !== 'failed' ? `Expected failed, got ${job.status}` : undefined, details: { jobId, status: job.status } };
}

// 4-6. Concurrent batch tests
async function testConcurrentBatch(n: number, timeoutMs: number) {
  const ids: string[] = [];
  const submissions = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      submitTask(taskPayload(`Concurrent batch job ${i + 1}/${n}. Run ls and call finish_job with the file count.`))
    ),
  );
  for (const s of submissions) {
    if (s.status !== 201) return { passed: false, error: `POST returned ${s.status}` };
    ids.push(s.jobId);
  }
  const { jobs, timedOut } = await waitForJobs(ids, timeoutMs);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  const timedOutCount = timedOut.length;
  const times = jobs.map(j => (j.updated_at - j.created_at) / 1000);
  return {
    passed: doneCount === n,
    error: doneCount !== n ? `${doneCount}/${n} done, ${failedCount} failed, ${timedOutCount} timed out` : undefined,
    details: { n, doneCount, failedCount, timedOutCount, minTime: Math.min(...times).toFixed(1), maxTime: Math.max(...times).toFixed(1), avgTime: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) },
  };
}

// 7. Rapid-fire submission
async function test07() {
  const ids: string[] = [];
  // Submit sequentially without waiting, as fast as possible
  for (let i = 0; i < 5; i++) {
    const { jobId, status } = await submitTask(taskPayload(`Rapid-fire job ${i + 1}/5. Run echo hello and call finish_job.`));
    if (status !== 201) return { passed: false, error: `POST ${i + 1} returned ${status}` };
    ids.push(jobId);
  }
  const { jobs, timedOut } = await waitForJobs(ids, 300_000);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  return {
    passed: doneCount === 5,
    error: doneCount !== 5 ? `${doneCount}/5 done, ${failedCount} failed, ${timedOut.length} timed out` : undefined,
    details: { doneCount, failedCount },
  };
}

// 8. Cross-repo jobs
async function test08() {
  const dirs = [WORK_DIR, '/tmp'];
  const submissions = await Promise.all(
    dirs.map((dir, i) =>
      submitTask(taskPayload(`Cross-repo test ${i + 1}. Run pwd and ls, then call finish_job.`, { workDir: dir }))
    ),
  );
  const ids = submissions.map(s => s.jobId);
  if (submissions.some(s => s.status !== 201)) return { passed: false, error: 'POST failed' };
  const { jobs } = await waitForJobs(ids, 300_000);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  return {
    passed: doneCount === 2,
    error: doneCount !== 2 ? `${doneCount}/2 done` : undefined,
    details: { dirs, statuses: jobs.map(j => j.status) },
  };
}

// 9. Mixed models
async function test09() {
  const models = [FAST_MODEL, 'claude-sonnet-4-20250514'];
  const submissions = await Promise.all(
    models.map((model, i) =>
      submitTask(taskPayload(`Mixed model test (${model.split('-').slice(1, 3).join('-')}). Run ls and call finish_job.`, { model }))
    ),
  );
  const ids = submissions.map(s => s.jobId);
  if (submissions.some(s => s.status !== 201)) return { passed: false, error: 'POST failed' };
  const { jobs } = await waitForJobs(ids, 300_000);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const times = jobs.map(j => ((j.updated_at - j.created_at) / 1000).toFixed(1) + 's');
  return {
    passed: doneCount === 2,
    error: doneCount !== 2 ? `${doneCount}/2 done: ${jobs.map(j => j.status).join(', ')}` : undefined,
    details: { models, statuses: jobs.map(j => j.status), times },
  };
}

// 10. Different max_turns
async function test10() {
  const [sub1, sub2] = await Promise.all([
    submitTask(taskPayload('MaxTurns=1 test. Call finish_job immediately.', { maxTurns: 1 })),
    submitTask(taskPayload('MaxTurns=5 test. Read package.json, then call finish_job.', { maxTurns: 5 })),
  ]);
  if (sub1.status !== 201 || sub2.status !== 201) return { passed: false, error: 'POST failed' };
  const { jobs } = await waitForJobs([sub1.jobId, sub2.jobId], 300_000);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  return {
    passed: doneCount === 2,
    error: doneCount !== 2 ? `${doneCount}/2 done` : undefined,
    details: { statuses: jobs.map(j => j.status) },
  };
}

// 11. Sequential dependencies
async function test11() {
  const subA = await submitTask(taskPayload('Dependency test A (parent). Run ls and call finish_job.'));
  if (subA.status !== 201) return { passed: false, error: `POST A returned ${subA.status}` };

  const subB = await submitTask(taskPayload('Dependency test B (child). Run pwd and call finish_job.', { dependsOn: [subA.jobId] }));
  if (subB.status !== 201) return { passed: false, error: `POST B returned ${subB.status}` };

  // Poll both — B should stay queued until A is done
  let bRanBeforeADone = false;
  const startPoll = Date.now();
  const timeoutMs = 360_000;

  while (Date.now() - startPoll < timeoutMs) {
    const [jobA, jobB] = await Promise.all([getJob(subA.jobId), getJob(subB.jobId)]);

    if (['assigned', 'running'].includes(jobB.status) && !['done', 'failed', 'cancelled'].includes(jobA.status)) {
      bRanBeforeADone = true;
    }

    if (['done', 'failed', 'cancelled'].includes(jobA.status) && ['done', 'failed', 'cancelled'].includes(jobB.status)) {
      return {
        passed: jobA.status === 'done' && jobB.status === 'done' && !bRanBeforeADone,
        error: bRanBeforeADone ? 'B started before A finished' : (jobA.status !== 'done' ? `A: ${jobA.status}` : jobB.status !== 'done' ? `B: ${jobB.status}` : undefined),
        details: { a: jobA.status, b: jobB.status, bRanBeforeADone },
      };
    }
    await sleep(POLL_MS);
  }
  return { passed: false, error: 'Timed out' };
}

// 12. Dependency cascade failure
async function test12() {
  const subA = await submitTask(taskPayload('Cascade fail parent. Run ls.', { workDir: '/nonexistent/cascade/test' }));
  if (subA.status !== 201) return { passed: false, error: `POST A returned ${subA.status}` };

  const subB = await submitTask(taskPayload('Cascade fail child. Run ls.', { dependsOn: [subA.jobId] }));
  if (subB.status !== 201) return { passed: false, error: `POST B returned ${subB.status}` };

  const { jobs } = await waitForJobs([subA.jobId, subB.jobId], 240_000);
  const [jobA, jobB] = jobs;
  return {
    passed: jobA.status === 'failed' && jobB.status === 'failed',
    error: jobA.status !== 'failed' ? `A: ${jobA.status}` : jobB.status !== 'failed' ? `B should cascade-fail, got: ${jobB.status}` : undefined,
    details: { a: jobA.status, b: jobB.status },
  };
}

// 13. High concurrency stress test (observational)
async function test13() {
  const n = 10;
  const submissions = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      submitTask(taskPayload(`Stress test job ${i + 1}/${n}. Run echo ok and call finish_job.`))
    ),
  );
  const ids = submissions.filter(s => s.status === 201).map(s => s.jobId);
  if (ids.length < n) return { passed: false, error: `Only ${ids.length}/${n} accepted` };
  const { jobs, timedOut } = await waitForJobs(ids, 600_000);
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;

  // Observational: check health endpoint is still responsive
  let healthOk = false;
  try {
    const h = await get('/health');
    healthOk = h.status !== 'unhealthy';
  } catch { healthOk = false; }

  return {
    passed: healthOk, // observational — server stability is the real test
    error: !healthOk ? 'Server unhealthy after stress test' : undefined,
    details: { n, doneCount, failedCount, timedOutCount: timedOut.length, healthOk },
  };
}

// 14. Resource health check (observational)
async function test14() {
  try {
    const h = await get('/health');
    return {
      passed: h.status !== 'unhealthy',
      details: { status: h.status, checks: h.checks },
    };
  } catch (err: any) {
    return { passed: false, error: `Health endpoint failed: ${err.message}` };
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printReport() {
  const total = Date.now() - startTime;
  const run = results.filter(r => !r.skipped);
  const passed = run.filter(r => r.passed && !r.observational).length;
  const failed = run.filter(r => !r.passed && !r.observational).length;
  const info = run.filter(r => r.observational).length;

  console.log('\n' + '='.repeat(90));
  console.log('  AUTODEV LIVE TEST SUITE REPORT');
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log(`  Total duration: ${fmtMs(total)}`);
  console.log('='.repeat(90));
  console.log('');
  console.log('  #  | Category           | Test                            | Result  | Time     | Notes');
  console.log('  ---|--------------------|---------------------------------|---------|----------|' + '-'.repeat(30));

  for (const r of results) {
    const result = r.skipped ? 'SKIP' : r.observational ? (r.passed ? 'INFO' : 'WARN') : r.passed ? 'PASS' : 'FAIL';
    const icon = r.skipped ? '⊘' : r.passed ? '✓' : '✗';
    const notes = r.error ?? summarizeDetails(r.details);
    console.log(
      `  ${icon} ${String(r.num).padStart(2)} | ${r.category.padEnd(18)} | ${r.name.padEnd(31)} | ${result.padEnd(7)} | ${fmtMs(r.elapsedMs).padStart(8)} | ${notes.slice(0, 40)}`,
    );
  }

  console.log('');
  console.log('='.repeat(90));
  console.log(`  RESULT: ${passed} passed, ${failed} failed, ${info} observational`);
  if (failed > 0) {
    console.log('');
    console.log('  FAILURES:');
    for (const r of run.filter(r => !r.passed && !r.observational)) {
      console.log(`    ${r.num}. ${r.name}: ${r.error}`);
      if (Object.keys(r.details).length > 0) {
        console.log(`       ${JSON.stringify(r.details)}`);
      }
    }
  }
  console.log('='.repeat(90));
  console.log(`\n  Created ${run.length} test scenarios. Jobs remain in DB for inspection.`);
  console.log('');

  return failed;
}

function summarizeDetails(d: Record<string, unknown>): string {
  if (!d || Object.keys(d).length === 0) return '';
  if (d.doneCount !== undefined) return `${d.doneCount}/${d.n ?? '?'} done`;
  if (d.statuses) return (d.statuses as string[]).join(', ');
  if (d.status) return String(d.status);
  return '';
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  Autodev Live Test Suite');
  console.log(`  Server: ${BASE_URL}`);
  console.log('');

  // Pre-flight
  console.log('  Pre-flight check...');
  try {
    const h = await get('/health');
    if (h.status === 'unhealthy') {
      console.error('  ✗ Server is unhealthy. Aborting.');
      process.exit(1);
    }
    console.log(`  ✓ Server is ${h.status}`);
  } catch (err: any) {
    console.error(`  ✗ Cannot reach server at ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }

  // Check for running jobs
  try {
    const running: Job[] = await get('/jobs?status=running');
    const assigned: Job[] = await get('/jobs?status=assigned');
    const active = running.length + assigned.length;
    if (active > 0) {
      console.log(`  ⚠ ${active} jobs currently active (${running.length} running, ${assigned.length} assigned)`);
      console.log('    Results may be affected by contention. Proceeding anyway.');
    } else {
      console.log('  ✓ No active jobs (clean baseline)');
    }
  } catch { /* ignore */ }

  console.log('');
  console.log('  ── Baseline ──');

  await runTest(1, 'Single job baseline', 'baseline', test01);
  await runTest(2, 'Validation: missing desc', 'validation', test02);
  await runTest(3, 'Bad work_dir fails', 'validation', test03);

  console.log('');
  console.log('  ── Concurrency ──');

  await runTest(4, 'Concurrent batch (2)', 'concurrency', () => testConcurrentBatch(2, 300_000));
  await runTest(5, 'Concurrent batch (5)', 'concurrency', () => testConcurrentBatch(5, 480_000));
  await runTest(6, 'Concurrent batch (10)', 'concurrency', () => testConcurrentBatch(10, 600_000));
  await runTest(7, 'Rapid-fire (5 serial)', 'concurrency', test07);

  console.log('');
  console.log('  ── Variants ──');

  await runTest(8, 'Cross-repo work_dirs', 'variants', test08);
  await runTest(9, 'Mixed models', 'variants', test09);
  await runTest(10, 'Different max_turns', 'variants', test10);

  console.log('');
  console.log('  ── Dependencies ──');

  await runTest(11, 'Sequential dependency', 'dependencies', test11);
  await runTest(12, 'Dependency cascade fail', 'dependencies', test12);

  console.log('');
  console.log('  ── Stress (observational) ──');

  await runTest(13, 'High concurrency (10)', 'stress', test13, true);
  await runTest(14, 'Post-test health', 'stress', test14, true);

  const failures = printReport();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
