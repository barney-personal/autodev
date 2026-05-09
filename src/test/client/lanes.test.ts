/**
 * Tests for the workflow board lane classification helpers.
 * Pure functions — no DB, no fetch, no React.
 */
import { describe, it, expect } from 'vitest';
import {
  laneFor,
  toneFor,
  repoFor,
  buildRepoTree,
  isLaneVisible,
} from '../../client/components/board/lanes';
import type { Workflow } from '../../shared/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a Workflow with sane defaults for tests; override fields per case. */
function mkW(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'w1',
    title: 'Test workflow',
    task: 'do the thing',
    work_dir: '/Users/x/repos/foo',
    implementer_model: 'claude-opus-4-7',
    reviewer_model: 'codex-gpt-5.5',
    max_cycles: 5,
    current_cycle: 0,
    current_phase: 'idle',
    status: 'running',
    milestones_total: 0,
    milestones_done: 0,
    project_id: null,
    max_turns_assess: 0,
    max_turns_review: 0,
    max_turns_implement: 0,
    stop_mode_assess: 'turns',
    stop_value_assess: null,
    stop_mode_review: 'turns',
    stop_value_review: null,
    stop_mode_implement: 'turns',
    stop_value_implement: null,
    template_id: null,
    use_worktree: 0,
    worktree_path: null,
    worktree_branch: null,
    blocked_reason: null,
    pr_url: null,
    completion_threshold: 0,
    start_command: null,
    max_verify_retries: 0,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  } as Workflow;
}

// ─── laneFor ────────────────────────────────────────────────────────────────

describe('laneFor', () => {
  it('routes blocked → attn', () => {
    expect(laneFor(mkW({ status: 'blocked' }))).toBe('attn');
  });

  it('routes failed → attn', () => {
    expect(laneFor(mkW({ status: 'failed' }))).toBe('attn');
  });

  it('routes complete with PR → pr', () => {
    expect(laneFor(mkW({ status: 'complete', pr_url: 'https://github.com/x/y/pull/1' }))).toBe('pr');
  });

  it('routes complete without PR → done', () => {
    expect(laneFor(mkW({ status: 'complete', pr_url: null }))).toBe('done');
  });

  it('routes cancelled → done', () => {
    expect(laneFor(mkW({ status: 'cancelled' }))).toBe('done');
  });

  it('routes running with PR + verify phase → pr', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_phase: 'verify',
      pr_url: 'https://github.com/x/y/pull/1',
      current_cycle: 3,
    }))).toBe('pr');
  });

  it('keeps running with PR + implement phase in flight (mid-iteration draft PR)', () => {
    // Regression: a draft PR opened mid-implement should NOT pre-emptively
    // claim the In Review lane while the run is still iterating.
    expect(laneFor(mkW({
      status: 'running',
      current_phase: 'implement',
      pr_url: 'https://github.com/x/y/pull/1',
      current_cycle: 3,
    }))).toBe('flight');
  });

  it('keeps running with PR + review phase in flight', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_phase: 'review',
      pr_url: 'https://github.com/x/y/pull/1',
      current_cycle: 3,
    }))).toBe('flight');
  });

  it('routes triage when cycle 0, no milestones, idle phase', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_cycle: 0,
      current_phase: 'idle',
      milestones_total: 0,
    }))).toBe('triage');
  });

  it('routes triage when cycle 0, no milestones, assess phase', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_cycle: 0,
      current_phase: 'assess',
      milestones_total: 0,
    }))).toBe('triage');
  });

  it('leaves triage once milestones exist (assess produced a plan)', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_cycle: 0,
      current_phase: 'assess',
      milestones_total: 5,
    }))).toBe('flight');
  });

  it('leaves triage once cycle advances', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_cycle: 1,
      current_phase: 'implement',
      milestones_total: 0,
    }))).toBe('flight');
  });

  it('default running case → flight', () => {
    expect(laneFor(mkW({
      status: 'running',
      current_cycle: 2,
      current_phase: 'implement',
      milestones_total: 5,
      milestones_done: 1,
    }))).toBe('flight');
  });
});

// ─── toneFor ────────────────────────────────────────────────────────────────

describe('toneFor', () => {
  it('blocked override beats lane', () => {
    expect(toneFor('flight', true)).toBe('attn');
  });

  it('flight → active', () => {
    expect(toneFor('flight', false)).toBe('active');
  });

  it('attn → attn', () => {
    expect(toneFor('attn', false)).toBe('attn');
  });

  it('pr → pr', () => {
    expect(toneFor('pr', false)).toBe('pr');
  });

  it('done → done', () => {
    expect(toneFor('done', false)).toBe('done');
  });

  it('triage → idle', () => {
    expect(toneFor('triage', false)).toBe('idle');
  });
});

// ─── repoFor ────────────────────────────────────────────────────────────────

describe('repoFor', () => {
  it('extracts trailing dir from absolute work_dir', () => {
    expect(repoFor(mkW({ work_dir: '/Users/cleo/repos/poker-engine' }))).toBe('poker-engine');
  });

  it('handles trailing slash', () => {
    expect(repoFor(mkW({ work_dir: '/Users/cleo/repos/poker-engine/' }))).toBe('poker-engine');
  });

  it('handles single-segment path', () => {
    expect(repoFor(mkW({ work_dir: 'foo' }))).toBe('foo');
  });

  it('returns "unknown" for null work_dir', () => {
    expect(repoFor(mkW({ work_dir: null }))).toBe('unknown');
  });

  it('returns "unknown" for empty string work_dir', () => {
    expect(repoFor(mkW({ work_dir: '' }))).toBe('unknown');
  });

  it('does not include parent dirs', () => {
    // Sanity check — the rail buckets by basename; "/repos/foo" and "/work/foo"
    // should both group under "foo".
    expect(repoFor(mkW({ work_dir: '/a/b/foo' }))).toBe('foo');
    expect(repoFor(mkW({ work_dir: '/x/y/foo' }))).toBe('foo');
  });
});

// ─── buildRepoTree ──────────────────────────────────────────────────────────

describe('buildRepoTree', () => {
  it('returns empty array for no workflows', () => {
    expect(buildRepoTree([])).toEqual([]);
  });

  it('groups workflows by repo basename', () => {
    const tree = buildRepoTree([
      mkW({ id: 'a', work_dir: '/x/repos/poker', updated_at: 100 }),
      mkW({ id: 'b', work_dir: '/x/repos/poker', updated_at: 200 }),
      mkW({ id: 'c', work_dir: '/x/repos/api',   updated_at: 300 }),
    ]);
    expect(tree.map(g => g.repo)).toEqual(['api', 'poker']);
    expect(tree.find(g => g.repo === 'poker')!.items.map(w => w.id)).toEqual(['b', 'a']); // sorted desc
    expect(tree.find(g => g.repo === 'api')!.items.map(w => w.id)).toEqual(['c']);
  });

  it('sorts groups by most-recent activity (latest updated_at) desc', () => {
    const tree = buildRepoTree([
      mkW({ id: 'old',   work_dir: '/x/repos/old',   updated_at: 100 }),
      mkW({ id: 'fresh', work_dir: '/x/repos/fresh', updated_at: 1_000_000 }),
      mkW({ id: 'mid',   work_dir: '/x/repos/mid',   updated_at: 5_000 }),
    ]);
    expect(tree.map(g => g.repo)).toEqual(['fresh', 'mid', 'old']);
    expect(tree[0].latest).toBe(1_000_000);
    expect(tree[2].latest).toBe(100);
  });

  it('groups null work_dir under "unknown"', () => {
    const tree = buildRepoTree([
      mkW({ id: 'a', work_dir: null }),
      mkW({ id: 'b', work_dir: null }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].repo).toBe('unknown');
    expect(tree[0].items).toHaveLength(2);
  });
});

// ─── isLaneVisible ──────────────────────────────────────────────────────────

describe('isLaneVisible', () => {
  // After moving the time-window filter up to App.tsx, isLaneVisible is now a
  // stable no-op hook. The contract is: it must always return true. These tests
  // are here so a future per-lane filter can't silently drop visibility for
  // existing lanes without us noticing.
  it('returns true for every lane', () => {
    const w = mkW({});
    const now = Date.now();
    for (const lane of ['triage', 'flight', 'attn', 'pr', 'done'] as const) {
      expect(isLaneVisible(w, lane, now)).toBe(true);
    }
  });
});
