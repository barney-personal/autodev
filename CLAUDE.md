# Hurlicane

## Setup

When asked to set up or install this project, run the following steps in order. Check each prerequisite and install if missing, then install npm dependencies.

### 1. Check Node.js (requires >= 22)

```bash
node --version
```

If not installed or too old, install via [nvm](https://github.com/nvm-sh/nvm) or directly from nodejs.org:

```bash
# macOS with Homebrew
brew install node
```

### 2. Check tmux

```bash
which tmux || echo "MISSING: tmux not found"
```

Install if missing:

```bash
# macOS
brew install tmux
# Ubuntu/Debian
sudo apt install tmux
```

### 3. Check C++ build tools (required for node-pty)

```bash
# macOS
xcode-select -p || xcode-select --install
# Ubuntu/Debian
which make || sudo apt install build-essential python3
```

### 4. Check Claude Code CLI

```bash
which claude || echo "MISSING: claude not found"
```

Install if missing:

```bash
npm install -g @anthropic-ai/claude-code
```

### 5. Install npm dependencies

```bash
npm install
```

### 6. Verify setup

```bash
node --version   # should be >= 22
which tmux
which claude
ls node_modules | head -5
```

If everything looks good, start the server with:

```bash
npm run dev
```

Then open http://localhost:3456.

---

## Dev Commands

- `npm run dev` — start server (port 3456) + Vite dev server concurrently, both with hot reload
- `npm run build` — compile TypeScript and bundle client for production
- `npm run server:start` — run production build
- `npm test` — run tests
- `npm run test:watch` — watch mode tests

## Architecture

- Server: Express + Socket.io on :3456; MCP server on :3947
- Client: React 18 + Vite
- Database: SQLite via `node:sqlite` experimental (auto-created at `data/orchestrator.db`)
- Agents: spawned as `claude --print --output-format stream-json --verbose` subprocesses (or `codex exec --json` for Codex models)

## Key Subsystems

### Autonomous Agent Runs (Workflows)

Structured multi-cycle assess/review/implement loops. Created via `POST /api/workflows` or the `create_autonomous_agent_run` MCP tool.

- **Assess phase** — implementer scans codebase, writes plan with checkboxes to shared notes
- **Review phase** — reviewer validates plan (cycle 1) or reviews code changes (cycle 2+)
- **Implement phase** — implementer works on top unchecked milestone, writes worklog
- All phases share a git worktree and branch; PR auto-created on completion
- Resume blocked workflows from a specific phase/cycle via `POST /api/workflows/:id/resume`

### Eye (Autonomous Monitoring)

Background agent that monitors the codebase on a configurable cycle. Communicates through discussions, proposals (with Codex verification), and PR reviews. Configured from the Eye panel in the dashboard.

### MCP Tools

Agents connect to the MCP server on :3947 and have access to: `ask_user`, `lock_files`, `release_files`, `check_file_locks`, `report_status`, `create_job`, `create_autonomous_agent_run`, `wait_for_jobs`, `finish_job`, `write_note`, `read_note`, `list_notes`, `watch_notes`, `search_kb`, `report_learnings`, plus Eye tools (`start_discussion`, `check_discussions`, `reply_discussion`, `create_proposal`, `check_proposals`, `reply_proposal`, `update_proposal`, `report_pr`, `report_pr_review`, `check_pr_reviews`, `reply_pr_review`, `update_daily_summary`) and integration tools (`query_linear`, `query_logs`, `query_db`, `query_ci_logs`).

### File Locking

A `PreToolUse` hook (`scripts/check-lock-hook.mjs`) blocks Edit/Write tool calls unless the agent holds a DB lock for that file. This applies to all Claude Code sessions running in this directory, including interactive ones.

To manually acquire a lock for direct edits while the orchestrator is running:

```bash
AGENT_ID="$ORCHESTRATOR_AGENT_ID"
FILE="/absolute/path/to/file"
LOCK_ID=$(node -e "const {randomUUID}=require('crypto');console.log(randomUUID())")
NOW=$(node -e "console.log(Date.now())")
EXPIRES=$(node -e "console.log(Date.now()+300000)")
sqlite3 data/orchestrator.db \
  "INSERT INTO file_locks (id,agent_id,file_path,reason,acquired_at,expires_at,released_at) VALUES ('$LOCK_ID','$AGENT_ID','$FILE','manual',$NOW,$EXPIRES,NULL);"

# ... make your edits ...

sqlite3 data/orchestrator.db \
  "UPDATE file_locks SET released_at=$(node -e 'console.log(Date.now())') WHERE id='$LOCK_ID';"
```

## Project Structure

```
src/
  client/              React + Vite dashboard
  server/
    api/               REST endpoints (jobs, agents, workflows, debates, eye, templates, projects, etc.)
    db/                SQLite init, schema, query helpers
    mcp/               MCP server and tool implementations
      tools/           Individual tool handlers (createAutonomousAgentRun, notes, integrations, etc.)
    orchestrator/      Core orchestration logic
      AgentRunner        Spawn Claude/Codex subprocesses
      WorkQueueManager   Job dispatcher (2s poll)
      WorkflowManager    Assess/review/implement cycle engine
      WorkflowPrompts    Phase-specific prompt generation
      AutonomousAgentRunManager  Create workflows via MCP or API
      PrCreator          Auto-create GitHub PRs from worktrees
      DebateManager      Multi-round debate engine
      StuckJobWatchdog   Detect dead agents, reconnect MCP sessions
      HealthMonitor      Stalled/high-turn/long-running warnings
      FailureClassifier  Classify failures (rate_limit, provider_overload, etc.)
      ModelClassifier    Auto-classify task complexity -> model
      RetryManager       Retry policies (none, same, analyze)
      MemoryTriager      Triage reported learnings
      EyeConfig          Eye configuration and targets
      PtyManager         Pseudo-terminal for interactive sessions
      FileLockRegistry   File lock coordination with deadlock detection
    socket/            Socket.io event broadcasting
    integrations/      GitHubPoller for PR tracking
  shared/
    types.ts           Types shared between server and client
scripts/
  check-lock-hook.mjs Pre-tool-use hook enforcing file locks
data/
  orchestrator.db     SQLite database (auto-created)
  agent-logs/         NDJSON output and stderr logs per agent
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | HTTP + UI server port |
| `MCP_PORT` | `3947` | MCP tool server port |
| `DB_PATH` | `data/orchestrator.db` | SQLite database location |
| `CLAUDE_BIN` | `$(which claude)` | Path to Claude Code CLI |
| `ORCHESTRATOR_AGENT_ID` | *(auto)* | Agent identity for lock hook |
| `ORCHESTRATOR_API_URL` | `http://localhost:3456` | Base URL for lock verification |
| `ANTHROPIC_API_KEY` | — | Required for model auto-classification |
| `SENTRY_DSN` | — | Optional error tracking |
