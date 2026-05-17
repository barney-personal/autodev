/**
 * M1 — failing integration test for the wrap-up "no commits on branch"
 * false-negative bug that lost work on the three polymarket-agent workflows
 * (`714c07ad`, `112c728c`, `c8cace7d`) on 2026-05-17.
 *
 * Bug summary (see docs/wrap-up-flow.md):
 *   `countBranchCommits` only tries `origin/<default-branch>` and `origin/HEAD`
 *   as base refs. When neither is resolvable (a `git worktree add` setup that
 *   never ran `git remote set-head origin --auto`), it returns 0 — treating
 *   unverifiable remote metadata as a verified empty branch. `pushAndCreatePr`
 *   then logs `"no commits on branch — skipping PR"` and `finalizeWorkflow`
 *   deletes the worktree, stranding real local commits.
 *
 * Fixture shape (per brief A.2):
 *   - bare origin
 *   - working clone with `main` pushed to origin (so `origin/main` exists)
 *   - workflow branch with 3 commits added in a worktree
 *   - `main` advances by 2 more commits on origin (concurrent merge simulation)
 *   - `origin/HEAD` symbolic ref NOT set, and `refs/remotes/origin/HEAD` packed-ref
 *     absent — so `getRemoteDefaultBranch` fails AND `rev-parse origin/HEAD` fails
 *
 * Under current code, `countBranchCommits` returns 0 even though the workflow
 * branch has 3 publishable commits. After M2, the function (or its successor)
 * must fall back to `origin/main`/`origin/master`/merge-base so it returns the
 * true count and the worktree is preserved.
 *
 * These assertions are expected to FAIL against current code (`HEAD~1` for the
 * docs commit). After M2 lands they must pass.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync as realExecFileSync, execSync as realExecSync } from 'child_process';

import {
  countBranchCommits,
  getPrCreationOutcome,
} from '../server/orchestrator/WorkflowPRCreator.js';
import { quarantineWorktree } from '../server/orchestrator/WorkflowWorktreeManager.js';
import type { Workflow } from '../shared/types.js';

interface Fixture {
  rootDir: string;
  originDir: string;
  workDir: string;
  worktreePath: string;
  branch: string;
  cleanup: () => void;
}

function buildFixture(): Fixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'no-commits-falseneg-'));
  const originDir = path.join(rootDir, 'origin.git');
  const workDir = path.join(rootDir, 'work');
  const branch = `workflow/falseneg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreePath = path.join(rootDir, 'worktrees', branch.replace(/\//g, '-'));

  const run = (cmd: string, cwd: string) => {
    realExecSync(cmd, { cwd, stdio: 'pipe', timeout: 15000 });
  };

  realExecSync(`git init --bare ${JSON.stringify(originDir)}`, { stdio: 'pipe', timeout: 10000 });

  realExecSync(`git init ${JSON.stringify(workDir)}`, { stdio: 'pipe', timeout: 10000 });
  run('git config user.email "falseneg-test@example.com"', workDir);
  run('git config user.name "Falseneg Test"', workDir);
  run('git config commit.gpgsign false', workDir);
  run(`git remote add origin ${JSON.stringify(originDir)}`, workDir);

  writeFileSync(path.join(workDir, 'README.md'), '# falseneg test fixture\n');
  run('git checkout -b main', workDir);
  run('git add README.md', workDir);
  run('git commit -m "initial"', workDir);
  run('git push -u origin main', workDir);

  // Workflow branch with 3 real commits inside the worktree.
  realExecSync(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)}`,
    { cwd: workDir, stdio: 'pipe', timeout: 15000 },
  );
  run('git config user.email "falseneg-test@example.com"', worktreePath);
  run('git config user.name "Falseneg Test"', worktreePath);
  run('git config commit.gpgsign false', worktreePath);
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(worktreePath, `branch-${i + 1}.txt`), `branch work ${i + 1}\n`);
    run(`git add branch-${i + 1}.txt`, worktreePath);
    run(`git commit -m "branch commit ${i + 1}"`, worktreePath);
  }

  // Advance main on origin by 2 commits (concurrent merges during the workflow).
  for (let i = 0; i < 2; i++) {
    writeFileSync(path.join(workDir, `main-${i + 1}.txt`), `main progress ${i + 1}\n`);
    run(`git add main-${i + 1}.txt`, workDir);
    run(`git commit -m "main commit ${i + 1}"`, workDir);
  }
  run('git push origin main', workDir);

  // Make origin/HEAD unresolvable from inside the worktree, while keeping
  // origin/main as a real remote ref. This reproduces the production setup
  // where `git worktree add` never ran `git remote set-head origin --auto`.
  //
  //  - delete the symbolic-ref form
  //  - delete the packed-ref / loose ref form
  // After this, both `git symbolic-ref refs/remotes/origin/HEAD` and
  // `git rev-parse --verify origin/HEAD` fail, while `origin/main` resolves.
  try {
    realExecSync('git symbolic-ref --delete refs/remotes/origin/HEAD', {
      cwd: worktreePath, stdio: 'pipe', timeout: 5000,
    });
  } catch { /* ref may not exist as a symbolic-ref */ }
  // Belt-and-braces: fetch with --prune does not remove origin/HEAD on its
  // own; explicitly remove any loose ref file in the shared git dir.
  const gitDir = realExecFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }).toString().trim();
  const headRefPath = path.join(gitDir, 'refs', 'remotes', 'origin', 'HEAD');
  try { rmSync(headRefPath, { force: true }); } catch { /* best-effort */ }

  // Sanity: verify the fixture is in the exact state the bug needs.
  let symbolicRefOk = false;
  try {
    realExecFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    symbolicRefOk = true;
  } catch { /* expected to fail */ }
  if (symbolicRefOk) {
    throw new Error('fixture setup: origin/HEAD symbolic-ref still resolves; bug cannot be reproduced');
  }
  let originHeadRevParseOk = false;
  try {
    realExecFileSync('git', ['rev-parse', '--verify', 'origin/HEAD'], {
      cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    originHeadRevParseOk = true;
  } catch { /* expected to fail */ }
  if (originHeadRevParseOk) {
    throw new Error('fixture setup: origin/HEAD still resolves via rev-parse; bug cannot be reproduced');
  }
  // origin/main must still resolve — that is what the fix will fall back to.
  realExecFileSync('git', ['rev-parse', '--verify', 'origin/main'], {
    cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });

  return {
    rootDir,
    originDir,
    workDir,
    worktreePath,
    branch,
    cleanup: () => {
      try { rmSync(rootDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    },
  };
}

function makeWorkflow(fx: Fixture): Workflow {
  return {
    id: 'wf-falseneg-test',
    title: 'falseneg',
    task: 't',
    work_dir: fx.workDir,
    worktree_path: fx.worktreePath,
    worktree_branch: fx.branch,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'codex',
    current_cycle: 1,
    max_cycles: 10,
    current_phase: 'implement',
    status: 'running',
    milestones_total: 1,
    milestones_done: 1,
    project_id: null,
    use_worktree: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  } as unknown as Workflow;
}

describe('wrap-up no-commits false-negative (M1)', () => {
  let fx: Fixture;

  beforeAll(() => {
    // Sanity: a real git binary must be available; otherwise these tests are
    // a waste of time. We don't gate on it — the fixture setup will fail loudly
    // if `git` is missing.
  });

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    fx?.cleanup();
  });

  it('countBranchCommits must not return 0 when origin/HEAD is missing but the branch has real commits ahead of origin/main', () => {
    // The branch has 3 commits on top of the merge-base with main; the fix
    // must surface at least those 3, regardless of how far main has moved.
    expect(existsSync(fx.worktreePath)).toBe(true);
    const count = countBranchCommits(fx.worktreePath);
    // Currently, this is 0 (the bug). After M2 the fallback chain must
    // resolve origin/main (or local main) and report >= 3.
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('getPrCreationOutcome must NOT report no_publishable_commits when origin/HEAD is missing but the branch has real commits', () => {
    const wf = makeWorkflow(fx);
    const outcome = getPrCreationOutcome(wf, null);
    // Pre-fix: this is `no_publishable_commits` and finalizeWorkflow then
    // deletes the worktree. Post-fix: must be `failed_with_publishable_commits`
    // (or `created`) so the worktree is preserved/quarantined.
    expect(outcome).not.toBe('no_publishable_commits');
  });
});

// ─── quarantineWorktree — directory move + WHY.md + DB clear ────────────────
//
// These tests verify the quarantine function's on-disk and metadata behavior
// using a minimal real worktree fixture (no full server stack required).

describe('quarantineWorktree (M2)', () => {
  let tmpRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'quarantine-test-'));
    cleanup = () => {
      try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
    };
  });

  afterEach(() => cleanup());

  it('moves the worktree directory to .orchestrator-quarantine/<id>/', () => {
    const worktreePath = path.join(tmpRoot, 'wt');
    const workDir = path.join(tmpRoot, 'work');
    realExecSync(`mkdir -p ${JSON.stringify(worktreePath)} ${JSON.stringify(workDir)}`, { stdio: 'pipe' });
    writeFileSync(path.join(worktreePath, 'some-work.txt'), 'uncommitted work\n');

    const wf = {
      id: 'qtest-' + Math.random().toString(36).slice(2, 8),
      work_dir: workDir,
      worktree_path: worktreePath,
      worktree_branch: 'workflow/test',
    } as any;

    const result = quarantineWorktree(wf, 'test: no_publishable_commits');

    expect(result.ok).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    const quarantineDir = path.join(workDir, '.orchestrator-quarantine', wf.id);
    expect(existsSync(quarantineDir)).toBe(true);
    expect(existsSync(path.join(quarantineDir, 'some-work.txt'))).toBe(true);
  });

  it('writes a WHY.md with workflow id, timestamp, original path, and reason', () => {
    const worktreePath = path.join(tmpRoot, 'wt2');
    const workDir = path.join(tmpRoot, 'work2');
    realExecSync(`mkdir -p ${JSON.stringify(worktreePath)} ${JSON.stringify(workDir)}`, { stdio: 'pipe' });

    const wfId = 'qtest-why-' + Math.random().toString(36).slice(2, 8);
    const wf = {
      id: wfId,
      work_dir: workDir,
      worktree_path: worktreePath,
      worktree_branch: 'workflow/why-test',
    } as any;

    const result = quarantineWorktree(wf, 'finalize: no_publishable_commits');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const why = readFileSync(path.join(result.path, 'WHY.md'), 'utf8');
    expect(why).toContain(`workflow_id: ${wfId}`);
    expect(why).toContain(`original_worktree_path: ${worktreePath}`);
    expect(why).toContain('finalize: no_publishable_commits');
    expect(why).toContain('workflow/why-test');
  });

  it('returns ok:false for a missing worktree_path', () => {
    const wf = {
      id: 'qtest-miss',
      work_dir: tmpRoot,
      worktree_path: null,
      worktree_branch: 'workflow/test',
    } as any;
    const result = quarantineWorktree(wf, 'test');
    expect(result.ok).toBe(false);
  });

  it('uses a timestamp suffix when the quarantine slot already exists', () => {
    const worktreePath1 = path.join(tmpRoot, 'wt3a');
    const worktreePath2 = path.join(tmpRoot, 'wt3b');
    const workDir = path.join(tmpRoot, 'work3');
    realExecSync(
      `mkdir -p ${JSON.stringify(worktreePath1)} ${JSON.stringify(worktreePath2)} ${JSON.stringify(workDir)}`,
      { stdio: 'pipe' },
    );

    const wfId = 'qtest-dup-' + Math.random().toString(36).slice(2, 8);
    const wf1 = { id: wfId, work_dir: workDir, worktree_path: worktreePath1, worktree_branch: 'w/a' } as any;
    const wf2 = { id: wfId, work_dir: workDir, worktree_path: worktreePath2, worktree_branch: 'w/b' } as any;

    const r1 = quarantineWorktree(wf1, 'first');
    const r2 = quarantineWorktree(wf2, 'second');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // The second result path must differ from the first (timestamp suffix).
    if (r1.ok && r2.ok) {
      expect(r1.path).not.toBe(r2.path);
      expect(existsSync(r1.path)).toBe(true);
      expect(existsSync(r2.path)).toBe(true);
    }
  });
});
