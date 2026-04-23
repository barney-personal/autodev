# Autodev

> **Warning:** This project is experimental and under active development. APIs, features, and behavior may change without notice. Use at your own risk.

A web-based orchestrator for running multiple Claude Code (and Codex) agents in parallel. Agents coordinate through file locks, spawn sub-agents, share data via a scratchpad, learn from past tasks through a persistent knowledge base, and run structured autonomous workflows — all visible in a real-time dashboard.

## Requirements

- **Node.js >= 22** — uses the experimental `node:sqlite` module
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** — install via npm, then find your binary with `which claude`
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **tmux** — required for interactive sessions
  ```bash
  # macOS
  brew install tmux
  # Ubuntu/Debian
  sudo apt install tmux
  ```
- **C++ build tools** — needed to compile the `node-pty` native addon
  ```bash
  # macOS — install Xcode Command Line Tools if not already present
  xcode-select --install
  # Ubuntu/Debian
  sudo apt install build-essential python3
  ```
- **sqlite3 CLI** — needed only if you want to manually acquire file locks (see below)
  ```bash
  # macOS
  brew install sqlite
  # Ubuntu/Debian
  sudo apt install sqlite3
  ```
- **[Codex CLI](https://github.com/openai/codex)** *(optional)* — only needed if you want to run OpenAI Codex agents
  ```bash
  npm install -g @openai/codex
  ```

## Setup

```bash
npm install
```

If your Claude binary is somewhere else, set `CLAUDE_BIN`:

```bash
export CLAUDE_BIN=/path/to/claude
```

## Starting the Server

```bash
npm run dev
```

This starts the Express + Socket.io server on port 3456 and the Vite dev server concurrently, both with hot reload.

Open **http://localhost:3456** in your browser.

For production:

```bash
npm run build
npm run server:start
```

## Autonomous Agent Runs

Autonomous agent runs are structured multi-cycle workflows that alternate between an **implementer** (Claude) and a **reviewer** (Codex or another model) to complete complex tasks. Each cycle progresses through three phases:

1. **Assess** (cycle 0 only) — the implementer scans the codebase, writes a plan with concrete milestones as checkboxes
2. **Review** — the reviewer validates the plan (cycle 1) or reviews the latest code changes (cycle 2+), running tests and checking quality
3. **Implement** — the implementer works on the top unchecked milestone, commits changes, checks it off, and writes a worklog entry

### Creating an Autonomous Agent Run

**From the dashboard:** Click **New Autonomous Agent Run** in the header. Fill in:

- **Task** — the work to accomplish (required)
- **Title** — auto-generated from the task if left blank
- **Working Directory** — the repo to work in
- **Implementer Model** — which model writes code (default: Sonnet)
- **Reviewer Model** — which model reviews (default: Codex)
- **Max Cycles** — cap on assess/review/implement loops (1-50, default 10)
- **Use Worktree** — create a shared git worktree so all phases accumulate changes on one branch (recommended)
- **Template** — optional prompt template
- **Stop Modes** — per-phase stopping: `turns` (conversation turns), `budget` (dollar cap), `time` (minutes), or `completion` (milestone-based)

**Via REST API:**

```bash
curl -X POST http://localhost:3456/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Refactor the authentication layer to use JWT",
    "workDir": "/path/to/repo",
    "implementerModel": "claude-opus-4-7[1m]",
    "reviewerModel": "codex-gpt-5.5",
    "maxCycles": 10,
    "useWorktree": true
  }'
```

**Via MCP tool** (from another agent):

Agents can call `create_autonomous_agent_run` to spawn a workflow programmatically. This is useful for orchestrating complex multi-repo tasks.

### How It Works

All phases share a git worktree and communicate through shared notes:

- **Plan** — stored as `workflow/<id>/plan` with checkbox milestones (`- [ ]` unchecked, `- [x]` done)
- **Contract** — stored as `workflow/<id>/contract` with operating rules
- **Worklogs** — stored as `workflow/<id>/worklog/cycle-<N>-<phase>` after each phase

When all milestones are checked off (or max cycles reached), the workflow finalizes: pushes the branch and auto-creates a GitHub PR via `gh pr create`.

### Managing Workflows

- **Monitor** — click any workflow card to see progress, plan, worklogs, and jobs
- **Cancel** — `POST /api/workflows/:id/cancel` stops all queued jobs and cleans up the worktree
- **Resume** — `POST /api/workflows/:id/resume` restarts a blocked workflow, optionally from a specific phase or cycle:
  ```bash
  curl -X POST http://localhost:3456/api/workflows/<id>/resume \
    -H 'Content-Type: application/json' \
    -d '{"phase": "implement", "cycle": 3}'
  ```
  Use `force=true` to resume a workflow that is still marked as running (e.g., after a crash).

### Recovery & Self-Healing

Autonomous agent runs include several mechanisms that detect failures and recover automatically, so long-running workflows keep progressing without manual intervention.

**Blocked reason tracking.** Every path that blocks a workflow sets a structured `blocked_reason` explaining what went wrong and what needs to happen next. This is visible in the dashboard and returned by the API.

**Plan validation.** After the assess phase, the workflow checks that the plan note exists and contains at least one milestone checkbox. If the plan is empty or missing, a repair job is spawned to fix it. This prevents the workflow from entering the review/implement loop with nothing to work on.

**Repair jobs.** When a required artifact (plan or contract note) is missing at the start of a phase, the workflow spawns a repair agent to regenerate it. Each phase/cycle gets a budget of 2 repair attempts before the workflow blocks with a descriptive reason.

**Zero-progress detection.** Before each implement phase, the workflow snapshots how many milestones are done. After implement completes, it compares against the snapshot. Two consecutive implement cycles with no new milestones checked off block the workflow — this prevents infinite loops where the implementer runs but accomplishes nothing. The counter resets when progress is made, and `resume` clears it.

**Model fallback rotation.** When a model hits a rate limit, the workflow rotates through candidate models including extended-thinking `[1m]` variants. The candidate set is phase-aware: review phases include the reviewer model, implement phases include the implementer model. If all candidates are unavailable, the workflow blocks with a descriptive reason.

**Alternate provider fallback.** After exhausting same-model retries (budget of 3) for transient CLI failures like `codex_cli_crash` or `stdin_hang`, the workflow falls back to an alternate provider model. If no alternate is available, it blocks.

**Worktree branch verification.** Before spawning any phase job, the workflow verifies the git worktree is on the expected branch. If the checkout fails (e.g., the worktree was deleted or the branch drifted), the workflow blocks immediately rather than writing to the wrong branch. This check also runs on `resume`.

**Resume error handling.** The resume API validates the workflow state before changing status, so a failed branch check doesn't leave the workflow orphaned in a `running` state. `force=true` re-reads the workflow from the database to avoid acting on stale data. Errors return a 500 JSON response.

**Reconciliation.** On server startup, `reconcileRunningWorkflows` scans for workflows that were `running` when the server last stopped. It detects idle phases (no active job) and respawns them, and blocks workflows whose required artifacts are missing.

**Inline context.** Phase prompts pre-load the plan, contract, and recent worklogs directly into the agent's prompt (capped at 50,000 characters total). This reduces the chance of agents failing because they couldn't read a shared note.

## Using the Dashboard

### Creating a Job

Click **New Job** in the header to open the job form. Fill in:

- **Description** — the task to run (required)
- **Title** — auto-generated from the description if left blank
- **Priority** — -10 to +10; higher priority jobs are dispatched first
- **Model** — leave blank to auto-classify (see [Model Auto-Classification](#model-auto-classification)), or specify a model ID (Claude or Codex)
- **Work directory** — defaults to the server's working directory
- **Max turns** — cap on conversation turns before the agent stops
- **Stop mode** — alternative to max turns: `budget` (dollar cap), `time` (minutes), or `completion` (the agent decides when it's done, with a safety cap of 1000 turns)
- **Depends on** — job IDs that must complete first
- **Use worktree** — create an isolated git worktree for this job; a GitHub PR is auto-created on completion
- **Interactive** — run in a tmux PTY instead of batch mode
- **Context** — extra key/value data injected into the agent's prompt
- **Template** — pick a saved prompt template to pre-fill the description
- **Repeat every N seconds** — re-queue the job on a schedule after each successful completion
- **Retry policy** — what to do if the job fails (see [Retry & Completion Checks](#retry--completion-checks))
- **Completion checks** — validation rules that must pass for a job to be considered successful

Submit the form and the job enters the queue. The `WorkQueueManager` polls every 2 seconds, resolves dependencies, and dispatches queued jobs to Claude Code subprocesses.

### Watching Agent Output

Click any agent card to open its terminal panel. The **Output** tab streams the agent's JSON event log in a readable format — assistant text, tool calls, and results. The **Changes** tab shows a git diff of files modified since the agent started (if the work directory is a git repo).

Agent cards are color-coded by status:

| Color | Meaning |
|-------|---------|
| Orange | Starting or running |
| Red | Waiting for your answer |
| Blue | Interactive agent idle (waiting for your input) |
| Green | Done with unread output |
| Dim | Failed or cancelled |

### Answering Agent Questions

Agents can call `ask_user` to pause and ask you something. When this happens the agent card turns red and a prompt appears in the terminal panel. Type your answer and click **Submit** — the agent resumes immediately.

### Interactive Sessions

Set **Interactive** when creating a job to run the agent in a tmux session via a pseudo-terminal instead of batch mode. This is useful for tasks that need live terminal I/O (e.g., running a test suite, using an editor).

In interactive mode:
- The terminal panel shows raw PTY output with full scrollback
- You can send input directly to the running process
- **Disconnect** exits the session view without killing the agent
- **Continue** (after the agent finishes) sends a follow-up message to the same tmux session

### Agent Lifecycle Actions

After an agent finishes or fails, you have several options:

| Action | What it does |
|--------|-------------|
| Continue | Sends a follow-up message to the same session, preserving conversation context |
| Retry | Creates a fresh job with the same description |
| Requeue | Cancels the current run and resets the job back to queued |
| Reconnect | Re-attaches to a still-alive tmux session (useful after UI disconnects) |

### Dashboard Panels

| Button | What it does |
|--------|-------------|
| Search | Full-text search across all agent output (powered by SQLite FTS5) |
| Timeline | Gantt chart of job execution over time |
| Graph | DAG visualization of job dependencies |
| Usage | Cost breakdown and token metrics (Claude and Codex separately) |
| Templates | Create and manage reusable prompt templates |
| Batch | Create and run batch template lists |
| Debate | Set up a structured multi-round debate between two models |
| Projects | Organize jobs into named groups |
| KB | Browse, search, and manage the agent knowledge base |
| Eye | Autonomous monitoring agent — discussions, proposals, and PR reviews |
| Settings | Configure global options (e.g., max concurrent agents) |

## Projects

Jobs can be organized into **Projects** — named groups visible in the dashboard. Click **Projects** in the header to create, switch between, or delete projects. The dashboard filters to show only jobs in the active project.

Sub-agents spawned via `create_job` inherit their parent's project automatically. Batch templates, debates, and autonomous agent runs each create a new project when run.

Jobs can also be **flagged** for attention or **archived** to hide them from the default view. Use the archive view in the project selector to see archived jobs.

## Templates

**Templates** are reusable prompt skeletons that standardize how agents approach tasks. When a job uses a template, the template's content is prepended to the job description as a `## Guidelines` section, ensuring the agent follows your methodology regardless of what specific task it's given.

Templates can also set default **model** and **work directory** values that auto-fill in the job form when selected. The Templates panel shows per-template stats — success rate, average cost, average turns, and average duration broken down by model.

## Debates

**Debates** run two AI models — Claude and a Codex model — through a structured multi-round discussion on a shared task. Each round both sides independently analyze the problem and state a verdict (`agree`, `disagree`, or `partial`). When both sides agree the debate concludes with **consensus**; if the maximum number of rounds is reached without agreement it concludes with **disagreement**.

### Creating a Debate

Click **Debate** in the header and fill in:

- **Task** — the question or decision to debate
- **Claude model** — which Claude model to use
- **Codex model** — which Codex model to use
- **Max rounds** — 1-10 rounds (default 3)
- **Template** — optional prompt template to pre-fill the task
- **Post-action prompt** — if set, runs one model after the debate completes (e.g., "Implement what you agreed on")
- **Post-action role** — which side (Claude or Codex) runs the post-action
- **Verification** — if enabled and a post-action prompt is set, the other model reviews the implementation and the implementer responds with refinements
- **Loop count** — run the entire debate multiple times (for iterative refinement)

## Batch Templates

**Batch Templates** let you save a list of task descriptions and run them all at once. Click **Batch** in the header to manage templates.

When you run a batch template you can choose:

- **Normal mode** — creates one job per item in the template
- **Debate mode** — creates one full debate per item (with all debate options)
- Model, work directory, max turns, worktree, and other per-job options

All jobs (or debates) from a single batch run are grouped under a new project.

## Agent Memory & Knowledge Base

Agents build up a persistent **knowledge base** of learnings across tasks — project conventions, debugging insights, build quirks, and useful patterns. This means agents get smarter over time as they accumulate experience with your codebase.

### How It Works

1. **At the start of each task**, the agent's prompt is automatically injected with relevant KB entries for the current project under a `## Memory` section.

2. **During a task**, agents can search for past learnings:
   ```
   search_kb(query, project_id?)  — full-text search of the knowledge base
   ```

3. **At the end of a task**, agents report what they learned:
   ```
   report_learnings(learnings[])  — report up to 5 learnings with title, content, tags, and scope
   ```
   Each learning has a **scope** hint: `"project"` for repo-specific knowledge or `"global"` for universal patterns.

4. **After a job completes**, a Haiku triage pass automatically classifies each reported learning as `project`, `global`, or `discard`. It checks against existing KB entries to avoid duplicates. Learnings that survive triage are persisted to the knowledge base.

### Managing the Knowledge Base

Click **KB** in the header to open the Knowledge Base modal. From here you can:

- Browse all entries (filterable by project)
- Full-text search across entries
- Manually add, edit, or delete entries
- See which agent and job produced each entry

## Eye — Autonomous Monitoring Agent

**Eye** is a background agent that runs on a configurable cycle (default: every 2 minutes), continuously monitoring your codebase for bugs, improvements, and open pull requests. It communicates findings through three channels: discussions, proposals, and PR reviews.

Click **Eye** in the header to open the Eye panel. A badge shows the count of items awaiting your response.

### Discussions

Bidirectional conversation threads between Eye and the user. Eye can start discussions to ask questions, share observations, or raise alerts. You can also send messages to Eye from the **Send to Eye** tab.

### Proposals

Structured improvement suggestions with confidence scores, categories (`bug_fix`, `product_improvement`, `tech_debt`, `security`, `performance`), and an implementation plan. Eye must independently verify each finding with a separate Codex agent before creating a proposal.

Proposal lifecycle: `pending` -> `approved` / `rejected` / `discussing` -> `in_progress` -> `done` / `failed`

When you approve a proposal, Eye spawns a worker agent in a worktree to implement it and auto-creates a PR on completion.

### PR Reviews

Eye reviews GitHub pull requests and posts draft review comments with severity levels (`info`, `suggestion`, `warning`, `issue`). Reviews stay in draft until you submit or dismiss them from the dashboard. A GitHub poller automatically tracks PR status changes.

### Eye Panel Tabs

| Tab | Description |
|-----|-------------|
| Send to Eye | Send a message or question to Eye |
| Discussions | View and reply to discussion threads |
| Proposals | Review, approve, or reject proposals |
| PR Reviews | Review draft PR comments; submit or dismiss |
| Activity | History of Eye agent runs with cost and duration |
| Summary | Daily summary bullets from Eye's monitoring cycles |
| Config | Configure targets, prompt, repeat interval, and integrations |

### Starting & Stopping Eye

Eye is started and stopped from the Config tab. When you reply to a discussion, proposal, or PR review, Eye is automatically woken from its sleep cycle to respond promptly.

## Model Auto-Classification

When a job is created without an explicit model, a Haiku classifier analyzes the task description and assigns a model based on complexity:

| Classification | Model |
|----------------|-------|
| Simple | Haiku |
| Medium | Sonnet |
| Complex | Opus |

This keeps costs down for straightforward tasks while ensuring complex work gets the most capable model. You can always override this by specifying a model explicitly.

## Retry & Completion Checks

### Retry Policies

Jobs can be configured with a retry policy that triggers when they fail:

| Policy | Behavior |
|--------|----------|
| `none` | No retry (default) |
| `same` | Re-queues an identical copy of the failed job |
| `analyze` | Spawns a Haiku agent to diagnose the failure, then creates a refined retry with the diagnosis context |

### Completion Checks

Completion checks are validation rules that run after an agent finishes. If any check fails, the job is marked as failed (and retry policies apply):

| Check | What it validates |
|-------|-------------------|
| `diff_not_empty` | The agent actually made git changes |
| `no_error_in_output` | No error events in the agent's recent output |
| `custom_command:<cmd>` | Runs a shell command in the work directory; exit 0 = pass |

Example custom command: `custom_command:npm test` ensures tests pass before the job is considered done.

## Scheduled & Repeat Jobs

Jobs support scheduling and recurring execution:

- **Scheduled jobs** — set a future timestamp and the job stays queued until that time arrives
- **Repeat jobs** — set a repeat interval (in seconds) and the job automatically re-queues itself after each successful completion

## Git Worktree Support & Auto-PR

Enable **Use worktree** on any job or autonomous agent run to give that agent an isolated git checkout. The orchestrator runs `git worktree add` before spawning the agent and sets the agent's working directory to the new worktree.

When a worktree job or workflow completes successfully:
1. Any uncommitted changes are committed
2. The branch is pushed to the remote
3. A GitHub PR is auto-created via `gh pr create` with a generated description
4. The PR URL is stored and shown in the dashboard

For failed worktree jobs, the branch is still pushed to preserve the work.

Worktrees are created under `.orchestrator-worktrees/` relative to the repository root. They are automatically cleaned up after the job reaches a terminal state.

## Codex CLI Support

You can run [Codex](https://github.com/openai/codex) agents alongside Claude agents. Select a Codex model (e.g., `codex`, `codex-gpt-5.3-codex`) when creating a job, debate, or batch run.

- **Batch mode** — runs `codex exec --json` and parses the stream-json event format
- **Interactive mode** — launches Codex in a tmux PTY session
- **Cost tracking** — Codex spend is tracked separately from Claude and shown in the Usage panel
- **Sub-agents** — `create_job` passes the parent model down so Codex-spawned sub-jobs stay on Codex
- **Reviewer role** — Codex is the default reviewer model in autonomous agent runs

## File Locking

Agents must acquire a lock before editing a file. A pre-tool-use hook (`scripts/check-lock-hook.mjs`) enforces this — it intercepts every Edit/Write call and rejects it if the agent doesn't hold the lock for that file.

Agents use MCP tools to coordinate:

```
lock_files(files, reason)   — acquire exclusive lock(s); blocks until available
release_files(files)        — release lock(s) when done
check_file_locks()          — list all currently held locks
```

The lock registry supports **deadlock detection** — if agents form a circular wait (A waits for B, B waits for A), it detects the cycle and returns immediately so agents can release and retry. Locks have a default TTL of 10 minutes and are automatically cleaned up when an agent's job reaches a terminal state.

## Multi-Agent Orchestration

Agents can spawn and coordinate sub-agents using MCP tools:

```
create_job(description, title?, priority?, work_dir?, max_turns?, model?, depends_on?)
  -> returns { job_id, title, status }

create_autonomous_agent_run(task, title?, workDir?, implementerModel?, reviewerModel?, maxCycles?, ...)
  -> returns { autonomous_agent_run_id, title, status, project_id, assess_job_id }

wait_for_jobs(job_ids, timeout_ms?)
  -> blocks until all jobs finish; returns { job_id, status, result_text } for each
```

Agents can share data through the scratchpad:

```
write_note(key, value)
read_note(key)
list_notes(prefix?)
watch_notes(keys?, prefix?, until_value?, timeout_ms?)
  -> blocks until the specified keys exist (or a note under the prefix exists)
```

Use namespaced keys like `"results/step1"` to avoid collisions between agents. Use `watch_notes` instead of polling `read_note` — it blocks until the data is ready and wakes up automatically.

Additional coordination tools:

```
report_status(message)      — update the dashboard status shown on the agent card
finish_job(result?)         — signal task completion (automated jobs only)
search_kb(query)            — search the knowledge base for past learnings
report_learnings(learnings) — report what you learned for future agents
```

## Integration Tools

Agents have access to external system integrations via MCP tools:

| Tool | What it does |
|------|-------------|
| `query_linear` | Query the Linear API using GraphQL |
| `query_logs` | Search OpenSearch/Kubernetes logs (requires AWS SSO) |
| `query_db` | Execute read-only SQL queries against PostgreSQL |
| `query_ci_logs` | Fetch GitHub Actions CI logs for a PR, branch, or run |

These are available to all agents and are particularly useful for Eye's autonomous monitoring.

## Health Monitoring

The orchestrator includes automated health monitoring that watches for problematic agents:

| Warning | Trigger |
|---------|---------|
| Stalled | No output for more than 10 minutes |
| High turns | Agent has used 80%+ of its max turns cap |
| Long running | Agent has been running for over 60 minutes |
| Budget warning | Approaching stop_value budget limit |
| Time warning | Approaching stop_value time limit |

A **stuck job watchdog** runs every 30 seconds to detect agents whose underlying process has died but whose database status still shows running. It cleans up orphaned locks, resolves pending questions, handles disconnected MCP sessions, and restarts agents that were waiting on completed dependencies.

**Failure classification** automatically categorizes job failures (rate limit, provider overload, tool error, etc.) to support smarter retry decisions.

## Settings

Click the settings icon in the header to open the Settings modal. Currently configurable:

| Setting | Default | Description |
|---------|---------|-------------|
| Max Concurrent Agents | 20 | How many agents may run simultaneously |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | HTTP + UI server port |
| `MCP_PORT` | `3947` | MCP tool server port (agents connect here) |
| `DB_PATH` | `data/orchestrator.db` | SQLite database location |
| `CLAUDE_BIN` | `$(which claude)` | Path to the Claude Code CLI |
| `ORCHESTRATOR_AGENT_ID` | *(set automatically)* | Agent identity; used by the lock hook |
| `ORCHESTRATOR_API_URL` | `http://localhost:3456` | Base URL for lock verification |
| `ANTHROPIC_API_KEY` | — | Required for model auto-classification and memory triage |
| `SENTRY_DSN` | — | Optional error tracking |

## Project Structure

```
src/
  client/          React + Vite dashboard
  server/
    api/           REST endpoints (jobs, agents, workflows, debates, eye, templates, projects,
                   batch, knowledge-base, locks, worktrees, usage, search, settings, models)
    db/            SQLite init, schema, query helpers
    integrations/  GitHubPoller for automatic PR tracking
    mcp/           MCP server and tool implementations
      tools/       Individual tool handlers (createAutonomousAgentRun, notes, integrations,
                   lockFiles, askUser, finishJob, createJob, waitForJobs, reportStatus,
                   watchNotes, knowledgeBase, reportLearnings, eye tools)
    orchestrator/  Core orchestration logic
      AgentRunner          Spawn Claude/Codex subprocesses, handle lifecycle
      WorkQueueManager     Job dispatcher (2s poll cycle)
      WorkflowManager      Assess/review/implement cycle engine
      WorkflowPrompts      Phase-specific prompt generation
      AutonomousAgentRunManager  Create workflows via MCP or API
      PrCreator            Auto-create GitHub PRs from worktree branches
      DebateManager        Multi-round debate engine
      StuckJobWatchdog     Detect dead agents, reconnect MCP sessions
      HealthMonitor        Stalled/high-turn/long-running warnings
      FailureClassifier    Classify failures for smarter retries
      ModelClassifier      Auto-classify task complexity -> model
      RetryManager         Retry policies (none, same, analyze)
      CompletionChecks     Validate job outcomes
      MemoryTriager        Triage reported learnings (project/global/discard)
      KBConsolidator       Consolidate knowledge base entries
      EyeConfig            Eye configuration and targets
      RecoveryLedger       Track recovery events
      ResourceMonitor      System resource monitoring + queue throttling
      DbBackup             Automatic SQLite backups
      WorktreeCleanup      Clean orphaned git worktrees
      PtyManager           Pseudo-terminal for interactive sessions
      FileLockRegistry     File lock coordination with deadlock detection
      CostEstimator        Token usage and cost tracking
    socket/        Socket.io event broadcasting
  shared/
    types.ts       Types shared between server and client
scripts/
  check-lock-hook.mjs   Pre-tool-use hook that enforces file locks
data/
  orchestrator.db        SQLite database (auto-created on first run)
  agent-logs/            NDJSON output and stderr logs per agent
```
