# End-of-Workflow Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the verify phase from running after every implement cycle to running once at workflow completion (before PR creation), with failed verifications spawning fix-implement cycles.

**Architecture:** The verify phase trigger moves from `handleImplementCompleted` (per-cycle) to `advanceAfterImplement` (completion-threshold gate). On verify pass, finalization proceeds normally. On verify fail, a new implement job is spawned with the failure context (tagged `is_verify_retry`), which loops back through the normal completion check and re-triggers verify. The review-phase completion path (line 147-150) also gets the same verify gate. Verify-retry implement jobs bypass zero-progress detection since they're fixing verify failures, not progressing milestones.

**Tech Stack:** TypeScript, Vitest, SQLite

---

### Task 1: Move verify trigger from per-cycle to completion gate

**Files:**
- Modify: `src/server/orchestrator/WorkflowManager.ts:278-298` (handleImplementCompleted)
- Modify: `src/server/orchestrator/WorkflowManager.ts:304-318` (advanceAfterImplement)
- Modify: `src/server/orchestrator/WorkflowManager.ts:130-161` (review case completion path)

- [ ] **Step 1: Remove per-cycle verify trigger from handleImplementCompleted**

In `handleImplementCompleted` (line 278), remove the verify_command check block (lines 282-295) so implement completions always go straight to `advanceAfterImplement`:

```typescript
function handleImplementCompleted(job: Job, workflow: Workflow, milestones: { total: number; done: number }): void {
  updateAndEmit(workflow.id, { milestones_total: milestones.total, milestones_done: milestones.done });
  const updated = queries.getWorkflowById(workflow.id)!;
  advanceAfterImplement(job, workflow, updated, milestones);
}
```

- [ ] **Step 2: Add verify gate to the completion-threshold path in advanceAfterImplement**

In `advanceAfterImplement` (line 304), replace the direct `finalizeWorkflow` call with a verify check when `verify_command` is configured:

```typescript
function advanceAfterImplement(job: Job, workflow: Workflow, updated: Workflow, milestones: { total: number; done: number }): void {
  if (milestones.total > 0 && meetsCompletionThreshold(milestones, updated.completion_threshold)) {
    // If verify command is configured, run verification before finalizing
    if (updated.verify_command) {
      console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}) — running verify before finalization`);
      scheduleVerifyPhase(updated, job, milestones).catch(err => {
        console.error(`[workflow ${workflow.id}] verify phase threw unexpectedly:`, err);
        captureWithContext(err, { workflow_id: workflow.id, component: 'VerifyRunner' });
        updateAndEmit(workflow.id, {
          status: 'blocked',
          current_phase: 'verify' as WorkflowPhase,
          blocked_reason: `Verify phase threw an unexpected error: ${errMsg(err)}`,
        });
      });
      return;
    }
    console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}, threshold ${updated.completion_threshold}) — marking complete`);
    updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
    finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
  } else if (updated.current_cycle >= updated.max_cycles) {
    console.log(`[workflow ${workflow.id}] reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones — marking blocked (not complete)`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'idle' as WorkflowPhase, blocked_reason: `Reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones complete` });
    if (milestones.done > 0) {
      const latestWf = queries.getWorkflowById(workflow.id)!;
      pushAndCreatePr(latestWf, true);
    }
  } else {
    handleZeroProgressAndAdvance(job, workflow, updated, milestones);
  }
}
```

- [ ] **Step 3: Add verify gate to the review-phase completion path**

In the `case 'review'` handler (line 147), replace the direct `finalizeWorkflow` call with the same verify-gated logic:

```typescript
if (milestones.total > 0 && meetsCompletionThreshold(milestones, updated.completion_threshold)) {
  if (updated.verify_command) {
    console.log(`[workflow ${workflow.id}] milestones meet completion threshold after review — running verify before finalization`);
    const lastImplementJob = queries.getJobsForWorkflow(workflow.id)
      .filter(j => j.workflow_phase === 'implement' && j.status === 'done')
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    if (lastImplementJob) {
      scheduleVerifyPhase(updated, lastImplementJob, milestones).catch(err => {
        console.error(`[workflow ${workflow.id}] verify phase threw unexpectedly:`, err);
        captureWithContext(err, { workflow_id: workflow.id, component: 'VerifyRunner' });
        updateAndEmit(workflow.id, {
          status: 'blocked',
          current_phase: 'verify' as WorkflowPhase,
          blocked_reason: `Verify phase threw an unexpected error: ${errMsg(err)}`,
        });
      });
    } else {
      // No implement job found — finalize without verify
      console.log(`[workflow ${workflow.id}] milestones meet threshold after review but no implement job to verify — finalizing directly`);
      updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
      finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
    }
  } else {
    console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}, threshold ${updated.completion_threshold}) after review — marking complete`);
    updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
    finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
  }
} else {
  spawnPhaseJob(updated, 'implement', updated.current_cycle);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No errors in WorkflowManager.ts

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/WorkflowManager.ts
git commit -m "refactor: move verify trigger from per-cycle to completion gate"
```

---

### Task 2: Update scheduleVerifyPhase to finalize on pass, spawn implement on fail

**Files:**
- Modify: `src/server/orchestrator/WorkflowManager.ts:330-445` (scheduleVerifyPhase)

- [ ] **Step 1: Change the verify-pass path to finalize instead of calling advanceAfterImplement**

In `scheduleVerifyPhase`, replace the pass handler (lines 403-409) so that on exit code 0 it finalizes the workflow:

```typescript
  if (verifyResult.exitCode === 0) {
    console.log(`[workflow ${workflowId}] verify PASSED (cycle ${cycle}, attempt ${attempt}, ${(verifyResult.durationMs / 1000).toFixed(1)}s) — finalizing workflow`);
    // Clear any stale verify failure note from a previous failed attempt
    queries.deleteNote(`workflow/${workflowId}/verify-failure/${cycle}`);
    updateAndEmit(workflowId, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
    finalizeWorkflow(queries.getWorkflowById(workflowId)!).catch(err => console.error(`[workflow ${workflowId}] finalizeWorkflow error:`, err));
  } else {
```

- [ ] **Step 2: Change the verify-fail retry path to spawn implement with is_verify_retry context**

In the failure handler (lines 410-444), when retries remain, spawn an implement job tagged with `is_verify_retry` in its context. This is done by inserting the job directly (like repair jobs do) rather than calling `spawnPhaseJob`, so we can set the context field:

```typescript
  } else {
    const failedRuns = queries.getVerifyRunsForCycle(workflowId, cycle).filter(r => r.exit_code !== 0);
    const maxRetries = fresh.max_verify_retries;

    console.log(`[workflow ${workflowId}] verify FAILED (cycle ${cycle}, attempt ${attempt}, exit ${verifyResult.exitCode}) — ${failedRuns.length}/${maxRetries + 1} failures`);

    // Persist the latest failure so the next implement prompt can surface it
    queries.upsertNote(
      `workflow/${workflowId}/verify-failure/${cycle}`,
      JSON.stringify({
        command: verifyCommand,
        exitCode: verifyResult.exitCode,
        stdout: verifyResult.stdout,
        stderr: verifyResult.stderr,
        attempt,
        durationMs: verifyResult.durationMs,
      }),
      null,
    );

    if (attempt <= maxRetries) {
      // Retries remain — re-run implement for the same cycle with verify retry context
      console.log(`[workflow ${workflowId}] verify failure ${attempt}/${maxRetries} — re-spawning implement for cycle ${cycle} (verify retry)`);
      const inlineContext = preReadWorkflowContext(workflowId, { cycle });
      const prompt = buildImplementPrompt(fresh, cycle, inlineContext);
      const model = getWorkflowFallbackModel(fresh, 'implement', fresh.implementer_model) ?? fresh.implementer_model;
      const retryJob = queries.insertJob({
        id: randomUUID(),
        title: `[Workflow C${cycle}] Implement (verify retry ${attempt})`,
        description: prompt,
        context: JSON.stringify({ is_verify_retry: true }),
        priority: 0,
        model,
        template_id: fresh.template_id,
        work_dir: fresh.worktree_path ?? fresh.work_dir,
        max_turns: effectiveMaxTurns(fresh.stop_mode_implement, fresh.stop_value_implement),
        stop_mode: fresh.stop_mode_implement,
        stop_value: fresh.stop_value_implement,
        project_id: fresh.project_id,
        use_worktree: 0,
        workflow_id: workflowId,
        workflow_cycle: cycle,
        workflow_phase: 'implement',
      });
      try { socket.emitJobNew(retryJob); } catch (emitErr) { console.warn(`[workflow ${workflowId}] socket.emitJobNew failed:`, emitErr); }
      nudgeQueue();
      updateAndEmit(workflowId, { current_phase: 'implement' as WorkflowPhase });
    } else {
      const output = (verifyResult.stderr || verifyResult.stdout).slice(0, 300);
      const verifyFailReason = `verify_failed: Verify phase failed ${attempt} time(s) on cycle ${cycle} (exit ${verifyResult.exitCode}): ${output || '(no output)'}`;
      console.log(`[workflow ${workflowId}] ${verifyFailReason} — marking blocked`);
      updateAndEmit(workflowId, {
        status: 'blocked',
        current_phase: 'verify' as WorkflowPhase,
        blocked_reason: verifyFailReason,
      });
    }
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/WorkflowManager.ts
git commit -m "feat: verify pass finalizes workflow, fail spawns implement with verify retry context"
```

---

### Task 3: Bypass zero-progress detection for verify-retry implement jobs

**Files:**
- Modify: `src/server/orchestrator/WorkflowManager.ts:447-522` (handleZeroProgressAndAdvance)

- [ ] **Step 1: Add is_verify_retry check at the top of handleZeroProgressAndAdvance**

Verify-retry implement jobs should skip zero-progress detection and cycle advancement. When a verify-retry implement completes, the normal flow through `advanceAfterImplement` will check if milestones still meet the completion threshold and re-trigger verify. Add this early return near the existing `is_repair` check (around line 513):

Move the existing `is_repair` and add `is_verify_retry` check together, both before the zero-progress logic. Actually, the `is_repair` check is at the end (line 513), and it goes to review. For `is_verify_retry`, we want to let the normal `advanceAfterImplement` flow handle it (which will re-check completion threshold). But `handleZeroProgressAndAdvance` is only called when the completion threshold is NOT met. If verify fails and the agent "breaks" something during the fix, milestones might drop below threshold. In that case, we should still advance to the next review cycle normally. So verify-retry jobs that don't meet the threshold should just advance normally like any other implement job. The key thing is: **don't block on zero-progress for verify-retry jobs**, since the agent's goal was fixing verify failures, not checking off milestones.

Add the `is_verify_retry` skip right after the `is_repair` check:

```typescript
  const jobContext = job.context ? JSON.parse(job.context) : {};
  if (jobContext.is_repair) {
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', updated.current_cycle);
    return;
  }

  // Verify-retry implements are fixing test/verify failures, not progressing milestones.
  // Skip zero-progress detection — just advance to the next cycle normally.
  if (jobContext.is_verify_retry) {
    const nextCycle = updated.current_cycle + 1;
    updateAndEmit(workflow.id, { current_cycle: nextCycle });
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
    return;
  }

  const nextCycle = updated.current_cycle + 1;
  updateAndEmit(workflow.id, { current_cycle: nextCycle });
  spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
```

Wait — the zero-progress detection happens *before* the `is_repair` check (lines 452-511). The early returns in the zero-progress block would still fire for verify-retry jobs. We need the `is_verify_retry` check **before** the zero-progress logic. Add it at the top of `handleZeroProgressAndAdvance`:

```typescript
function handleZeroProgressAndAdvance(job: Job, workflow: Workflow, updated: Workflow, milestones: { total: number; done: number }): void {
  // Verify-retry implements are fixing test/verify failures, not progressing milestones.
  // Skip zero-progress detection — just advance to the next cycle.
  const jobContext = job.context ? JSON.parse(job.context) : {};
  if (jobContext.is_verify_retry) {
    const nextCycle = updated.current_cycle + 1;
    updateAndEmit(workflow.id, { current_cycle: nextCycle });
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
    return;
  }

  const preImplKey = `workflow/${workflow.id}/pre-implement-milestones/${updated.current_cycle}`;
  // ... rest of existing function unchanged ...
```

And remove the duplicate `jobContext` parse that was at line 513 (since we now parse it at the top):

```typescript
  // Existing is_repair check (line 513) — reuse jobContext from the top of the function
  if (jobContext.is_repair) {
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', updated.current_cycle);
    return;
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/WorkflowManager.ts
git commit -m "fix: bypass zero-progress detection for verify-retry implement jobs"
```

---

### Task 4: Remove the cycle-0 skip logic

**Files:**
- Modify: `src/server/orchestrator/WorkflowManager.ts` (scheduleVerifyPhase, if any cycle-0 references remain)

- [ ] **Step 1: Verify no cycle-0 skip is needed**

The old per-cycle verify had a `(job.workflow_cycle ?? 0) > 0` check to skip cycle 0 (the planning cycle). Since verify now only triggers at completion threshold (which can't be met on cycle 0 since assess doesn't check off milestones), this skip is inherently handled. No code change needed — just verify that the removed `handleImplementCompleted` code was the only place this check existed.

Run: `grep -n 'cycle.*> 0' src/server/orchestrator/WorkflowManager.ts`
Expected: No references to the old cycle-0 verify skip

- [ ] **Step 2: Verify the verify note key uses the current cycle (not hardcoded)**

In `scheduleVerifyPhase`, confirm that the cycle variable comes from the implement job that triggered it (via `implementJob.workflow_cycle ?? workflow.current_cycle`). This is correct since at finalization time the cycle is the last implement cycle. No change needed.

---

### Task 5: Update tests for the new behavior

**Files:**
- Modify: `src/test/verify-lifecycle.test.ts`

- [ ] **Step 1: Update the "no-verify regression" test**

This test confirms workflows without `verify_command` advance normally. It should still pass as-is since we only removed the per-cycle trigger — `advanceAfterImplement` without a verify command still goes to the normal path. Verify it passes:

Run: `npx vitest run src/test/verify-lifecycle.test.ts -t "advances normally" 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 2: Update the "cycle-0 skip" test**

This test checks that verify doesn't run on cycle 0. Since verify now only triggers at completion threshold, cycle 0 inherently doesn't trigger it. But we need to make sure `meetsCompletionThreshold` returns false for the test (it already does via the mock). Update the test description to reflect the new semantics:

```typescript
  it('does not run verify when completion threshold is not met (cycle 0)', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { updateWorkflow, upsertNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 0 });
    updateWorkflow(workflow.id, { verify_command: 'echo hello' } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [ ] M1\n- [ ] M2', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 0,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);

    // Verify must NOT run — completion threshold not met
    expect(runVerification).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Update the "verify pass" test**

The existing test checks that verify runs after implement and advances to next review cycle. Now, verify should run when completion threshold is met and should finalize the workflow on pass.

Update the `meetsCompletionThreshold` mock to return `true` for this test, and assert that `finalizeWorkflow` is called instead of advancing to review:

```typescript
  it('runs verify and finalizes workflow on pass when threshold is met', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getVerifyRunsForCycle, getNote } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');
    const { finalizeWorkflow: mockFinalize } = await import('../server/orchestrator/WorkflowPRCreator.js');

    mockVerifyResult = { exitCode: 0, stdout: 'All checks passed', stderr: '', durationMs: 250 };
    // Make completion threshold return true so verify triggers
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 2 });
    updateWorkflow(workflow.id, { verify_command: 'npm test', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 50));

    expect(runVerification).toHaveBeenCalledWith('npm test', expect.any(String));

    // Verify run persisted
    const runs = getVerifyRunsForCycle(workflow.id, 2);
    expect(runs.length).toBe(1);
    expect(runs[0].exit_code).toBe(0);

    // Workflow should be marked complete
    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('complete');

    // finalizeWorkflow should have been called
    expect(mockFinalize).toHaveBeenCalled();

    // Reset mock
    vi.mocked(meetsCompletionThreshold).mockReturnValue(false);
  });
```

- [ ] **Step 4: Update the "verify fail + retry" test**

Now verify failure should spawn an implement job with `is_verify_retry` context. Update to trigger via completion threshold:

```typescript
  it('spawns implement with verify_retry context on verify failure when retries remain', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, getVerifyRunsForCycle, getNote, getJobsForWorkflow } = await import('../server/db/queries.js');
    const { runVerification } = await import('../server/orchestrator/VerifyRunner.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    mockVerifyResult = { exitCode: 1, stdout: '', stderr: 'Server error 500', durationMs: 400 };
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { verify_command: 'exit 1', max_verify_retries: 2 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 50));

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).not.toBe('blocked');
    // Phase should be implement (re-spawned for verify retry)
    expect(freshWf.current_phase).toBe('implement');

    // A new implement job should have been spawned with is_verify_retry context
    const jobs = getJobsForWorkflow(workflow.id);
    const retryJob = jobs.find(j => j.context && JSON.parse(j.context).is_verify_retry);
    expect(retryJob).toBeTruthy();
    expect(retryJob!.title).toContain('verify retry');

    // Failure note should be written
    const failureNote = getNote(`workflow/${workflow.id}/verify-failure/1`);
    expect(failureNote).not.toBeNull();

    // Reset mock
    vi.mocked(meetsCompletionThreshold).mockReturnValue(false);
  });
```

- [ ] **Step 5: Update the "verify fail exhausted" test**

Same pattern — trigger via completion threshold, pre-insert enough failed runs to exhaust retries:

```typescript
  it('blocks workflow after max_verify_retries exhausted', async () => {
    const { onJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { getWorkflowById, updateWorkflow, upsertNote, insertVerifyRun } = await import('../server/db/queries.js');
    const { meetsCompletionThreshold } = await import('../server/orchestrator/WorkflowMilestoneParser.js');

    mockVerifyResult = { exitCode: 2, stdout: '', stderr: 'Fatal error', durationMs: 200 };
    vi.mocked(meetsCompletionThreshold).mockReturnValue(true);

    const { workflow } = await makeVerifyWorkflow({ current_cycle: 1 });
    updateWorkflow(workflow.id, { verify_command: 'exit 2', max_verify_retries: 1 } as any);
    upsertNote(`workflow/${workflow.id}/plan`, '- [x] M1\n- [x] M2\n- [x] M3', null);

    // Pre-insert 1 failed run (so attempt will be 2, which exceeds max_verify_retries=1)
    insertVerifyRun({
      id: 'existing-run-id',
      workflow_id: workflow.id,
      cycle: 1,
      attempt: 1,
      command: 'exit 2',
      exit_code: 2,
      stdout: null,
      stderr: 'Previous failure',
      duration_ms: 150,
      created_at: Date.now(),
    });

    const job = await insertTestJob({
      workflow_id: workflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      status: 'done',
    });

    onJobCompleted(job);
    await new Promise(r => setTimeout(r, 100));

    const freshWf = getWorkflowById(workflow.id)!;
    expect(freshWf.status).toBe('blocked');
    expect(freshWf.blocked_reason).toContain('verify_failed');
    expect(freshWf.current_phase).toBe('verify');

    // Reset mock
    vi.mocked(meetsCompletionThreshold).mockReturnValue(false);
  });
```

- [ ] **Step 6: Run all verify tests**

Run: `npx vitest run src/test/verify-lifecycle.test.ts 2>&1 | tail -30`
Expected: All 5 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/test/verify-lifecycle.test.ts
git commit -m "test: update verify lifecycle tests for end-of-workflow verification"
```

---

### Task 6: Update prompt test assertions

**Files:**
- Modify: `src/test/verify-prompt.test.ts` (minimal — only if assertions reference per-cycle behavior)

- [ ] **Step 1: Check existing prompt tests still pass**

The prompt tests test `renderVerifyFailure` and `buildImplementPrompt` with verify failure context. These are about rendering, not lifecycle, so they should pass unchanged.

Run: `npx vitest run src/test/verify-prompt.test.ts 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 2: Run the VerifyRunner tests**

Run: `npx vitest run src/test/verify-runner.test.ts 2>&1 | tail -20`
Expected: All tests pass (VerifyRunner is unchanged)

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run 2>&1 | tail -40`
Expected: All tests pass

- [ ] **Step 4: Commit (only if changes were needed)**

```bash
# Only if prompt tests needed updating:
git add src/test/verify-prompt.test.ts
git commit -m "test: fix prompt test assertions for end-of-workflow verify"
```

---

### Task 7: Verify TypeScript compilation and dev server

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: Clean compilation, no errors

- [ ] **Step 2: Build**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Final commit if needed**

If any compilation fixes were needed, commit them.
