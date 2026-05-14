# Wrap-Up Safety Contract

`POST /api/workflows/:id/wrap-up` stops a running or blocked workflow and tries to publish whatever has been committed as a draft PR. This document defines the **safety contract** the endpoint guarantees and the manual recovery procedure for each non-success outcome.

## The invariant

> **Wrap-up is always safe to call.** It will never delete a worktree that has local commits ahead of the origin base ref. If the endpoint cannot positively prove there is nothing to recover, the worktree is preserved and the workflow is marked `blocked` with a reason explaining what to do next.

This invariant is enforced by `probeRecoverableWorkflowWork()` in `src/server/orchestrator/WorkflowPRCreator.ts` and exercised by the regression suite at `src/test/api/workflows-wrap-up.test.ts`. Any refactor that breaks the invariant should fail those tests; reviewers explicitly check this guard.

## The four operator-visible outcomes

The response JSON shape is `{ workflow, pr_url, outcome }`. The `outcome` field is one of:

| `outcome`                          | HTTP | Workflow status | Worktree on disk | Meaning |
|------------------------------------|------|------------------|-------------------|---------|
| `draft_pr_created`                 | 200  | `complete`       | removed           | Branch was pushed and a draft PR was created. `pr_url` is set. |
| `no_publishable_commits`           | 200  | `cancelled`      | removed           | The probe positively verified the branch has zero commits ahead of origin. Nothing to publish. |
| `draft_pr_failed_preserved`        | 409  | `blocked`        | **preserved**     | Push or `gh pr create` failed (or the probe was uncertain). Local commits may still be on disk. `blocked_reason` describes which step failed. |
| `missing_worktree_with_progress`   | 409  | `blocked`        | (already missing) | Worktree metadata was missing but milestones were completed. Commits may be recoverable from the parent checkout (Fix-C6b path). |

The shape of the response does not change. Operators who script `curl` calls against this endpoint can keep doing so.

## The `blocked_reason` prefixes

When `outcome` is `draft_pr_failed_preserved`, the `blocked_reason` field always follows one of these prefixes so it can be parsed or grepped:

- `Wrap-up: branch push failed (<git stderr>) — worktree preserved at <path>`
- `Wrap-up: branch pushed but gh pr create failed (<gh stderr>) — worktree preserved at <path>`
- `Wrap-up: unknown PR-creation failure (<probe detail>) — worktree preserved at <path>`

When `outcome` is `missing_worktree_with_progress`, the reason is:

- `Wrap-up failed — worktree metadata missing but <done>/<total> milestones completed. Commits may be recoverable from the main checkout.`

`reconcileBlockedPRs` in `WorkflowPRCreator.ts` recognizes these reasons and will retry on next server start for non-auth `branch push failed` and for both `gh pr create failed` / `unknown PR-creation failure` reasons. Auth-classified push failures are intentionally not auto-retried — they will not fix themselves.

## What gets retried automatically

`pushBranch` does one bounded retry on transient failures:

1. Attempt 1: `git push -u origin <branch>`
2. On a non-auth failure: sleep ~5s, then attempt `git push --force-with-lease -u origin <branch>` once.

Auth and permission failures (`Authentication failed`, `Permission denied`, `could not read Username`, `could not read Password`, `terminal prompts disabled`, plain `403`) skip the retry. Rate-limit `403` responses (`Retry-After`, `rate limit`, `secondary rate limit`, abuse-detection wording) are treated as transient and **do** get the retry.

`gh pr create` is not retried automatically — if it fails, the workflow is preserved and the operator runs the manual recovery below.

## Manual recovery — `branch push failed`

The branch push never reached origin. The worktree contains all your commits.

1. Inspect the preserved worktree:
   ```bash
   cd "<worktree path from blocked_reason>"
   git log --oneline origin/main..HEAD
   git status
   ```
2. Diagnose the push failure (auth, network, rate limit). The exact `git` stderr is included in the `blocked_reason`.
3. Push manually once the underlying issue is resolved:
   ```bash
   git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
   ```
   If origin has stale state from a partial push, use `--force-with-lease`.
4. Open the PR yourself:
   ```bash
   gh pr create --draft --base main --head "$(git rev-parse --abbrev-ref HEAD)" --title '...' --body '...'
   ```
5. Update the workflow status from the dashboard or directly:
   ```bash
   curl -X POST http://localhost:3456/api/workflows/<id>/resume -H 'Content-Type: application/json' -d '{}'
   ```
   Resume will pick up the now-pushed branch on next reconciliation, or you can mark the workflow `complete` manually from the dashboard if the PR was opened by hand.

## Manual recovery — `branch pushed but gh pr create failed`

The branch is already on origin; only the PR-creation step failed (gh CLI auth issue, GitHub API hiccup, label missing, etc.).

1. Confirm the branch is on origin:
   ```bash
   git ls-remote origin "<branch>"
   ```
2. Open the PR manually:
   ```bash
   cd "<worktree path from blocked_reason>"
   gh pr create --draft --base main --head "$(git rev-parse --abbrev-ref HEAD)" --title '...' --body '...'
   ```
3. Optionally re-run wrap-up after fixing the underlying gh CLI issue — the new push will be a no-op (idempotent) and the PR creation will retry.

## Manual recovery — `unknown PR-creation failure`

The probe was uncertain (e.g. missing origin base ref, missing worktree metadata, command failure). The worktree is preserved as a precaution even when nothing strictly broke.

1. Inspect the worktree at the path mentioned in `blocked_reason`.
2. If `git log origin/main..HEAD` shows real commits, follow the **branch push failed** recovery.
3. If there are no commits ahead of origin, the workflow can be safely cancelled from the dashboard. The worktree can then be cleaned up by removing the directory and pruning:
   ```bash
   git worktree remove "<worktree path>"
   git worktree prune
   ```

## Manual recovery — `missing_worktree_with_progress`

The orchestrator lost track of the worktree path but the workflow had checked off milestones. Commits likely still exist in the parent checkout's reflog or working tree.

1. From the parent checkout, try:
   ```bash
   git reflog | grep workflow/<short-id>
   git branch -a | grep workflow/<short-id>
   ```
2. If the branch ref is found, push it and open a PR manually as above.
3. If only reflog entries remain, recover with `git checkout -b <branch> <reflog-sha>`.

## What `cancelled` means now

The `cancelled` outcome is reserved for workflows where the probe positively verified there is nothing to recover — the worktree exists, is on the expected branch, has a clean working tree, and has zero commits ahead of a verified origin base ref. Anything short of all four conditions blocks instead of cancels. This is the load-bearing safety property; do not weaken the probe.

## Live evidence

The contract was hardened after two real losses:

| Workflow | Date | Symptom | Recovery |
|---|---|---|---|
| poker_agent V3 (PR #23) | 2026-05-04 | hit max_cycles at 12/14 milestones | branch preserved (`failed_with_publishable_commits` path); manual `gh pr create` from worktree |
| polymarket-agent arbitrage (PR #11) | 2026-05-06 | hit max_cycles at 12/13; wrap-up silently `cancelled` and deleted the worktree | recovered by `git reflog` + force-push (lucky) |

The polymarket-agent loss was the regression target for this contract: the default fallthrough now never deletes a worktree without first proving there is nothing to recover.

## Related code

- `src/server/api/workflows.ts` — `POST /:id/wrap-up` handler
- `src/server/orchestrator/WorkflowPRCreator.ts` — `probeRecoverableWorkflowWork`, `pushBranch`, `createWorkflowPr`, `pushAndCreatePr`, `isReconcilablePrBlockedReason`
- `src/test/api/workflows-wrap-up.test.ts` — regression suite covering every wrap-up branch with real temp git worktrees
