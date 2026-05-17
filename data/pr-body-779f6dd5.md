# autodev: fix wrap-up "no commits" false-negative + capture agent PR URLs + watchdog re-aim + file-claim TTL

## 1. Root cause of the "no commits on branch" false-negative

`countBranchCommits` in `src/server/orchestrator/WorkflowPRCreator.ts` previously tried only `origin/<remote-default-branch>` (resolved via `git symbolic-ref refs/remotes/origin/HEAD`) and `origin/HEAD`. On 2026-05-17 three polymarket-agent workflows landed with `origin/HEAD` missing as a symbolic-ref (no replacement set in the working clone), so `getRemoteDefaultBranch` returned `null`, the only remaining candidate `origin/HEAD` also failed, and the function `return 0;` even when the branch held real commits ahead of `origin/main`.

Exact pre-fix locations:

- `src/server/orchestrator/WorkflowPRCreator.ts:64-76` — `countBranchCommits` returned `number`, no fallback chain.
- `src/server/orchestrator/WorkflowPRCreator.ts:535-537` — `pushAndCreatePr` treated `0` as verified empty.
- `src/server/orchestrator/WorkflowPRCreator.ts:555-568` — `getPrCreationOutcome` mapped `0` to `no_publishable_commits`.
- `src/server/orchestrator/WorkflowPRCreator.ts:637` — `finalizeWorkflow` then called `removeWorktree`, destroying the branch's local commits.

Fix (commits `184537b` / M2 and `cf8689a` / M3): `countBranchCommits` now returns `number | null`; the fallback chain probes `origin/<default>`, `origin/HEAD`, `origin/main`, then `origin/master`; callers preserve work on `null`; `getPrCreationOutcome` returns `failed_with_publishable_commits` for `null`; both finalize and the manual `POST /api/workflows/:id/wrap-up` no-commits paths now call `quarantineWorktree` (moves to `<work_dir>/.orchestrator-quarantine/<workflow_id>/` with a `WHY.md`) instead of `removeWorktree`. A real-git integration fixture (`src/test/workflow-no-commits-falseneg.test.ts`) reproduces the missing-`origin/HEAD` topology and asserts the publishable-work path is preserved.

## 2. Agent-created PR URL capture and backfill

`src/server/orchestrator/AgentPrUrlCapture.ts` adds pure helpers (`extractGithubPullUrls`, `parseOwnerRepoFromOriginUrl`, `getWorkflowOriginOwnerRepo`, `validateAgentCreatedPrUrl`, `findAgentCreatedPrUrl`) and a mutating wrapper `captureAgentCreatedPrUrl(workflow, { dryRun?, updateAndEmit?, exec?, listOutputsForLatestImplementer? })`. The wrap-up flow scans the most-recently-finished implementer agent's output (selected by `(workflow_cycle desc, agent.finished_at desc)` so same-cycle retries win) for `https://github.com/<owner>/<repo>/pull/<N>` URLs, rejects any whose `owner/repo` differs from the workflow's origin BEFORE calling `gh pr view`, then validates state=OPEN and `headRefName` matches `workflow.worktree_branch`. On hit the URL is stored on `workflows.pr_url`, emits `"agent-created PR URL captured: <url>"`, and the outcome becomes `agent_pr_captured`. Origin resolution falls back from `worktree_path` to `work_dir` so backfill rows whose worktree has been removed/quarantined still resolve owner/repo.

`scripts/backfill-agent-pr-urls.ts` is dry-run by default (`--apply` required for writes; `--db <path>` overrides). It selects `pr_url IS NULL AND status='complete'` and reuses the same finder/validator; rows where origin matches but full `gh pr view` cannot run surface as `manual-review` so the operator can see candidates without writes.

Workflow backfill table (dry-run against `/home/node/.openclaw/workspace/autodev-data/orchestrator.db`):

| workflow id (short) | PR URL |
| --- | --- |
| f3718289 | https://github.com/bh13731/polymarket-agent/pull/27 |
| 44f28b8c | https://github.com/bh13731/polymarket-agent/pull/28 |
| 714c07ad | https://github.com/bh13731/polymarket-agent/pull/30 |
| 112c728c | https://github.com/bh13731/polymarket-agent/pull/29 |
| c8cace7d | not captured — human-rescued PR #31; the agent output never contained the URL, so the safety-net parser correctly does not surface it |

## 3. Watchdog discovery query

`/home/node/.openclaw/workspace/scripts/autodev_workflow_watchdog.py` no longer hardcodes a UUID. Default behavior queries:

```sql
SELECT id FROM workflows
WHERE status NOT IN ('complete','cancelled','failed')
  AND updated_at > ?
ORDER BY updated_at DESC
```

The bind parameter is `now - 7 days`. Manual override: `AUTODEV_WORKFLOW_IDS=<comma-separated UUIDs>` (legacy `AUTODEV_WORKFLOW_ID=<single>` honored as back-compat). Existing stuck-signal gates (storm, hang, no-update-30min, fast-quiet implements) are preserved. Per-`(workflow_id, condition)` dedup is stored in `/tmp/autodev_workflow_watchdog_state.json` with a 30-minute cooldown so a single condition cannot spam the same alert. 15 stdlib `unittest` tests in `scripts/tests/test_autodev_workflow_watchdog.py` cover discovery, env override precedence, dedup, and the no-update / blocked / complete / missing condition cases. These files live in the workspace-state repo (`/home/node/.openclaw/workspace/scripts/`), not in this autodev PR — they are referenced here for completeness.

## 4. File-claim release semantics and production backfill count

`src/server/db/workflowQueries.ts` — `updateWorkflow` detects when `fields.status ∈ {'complete','cancelled','failed'}` and wraps the `UPDATE workflows ... WHERE id = ?` write together with `UPDATE workflow_file_claims SET released_at = ? WHERE workflow_id = ? AND released_at IS NULL` in a single `withTransaction` block. Non-terminal status updates (e.g. `blocked`) and updates that do not touch `status` keep the original single-write path so transient blocks do not lose claims.

`src/server/orchestrator/StartupMaintenance.ts` — `backfillReleaseStaleClaims()` runs at boot inside the existing `runStartupMaintenance()` flow with an idempotent `UPDATE workflow_file_claims SET released_at = ? WHERE released_at IS NULL AND workflow_id IN (SELECT id FROM workflows WHERE status IN ('complete','cancelled','failed'))`. The boot log line `released stale workflow file claims` is emitted only when count > 0 so healthy boots stay quiet.

## 5. Before/after the M10 backfill (polymarket-agent workflows)

Before (cycle-12 read-only counts against `/home/node/.openclaw/workspace/autodev-data/orchestrator.db`):

- `completed_workflows_with_null_pr_url = 21`
- `stale_claims_on_terminal_workflows = 29` (released_at IS NULL, owned by `complete`/`cancelled`/`failed`)
- `all_active_claims = 50`

After (cycle-13 read-only counts against the same DB):

- `completed_workflows_with_null_pr_url = 17`
- `stale_claims_on_terminal_workflows = 0`
- `all_active_claims = 21`

The four candidate PR URLs from the M6 dry-run are now stored on rows `f3718289`, `44f28b8c`, `714c07ad`, and `112c728c`; `c8cace7d` remains `NULL` as expected for the human-rescued PR #31.

Note: `gh auth status` is not configured in the gateway container shell used during cycles 12 and 13, so this PR does not include a fresh `gh pr view` validation log against those four URLs. The before/after counts above were observed read-only against the production DB; reviewers can re-run `scripts/backfill-agent-pr-urls.ts --db <path> --dry-run` from a host with `gh auth` to independently re-validate.

## Test evidence

- `python3 -m unittest tests.test_autodev_workflow_watchdog -v` (in `/home/node/.openclaw/workspace/scripts/`): 15 tests, all pass.
- Vitest targeted suites (`workflow-no-commits-falseneg`, `workflow-partial-pr`, `agent-pr-url-capture`, `workflow-file-claims`, `startup-maintenance-claims`) and `npm run build` cannot be executed in this worktree: `npm test` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` from `vite/module-runner` against the pnpm-hoisted `node_modules`, and `tsc` resolves but build is gated on the same toolchain. Reviewers running the suite in a host with a fresh `npm install` should see the new tests pass.
