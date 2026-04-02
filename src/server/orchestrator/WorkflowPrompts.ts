import type { Workflow } from '../../shared/types.js';

// ─── Inline Context ──────────────────────────────────────────────────────────

/** Pre-read scratchpad context to inline in review/implement prompts. */
export interface InlineWorkflowContext {
  plan?: string;
  contract?: string;
  worklogs?: Array<{ key: string; value: string }>;
  /** Diff from the last completed implement-phase agent (review prompts only). */
  recentDiff?: string;
}

/**
 * Hard cap (in characters) for the total inline context section.
 * Keeps prompt growth bounded even for workflows with many cycles.
 */
export const INLINE_CONTEXT_MAX_CHARS = 60_000;

/**
 * Extract a numeric cycle number from a worklog note key.
 * Keys like "workflow/.../worklog/cycle-3" → 3.
 * Returns NaN for non-cycle keys so they sort to the end.
 */
function extractCycleNumber(key: string): number {
  const match = key.match(/cycle-(\d+)$/);
  return match ? Number(match[1]) : NaN;
}

/**
 * Sort worklogs by numeric cycle number extracted from the note key.
 * Non-cycle keys (NaN) are placed at the end in their original relative order.
 */
export function sortWorklogsByNumericCycle(worklogs: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return [...worklogs].sort((a, b) => {
    const na = extractCycleNumber(a.key);
    const nb = extractCycleNumber(b.key);
    // Both have numeric cycles — sort numerically
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    // Non-cycle keys go after cycle keys
    if (isNaN(na) && !isNaN(nb)) return 1;
    if (!isNaN(na) && isNaN(nb)) return -1;
    // Both non-cycle — preserve original order
    return 0;
  });
}

/** Returns true only when the context object has at least one non-empty field. */
export function hasInlineContent(ctx: InlineWorkflowContext | undefined): boolean {
  if (!ctx) return false;
  if (ctx.plan) return true;
  if (ctx.contract) return true;
  if (ctx.worklogs && ctx.worklogs.length > 0) return true;
  return false;
}

/**
 * Render an inline context section if context is available.
 * Truncates to INLINE_CONTEXT_MAX_CHARS so prompt size stays bounded.
 * Returns empty string when no inline context is provided.
 */
export function renderInlineContext(ctx: InlineWorkflowContext | undefined, planKey: string, contractKey: string, worklogPrefix: string): string {
  if (!ctx) return '';
  const parts: string[] = [];

  if (ctx.plan) {
    parts.push(`### Plan (snapshot — use \`write_note("${planKey}", ...)\` to update)\n\n${ctx.plan}`);
  }
  if (ctx.contract) {
    parts.push(`### Contract\n\n${ctx.contract}`);
  }
  if (ctx.worklogs && ctx.worklogs.length > 0) {
    const sorted = sortWorklogsByNumericCycle(ctx.worklogs);
    const logEntries = sorted.map(w => `#### ${w.key}\n\n${w.value}`).join('\n\n');
    parts.push(`### Worklogs (read-only snapshots)\n\n${logEntries}`);
  }

  if (parts.length === 0) return '';

  let body = parts.join('\n\n');
  if (body.length > INLINE_CONTEXT_MAX_CHARS) {
    body = body.slice(0, INLINE_CONTEXT_MAX_CHARS) + '\n\n... (truncated — use `list_notes("' + worklogPrefix + '")` to read remaining entries)';
  }

  return `\n\n## Pre-loaded Context\n\nThe following scratchpad context has been pre-read for you. You do NOT need to call \`read_note\` for these unless you need to refresh after an update.\n\n${body}`;
}

/**
 * Hard cap (in characters) for the recent-change diff section in review prompts.
 * Large enough to be useful but bounded so prompt size stays safe.
 */
export const RECENT_DIFF_MAX_CHARS = 30_000;

/**
 * Render a "Recent Changes" section from the last implement-phase diff.
 * Only used in review prompts (cycle 2+). Returns empty string when no diff is available.
 */
export function renderRecentChanges(diff: string | undefined): string {
  if (!diff || !diff.trim()) return '';

  let body = diff;
  let truncated = false;
  if (body.length > RECENT_DIFF_MAX_CHARS) {
    body = body.slice(0, RECENT_DIFF_MAX_CHARS);
    truncated = true;
  }

  return `\n\n## Recent Changes\n\nThe following diff was captured from the last implement phase. Use this to start your code review — run \`git diff\` or \`git log\` for the complete picture.\n\n\`\`\`diff\n${body}\n\`\`\`${truncated ? '\n\n_(diff truncated at ' + RECENT_DIFF_MAX_CHARS + ' chars — run `git log --patch` for full changes)_' : ''}`;
}

/**
 * Build the assess phase prompt (cycle 0 only).
 * The agent scans the codebase, writes a plan with checkbox milestones, and stores it as a note.
 */
export function buildAssessPrompt(workflow: Workflow): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  return `# Autonomous Agent Run: Assess Phase (Cycle 0)

You are the IMPLEMENTER agent in a structured autonomous agent run with assess/review/implement phases.
Your task in this phase is to **assess the codebase and propose a plan**.

## Task
${workflow.task}

## Working Directory
${workflow.work_dir ?? '(not specified)'}

## Instructions

1. **Read the codebase** — scan the project structure, key files, tests, dependencies, and configuration.
2. **Assess quality** — note any issues, patterns, tech debt, missing tests, or areas for improvement relevant to the task.
3. **Write a plan** with concrete milestones as markdown checkboxes. Each milestone should be achievable in a single implementation cycle.

## Plan Format

Write the plan to the shared scratchpad using \`write_note\` with key \`${planKey}\`. Use this exact format:

\`\`\`markdown
# Plan

## Goal
<one-line description of what this autonomous agent run aims to achieve>

## Assessment
<brief assessment of current state relevant to the task>

## Milestones
- [ ] **M1: <title>** — <description with clear acceptance criteria>
- [ ] **M2: <title>** — <description with clear acceptance criteria>
- [ ] **M3: <title>** — <description with clear acceptance criteria>
(add as many as needed, but keep each achievable in one cycle)

## Priority Order
<which milestone to tackle first and why>

## Risks
<known risks, dependencies between milestones, or blockers>
\`\`\`

## Contract

Also write the operating contract using \`write_note\` with key \`${contractKey}\`:

\`\`\`markdown
# Autonomous Agent Run Contract
- One agent works at a time (no concurrent edits)
- Plan milestones use checkbox format: \`- [ ]\` unchecked, \`- [x]\` checked
- Worklog entries are append-only
- If blocked, explain clearly so the next agent can resolve it
- All existing tests must pass before marking a milestone complete
- Changes must be committed with descriptive messages
\`\`\`

## Important
- Use \`write_note("${planKey}", <plan content>)\` to store the plan.
- Use \`write_note("${contractKey}", <contract content>)\` to store the contract.
- Do NOT implement anything yet — this is assessment and planning only.${workflow.worktree_branch ? `
- **You are on branch \`${workflow.worktree_branch}\`. Do NOT switch branches or checkout main.**` : ''}
- Call \`report_status\` to update your progress.`;
}

/**
 * Build the review phase prompt.
 * Cycle 1: plan quality review only (no code yet).
 * Cycle 2+: code quality review of the last implementation + plan update.
 */
export function buildReviewPrompt(workflow: Workflow, cycle: number, inlineContext?: InlineWorkflowContext): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  const worklogKey = `workflow/${workflow.id}/worklog/cycle-${cycle - 1}`;
  const worklogPrefix = `workflow/${workflow.id}/worklog/`;
  const isFirstReview = cycle === 1;
  const hasInline = hasInlineContent(inlineContext);

  const codeReviewSection = isFirstReview ? '' : `
## Step 2: Code Review (MOST IMPORTANT)

The implementer just completed cycle ${cycle - 1}. You must review the actual code changes before touching the plan.

1. ${hasInline ? 'Review the worklog in the Pre-loaded Context section below.' : `Read the worklog for what was changed: \`read_note("${worklogKey}")\``}
2. In the working directory (${workflow.work_dir ?? 'project root'}), inspect the implementation:
   - Run \`git log --oneline -10\` to see recent commits
   - Run \`git diff HEAD~1\` (or \`git diff HEAD~<n>\` to cover all commits from this cycle) to see exact code changes
   - Read any new or heavily modified files in full
   - Run the test suite to check for regressions
3. **Assess code quality** — look for:
   - Correctness: does it actually satisfy the milestone's acceptance criteria?
   - Edge cases: null/undefined handling, empty arrays, concurrency, off-by-one errors
   - Error handling: are failures surfaced properly or silently swallowed?
   - Test coverage: are the new code paths tested? Are tests meaningful or just for coverage?
   - Code style and consistency with the surrounding codebase
   - Security: injection, unvalidated inputs, secrets in code
   - Performance: N+1 queries, unnecessary re-renders, blocking operations
4. **For every issue found**, add a new unchecked milestone to the plan:
   \`- [ ] **Fix: <short title>** — <specific description of what needs to change and why>\`

These fix milestones will be implemented in the next cycle. Be specific — vague feedback like "improve error handling" is not actionable.
`;

  const readContextSection = hasInline
    ? `## Step 1: Read Context

The current plan, contract, and worklogs have been pre-loaded below. Review them directly — no \`read_note\` calls needed unless you want to refresh after an update.
`
    : `## Step 1: Read Context

1. Read the current plan: \`read_note("${planKey}")\`
2. Read the operating contract: \`read_note("${contractKey}")\`
3. Read all worklog entries: \`list_notes("${worklogPrefix}")\` then read each one.
`;

  return `# Autonomous Agent Run: Review Phase (Cycle ${cycle})

You are the REVIEWER agent in a structured autonomous agent run with assess/review/implement phases.
${isFirstReview
    ? 'This is the first review — no code has been written yet. Your job is to validate and improve the initial plan.'
    : `Your primary job this cycle is to **review the code Claude just wrote** and add fix milestones for any issues. Then update the plan for the next cycle.`}

## Task
${workflow.task}

## Working Directory
${workflow.work_dir ?? '(not specified)'}

${readContextSection}
${codeReviewSection}
## Step ${isFirstReview ? 2 : 3}: Update the Plan

Rewrite the plan to reflect your review:
- Keep all checked-off milestones (\`- [x]\`) exactly as-is
- Reorder remaining unchecked milestones for maximum impact
- Remove milestones made redundant by what's been implemented
- Sharpen acceptance criteria where they were vague
- Add any new fix or improvement milestones you identified in your code review (numbered sequentially)
- Each milestone must be achievable in a single implementation cycle

Write the updated plan back: \`write_note("${planKey}", <updated plan>)\`

## Rules
- Do NOT implement anything — review and planning only.
- If the implementation was poor quality, add multiple specific fix milestones rather than vague notes.
- The implementer reads your plan directly — be precise and actionable.${workflow.worktree_branch ? `
- **You are on branch \`${workflow.worktree_branch}\`. Do NOT switch branches or checkout main.**` : ''}
- Call \`report_status\` to update your progress.${renderInlineContext(inlineContext, planKey, contractKey, worklogPrefix)}${!isFirstReview ? renderRecentChanges(inlineContext?.recentDiff) : ''}`;
}

/**
 * Build the implement phase prompt.
 * The agent reads the plan, implements the top unchecked milestone, and writes a worklog entry.
 */
export function buildImplementPrompt(workflow: Workflow, cycle: number, inlineContext?: InlineWorkflowContext): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  const worklogKey = `workflow/${workflow.id}/worklog/cycle-${cycle}`;
  const worklogPrefix = `workflow/${workflow.id}/worklog/`;
  const hasInline = hasInlineContent(inlineContext);

  const readSteps = hasInline
    ? `1. **Review the pre-loaded context** below — the current plan, contract, and prior worklogs are already included.
2. **Find the first unchecked milestone** (\`- [ ]\`) in the plan.`
    : `1. **Read the current plan**: \`read_note("${planKey}")\`
2. **Read the operating contract**: \`read_note("${contractKey}")\`
3. **Read previous worklog entries**: \`list_notes("${worklogPrefix}")\` then read each one to understand prior work.
4. **Find the first unchecked milestone** (\`- [ ]\`) in the plan.`;

  const implementStep = hasInline ? 3 : 5;
  const checkOffStep = hasInline ? 4 : 6;
  const worklogStep = hasInline ? 5 : 7;

  return `# Autonomous Agent Run: Implement Phase (Cycle ${cycle})

You are the IMPLEMENTER agent in a structured autonomous agent run with assess/review/implement phases.
Your task is to **implement the top unchecked milestone** from the plan.

## Task
${workflow.task}

## Working Directory
${workflow.work_dir ?? '(not specified)'}

## Instructions

${readSteps}
${implementStep}. **Implement it**:
   - Make the necessary code changes
   - Run tests and fix any issues you introduce
   - Ensure all existing tests still pass
   - Commit with descriptive messages
${checkOffStep}. **Check off the milestone** — update the plan, changing \`- [ ]\` to \`- [x]\` for the completed milestone:
   \`write_note("${planKey}", <updated plan with milestone checked off>)\`
${worklogStep}. **Write a worklog entry** using \`write_note("${worklogKey}", <worklog entry>)\`

## Worklog Entry Format

\`\`\`markdown
## Cycle ${cycle} — <milestone name>
**Owner:** Implementer
**Timestamp:** <current UTC timestamp>

### What changed
- <file or area>: <description of change>

### Commits
- \`<short hash>\` <commit message>

### Test results
- <test suite>: <pass count> passed, <fail count> failed

### Blockers
- <blocker description> (or "None")

### Next step
<What should happen next, or "All milestones complete" if done>
\`\`\`

## Rules
- Implement only ONE milestone per cycle.
- Always lock files before editing (\`lock_files\`) and release when done (\`release_files\`).
- Use \`git add <specific files>\` — never \`git add -A\` or \`git add .\`${workflow.worktree_branch ? `
- **CRITICAL: You are on branch \`${workflow.worktree_branch}\`. Do NOT switch branches. Do NOT checkout main. All commits must go on this branch. Run \`git branch --show-current\` to verify before committing.**` : ''}
- If blocked, explain clearly in the worklog and set the "Next step" to describe what needs to happen.
- Call \`report_status\` regularly to update your progress.
- Call \`search_kb\` at the start for relevant prior knowledge.
- Call \`report_learnings\` near the end with anything useful you discovered.${renderInlineContext(inlineContext, planKey, contractKey, worklogPrefix)}`;
}
