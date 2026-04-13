# Orchestrator Quality Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Refactor the hurlicane orchestrator module from its current state (PtyManager 4/10, WorkflowManager 6/10, Concurrency 5/10) to production-quality 10/10 by eliminating architectural debt: circular dependencies, god files, implicit state machines, race conditions, and missing circuit breakers.

**Architecture:** Break the AgentRunner-PtyManager circular dependency by extracting shared config into a new module. Decompose PtyManager (1,463 lines, 9 concerns) into 5 focused modules each under 300 lines. Add an explicit agent lifecycle state machine. Extract WorkflowManager's repeated recovery pattern into a helper. Add a circuit breaker to WorkQueueManager that pauses dispatch when all models are rate-limited.

**Tech Stack:** TypeScript, Node.js 25, vitest, tmux, node-pty, better-sqlite3

**Repo:** /Users/barneyhussey-yeo/GitHub/personal/hurlicane
**Branch:** refactor/orchestrator-quality-overhaul

---

## File Structure

### New Files (Extract from existing)

| File | Responsibility | Extracted From |
|------|---------------|----------------|
| AgentConfig.ts | Shared constants (SYSTEM_PROMPT, HOOK_SETTINGS, CLAUDE, CODEX, paths) + shared types (RunOptions) | AgentRunner.ts lines 55-168 |
| AgentLifecycle.ts | Explicit AgentState enum, AgentStateManager class tracking per-agent state with transition validation | New (replaces implicit Map-based tracking) |
| PtyResourceManager.ts | PTY concurrency cap, resource checks, backoff logic, tmux session counting | PtyManager.ts lines 54-127 |
| AgentSpawner.ts | tmux session creation, script generation, prompt building, env setup | PtyManager.ts lines 680-979 |
| PtySessionManager.ts | PTY attach/detach, event handlers (onData/onExit), resize, input, disconnect | PtyManager.ts lines 1062-1350 |
| JobFinalizer.ts | Standalone print job resolution, ndjson parsing, cost extraction, exit polling | PtyManager.ts lines 986-1060 |
| PtyDiskLogger.ts | PTY log file management, persistent FDs, fsync timer, snapshot capture | PtyManager.ts lines 129-644 |
| WorkflowRecovery.ts | Extracted idempotent recovery helper, recovery key constants | WorkflowManager.ts lines 245-354 |
| WorkflowPhaseConfig.ts | Phase-to-model/stopMode/promptBuilder lookup table | WorkflowManager.ts switch statements |
| CircuitBreaker.ts | Org-level rate-limit detection, dispatch pause/resume, proactive backpressure | New |

All new files go in src/server/orchestrator/.

### Modified Files

| File | Changes |
|------|---------|
| PtyManager.ts | Becomes thin facade re-exporting from sub-modules |
| AgentRunner.ts | Move shared constants to AgentConfig.ts, import from there |
| WorkflowManager.ts | Use WorkflowRecovery helper, WorkflowPhaseConfig table |
| WorkQueueManager.ts | Integrate CircuitBreaker before dispatch |
| StuckJobWatchdog.ts | Update imports to use sub-modules |
| recovery.ts | Update imports |

---

## Phase 1: Break the Circular Dependency (Tasks 1-3)

### Task 1: Extract AgentConfig.ts with shared constants and types

**Files:**
- Create: src/server/orchestrator/AgentConfig.ts
- Modify: src/server/orchestrator/AgentRunner.ts
- Modify: src/server/orchestrator/PtyManager.ts

- [x] Step 1: Read AgentRunner.ts lines 55-168 to get exact SYSTEM_PROMPT, HOOK_SETTINGS, RunOptions, CLAUDE, CODEX, MCP_PORT, LOGS_DIR, HOOK_SCRIPT values
- [x] Step 2: Create AgentConfig.ts with those constants. Include re-exports.
- [x] Step 3: Update AgentRunner.ts to import from AgentConfig and re-export for backward compatibility
- [x] Step 4: Update PtyManager.ts to import constants from AgentConfig (SYSTEM_PROMPT, HOOK_SETTINGS) instead of AgentRunner
- [x] Step 5: Run tests: npx vitest run (all must pass)
- [x] Step 6: Commit: "refactor: extract AgentConfig.ts to begin breaking circular dependency"

### Task 2: Move readClaudeMd, buildMemorySection, cancelledAgents to AgentConfig

**Files:**
- Modify: src/server/orchestrator/AgentConfig.ts
- Modify: src/server/orchestrator/AgentRunner.ts
- Modify: src/server/orchestrator/PtyManager.ts

- [ ] Step 1: Read readClaudeMd (AgentRunner line 1035) and buildMemorySection (line 1120). Move to AgentConfig.ts
- [ ] Step 2: Move cancelledAgents Set to AgentConfig.ts
- [ ] Step 3: Re-export from AgentRunner for backward compatibility
- [ ] Step 4: Update PtyManager.ts: import readClaudeMd, buildMemorySection, cancelledAgents from AgentConfig
- [ ] Step 5: Run tests and commit: "refactor: move shared functions to AgentConfig"

### Task 3: Move ensureCodexTrusted to AgentConfig, break circular dep

**Files:**
- Modify: src/server/orchestrator/AgentConfig.ts
- Modify: src/server/orchestrator/AgentRunner.ts
- Modify: src/server/orchestrator/PtyManager.ts

- [ ] Step 1: Read ensureCodexTrusted from PtyManager.ts. Move to AgentConfig.ts
- [ ] Step 2: Update AgentRunner.ts to import from AgentConfig instead of PtyManager
- [ ] Step 3: Update PtyManager.ts to import from AgentConfig
- [ ] Step 4: Verify: grep for 'from.*PtyManager' in AgentRunner.ts should return nothing
- [ ] Step 5: Run tests and commit: "refactor: break AgentRunner-PtyManager circular dependency"

---

## Phase 2: Explicit Agent Lifecycle State Machine (Tasks 4-5)

### Task 4: Create AgentLifecycle.ts

**Files:**
- Create: src/server/orchestrator/AgentLifecycle.ts
- Create: src/test/agent-lifecycle.test.ts

- [x] Step 1: Write tests: normal lifecycle, invalid transitions, activeCount, countInState, Spawning->Failed, Attaching->Polling
- [x] Step 2: Run tests to verify they fail
- [x] Step 3: Implement AgentState enum (Spawning, Attaching, Running, Polling, Exiting, Done, Failed) and AgentStateManager class with transition validation. Terminal states auto-clean from map.
- [x] Step 4: Run tests to verify they pass
- [x] Step 5: Commit: "feat: add explicit AgentState enum and AgentStateManager"

### Task 5: Integrate AgentStateManager into PtyManager

**Files:**
- Modify: src/server/orchestrator/PtyManager.ts
- Modify: src/test/pty-manager.test.ts (if test helpers reference _spawningAgents)

- [ ] Step 1: Replace _spawningAgents Set with AgentStateManager instance
- [ ] Step 2: Replace all _spawningAgents.add/delete/has/size with state transitions
- [ ] Step 3: Update checkPtyResourceAvailability to use agentStates.countInState
- [ ] Step 4: Update test helpers (_seedSpawningAgentForTest, _isAgentSpawningForTest)
- [ ] Step 5: Run full test suite and commit: "refactor: replace _spawningAgents with AgentStateManager"

---

## Phase 3: Decompose PtyManager (Tasks 6-11)

### Task 6: Extract PtyResourceManager.ts

- [ ] Step 1: Write tests for resource checks (concurrency cap, backoff, tmux count)
- [ ] Step 2: Extract MAX_PTY_SESSIONS, backoff state, checkPtyResourceAvailability (parameterized)
- [ ] Step 3: Update PtyManager.ts to use PtyResourceManager
- [ ] Step 4: Run tests and commit: "refactor: extract PtyResourceManager"

### Task 7: Extract PtyDiskLogger.ts

- [ ] Step 1: Extract path helpers, FD management, fsync timer, snapshot capture, readTextTail
- [ ] Step 2: Update PtyManager imports
- [ ] Step 3: Run tests and commit: "refactor: extract PtyDiskLogger"

### Task 8: Extract JobFinalizer.ts

- [ ] Step 1: Extract standalone job resolution, ndjson parsing, exit polling, cost extraction
- [ ] Step 2: Move _standaloneExitPolls, all finalization functions
- [ ] Step 3: Update PtyManager imports
- [ ] Step 4: Run tests and commit: "refactor: extract JobFinalizer"

### Task 9: Extract AgentSpawner.ts

- [ ] Step 1: Extract buildAgentScript (pure function from startInteractiveAgent)
- [ ] Step 2: Extract buildInteractivePrompt
- [ ] Step 3: Extract spawnTmuxSession
- [ ] Step 4: Rewrite startInteractiveAgent as thin orchestrator calling the above
- [ ] Step 5: Run tests and commit: "refactor: extract AgentSpawner, decompose startInteractiveAgent"

### Task 10: Extract PtySessionManager.ts

- [ ] Step 1: Extract attachPty, _ptys Map, _ptyBuffers, _pendingResizes
- [ ] Step 2: Extract disconnect, writeInput, resize, getPtyBuffer, isTmuxSessionAlive, cleanupStaleTmuxSessions
- [ ] Step 3: Wire up AgentStateManager transitions in attach/disconnect paths
- [ ] Step 4: Run tests and commit: "refactor: extract PtySessionManager"

### Task 11: Convert PtyManager.ts to thin facade

- [ ] Step 1: Replace PtyManager.ts body with re-exports from sub-modules
- [ ] Step 2: Verify PtyManager.ts is under 100 lines
- [ ] Step 3: Verify no file exceeds 350 lines
- [ ] Step 4: Run full test suite
- [ ] Step 5: Commit: "refactor: PtyManager is now a thin facade"

---

## Phase 4: WorkflowManager Recovery Cleanup (Tasks 12-14)

### Task 12: Extract WorkflowRecovery.ts with idempotent recovery helper

- [ ] Step 1: Write tests for tryAcquireRecoverySlot (acquired, active_duplicate, stale_exhausted)
- [ ] Step 2: Implement WorkflowRecovery.ts with RecoveryKeys builders and tryAcquireRecoverySlot
- [ ] Step 3: Rewrite handleFailedJob to use tryAcquireRecoverySlot (eliminates 3x duplication)
- [ ] Step 4: Run tests and commit: "refactor: extract WorkflowRecovery helper"

### Task 13: Extract WorkflowPhaseConfig.ts

- [ ] Step 1: Write tests for getPhaseConfig (all 4 phases, unknown phase throws)
- [ ] Step 2: Implement phase config lookup table
- [ ] Step 3: Replace switch statements in spawnPhaseJob and resumeWorkflow
- [ ] Step 4: Run tests and commit: "refactor: extract WorkflowPhaseConfig lookup table"

### Task 14: Replace all inline recovery key strings with constants

- [ ] Step 1: Find all workflow note key patterns in WorkflowManager.ts
- [ ] Step 2: Add all key builders to RecoveryKeys in WorkflowRecovery.ts
- [ ] Step 3: Replace inline key construction throughout WorkflowManager.ts
- [ ] Step 4: Run tests and commit: "refactor: named recovery key constants"

---

## Phase 5: Circuit Breaker (Tasks 15-16)

### Task 15: Create CircuitBreaker.ts

- [ ] Step 1: Write tests (starts closed, opens on all-models-limited, closes on model available, opens on N infra failures, resets on success)
- [ ] Step 2: Implement CircuitBreaker class with model tracking and infra failure counting
- [ ] Step 3: Run tests and commit: "feat: add CircuitBreaker"

### Task 16: Integrate CircuitBreaker into dispatch and model classifier

- [ ] Step 1: Add breaker instance to WorkQueueManager, check in tick() before dispatch
- [ ] Step 2: Wire ModelClassifier markModelRateLimited/expiry to breaker
- [ ] Step 3: Wire job completion success/infra-failure to breaker
- [ ] Step 4: Run tests and commit: "feat: integrate CircuitBreaker into dispatch loop"

---

## Phase 6: Verification (Tasks 17-19)

### Task 17: Verify module boundaries

- [ ] Step 1: Check no file exceeds 350 lines (except AgentRunner, WorkflowManager, StuckJobWatchdog which are out of scope)
- [ ] Step 2: Check no circular dependencies: grep AgentRunner for PtyManager imports (should be zero)
- [ ] Step 3: Verify PtyManager.ts facade is under 100 lines

### Task 18: Full test suite + type check

- [ ] Step 1: npx tsc --noEmit (no type errors)
- [ ] Step 2: npx vitest run (all tests pass)
- [ ] Step 3: npm run build (clean build)

### Task 19: Create PR

- [ ] Step 1: Push branch
- [ ] Step 2: Create PR with summary of all changes and before/after metrics
