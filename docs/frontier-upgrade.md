# Frontier upgrade — 1 October 2026

## Outcome and scope

Upgrade the existing local autonomous development service in place. Keep its durable SQLite jobs, worktrees, MCP tools, independent review, recovery, and supervision. Verify the application with real provider calls and an isolated coding task before deploying to the existing LaunchAgent.

## Research and decisions

| Capability | Decision |
| --- | --- |
| Current coding/reasoning models | Opus 5.5 implements; GPT-6 Astra independently reviews workflows. GPT-6.1 Sol is the balanced Codex default; GPT-6 Luna is available for focused tasks. Sonnet 5.5 handles medium tasks and routing. Haiku remains the inexpensive classifier. |
| Model/account discovery | Read the installed Codex CLI catalog, including models advertised to ChatGPT accounts. Cache definitive account-access denials for 24 hours, automatically fall back before work starts, and expose the reason. Hide internal models, preserve catalog order, and fall back to explicit supported choices if unavailable. Never infer the default by sorting model names. |
| Long-running agents | Run unattended jobs from both providers as detached headless processes. Persist their execution mode for restart recovery, retain session IDs and file-backed logs, and keep terminal sessions for interactive work. Correct Codex resume arguments and persist the Resolver's re-block circuit across service restarts. |
| Reasoning and context | Support current maximum reasoning effort, preserve explicit job effort, and map unsupported legacy levels. Claude 5.5 already has 1M context, without a suffix. Increase supervisor output allowance because thinking and tool calls share the output budget. |
| Costs | Share model pricing between dashboard and server; correct cached-input double counting and nested Claude usage. Deduplicate Claude content blocks using durable per-message usage and reconcile final output/reasoning tokens from the terminal result. Store a conservative standard-price estimate for Codex completions. Subscription billing and premium service tiers can differ. |
| Managed/cloud agents | Current managed runtimes are viable for a future remote worker pool. This release retains local repository access and the existing MCP/state contracts; migrating state, secrets, execution and worktrees to a new service would not itself improve this deployment's reliability. |
| Tool calling, browser/computer use, parallelism | Existing coding harnesses provide tool execution and optional configured capabilities. Preserve the project's job graph, review boundaries and concurrency limits. Do not enable extra tools or nested parallel work globally without task-level need. |
| Production access | Add an HttpOnly browser session and protect Socket.io with the same credentials as the API. Bind HTTP/MCP to loopback by default. Keep bearer tokens working for CLI clients. |
| Deployment | Build the SQL schema and revision metadata into the artifact. Correct static-client serving. Extend the existing CI for both TypeScript projects, tests and self-contained production builds. Start only prebuilt releases, preserving the current environment/database. |

## Implementation checklist

- [x] Current model catalog, role defaults, routing and effort handling.
- [x] Shared pricing and corrected usage parsing.
- [x] Correct Codex session resume invocation and quoted shell launcher arguments.
- [x] Durable Resolver re-block detection with operator reset and expiry.
- [x] Browser sign-in and authenticated socket access.
- [x] Self-contained production build and CI.
- [x] Full regression suite and live provider/harness verification.
- [x] Prepare release checks and rollback backup procedure. Deployment status is recorded in the [release PR](https://github.com/barney-personal/autodev/pull/45).

## Validation and rollout

Use the existing production credentials without copying or printing them. Existing jobs and workflows retain their pinned models. Use a disposable repository for coding/MCP smoke tests. Before the live restart, verify the queue is idle, back up the SQLite database, preserve the previous build, and check that the primary checkout has no conflicting tracked edits. Fast-forward the release, restart `com.barney.autodev`, verify the revision at `/api/health`, check authentication and assets, and test task completion. Roll back the build/revision if startup or smoke checks fail; the new execution-mode/resume columns and usage ledger are additive and backwards compatible.

### Acceptance results

- TypeScript checks and production build passed. All **1,918 tests across 131 files** passed locally.
- Real Opus 5.5 and GPT-6 Astra coding tasks fixed an isolated repository, passed its tests, wrote an MCP note and called `finish_job`.
- This installed CLI advertises GPT-6.1 Sol, but the current ChatGPT account rejects it. A live task automatically retried on GPT-6 Astra and passed. Advertised availability is therefore treated as a hint, not proof of access.
- Browser sign-in, authenticated API/socket access, dynamic model picker, assets and health checks passed.
- A running Opus 5.5 process survived a graceful server restart, reattached to its existing log/session, reconnected to MCP, and completed the coding task. Shutdown also closes upgraded WebSocket connections before draining HTTP.
- Reproduce infrastructure checks with `node --env-file=.env scripts/check-live.mjs`. Run a paid, isolated coding acceptance test with `node --env-file=.env scripts/smoke-agent.mjs`; optionally set `SMOKE_MODEL` and `AUTODEV_URL`.
- These are integration checks, not a comparative coding benchmark. Existing model pins and the three historically blocked production workflows are preserved.

### Deployment boundary

This release targets the existing local LaunchAgent. HTTP and MCP now bind to loopback by default. A remote/container installation must set its bind addresses deliberately and keep MCP on a trusted interface. Reverse proxies must preserve the original Host; proxy termination is not configured by this release. Browser sessions expire after seven days; logout clears that browser's cookie, and rotating AUTH_TOKEN revokes all existing cookies. Use a high-entropy token as in the existing deployment.

## Sources

- [OpenAI model catalog](https://developers.openai.com/api/docs/models) — current model roles and prices.
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) — model-dependent reasoning and state continuity.
- [OpenAI agent runtime options](https://developers.openai.com/api/docs/guides/agents) — managed agents, SDKs, and direct Responses integrations.
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) — coding harness integration.
- [Claude model catalog](https://platform.claude.com/docs/en/models/overview) — current models and prices.
- [Claude Opus 5.5 migration](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) — always-on thinking, tool choice, context and output-budget compatibility.

The model-specific GPT-6 migration page could not be fetched after retry. Migration mechanics were cross-checked against the bundled OpenAI Docs guidance and the installed CLI's help/catalog; current model IDs and prices came from the live official catalog.
