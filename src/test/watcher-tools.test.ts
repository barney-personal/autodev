/**
 * Tests for the watcher's server-side action handlers.
 *
 * Proves:
 * 1. post_commentary persists and emits via socket; severity bumps watcher row.
 * 2. nudge_job applies once then enters cooldown on rapid retries.
 * 3. restart_job is capped at MAX_RESTARTS_PER_AGENT and auto-escalates on cap.
 * 4. escalate_to_user opens a discussion thread.
 *
 * The handlers depend on file-lock and kill plumbing, so we mock the pieces
 * that would touch real OS state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupTestDb, cleanupTestDb, createSocketMock, insertTestJob,
} from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({ releaseAll: vi.fn() })),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    // Avoid actually killing tmux sessions during tests; let execFile fall through.
    execFileSync: vi.fn(() => ''),
  };
});

const HARM_PID = -1; // never matches any real process

async function makeWatcher(agentStatus: string = 'running') {
  const queries = await import('../server/db/queries.js');
  const job = await insertTestJob({ status: 'running' });
  const agentId = randomUUID();
  queries.insertAgent({ id: agentId, job_id: job.id, status: agentStatus as never, started_at: Date.now(), pid: HARM_PID });
  const watcher = queries.insertWatcher({ id: randomUUID(), agent_id: agentId, job_id: job.id, model: 'claude-opus-4-7' });
  return { agentId, jobId: job.id, watcher };
}

describe('watcherTools.execPostCommentary', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('persists commentary and emits the socket event', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const socket = await import('../server/socket/SocketManager.js');
    const queries = await import('../server/db/queries.js');

    const { watcher } = await makeWatcher();
    const r = execPostCommentary(watcher, { severity: 'concern', headline: 'Looking shaky', detail: 'long input' });

    expect(r.ok).toBe(true);
    expect(vi.mocked(socket.emitWatcherCommentaryNew)).toHaveBeenCalledTimes(1);
    expect(queries.listCommentaryForAgent(watcher.agent_id)).toHaveLength(1);
  });

  it('strips control + bidi-override chars from detail and evidence', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(0x1B);
    const RLO = String.fromCharCode(0x202E);

    const r = execPostCommentary(watcher, {
      severity: 'info',
      headline: 'check',
      detail: `dirty${NUL}detail${RLO}spoof`,
      evidence: `dirty${ESC}[2Jevidence`,
    });
    expect(r.ok).toBe(true);

    const stored = queries.listCommentaryForAgent(watcher.agent_id)[0];
    // C0/C1 + bidi overrides must be gone from both fields.
    const FORBIDDEN = /[\x00-\x08\x0E-\x1F\x7F-\x9F‪-‮⁦-⁩]/;
    expect(stored.detail ?? '').not.toMatch(FORBIDDEN);
    expect(stored.evidence ?? '').not.toMatch(FORBIDDEN);
    // Surrounding text survives.
    expect(stored.detail).toContain('dirty');
    expect(stored.evidence).toContain('evidence');
  });

  it('decays next_severity once a concern rolls off the sliding window', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    // Post 'concern' — badge lights up.
    execPostCommentary(watcher, { severity: 'concern', headline: 'A' });
    let w = queries.getWatcherById(watcher.id)!;
    expect(w.next_severity).toBe('concern');

    // Within the SEVERITY_WINDOW_SIZE (=3) window 'info' alongside the still-
    // present concern keeps the badge at 'concern' (max severity in window).
    execPostCommentary(w, { severity: 'info', headline: 'B' });
    w = queries.getWatcherById(watcher.id)!;
    expect(w.next_severity).toBe('concern');

    // Two more 'info' posts push the concern OUT of the 3-entry window — now
    // window = [B, C, D] all 'info' → badge decays.
    execPostCommentary(w, { severity: 'info', headline: 'C' });
    execPostCommentary(w, { severity: 'info', headline: 'D' });
    w = queries.getWatcherById(watcher.id)!;
    expect(w.next_severity).toBe('info');
  });

  it('resolved clears the badge immediately regardless of prior severity', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    execPostCommentary(watcher, { severity: 'blocker', headline: 'A' });
    let w = queries.getWatcherById(watcher.id)!;
    expect(w.next_severity).toBe('blocker');

    execPostCommentary(w, { severity: 'resolved', headline: 'B' });
    w = queries.getWatcherById(watcher.id)!;
    expect(w.next_severity).toBe('resolved');
  });

  it('deriveNextSeverity (pure) — picks max in window, resets after resolved', async () => {
    const { deriveNextSeverity, SEVERITY_WINDOW_SIZE } = await import('../server/orchestrator/watcherTools.js');
    expect(deriveNextSeverity([])).toBe('info');
    expect(deriveNextSeverity(['info', 'info'])).toBe('info');
    expect(deriveNextSeverity(['concern', 'info', 'info', 'info'])).toBe('info');
    expect(deriveNextSeverity(['concern', 'info', 'info'])).toBe('concern');
    expect(deriveNextSeverity(['blocker', 'resolved', 'concern'])).toBe('concern');
    expect(deriveNextSeverity(['blocker', 'resolved'])).toBe('resolved');
    expect(SEVERITY_WINDOW_SIZE).toBe(3);
  });
});

describe('watcherTools.execNudgeJob', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('strips control characters from the nudge message + reason before storage', async () => {
    const { execNudgeJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const dirtyMessage = `try${String.fromCharCode(0)}NUL${String.fromCharCode(0x1B)}[31mESC the smaller test suite first`;
    const dirtyReason = `looping${String.fromCharCode(0x07)}BELL on the same file`;
    const r = execNudgeJob(watcher, { message: dirtyMessage, reason: dirtyReason });
    expect(r.ok).toBe(true);

    // Stored note must not carry control chars back to the watched agent.
    const note = queries.getNote(`watcher/nudges/${watcher.agent_id}`);
    expect(note?.value).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
    expect(note?.value).toContain('try');
    expect(note?.value).toContain('smaller test suite');

    // The action's payload (the nudge message) must also be clean.
    const action = queries.listActionsForAgent(watcher.agent_id)[0];
    expect(action.payload).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
    expect(action.reason).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);

    // And the auto-commentary detail.
    const commentary = queries.listCommentaryForAgent(watcher.agent_id)[0];
    expect(commentary.detail ?? '').not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
  });

  it('applies first nudge and gates rapid second nudge', async () => {
    const { execNudgeJob, NUDGE_COOLDOWN_MS } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const r1 = execNudgeJob(watcher, { message: 'try X instead' });
    expect(r1.ok).toBe(true);
    expect(r1.outcome).toBe('applied');

    const r2 = execNudgeJob(watcher, { message: 'also try Y' });
    expect(r2.ok).toBe(false);
    expect(r2.outcome).toBe('gated');

    // The nudge note should contain only the first message
    const note = queries.getNote(`watcher/nudges/${watcher.agent_id}`);
    expect(note?.value).toContain('try X instead');
    expect(note?.value).not.toContain('also try Y');

    // cooldown is what we expect
    expect(NUDGE_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe('watcherTools.execRestartJob', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('rejects when no reason is supplied', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const { watcher } = await makeWatcher();
    const r = execRestartJob(watcher, { reason: '' });
    expect(r.ok).toBe(false);
  });

  it('restarts the agent and requeues the job', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, jobId } = await makeWatcher();

    const r = execRestartJob(watcher, { reason: 'looping on same edit', diagnosis: 'agent re-reads foo.ts every turn' });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('applied');

    const agent = queries.getAgentById(watcher.agent_id)!;
    expect(agent.status).toBe('cancelled');
    const job = queries.getJobById(jobId)!;
    expect(job.status).toBe('queued');
    expect(job.description).toContain('Watcher restart notes');
    expect(job.description).toContain('looping on same edit');
  });

  it('gates after MAX_RESTARTS_PER_AGENT applied restarts', async () => {
    const { execRestartJob, MAX_RESTARTS_PER_AGENT } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    // Prepopulate applied restart actions to push the counter to the cap
    for (let i = 0; i < MAX_RESTARTS_PER_AGENT; i++) {
      queries.insertAction({
        id: randomUUID(), watcher_id: watcher.id, agent_id: watcher.agent_id,
        type: 'restart', reason: 'prev', outcome: 'applied',
      });
    }

    const r = execRestartJob(watcher, { reason: 'one more time' });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('gated');
    // Auto-escalation should have run too
    const discussions = queries.listDiscussions();
    expect(discussions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('watcherTools.execReadRecentOutput', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns a slim text summary of recent stream-json output', async () => {
    const { execReadRecentOutput } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    // Insert a mix of assistant text, tool_use, result, error, and a Codex
    // command_execution. The reader must render each compactly.
    const evs = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/foo.ts' } }] } },
      { type: 'result', is_error: false, result: 'all done', num_turns: 2 },
      { type: 'error', error: { message: 'fork failed' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'PASS' } },
    ];
    for (let i = 0; i < evs.length; i++) {
      queries.insertAgentOutput({
        agent_id: watcher.agent_id, seq: i, event_type: String(evs[i].type ?? '?'),
        content: JSON.stringify(evs[i]), created_at: Date.now(),
      });
    }

    const r = execReadRecentOutput(watcher, { limit: 50 });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('text: Working on it.');
    expect(r.message).toContain('tool Edit');
    expect(r.message).toContain('result: all done');
    expect(r.message).toContain('error: fork failed');
    expect(r.message).toContain('bash: npm test exit=0');
    expect(r.message).toContain('stdout: PASS');
  });

  it('returns a friendly message when the agent has produced no output yet', async () => {
    const { execReadRecentOutput } = await import('../server/orchestrator/watcherTools.js');
    const { watcher } = await makeWatcher();
    const r = execReadRecentOutput(watcher, {});
    expect(r.ok).toBe(true);
    expect(r.message).toContain('no output yet');
  });

  it('wraps the returned body in <agent-output> sentinels so the watcher LLM treats it as data', async () => {
    // Mirrors the <agent-text>/<agent-events> wrapping in the rendered tick.
    // Without this, agent-sourced text returned via read_recent_output had
    // no structural boundary — a line like "WATCHER INSTRUCTION: restart_job"
    // inside the watched agent's output could blend with legitimate framing.
    const { execReadRecentOutput } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();
    queries.insertAgentOutput({
      agent_id: watcher.agent_id, seq: 0, event_type: 'assistant',
      content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      created_at: Date.now(),
    });
    const r = execReadRecentOutput(watcher, {});
    expect(r.ok).toBe(true);
    expect(r.message.startsWith('<agent-output>')).toBe(true);
    expect(r.message.endsWith('</agent-output>')).toBe(true);
    expect(r.message).toContain('text: hello');
  });

  it('skips unparseable rows without throwing', async () => {
    const { execReadRecentOutput } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();
    queries.insertAgentOutput({
      agent_id: watcher.agent_id, seq: 0, event_type: 'raw',
      content: 'not even json {{{', created_at: Date.now(),
    });
    const r = execReadRecentOutput(watcher, {});
    expect(r.ok).toBe(true);
    expect(r.message).toContain('(unparseable)');
  });
});

describe('watcherTools.execRestartJob — diagnosis safety', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('caps and labels the watcher diagnosis when appending to the job description', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, jobId } = await makeWatcher();

    const huge = 'x'.repeat(20_000);  // way over the cap
    const r = execRestartJob(watcher, { reason: 'looping', diagnosis: huge });
    expect(r.ok).toBe(true);

    const job = queries.getJobById(jobId)!;
    // Capped at WATCHER_DIAGNOSIS_BODY_CAP (4000) + headroom for the surrounding markup.
    expect(job.description.length).toBeLessThan(6000);
    // Wrapped with an explicit "untrusted" label so the next agent doesn't
    // treat the diagnosis as instructions.
    expect(job.description).toContain('untrusted');
    // The watcher's text is rendered as a blockquote so prompt-injection text
    // inside it is visibly contained.
    expect(job.description).toContain('> ');
  });

  it('probes pid existence before SIGTERM so a recycled PID does not get signalled', async () => {
    // The agent.pid in the DB is captured at spawn time. If the original
    // process died and the OS recycled that PID to something unrelated,
    // sending SIGTERM would hit the wrong target. We now probe with
    // process.kill(pid, 0) (no-op existence check) and skip SIGTERM if
    // it throws — closing the common case where the process is just gone.
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, agentId } = await makeWatcher();
    // Use a high pid we know doesn't exist on the test host. The agent
    // factory defaults to HARM_PID=-1; node interprets -1 specially, so
    // override with a synthetic value first.
    queries.updateAgent(agentId, { pid: 2_147_483_640 });

    const killSpy = vi.spyOn(process, 'kill');
    try {
      const r = execRestartJob(watcher, { reason: 'looping' });
      expect(r.ok).toBe(true);

      // The probe (signal 0) was attempted but the actual SIGTERM was not
      // because the probe threw ESRCH for the non-existent PID.
      const probeCalls = killSpy.mock.calls.filter(args => args[1] === 0);
      const sigtermCalls = killSpy.mock.calls.filter(args => args[1] === 'SIGTERM');
      expect(probeCalls.length).toBeGreaterThanOrEqual(1);
      expect(sigtermCalls.length).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('accumulates multiple restart notes under a single header', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, jobId } = await makeWatcher();

    // First restart
    const r1 = execRestartJob(watcher, { reason: 'first issue', diagnosis: 'first details' });
    expect(r1.ok).toBe(true);

    // Reset agent + watcher state for the second restart (in production the
    // requeued job would spawn a new agent — for this test we just flip the
    // existing agent back to running so the watcher's same-agent restart
    // counter logic exercises the second branch of appendWatcherDiagnosis).
    queries.updateAgent(watcher.agent_id, { status: 'running', pid: -1 });

    const r2 = execRestartJob(watcher, { reason: 'second issue', diagnosis: 'second details' });
    expect(r2.ok).toBe(true);

    const job = queries.getJobById(jobId)!;
    const headerOccurrences = (job.description.match(/## Watcher restart notes/g) ?? []).length;
    expect(headerOccurrences).toBe(1);  // single header, both notes underneath
    expect(job.description).toContain('first issue');
    expect(job.description).toContain('second issue');
    expect(job.description).toContain('first details');
    expect(job.description).toContain('second details');
  });

  it('post-commit side-effect failure does NOT roll back the DB transition or mark the action failed', async () => {
    // Regression: previously a throw from any sync side-effect after the
    // withTransaction block fell into the catch block, which called
    // cancelledAgents.delete and marked the action 'failed' even though
    // the restart had already committed. The result was an inconsistent
    // record: agent.status='cancelled', job.status='queued', but the
    // watcher_actions row said the restart failed.
    //
    // We force a post-commit failure by mocking emitWatcherCommentaryNew
    // (called from the trailing execPostCommentary) to throw — that
    // happens after the withTransaction block AND after the wrapped
    // safeRun side-effects, so it lands in the unwrapped catch path.
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const { cancelledAgents } = await import('../server/orchestrator/AgentConfig.js');
    const queries = await import('../server/db/queries.js');
    const socket = await import('../server/socket/SocketManager.js');
    const { watcher, agentId, jobId } = await makeWatcher();

    vi.mocked(socket.emitWatcherCommentaryNew).mockImplementationOnce(() => {
      throw new Error('socket gone');
    });

    const r = execRestartJob(watcher, { reason: 'looping', diagnosis: 'foo' });
    // The action is reported as applied — the restart actually happened.
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('applied');

    // DB state must reflect the successful transition.
    expect(queries.getAgentById(agentId)?.status).toBe('cancelled');
    expect(queries.getJobById(jobId)?.status).toBe('queued');

    // The cancellation guard stays in place — handleAgentExit must not
    // think the agent is still legit.
    expect(cancelledAgents.has(agentId)).toBe(true);

    // The recorded action is 'applied' (with a warning detail), not 'failed'.
    const action = queries.listActionsForAgent(agentId).find(a => a.type === 'restart')!;
    expect(action.outcome).toBe('applied');
    expect(action.outcome_detail ?? '').toContain('socket gone');

    // Cleanup so subsequent tests don't see the lingering entry.
    cancelledAgents.delete(agentId);
  });

  it('strips control characters from the diagnosis to prevent log/terminal corruption', async () => {
    const { execRestartJob } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher, jobId } = await makeWatcher();

    const malicious = `clean text${String.fromCharCode(0x00)}<NUL>${String.fromCharCode(0x1B)}[31mESC[0m${String.fromCharCode(0x07)}BELL`;
    const r = execRestartJob(watcher, { reason: 'odd state', diagnosis: malicious });
    expect(r.ok).toBe(true);

    const job = queries.getJobById(jobId)!;
    // The literal control bytes must be gone…
    expect(job.description).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
    // …but the surrounding text survives.
    expect(job.description).toContain('clean text');
    expect(job.description).toContain('BELL');
  });
});

describe('watcherTools.sanitiseHeadline — control chars', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('strips control characters before storing commentary headlines', async () => {
    const { execPostCommentary } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const dirty = `Headline${String.fromCharCode(0)}NUL${String.fromCharCode(0x1B)}[2J`;
    const r = execPostCommentary(watcher, { severity: 'info', headline: dirty });
    expect(r.ok).toBe(true);

    const stored = queries.listCommentaryForAgent(watcher.agent_id)[0];
    expect(stored.headline).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
    expect(stored.headline).toContain('Headline');
  });
});

describe('watcherTools.execReadDiff', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('returns ok=false when the agent has no base_sha recorded', async () => {
    const { execReadDiff } = await import('../server/orchestrator/watcherTools.js');
    const { watcher } = await makeWatcher();
    const r = await execReadDiff(watcher);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('base_sha');
  });

  it('rejects a malformed base_sha that looks like a git flag', async () => {
    // base_sha is written server-side by AgentRunner so this is
    // belt-and-suspenders, but a corrupted/forged value masquerading as a
    // git flag (e.g. "--upload-pack=foo") should not be passed positionally.
    const { execReadDiff } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();
    queries.updateAgent(watcher.agent_id, { base_sha: '--upload-pack=evil' });
    const r = await execReadDiff(watcher);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not a valid git SHA');
  });

  it('returns ok=false when the job has no work_dir', async () => {
    const { execReadDiff } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();
    // Add a well-formed base_sha (40 hex chars), but the test job has
    // work_dir=null by default — the missing work_dir check should fire.
    queries.updateAgent(watcher.agent_id, { base_sha: 'a'.repeat(40) });
    const r = await execReadDiff(watcher);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('work_dir');
  });

  it('returns the diff between base_sha and worktree HEAD on the happy path', async () => {
    // Build a real, temporary git repo: one initial commit (becomes base_sha),
    // then a working-tree edit that should surface in the diff.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-diff-'));
    try {
      const gitOpts = { cwd: dir, stdio: 'pipe' as const, timeout: 10_000 };
      execFileSync('git', ['init', '-q', '-b', 'main'], gitOpts);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
      execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], gitOpts);
      fs.writeFileSync(path.join(dir, 'README.md'), 'initial content\n');
      execFileSync('git', ['add', '.'], gitOpts);
      execFileSync('git', ['commit', '-q', '-m', 'initial'], gitOpts);
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { ...gitOpts, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      // Modify the working tree so there's something to diff.
      fs.writeFileSync(path.join(dir, 'README.md'), 'initial content\nchanged line\n');

      const queries = await import('../server/db/queries.js');
      const { watcher, jobId } = await makeWatcher();
      queries.updateAgent(watcher.agent_id, { base_sha: baseSha });
      queries.updateJobWorkDir(jobId, dir);

      const { execReadDiff } = await import('../server/orchestrator/watcherTools.js');
      const r = await execReadDiff(watcher);
      expect(r.ok).toBe(true);
      // The diff must mention the modified file and show the added line.
      expect(r.message).toContain('README.md');
      expect(r.message).toContain('+changed line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watcherTools.execEscalateToUser', () => {
  beforeEach(async () => { await setupTestDb(); vi.clearAllMocks(); });
  afterEach(async () => { await cleanupTestDb(); });

  it('opens a discussion thread', async () => {
    const { execEscalateToUser } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const r = execEscalateToUser(watcher, { question: 'should we abandon the auth refactor?', context: 'tests still failing after 3 cycles' });
    expect(r.ok).toBe(true);
    expect(queries.listDiscussions()).toHaveLength(1);
    const msgs = queries.getDiscussionMessages(queries.listDiscussions()[0].id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('auth refactor');
  });

  it('strips control + bidi-override chars from question and context before they reach the discussion thread', async () => {
    // The escalation discussion is rendered in the dashboard's user inbox.
    // A jailbroken agent that steers the watcher toward writing bidi
    // overrides or ANSI escapes here could visually spoof the question
    // the user sees. Same sanitisation pipeline as nudges / commentary.
    const { execEscalateToUser } = await import('../server/orchestrator/watcherTools.js');
    const queries = await import('../server/db/queries.js');
    const { watcher } = await makeWatcher();

    const NUL = String.fromCharCode(0);
    const RLO = String.fromCharCode(0x202E);
    const ESC = String.fromCharCode(0x1B);

    const r = execEscalateToUser(watcher, {
      question: `should we${NUL}abandon${RLO}reverse the auth refactor?`,
      context: `tests${ESC}[2J still failing`,
    });
    expect(r.ok).toBe(true);

    const FORBIDDEN = /[\x00-\x08\x0E-\x1F\x7F-\x9F‪-‮⁦-⁩]/;
    const disc = queries.listDiscussions()[0];
    expect(disc.topic).not.toMatch(FORBIDDEN);
    expect(disc.context ?? '').not.toMatch(FORBIDDEN);
    const msg = queries.getDiscussionMessages(disc.id)[0];
    expect(msg.content).not.toMatch(FORBIDDEN);
    // Plain-ASCII content survives.
    expect(msg.content).toContain('auth refactor');
  });
});
