import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb, insertTestWorkflow, insertTestJob } from './helpers.js';
import {
  buildWorkflowReportData,
  parseRepairFlag,
  renderWorkflowReport,
  REPORT_LIMITS,
  type ReportJob,
  type WorkflowReportData,
} from '../server/orchestrator/WorkflowReport.js';
import { workflowReportFilename } from '../shared/workflowReport.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const C1 = String.fromCharCode(0x9b);

function baseData(overrides: Partial<WorkflowReportData> = {}): WorkflowReportData {
  return {
    id: 'wf-1',
    title: 'Synthetic workflow',
    task: 'Build the thing',
    status: 'running',
    current_phase: 'implement',
    current_cycle: 2,
    max_cycles: 5,
    milestones_done: 1,
    milestones_total: 3,
    implementer_model: 'claude-opus-5-5',
    reviewer_model: 'codex-gpt-6-astra',
    worktree_branch: 'workflow/synthetic',
    pr_url: null,
    blocked_reason: null,
    created_at: NOW - 2 * HOUR,
    updated_at: NOW - HOUR,
    plan: '# Plan\n- [x] M1\n- [ ] M2\n',
    jobs: [],
    verify_runs: [],
    ...overrides,
  };
}

function job(overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    id: 'job-a',
    cycle: 1,
    phase: 'implement',
    status: 'done',
    model: 'claude-opus-5-5',
    is_repair: false,
    created_at: NOW - HOUR,
    attempts: [],
    ...overrides,
  };
}

const HEADINGS = ['Status', 'Blocked reason', 'Original goal', 'Saved plan', 'Models', 'Recorded usage', 'Verification', 'Phase jobs'];

/** Slice one report section, ending at the next report-owned heading (saved text may contain its own). */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const ends = HEADINGS.map(h => md.indexOf(`\n## ${h}\n`, start + 1)).filter(i => i > start);
  return md.slice(start + 1, ends.length ? Math.min(...ends) : undefined);
}

describe('workflowReportFilename', () => {
  it('keeps a normal UUID', () => {
    expect(workflowReportFilename('b72888f3-9b8b-4ded-8de2-496a76bf93d8'))
      .toBe('autodev-workflow-b72888f3-9b8b-4ded-8de2-496a76bf93d8-report.md');
  });
  it('replaces path separators and odd characters, collapsing repeats', () => {
    expect(workflowReportFilename('../../etc/passwd')).toBe('autodev-workflow-etc-passwd-report.md');
    expect(workflowReportFilename('a b"c;\\d\r\ne')).toBe('autodev-workflow-a-b-c-d-e-report.md');
    expect(workflowReportFilename('id_with_underscores')).toBe('autodev-workflow-id_with_underscores-report.md');
  });
  it('falls back to unknown when nothing safe remains', () => {
    expect(workflowReportFilename('')).toBe('autodev-workflow-unknown-report.md');
    expect(workflowReportFilename('///')).toBe('autodev-workflow-unknown-report.md');
    expect(workflowReportFilename(undefined)).toBe('autodev-workflow-unknown-report.md');
  });
  it('caps very long IDs without a trailing separator', () => {
    const name = workflowReportFilename(`${'a'.repeat(79)}-${'b'.repeat(200)}`);
    expect(name).toBe(`autodev-workflow-${'a'.repeat(79)}-report.md`);
    expect(workflowReportFilename('x'.repeat(500)).length).toBe('autodev-workflow--report.md'.length + 80);
  });
});

describe('renderWorkflowReport', () => {
  it('includes the snapshot notice, identity, status and configured models', () => {
    const md = renderWorkflowReport(baseData(), NOW);
    expect(md).toContain('# Workflow report: Synthetic workflow');
    expect(md).toContain('**Workflow ID:** wf\\-1'.replace('\\-', '-'));
    expect(md).toContain(`**Snapshot generated:** ${new Date(NOW).toISOString()}`);
    expect(md).toContain('point-in-time snapshot');
    expect(md).toContain('**Status:** running');
    expect(md).toContain('**Current phase:** implement');
    expect(md).toContain('**Current cycle:** 2 (max cycles: 5)');
    expect(md).toContain('**Milestone progress:** 1/3 milestones done');
    expect(md).toContain('**Configured implementer:** claude-opus-5-5');
    expect(md).toContain('**Configured reviewer:** codex-gpt-6-astra');
    expect(md).toContain('**Elapsed wall-clock:** 2h so far');
    expect(md).toContain('**Branch:** workflow/synthetic');
    expect(md).toContain('**Pull request:** None recorded');
  });

  it('renders sparse historical data as unavailable, never zero cost', () => {
    const md = renderWorkflowReport(baseData({
      title: null, task: null, plan: null, status: 'complete', current_phase: null,
      current_cycle: null, max_cycles: null, milestones_done: null, milestones_total: null,
      implementer_model: null, reviewer_model: null, worktree_branch: null,
      created_at: null, updated_at: null,
      jobs: [job({ attempts: [] }), job({ id: 'job-b', attempts: [{ agent_id: 'ag', started_at: null, finished_at: null, cost_usd: null }] })],
    }), NOW);
    expect(md).toContain('# Workflow report: Untitled workflow');
    expect(md).toContain('**Created:** unavailable');
    expect(md).toContain('**Elapsed wall-clock:** Unavailable — creation time not recorded');
    expect(md).toContain('**Milestone progress:** Unavailable — milestone counts not recorded');
    expect(md).toContain('No plan saved');
    expect(md).toContain('Unavailable — no goal recorded');
    expect(md).toContain('Unavailable — no cost recorded (0 of 1 attempts had recorded cost)');
    expect(md).toContain('Unavailable — no attempt had a valid start and finish time (0 of 1)');
    expect(md).toContain('No verification runs recorded. Workflow status alone does not indicate that verification passed.');
    expect(md).not.toMatch(/\$0\.00|USD 0\.0000/);
  });

  it('distinguishes persisted 0/0 milestones from a missing plan', () => {
    const md = renderWorkflowReport(baseData({ milestones_done: 0, milestones_total: 0, plan: '- [ ] something' }), NOW);
    expect(md).toContain('No milestones recorded (0/0)');
    expect(section(md, 'Saved plan')).toContain('- [ ] something');
  });

  it('sums each identified attempt once, keeping identical-valued distinct attempts and explicit zero cost', () => {
    const a = (id: string, cost: number | null) => ({ agent_id: id, started_at: NOW - HOUR, finished_at: NOW - HOUR + 60_000, cost_usd: cost });
    const md = renderWorkflowReport(baseData({
      jobs: [
        job({ id: 'job-1', attempts: [a('ag-1', 0.5), a('ag-2', 0.5)] }),
        job({ id: 'job-2', attempts: [a('ag-3', 0.25)] }),       // same phase/cycle → repeated
        job({ id: 'job-3', attempts: [a('ag-4', 0)] }),
        job({ id: 'job-4', attempts: [a('ag-5', null)] }),
      ],
    }), NOW);
    const usage = section(md, 'Recorded usage');
    expect(usage).toContain('**Agent attempts:** 5');
    expect(usage).toContain('USD 1.25 (4 of 5 attempts had recorded cost; partial coverage)');
    expect(usage).toContain('5m (5 of 5 attempts had a valid start and finish time)');
    expect(usage).toContain('not a billing guarantee');
    const jobs = section(md, 'Phase jobs');
    expect(jobs).toContain('repeated phase/cycle (#2)');
    expect(jobs).toContain('USD 0.0000');           // genuine recorded zero
    expect(jobs).toMatch(/job\\-4|job-4/);
  });

  it('distinguishes a job with no agents from an identified all-null agent', () => {
    const md = renderWorkflowReport(baseData({
      jobs: [
        job({ id: 'no-agents', attempts: [] }),
        job({ id: 'null-agent', cycle: 2, attempts: [{ agent_id: 'x', started_at: null, finished_at: null, cost_usd: null }] }),
      ],
    }), NOW);
    const lines = section(md, 'Phase jobs').split('\n');
    const noAgents = lines.find(l => l.includes('no\\-agents') || l.includes('no-agents'))!;
    const nullAgent = lines.find(l => l.includes('null\\-agent') || l.includes('null-agent'))!;
    expect(noAgents.split(' | ')[6]).toBe('0');
    expect(nullAgent.split(' | ')[6]).toBe('1');
    expect(noAgents).toContain('unavailable');
  });

  it('labels terminal elapsed time as a last-update proxy and rejects inconsistent dates', () => {
    expect(renderWorkflowReport(baseData({ status: 'complete' }), NOW))
      .toContain('1h through last recorded update (completion time unavailable)');
    expect(renderWorkflowReport(baseData({ status: 'cancelled', updated_at: NOW - 3 * HOUR }), NOW))
      .toContain('Unavailable — last update time is before the creation time');
    expect(renderWorkflowReport(baseData({ status: 'running', created_at: NOW + HOUR }), NOW))
      .toContain('Unavailable — creation time is after the snapshot time');
    expect(renderWorkflowReport(baseData({ status: 'weird' }), NOW))
      .toContain('Unavailable — status not recognized');
    const md = renderWorkflowReport(baseData({ created_at: Number.NaN, updated_at: 1e20 }), NOW);
    expect(md).toContain('**Created:** unavailable');
    expect(md).toContain('**Last updated (any recorded change):** unavailable');
    const reversed = renderWorkflowReport(baseData({
      jobs: [job({ attempts: [{ agent_id: 'r', started_at: NOW, finished_at: NOW - 1000, cost_usd: 1 }] })],
    }), NOW);
    expect(reversed).toContain('Unavailable — no attempt had a valid start and finish time (0 of 1)');
  });

  it('renders a blocked run with its reason fenced', () => {
    const md = renderWorkflowReport(baseData({ status: 'blocked', blocked_reason: 'branch push failed: ## not a heading' }), NOW);
    const blocked = section(md, 'Blocked reason');
    expect(blocked).toContain('```text\nbranch push failed: ## not a heading\n```');
    expect(md).toContain('so far');
  });

  it('renders a completed run with verification outcomes and a PR link', () => {
    const md = renderWorkflowReport(baseData({
      status: 'complete',
      pr_url: 'https://github.com/example/repo/pull/42',
      verify_runs: [
        { id: 'v2', cycle: 1, attempt: 2, exit_code: 0, duration_ms: 90_000, created_at: NOW - 1000 },
        { id: 'v1', cycle: 1, attempt: 1, exit_code: 1, duration_ms: 30_000, created_at: NOW - 2000 },
        { id: 'v3', cycle: 2, attempt: 1, exit_code: null, duration_ms: null, created_at: null },
      ],
    }), NOW);
    expect(md).toContain('**Pull request:** [Open pull request](https://github.com/example/repo/pull/42)');
    const verify = section(md, 'Verification');
    expect(verify).toContain('3 verification runs: 1 passed, 1 failed, 1 unknown outcome.');
    const rows = verify.split('\n').filter(l => /^\| \d/.test(l));
    expect(rows[0]).toContain('failed (exit 1)');
    expect(rows[1]).toContain('passed');
    expect(rows[2]).toContain('unknown');
    expect(rows[2]).toContain('unavailable');
  });

  it('serializes PR links safely and rejects unsafe schemes and credentials', () => {
    const paren = renderWorkflowReport(baseData({ pr_url: 'https://example.com/a(b)<c>\\d e' }), NOW);
    const line = paren.split('\n').find(l => l.startsWith('- **Pull request:**'))!;
    expect(line).toContain('](https://example.com/a%28b%29%3Cc%3E/d%20e)');
    expect(line).not.toMatch(/\]\([^)]*[()<>\s\\][^)]*\)/);
    for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url', 'https://user:secret@github.com/x/pull/1']) {
      const md = renderWorkflowReport(baseData({ pr_url: bad }), NOW);
      expect(md).toContain('**Pull request:** Unavailable — invalid PR link');
      expect(md).not.toContain('secret');
      expect(md).not.toContain('javascript:');
    }
  });

  it('neutralizes Markdown injection and control/bidi characters in saved text', () => {
    const hostile = 'Intro\n```\n## Injected heading\n[x](javascript:alert(1)) ![img](http://evil/x.png) | a | b |\n````` long run\n' + RLO + 'gnp.exe' + NUL + BEL + C1 + '\r\nend';
    const md = renderWorkflowReport(baseData({
      title: 'Evil\n# title <b>bold</b> [link](http://x) | pipe',
      task: hostile,
      plan: hostile,
      implementer_model: '<script>alert(1)</script>',
      worktree_branch: 'feat|`x`',
    }), NOW);
    expect(md.split('\n')[0]).toBe('# Workflow report: Evil \\# title \\<b\\>bold\\</b\\> \\[link\\](http://x) \\| pipe');
    expect(md).not.toContain(RLO);
    expect(md).not.toContain(NUL);
    expect(md).not.toContain(BEL);
    expect(md).not.toContain(C1);
    expect(md).not.toContain('\r');
    expect(md).toContain('**Configured implementer:** \\<script\\>alert(1)\\</script\\>');
    expect(md).toContain('**Branch:** feat\\|\\`x\\`');
    // Free text uses a fence longer than any backtick run inside it, so nothing escapes the block.
    const goal = section(md, 'Original goal');
    expect(goal).toContain('``````text\nIntro\n```\n## Injected heading');
    expect(goal).toMatch(/end\n``````\n/);
    // Only the report's own headings appear at top level.
    const outside = md.replace(/``````text\n[\s\S]*?\n``````/g, '');
    expect(outside).not.toContain('Injected heading');
    expect(outside).not.toContain('javascript:');
  });

  it('caps oversized text with an explicit truncation notice and closes the fence', () => {
    const plan = 'p'.repeat(REPORT_LIMITS.textChars + 500);
    const md = renderWorkflowReport(baseData({ plan, blocked_reason: 'r'.repeat(5000), status: 'blocked' }), NOW);
    expect(section(md, 'Saved plan')).toContain(`${'p'.repeat(100)}\n\`\`\`\n\n_Truncated: showing the first 20,000 of 20,500 characters._`);
    expect(section(md, 'Blocked reason')).toContain('_Truncated: showing the first 2,000 of 5,000 characters._');
    const longTitle = renderWorkflowReport(baseData({ title: 't'.repeat(500) }), NOW);
    expect(longTitle.split('\n')[0]).toBe(`# Workflow report: ${'t'.repeat(200)}… (truncated)`);
  });

  it('bounds large job and verification tables with omitted-row notices while totals cover all rows', () => {
    const jobs = Array.from({ length: 1500 }, (_, i) => job({
      id: `job-${String(i).padStart(4, '0')}`,
      cycle: i,
      phase: i % 2 ? 'review' : 'verify',
      model: `model-${i}`,
      created_at: NOW - (1500 - i) * 1000,
      attempts: [{ agent_id: `ag-${i}`, started_at: NOW - 1000, finished_at: NOW, cost_usd: 0.01 }],
    }));
    const verify_runs = Array.from({ length: 400 }, (_, i) => ({ id: `v${i}`, cycle: i, attempt: 1, exit_code: 0, duration_ms: 1, created_at: NOW - (400 - i) }));
    const md = renderWorkflowReport(baseData({ jobs, verify_runs }), NOW);
    expect(md).toContain('_1400 jobs omitted (totals above include them)_');
    expect(md).toContain('_300 verification runs omitted_');
    expect(md).toContain('_1400 model-difference entries omitted._');
    expect(md).toContain('**Agent attempts:** 1500');
    expect(md).toContain('USD 15.00 (1500 of 1500 attempts had recorded cost)');
    expect(md).toContain('400 verification runs: 400 passed');
    const jobRows = section(md, 'Phase jobs').split('\n').filter(l => /^\| \d/.test(l));
    expect(jobRows).toHaveLength(100);
    expect(jobRows[0]).toContain('job\\-0000'.replace('\\-', '-'));
    expect(jobRows[99]).toContain('1499');
  });

  function worstCase(): WorkflowReportData {
    const fat = '😀`'.repeat(REPORT_LIMITS.textChars);
    const cell = '|'.repeat(1000);
    const jobs = Array.from({ length: 300 }, (_, i) => job({ id: `${cell}${i}`, phase: cell, status: cell, model: `${cell}${i}`, attempts: [] }));
    return baseData({ title: cell, task: fat, plan: fat, blocked_reason: fat, status: 'blocked', implementer_model: cell, jobs });
  }

  it('keeps worst-case input within the real byte budget', () => {
    const md = renderWorkflowReport(worstCase(), NOW);
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(REPORT_LIMITS.maxBytes);
  });

  it('shrinks section budgets to fit the byte cap while keeping fences balanced and multibyte text intact', () => {
    const original = REPORT_LIMITS.maxBytes;
    REPORT_LIMITS.maxBytes = 60_000;
    let md: string;
    try { md = renderWorkflowReport(worstCase(), NOW); } finally { REPORT_LIMITS.maxBytes = original; }
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(md).toContain('shortened further to keep this report within its size limit');
    expect(md).toContain('jobs omitted (totals above include them)');
    for (const name of ['Blocked reason', 'Original goal', 'Saved plan']) {
      const body = section(md, name);
      const fences = body.split('\n').filter(l => /^`{3,}/.test(l));
      expect(fences).toHaveLength(2);
      expect(fences[0]).toBe(`${fences[1]}text`);
      const inner = body.slice(body.indexOf('\n') + 1);
      const longestRun = Math.max(0, ...(inner.match(/`+/g) ?? []).filter(r => r !== fences[1]).map(r => r.length));
      expect(fences[1].length).toBeGreaterThan(longestRun);
    }
    expect(md).not.toMatch(/�/);
  });

  it('lists model differences, verify jobs without a configured model, and leaves matches out', () => {
    const md = renderWorkflowReport(baseData({
      implementer_model: 'codex-gpt-6.1-sol',
      jobs: [
        job({ id: 'j-review', phase: 'review', model: 'codex-gpt-6-astra' }),
        job({ id: 'j-impl', phase: 'implement', model: 'claude-sonnet-5-5' }),
        job({ id: 'j-impl2', phase: 'implement', model: 'claude-sonnet-5-5' }),
        job({ id: 'j-assess', phase: 'assess', model: 'claude-sonnet-4-6' }),
        job({ id: 'j-verify', phase: 'verify', model: 'claude-opus-4-7' }),
      ],
    }), NOW);
    const models = section(md, 'Models');
    expect(models).not.toContain('j\\-review');
    expect(models).toContain('implement: configured codex\\-gpt\\-6.1\\-sol'.replace(/\\-/g, '-'));
    expect(models).toContain('last recorded job model claude-sonnet-5-5 on 2 jobs (first: j-impl)');
    expect(models).toContain('assess intentionally uses a Claude model when the implementer is Codex');
    expect(models).toContain('verify: no per-workflow configured model; last recorded job model claude-opus-4-7 on 1 job');
  });

  it('orders jobs chronologically with stable ID ties and invalid times last', () => {
    const md = renderWorkflowReport(baseData({
      jobs: [
        job({ id: 'c', cycle: 0, created_at: null }),
        job({ id: 'b', cycle: 2, created_at: NOW - 100 }),
        job({ id: 'a', cycle: 3, created_at: NOW - 100 }),
        job({ id: 'z', cycle: 1, created_at: NOW - 500 }),
      ],
    }), NOW);
    const ids = section(md, 'Phase jobs').split('\n').filter(l => /^\| \d/.test(l)).map(l => l.split(' | ')[1]);
    expect(ids).toEqual(['z', 'a', 'b', 'c']);
  });

  it('marks repair only from persisted context', () => {
    const md = renderWorkflowReport(baseData({ jobs: [job({ id: 'r1', is_repair: true }), job({ id: 'r2', cycle: 9 })] }), NOW);
    const rows = section(md, 'Phase jobs').split('\n').filter(l => /^\| \d/.test(l));
    expect(rows[0].trimEnd().endsWith('| repair |')).toBe(true);
    expect(rows[1].trimEnd().endsWith('|  |')).toBe(true);
  });
});

describe('parseRepairFlag', () => {
  it('only trusts a boolean is_repair in valid JSON', () => {
    expect(parseRepairFlag('{"is_repair":true}')).toBe(true);
    expect(parseRepairFlag('{"is_repair":"true"}')).toBe(false);
    expect(parseRepairFlag('{not json')).toBe(false);
    expect(parseRepairFlag('null')).toBe(false);
    expect(parseRepairFlag(null)).toBe(false);
  });
});

describe('buildWorkflowReportData', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns null for an unknown workflow', () => {
    expect(buildWorkflowReportData('does-not-exist')).toBeNull();
  });

  it('composes persisted data into the allowlisted shape without secrets', async () => {
    const { insertAgent, updateAgent, upsertNote, insertVerifyRun, updateWorkflow } = await import('../server/db/queries.js');
    const wf = await insertTestWorkflow({ title: 'Real', task: 'Goal', status: 'complete', work_dir: '/secret/path/SENTINEL_WORKDIR' });
    updateWorkflow(wf.id, { pr_url: 'https://github.com/o/r/pull/1', worktree_branch: 'workflow/x', worktree_path: '/secret/SENTINEL_WT' });
    upsertNote(`workflow/${wf.id}/plan`, '- [x] M1', null);
    const j1 = await insertTestJob({ workflow_id: wf.id, workflow_phase: 'implement', workflow_cycle: 1, status: 'done', model: 'claude-opus-5-5', description: 'SENTINEL_PROMPT', context: '{"is_repair":true}' });
    const j2 = await insertTestJob({ workflow_id: wf.id, workflow_phase: 'implement', workflow_cycle: 1, status: 'done', context: '{"is_repair":"true"}' });
    await insertTestJob({ workflow_id: wf.id, workflow_phase: 'review', workflow_cycle: 1, status: 'failed' });
    insertAgent({ id: 'agent-1', job_id: j1.id, status: 'done', started_at: NOW - 2000, finished_at: NOW - 1000 });
    updateAgent('agent-1', { cost_usd: 0.4, diff: 'SENTINEL_DIFF', error_message: 'SENTINEL_ERROR' });
    insertAgent({ id: 'agent-2', job_id: j1.id, status: 'done', started_at: NOW - 2000, finished_at: NOW - 1000 });
    updateAgent('agent-2', { cost_usd: 0.4 });
    insertAgent({ id: 'agent-3', job_id: j2.id, status: 'failed', started_at: NOW - 500 });
    insertVerifyRun({ id: 'vr-1', workflow_id: wf.id, cycle: 1, attempt: 1, command: 'SENTINEL_COMMAND', exit_code: 0, stdout: 'SENTINEL_STDOUT', stderr: 'SENTINEL_STDERR', duration_ms: 1200, created_at: NOW });

    const data = buildWorkflowReportData(wf.id)!;
    expect(data.plan).toBe('- [x] M1');
    expect(data.pr_url).toBe('https://github.com/o/r/pull/1');
    expect(data.jobs).toHaveLength(3);
    const byId = new Map(data.jobs.map(j => [j.id, j]));
    expect(byId.get(j1.id)!.attempts.map(a => a.agent_id).sort()).toEqual(['agent-1', 'agent-2']);
    expect(byId.get(j1.id)!.is_repair).toBe(true);
    expect(byId.get(j2.id)!.is_repair).toBe(false);
    expect(byId.get(j2.id)!.attempts).toEqual([{ agent_id: 'agent-3', started_at: NOW - 500, finished_at: null, cost_usd: null }]);
    expect(data.jobs.find(j => j.phase === 'review')!.attempts).toEqual([]);
    expect(data.verify_runs).toEqual([{ id: 'vr-1', cycle: 1, attempt: 1, exit_code: 0, duration_ms: 1200, created_at: NOW }]);

    const md = renderWorkflowReport(data, NOW);
    expect(md).toContain('USD 0.8000 (2 of 3 attempts had recorded cost; partial coverage)');
    expect(md).toContain('1 verification run: 1 passed');
    expect(md).not.toMatch(/SENTINEL_/);
    expect(JSON.stringify(data)).not.toMatch(/SENTINEL_/);
  });

  it('handles a workflow with no jobs, plan or verification', async () => {
    const wf = await insertTestWorkflow({ status: 'cancelled' });
    const data = buildWorkflowReportData(wf.id)!;
    expect(data.jobs).toEqual([]);
    expect(data.plan).toBeNull();
    const md = renderWorkflowReport(data, NOW);
    expect(md).toContain('Unavailable — no agent attempts recorded');
    expect(md).toContain('No phase jobs recorded.');
    expect(md).not.toMatch(/USD \d/);
  });
});
