# Workflow Wrap-Up Flow (Operator Reference)

This doc traces the two code paths that end a workflow and explains where the
2026-05-17 "no commits on branch — skipping PR" lost-work bug lives. For the
public safety contract and operator recovery procedures, see
[`wrap-up.md`](./wrap-up.md). This document is implementer-facing.

## Two paths to wind-down

There are two distinct paths the orchestrator uses to close out a workflow.
They share helpers but have different guard rails.

### 1. `finalizeWorkflow` — happy-path completion

Called when a workflow reaches the milestone completion threshold and the
implementer agent has exited cleanly.

Code: `src/server/orchestrator/WorkflowPRCreator.ts` — `finalizeWorkflow`
(lines 579–639).

```
finalizeWorkflow(workflow)
  ├── releaseWorkflowClaims(workflow.id)                          [line 583]
  ├── loop up to _FINALIZE_MAX_ATTEMPTS (=3):
  │   └── pushAndCreatePr(workflow, isDraft=false)                [line 589]
  │       ├── ensureWorktreeBranch                                [line 522]
  │       ├── countBranchCommits(worktree_path) > 0 ?             [line 529]
  │       │     ─ false → log "no commits on branch — skipping PR"
  │       │              return null                              [line 535-537]
  │       ├── pushBranch                                          [line 540]
  │       └── createWorkflowPr                                    [line 546]
  ├── fallback: gh pr view <branch> --json url                    [line 612-624]
  ├── getPrCreationOutcome(workflow, prUrl)                       [line 626]
  │     ─ 'created'                          → removeWorktree     [line 629]
  │     ─ 'failed_with_publishable_commits'  → preserve + block   [line 630]
  │     ─ 'no_publishable_commits'           → removeWorktree     [line 637] ★
  └── done
```

★ This is the worktree-deletion path triggered by the bug. When
`countBranchCommits` returns 0 because of *unverifiable* remote refs (not
because the branch is genuinely empty), `getPrCreationOutcome` returns
`'no_publishable_commits'` and `finalizeWorkflow` removes the worktree along
with the only copy of the agent's work.

### 2. `POST /api/workflows/:id/wrap-up` — operator-initiated wind-down

Code: `src/server/api/workflows.ts` (the `wrap-up` handler) and the
`probeRecoverableWorkflowWork` helper in
`src/server/orchestrator/WorkflowPRCreator.ts` (lines 118–216).

This path is **already correct** because PR #15 (merged 2026-05-06) added the
`probeRecoverableWorkflowWork` probe that uses the safer fallback ref set
(`origin/<default>` → `origin/HEAD` → `origin/main` → `origin/master`) and
treats *any* uncertainty as "preserve the worktree." See `wrap-up.md` for the
operator-visible outcomes.

The asymmetry between the two paths is the bug.

## The `countBranchCommits` ref-discovery defect

Code: `WorkflowPRCreator.ts` — `countBranchCommits` (lines 64–76) and
`getRemoteDefaultBranch` (lines 20–33).

```ts
export function countBranchCommits(cwd: string): number {
  const candidateBaseRefs = new Set<string>();
  const defaultBranch = getRemoteDefaultBranch(cwd);
  if (defaultBranch) candidateBaseRefs.add(`origin/${defaultBranch}`);
  candidateBaseRefs.add('origin/HEAD');

  for (const baseRef of candidateBaseRefs) {
    const count = countCommitsAgainstBaseRef(cwd, baseRef);
    if (count !== null) return count;
  }
  return 0;                              // ← bug: unknown is reported as 0
}
```

There are two issues:

1. **Only two base ref candidates.** `getRemoteDefaultBranch` calls
   `git symbolic-ref refs/remotes/origin/HEAD`. In `git worktree add` setups
   that never ran `git remote set-head origin --auto`, that symbolic ref does
   not exist and `getRemoteDefaultBranch` returns `null`. The fallback list
   collapses to just `origin/HEAD`, which also fails. By contrast,
   `probeRecoverableWorkflowWork` (lines 173–176) tries
   `origin/HEAD`, `origin/main`, and `origin/master` as additional fallbacks.

2. **Unknown collapses to 0.** When every candidate fails to resolve,
   `countBranchCommits` returns `0` — indistinguishable from "this branch
   genuinely has no commits ahead of origin." `getPrCreationOutcome` then
   reports `'no_publishable_commits'` and `finalizeWorkflow` deletes the
   worktree.

## Why the 2026-05-17 polymarket-agent runs lost work

Three concurrent workflows (`714c07ad`, `112c728c`, `c8cace7d`) all hit
`finalizeWorkflow` after the implementer agent had already run `gh pr create`
inside the worktree. The orchestrator's `countBranchCommits` could not verify
`origin/HEAD` (the worktree's remote ref tracking was incomplete in those
runs), returned `0`, and `finalizeWorkflow` removed the worktrees. Two of the
three PRs survived because the implementer-created PR was already on GitHub;
the third (`c8cace7d`) had only a local push that was lost when the worktree
was deleted.

## Existing test pinning the bug

`src/test/workflow-partial-pr.test.ts` lines 689–794 (the
`countBranchCommits: safe fallback chain (Fix-C4b)` block) currently asserts
that missing origin refs → `0` → `no_publishable_commits`. This test must be
rewritten as part of M2 — the new contract is that *unknown* base-ref state is
preserved, not treated as empty.

## The quarantine contract (introduced by this workflow)

When `finalizeWorkflow` or any other path decides to skip PR creation because
of `countBranchCommits === 0` / `no_publishable_commits`, it must **not**
remove the worktree. Instead it moves the worktree into

```
<work_dir>/.orchestrator-quarantine/<workflow-id>/
```

writes a one-line `WHY.md` describing the workflow id, timestamp, the
original path, and the probe detail, and prunes git's worktree registration.
A human operator can recover the commits by `cd`-ing into the quarantined
directory and pushing manually.

The existing "verified-empty branch" log message (`no commits on branch —
skipping PR`) is preserved so we still see the signal in logs; the change is
purely that the destructive step is replaced with quarantine.

## Where the bugs live (summary)

| Bug | Symptom | Code location |
|---|---|---|
| A — no-commits false negative | `countBranchCommits` returns 0 when remote refs are unverifiable; worktree deleted | `WorkflowPRCreator.ts:64-76` (and `:535-537`, `:555-568`, `:637`) |
| B — agent-created PR URLs not captured | `workflows.pr_url` left NULL when implementer ran `gh pr create` itself | `finalizeWorkflow` (`WorkflowPRCreator.ts:579-639`) — never reads `agent_output` |
| C — dead watchdog | Hardcoded `WORKFLOW_ID` on a long-completed run | `/home/node/.openclaw/workspace/scripts/autodev_workflow_watchdog.py` |
| D — stale file claims | `workflow_file_claims` rows survive workflow terminal status changes | `src/server/db/workflowQueries.ts` — `updateWorkflow` does not atomically release |

## See also

- [`wrap-up.md`](./wrap-up.md) — operator-facing wrap-up safety contract
- PR #15 (`a49d1f2`) — prior wrap-up fix (introduced `probeRecoverableWorkflowWork`)
- `src/test/api/workflows-wrap-up.test.ts` — wrap-up endpoint regression suite
- `src/test/workflow-partial-pr.test.ts` — countBranchCommits + finalize tests
