/**
 * Tests for AgentPrUrlCapture (M4).
 *
 * Covers the pure helpers (extractGithubPullUrls, parseOwnerRepoFromOriginUrl,
 * validateAgentCreatedPrUrl, findAgentCreatedPrUrl) plus the captureAgentCreatedPrUrl
 * wrapper. All git / gh calls are stubbed via the `exec` dependency-injection seam;
 * agent output is fed in via the `listOutputsForLatestImplementer` seam so the
 * tests don't need a real DB.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  extractGithubPullUrls,
  parseOwnerRepoFromOriginUrl,
  validateAgentCreatedPrUrl,
  findAgentCreatedPrUrl,
  captureAgentCreatedPrUrl,
  getWorkflowOriginOwnerRepo,
  type ExecFn,
  type ParsedPrUrl,
} from '../server/orchestrator/AgentPrUrlCapture.js';
import type { Workflow } from '../shared/types.js';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test',
    title: 'Test Workflow',
    task: 'test',
    work_dir: '/tmp/work',
    implementer_model: 'claude',
    reviewer_model: 'codex',
    max_cycles: 5,
    current_cycle: 1,
    current_phase: 'implement',
    status: 'running',
    milestones_total: 1,
    milestones_done: 1,
    project_id: null,
    max_turns_assess: 50,
    max_turns_review: 30,
    max_turns_implement: 100,
    stop_mode_assess: 'turns',
    stop_value_assess: null,
    stop_mode_review: 'turns',
    stop_value_review: null,
    stop_mode_implement: 'turns',
    stop_value_implement: null,
    template_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/work/.wt/wf-test',
    worktree_branch: 'workflow/feat-x',
    blocked_reason: null,
    pr_url: null,
    completion_threshold: 1,
    start_command: null,
    max_verify_retries: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('extractGithubPullUrls', () => {
  it('extracts a single URL from prose', () => {
    const text = 'I opened https://github.com/myorg/myrepo/pull/42 and it looks good.';
    expect(extractGithubPullUrls(text)).toEqual([
      { url: 'https://github.com/myorg/myrepo/pull/42', owner: 'myorg', repo: 'myrepo', number: 42 },
    ]);
  });

  it('extracts multiple URLs and dedupes', () => {
    const text = `
      opened https://github.com/a/b/pull/1
      and https://github.com/c/d/pull/2
      and https://github.com/a/b/pull/1 again
    `;
    const got = extractGithubPullUrls(text);
    expect(got.map(p => p.url)).toEqual([
      'https://github.com/a/b/pull/1',
      'https://github.com/c/d/pull/2',
    ]);
  });

  it('strips trailing .git from repo slug', () => {
    const text = 'see https://github.com/o/r.git/pull/3';
    const got = extractGithubPullUrls(text);
    expect(got).toHaveLength(1);
    expect(got[0].repo).toBe('r');
  });

  it('returns empty array for empty or non-matching text', () => {
    expect(extractGithubPullUrls('')).toEqual([]);
    expect(extractGithubPullUrls('no URLs here')).toEqual([]);
    expect(extractGithubPullUrls('https://gitlab.com/x/y/pull/1')).toEqual([]);
  });
});

describe('parseOwnerRepoFromOriginUrl', () => {
  it('parses https URLs with and without .git', () => {
    expect(parseOwnerRepoFromOriginUrl('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseOwnerRepoFromOriginUrl('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseOwnerRepoFromOriginUrl('https://github.com/o/r/')).toEqual({ owner: 'o', repo: 'r' });
  });

  it('parses git@github.com:owner/repo form', () => {
    expect(parseOwnerRepoFromOriginUrl('git@github.com:myorg/myrepo.git')).toEqual({ owner: 'myorg', repo: 'myrepo' });
    expect(parseOwnerRepoFromOriginUrl('git@github.com:myorg/myrepo')).toEqual({ owner: 'myorg', repo: 'myrepo' });
  });

  it('parses ssh:// URLs', () => {
    expect(parseOwnerRepoFromOriginUrl('ssh://git@github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
  });

  it('returns null for unrecognized forms', () => {
    expect(parseOwnerRepoFromOriginUrl('https://gitlab.com/o/r.git')).toBeNull();
    expect(parseOwnerRepoFromOriginUrl('random string')).toBeNull();
  });
});

describe('getWorkflowOriginOwnerRepo', () => {
  it('reads `git remote get-url origin` from the worktree', () => {
    const exec: ExecFn = (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return 'git@github.com:openclaw/autodev.git\n';
    };
    expect(getWorkflowOriginOwnerRepo(makeWorkflow(), exec)).toEqual({ owner: 'openclaw', repo: 'autodev' });
  });

  it('returns null when worktree_path is missing', () => {
    expect(getWorkflowOriginOwnerRepo(makeWorkflow({ worktree_path: null }))).toBeNull();
  });

  it('returns null when origin url is unparseable', () => {
    const exec: ExecFn = () => 'not-a-url';
    expect(getWorkflowOriginOwnerRepo(makeWorkflow(), exec)).toBeNull();
  });
});

describe('validateAgentCreatedPrUrl', () => {
  const candidate: ParsedPrUrl = {
    url: 'https://github.com/openclaw/autodev/pull/42',
    owner: 'openclaw',
    repo: 'autodev',
    number: 42,
  };

  function execStub(prJson: object | null, opts: { originUrl?: string; ghThrows?: boolean } = {}): ExecFn {
    return (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return opts.originUrl ?? 'https://github.com/openclaw/autodev.git';
      }
      if (cmd === 'gh' && args[0] === 'pr') {
        if (opts.ghThrows) throw new Error('gh authentication required');
        return JSON.stringify(prJson);
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    };
  }

  it('returns ok=true when state is OPEN and headRefName matches', () => {
    const exec = execStub({
      url: candidate.url,
      state: 'OPEN',
      headRefName: 'workflow/feat-x',
      headRepository: { owner: { login: 'openclaw' } },
    });
    const got = validateAgentCreatedPrUrl(makeWorkflow(), candidate, { exec });
    expect(got.ok).toBe(true);
  });

  it('rejects MERGED PRs (M5: brief requires open PR)', () => {
    const exec = execStub({ url: candidate.url, state: 'MERGED', headRefName: 'workflow/feat-x' });
    const got = validateAgentCreatedPrUrl(makeWorkflow(), candidate, { exec });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/MERGED/);
  });

  it('rejects CLOSED PRs', () => {
    const exec = execStub({ url: candidate.url, state: 'CLOSED', headRefName: 'workflow/feat-x' });
    const got = validateAgentCreatedPrUrl(makeWorkflow(), candidate, { exec });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/CLOSED/);
  });

  it('rejects URLs from a different repo', () => {
    const exec = execStub(null);
    const other: ParsedPrUrl = { ...candidate, owner: 'someoneelse', url: 'https://github.com/someoneelse/autodev/pull/42' };
    const got = validateAgentCreatedPrUrl(makeWorkflow(), other, { exec });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/does not match workflow origin/);
  });

  it('rejects when PR head ref does not match workflow branch', () => {
    const exec = execStub({ url: candidate.url, state: 'OPEN', headRefName: 'some-other-branch' });
    const got = validateAgentCreatedPrUrl(makeWorkflow(), candidate, { exec });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/head ref/);
  });

  it('rejects when gh pr view fails', () => {
    const exec = execStub(null, { ghThrows: true });
    const got = validateAgentCreatedPrUrl(makeWorkflow(), candidate, { exec });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toMatch(/gh pr view failed/);
  });

  it('rejects when workflow has no worktree_branch', () => {
    const got = validateAgentCreatedPrUrl(makeWorkflow({ worktree_branch: null }), candidate);
    expect(got.ok).toBe(false);
  });
});

describe('findAgentCreatedPrUrl', () => {
  it('returns the matching URL when output contains one matching + one mismatched repo', () => {
    const outputs = [
      // stream-json assistant text containing a wrong-repo URL
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'I looked at https://github.com/somebody/somerepo/pull/9 first.' }] },
      }),
      // final result containing the correct URL
      JSON.stringify({
        type: 'result',
        result: 'Done — PR is at https://github.com/openclaw/autodev/pull/42',
      }),
      // a malformed stream-json row (raw text) — should still be scanned
      'malformed: but mentions https://github.com/openclaw/autodev/pull/99 for completeness',
    ];

    const exec: ExecFn = (cmd, args) => {
      if (cmd === 'git') return 'git@github.com:openclaw/autodev.git';
      if (cmd === 'gh') {
        // The number being viewed is args[2].
        const n = args[2];
        if (n === '9') return JSON.stringify({ state: 'OPEN', headRefName: 'workflow/feat-x' });
        if (n === '42') return JSON.stringify({ state: 'OPEN', headRefName: 'workflow/feat-x' });
        if (n === '99') return JSON.stringify({ state: 'OPEN', headRefName: 'totally-different-branch' });
        throw new Error('unexpected pr number');
      }
      throw new Error('unexpected exec');
    };

    const got = findAgentCreatedPrUrl(makeWorkflow(), {
      exec,
      listOutputsForLatestImplementer: () => outputs,
    });
    // The /9 URL is filtered out by repo mismatch (different owner/repo).
    // The /42 URL validates successfully → returned first.
    expect(got?.url).toBe('https://github.com/openclaw/autodev/pull/42');
  });

  it('returns null when no candidate validates', () => {
    const outputs = ['mentions https://github.com/openclaw/autodev/pull/77 but wrong head ref'];
    const exec: ExecFn = (cmd) => {
      if (cmd === 'git') return 'git@github.com:openclaw/autodev.git';
      return JSON.stringify({ state: 'OPEN', headRefName: 'not-our-branch' });
    };
    const got = findAgentCreatedPrUrl(makeWorkflow(), { exec, listOutputsForLatestImplementer: () => outputs });
    expect(got).toBeNull();
  });

  it('returns null when output is empty', () => {
    const got = findAgentCreatedPrUrl(makeWorkflow(), {
      exec: () => '',
      listOutputsForLatestImplementer: () => [],
    });
    expect(got).toBeNull();
  });
});

describe('defaultListOutputsForLatestImplementer (M5)', () => {
  // When two implementer agents exist for the same workflow_cycle (e.g. a
  // first agent that fell over and a retry that actually opened the PR), the
  // default lister must pick the most recent done agent by finished_at rather
  // than returning the first job's first agent. We exercise this via the
  // public `findAgentCreatedPrUrl` entry point, mocking the queries module so
  // we don't need a real DB.
  it('selects the most recent done implementer agent across same-cycle retries', async () => {
    vi.resetModules();
    vi.doMock('../server/db/queries.js', () => ({
      getJobsForWorkflow: (_id: string) => ([
        // Two implement jobs, same workflow_cycle (e.g. a retry of cycle 1).
        { id: 'job-old', workflow_phase: 'implement', status: 'done', workflow_cycle: 1 },
        { id: 'job-new', workflow_phase: 'implement', status: 'done', workflow_cycle: 1 },
        // An assess job that should be ignored entirely.
        { id: 'job-assess', workflow_phase: 'assess', status: 'done', workflow_cycle: 1 },
      ]),
      listAgents: () => ([
        { id: 'agent-old', job_id: 'job-old', status: 'done', finished_at: 1000 },
        { id: 'agent-new', job_id: 'job-new', status: 'done', finished_at: 2000 },
        { id: 'agent-assess', job_id: 'job-assess', status: 'done', finished_at: 3000 },
      ]),
      getAgentOutput: (agentId: string) => {
        if (agentId === 'agent-old') return [{ content: 'older implementer never opened a PR' }];
        if (agentId === 'agent-new') {
          return [{ content: 'newer implementer opened https://github.com/openclaw/autodev/pull/42' }];
        }
        return [];
      },
      updateWorkflow: () => undefined,
    }));
    const mod = await import('../server/orchestrator/AgentPrUrlCapture.js');
    const exec: ExecFn = (cmd) => {
      if (cmd === 'git') return 'git@github.com:openclaw/autodev.git';
      return JSON.stringify({ state: 'OPEN', headRefName: 'workflow/feat-x' });
    };
    const got = mod.findAgentCreatedPrUrl(makeWorkflow(), { exec });
    expect(got?.url).toBe('https://github.com/openclaw/autodev/pull/42');
    vi.doUnmock('../server/db/queries.js');
  });
});

describe('captureAgentCreatedPrUrl', () => {
  it('stores the validated URL via updateAndEmit', () => {
    const updateAndEmit = vi.fn();
    const exec: ExecFn = (cmd) => {
      if (cmd === 'git') return 'https://github.com/openclaw/autodev.git';
      return JSON.stringify({ state: 'OPEN', headRefName: 'workflow/feat-x' });
    };
    const res = captureAgentCreatedPrUrl(makeWorkflow(), {
      exec,
      listOutputsForLatestImplementer: () => [
        'agent finished: https://github.com/openclaw/autodev/pull/42 created',
      ],
      updateAndEmit,
    });
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.url).toBe('https://github.com/openclaw/autodev/pull/42');
      expect(res.stored).toBe(true);
    }
    expect(updateAndEmit).toHaveBeenCalledWith('wf-test', { pr_url: 'https://github.com/openclaw/autodev/pull/42' });
  });

  it('does not store when dryRun is true', () => {
    const updateAndEmit = vi.fn();
    const exec: ExecFn = (cmd) => {
      if (cmd === 'git') return 'https://github.com/openclaw/autodev.git';
      return JSON.stringify({ state: 'OPEN', headRefName: 'workflow/feat-x' });
    };
    const res = captureAgentCreatedPrUrl(makeWorkflow(), {
      dryRun: true,
      exec,
      listOutputsForLatestImplementer: () => ['https://github.com/openclaw/autodev/pull/42'],
      updateAndEmit,
    });
    expect(res.found).toBe(true);
    if (res.found) expect(res.stored).toBe(false);
    expect(updateAndEmit).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing pr_url', () => {
    const updateAndEmit = vi.fn();
    const res = captureAgentCreatedPrUrl(
      makeWorkflow({ pr_url: 'https://github.com/x/y/pull/1' }),
      {
        exec: () => '',
        listOutputsForLatestImplementer: () => ['https://github.com/openclaw/autodev/pull/42'],
        updateAndEmit,
      },
    );
    expect(res.found).toBe(false);
    expect(updateAndEmit).not.toHaveBeenCalled();
  });

  it('returns found=false when nothing validates', () => {
    const res = captureAgentCreatedPrUrl(makeWorkflow(), {
      exec: () => 'https://github.com/openclaw/autodev.git',
      listOutputsForLatestImplementer: () => ['no URL here'],
    });
    expect(res.found).toBe(false);
  });
});
