# Autonomous run efficiency

## Decisions — 1 October 2026

The first report-building workflow (`b72888f3-9b8b-4ded-8de2-496a76bf93d8`) was making useful progress, but its supervisor had completed 46 checks during assessment, using 57,359 uncached input tokens, 167,348 cached input tokens and 8,324 output tokens. Recorded supervisor cost at that snapshot was $1.0251. These are observations from one run, not a benchmark of model quality.

| Opportunity | Decision |
| --- | --- |
| A supervisor call for nearly every tool event | Coalesce routine tool, successful-turn and heartbeat triggers to one check per 30 seconds. Failures, warnings, initial/final checks and user requests keep their urgent path. Pending evidence is retained until the check runs. |
| Replaying every historical worklog | Include the two latest logs and an index of older note keys. Give plan, contract, log and diff-stat sections separate space limits so old content cannot crowd out the latest evidence. Require retrieval before relying on omitted details or rewriting an abbreviated note. |
| Reviews required to find two improvements | Replace the quota with evidence-based review. Approve sound plans, fix concrete gaps, and preserve independent review and verification. |
| Repeated repository discovery | Ask agents to batch independent searches, inspect the relevant entry points, and reuse supplied context. Require exact validation commands and commit references in worklogs. |
| Conflicting checkout instructions | Point phase prompts at the assigned worktree, matching the process working directory. |
| Supervision lost after restart | Preserve watcher state during manager shutdown; rehydrate it on restart. Explicit operator stops remain stopped. When configuration prevents rehydration, saved active watchers become visibly unavailable and can recover on a later configured boot. |
| Smaller models or lower reasoning effort | Defer until task-level quality evaluations demonstrate equivalence. Current implementer/reviewer model pins stay intact. |
| More parallel implementation agents | Keep the existing independent-task queue concurrency. Concurrent edits to one workflow need a separate ownership/dependency design. |
| Hard output limits or skipping tests | Keep current limits and required tests. Savings should come from redundant orchestration, not incomplete work. |

## Evidence and limits

A deterministic 12-cycle fixture with the same plan, contract and 50 evidence sentences per log produced 26,822 context characters before this change and 5,450 afterward: **79.7% less context text**. Both latest logs and every older retrieval key remained available. This does not establish a 79.7% latency or cost reduction: provider caching, reasoning, output and tool time all contribute.

Timing tests replay a busy stream and verify the 30-second bound, urgent failure/warning/completion delivery, manual checks, and invalid configuration fallback. Context tests cover oversized notes, numeric cycle ordering, retrieval paths, and retained recent evidence. Full typechecking, tests and production builds remain release gates.

`WATCHER_ROUTINE_INTERVAL_MS` defaults to `30000`; `0` restores the prior debounce-only cadence. Negative or non-finite settings use the default. The independent 45-second heartbeat still runs. No credentials, model choices or database schemas change.

OpenAI's [latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization) recommends reducing redundant requests, batching independent work and using deterministic logic where possible. Its [prompt caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching) supports preserving stable prefixes; this change leaves each coding CLI's conversation and cache behavior intact.
