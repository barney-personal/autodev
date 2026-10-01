# Adaptive model routing

Use the lightest model that meets the task's quality bar, and keep an independent strong reviewer. Lower token prices alone are not evidence of lower cost per accepted change: retries, review findings and time to completion matter.

## Execution policy

| Work | Claude execution | Codex execution | Conditions |
| --- | --- | --- | --- |
| Explicit mechanical text/formatting edits | Haiku 4.5 | GPT-6 Luna | High confidence, low risk, clear scope |
| Focused implementation or tests | Sonnet 5.5 | GPT-6.1 Sol | High confidence, low risk, objective requirements |
| Architecture, diagnosis, sensitive changes, uncertain requests | Configured implementer | Configured implementer | Never automatically reduced |
| Corrections, failed/no-progress attempts, final milestone | Configured implementer | Configured implementer | Deterministic escalation |
| Assessment, independent review, verification, watcher interventions | Existing configuration | Existing configuration | Outside adaptive selection |

Provider choice follows the workflow's configured implementer. An unavailable efficient model escalates to balanced, then the configured implementer. Existing provider-outage recovery still applies. Explicitly selected standalone job models remain authoritative. Auto-selected standalone job retries escalate to Opus; provenance is kept in `adaptive-job/<job-id>` notes.

The classifier cannot choose arbitrary model IDs, alter reasoning settings, skip review or run tools. It emits a small validated JSON classification. Sensitive keywords and paths, missing evidence and oversized inputs are checked before calling it. Low confidence, invalid output, provider failures or missing credentials retain the strong baseline. The eight-second deadline includes the response body; a failed decision provider is cooled down for one minute. There is no extra LLM retry chain delaying dispatch.

Workflows use the original request plus the complete current milestone. Recent failed attempts, review feedback and unchanged milestone counts prevent another cheap attempt. Final completion after adaptive execution requires an independent review, including when routing is subsequently disabled. If this final review needs more implementation but the cycle budget is exhausted, the workflow blocks with a clear reason rather than silently exceeding the budget. Verification then follows the existing workflow configuration.

## Configuration and rollout

`ADAPTIVE_ROUTING_MODE=off|shadow|live` defaults to off. In shadow mode workflow recommendations are recorded but static models execute; standalone jobs retain their existing classifier. In live mode eligible workflow implementations and jobs whose model is Auto use the policy. Adaptive workflow routing takes precedence over the legacy routing brain. The legacy brain's configuration and historical records remain available.

`ADAPTIVE_ROUTING_WORKFLOW_IDS` optionally scopes workflow routing. An unset list includes all workflows; a present empty list includes none. It does not restrict standalone Auto jobs. Changes take effect when the service restarts and apply at subsequent dispatches, without interrupting running agents.

`ADAPTIVE_DECISION_MODEL` defaults to `claude-haiku-4-5-20251001`, using `ANTHROPIC_API_KEY`. Supported alternatives are `claude-sonnet-5-5`, `gemini-3.5-flash-lite`, and `gemini-3.8-flash`. Gemini uses `GEMINI_API_KEY` or `GOOGLE_API_KEY` and the official REST endpoint with a JSON schema and low thinking. A Gemini CLI OAuth login does not supply this API credential. No global CLI settings are changed. Gemini is a decision provider here; autonomous editing continues through the existing Claude/Codex runners and their file-lock enforcement.

This deployment has Anthropic API access and a Gemini CLI login, but no Gemini API key. Use Haiku for live decisions; do not claim Gemini is active until a bounded API evaluation succeeds with that credential.

## Inspecting and evaluating

- `GET /api/routing-brain/adaptive` reports mode, classifier, credential presence, cooldown and review guarantees without exposing secrets.
- `GET /api/models` includes the same adaptive status. `GET /api/system/snapshot` adds it under `routing_brain.adaptive`.
- Workflow route decisions include policy version, classification, baseline/selected models, fallback reason, latency, token counts and `costKnown`. A false cost flag means unknown, not free. Gemini spend is intentionally unknown until pricing is integrated; never count its numeric compatibility placeholder as measured savings.
- Existing workflow metrics provide phase duration and recorded agent cost. Compare accepted milestones, review corrections and total retries as well as latency. Compare equivalent tasks; unrelated milestones are not a controlled speed benchmark.
- After building, run `node --env-file=.env scripts/eval-adaptive-routing.mjs` for eight synthetic cases without creating jobs or touching project files. It fails on unsafe downgrades or zero successful provider calls and reports classification accuracy, latency and known cost. This is a regression check, not proof of coding quality across arbitrary tasks.

Rollback: set `ADAPTIVE_ROUTING_MODE=off` and restart the service. Running agents continue. Persisted adaptive completions still receive their final independent review.

## Source basis (2026-10-01)

[OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection) recommends Luna for scoped work and Sol for everyday coding, and evaluating the lightest setting that meets the quality bar. [Claude's model catalog](https://platform.claude.com/docs/en/models/overview) distinguishes Haiku's latency, Sonnet's balance and Opus's agentic capabilities. [Gemini Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) targets high-throughput work; [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) supports constrained classification. These are starting points; actual access and performance must be measured in the deployment.
