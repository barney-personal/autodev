import type { Workflow } from '../../shared/types.js';

// ─── Inline Context ──────────────────────────────────────────────────────────

/** Pre-read scratchpad context passed into review/implement prompt builders. */
export interface InlineContext {
  plan?: string | null;
  contract?: string | null;
  worklogs?: Array<{ key: string; value: string }>;
}

/**
 * Hard cap per inline section (characters). Keeps prompt growth bounded even
 * when plans or worklogs accumulate across many cycles.
 */
const INLINE_CAP = 20_000;
/** Hard cap for total inline context across all sections. */
const INLINE_TOTAL_CAP = 50_000;

/** Truncate text to `cap` characters, appending a notice when truncated. */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n... (truncated at ${cap} characters — use note tools to read the full content)`;
}

/** Render inline context sections for inclusion in a prompt. */
function renderInlineContext(ctx: InlineContext, workflowId: string): string {
  const sections: string[] = [];
  const planKey = `workflow/${workflowId}/plan`;
  const contractKey = `workflow/${workflowId}/contract`;

  if (ctx.plan) {
    sections.push(`### Current Plan (from \`${planKey}\`)\n\n${capText(ctx.plan, INLINE_CAP)}`);
  }
  if (ctx.contract) {
    sections.push(`### Operating Contract (from \`${contractKey}\`)\n\n${capText(ctx.contract, INLINE_CAP)}`);
  }
  if (ctx.worklogs && ctx.worklogs.length > 0) {
    const entries = ctx.worklogs.map(w => `#### \`${w.key}\`\n\n${w.value}`);
    const combined = entries.join('\n\n');
    sections.push(`### Previous Worklogs\n\n${capText(combined, INLINE_CAP)}`);
  }

  let rendered = sections.join('\n\n');
  if (rendered.length > INLINE_TOTAL_CAP) {
    rendered = rendered.slice(0, INLINE_TOTAL_CAP) + `\n\n... (total inline context truncated at ${INLINE_TOTAL_CAP} characters)`;
  }
  return rendered;
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

export function buildWorkflowRepairPrompt(
  workflow: Workflow,
  phase: 'assess' | 'review',
  cycle: number,
  missingArtifacts: string[],
): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  const artifactList = missingArtifacts.map(a => `- \`${a}\``).join('\n');
  const writeTargets = [
    missingArtifacts.includes('plan') ? `- Write or rewrite the plan note: \`write_note("${planKey}", <plan>)\`` : null,
    missingArtifacts.includes('contract') ? `- Write or rewrite the contract note: \`write_note("${contractKey}", <contract>)\`` : null,
  ].filter(Boolean).join('\n');

  return `# Autonomous Agent Run: Repair Phase (${phase} cycle ${cycle})

You are repairing a workflow phase that finished without writing all required shared notes.
Do not implement product changes. Repair the missing workflow artifacts only.

## Task
${workflow.task}

## Working Directory
${workflow.work_dir ?? '(not specified)'}

## Missing Artifacts
${artifactList}

## Instructions
1. Read any existing workflow context first:
   - Plan: \`read_note("${planKey}")\`
   - Contract: \`read_note("${contractKey}")\`
2. Reconstruct the missing artifacts from the task and current workflow state.
3. Write only the missing artifacts back to the shared scratchpad.

## Required Writes
${writeTargets}

## Rules
- Do NOT make code changes.
- Do NOT switch branches.${workflow.worktree_branch ? `
- **You are on branch \`${workflow.worktree_branch}\`. Do NOT switch branches or checkout main.**` : ''}
- Call \`report_status\` with what you are repairing.`;
}

/**
 * Build the review phase prompt.
 * Cycle 1: plan quality review only (no code yet).
 * Cycle 2+: code quality review of the last implementation + plan update.
 */
export function buildReviewPrompt(workflow: Workflow, cycle: number, inlineCtx?: InlineContext): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  const worklogKey = `workflow/${workflow.id}/worklog/cycle-${cycle - 1}`;
  const worklogPrefix = `workflow/${workflow.id}/worklog/`;
  const isFirstReview = cycle === 1;
  const hasInline = inlineCtx && (inlineCtx.plan || inlineCtx.contract || (inlineCtx.worklogs && inlineCtx.worklogs.length > 0));

  const codeReviewSection = isFirstReview ? '' : `
## Step 2: Code Review (MOST IMPORTANT)

The implementer just completed cycle ${cycle - 1}. You must review the actual code changes before touching the plan.

1. Read the worklog for what was changed: ${hasInline ? '(provided inline below)' : `\`read_note("${worklogKey}")\``}
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
    ? `## Pre-loaded Context

The current plan, contract, and worklog entries are provided inline below — you do not need to read them via note tools.
You still have full access to \`read_note\`, \`write_note\`, and \`list_notes\` for updates and any notes not included here.

${renderInlineContext(inlineCtx!, workflow.id)}`
    : `## Step 1: Read Context

1. Read the current plan: \`read_note("${planKey}")\`
2. Read the operating contract: \`read_note("${contractKey}")\`
3. Read all worklog entries: \`list_notes("${worklogPrefix}")\` then read each one.`;

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
- Call \`report_status\` to update your progress.`;
}

/**
 * Build the implement phase prompt.
 * The agent reads the plan, implements the top unchecked milestone, and writes a worklog entry.
 */
export function buildImplementPrompt(workflow: Workflow, cycle: number, inlineCtx?: InlineContext): string {
  const planKey = `workflow/${workflow.id}/plan`;
  const contractKey = `workflow/${workflow.id}/contract`;
  const worklogKey = `workflow/${workflow.id}/worklog/cycle-${cycle}`;
  const worklogPrefix = `workflow/${workflow.id}/worklog/`;
  const hasInline = inlineCtx && (inlineCtx.plan || inlineCtx.contract || (inlineCtx.worklogs && inlineCtx.worklogs.length > 0));

  const readInstructions = hasInline
    ? `1. **Review the pre-loaded context below** — the current plan, contract, and worklogs are provided inline.
2. **Find the first unchecked milestone** (\`- [ ]\`) in the plan.`
    : `1. **Read the current plan**: \`read_note("${planKey}")\`
2. **Read the operating contract**: \`read_note("${contractKey}")\`
3. **Read previous worklog entries**: \`list_notes("${worklogPrefix}")\` then read each one to understand prior work.
4. **Find the first unchecked milestone** (\`- [ ]\`) in the plan.`;

  const implementStep = hasInline ? 3 : 5;
  const checkoffStep = hasInline ? 4 : 6;
  const worklogStep = hasInline ? 5 : 7;

  const inlineSection = hasInline
    ? `\n## Pre-loaded Context

The current plan, contract, and worklog entries are provided inline below — you do not need to read them via note tools.
You still have full access to \`read_note\`, \`write_note\`, and \`list_notes\` for updates and any notes not included here.

${renderInlineContext(inlineCtx!, workflow.id)}\n`
    : '';

  return `# Autonomous Agent Run: Implement Phase (Cycle ${cycle})

You are the IMPLEMENTER agent in a structured autonomous agent run with assess/review/implement phases.
Your task is to **implement the top unchecked milestone** from the plan.

## Task
${workflow.task}

## Working Directory
${workflow.work_dir ?? '(not specified)'}

## Instructions

${readInstructions}
${implementStep}. **Implement it**:
   - Make the necessary code changes
   - Run tests and fix any issues you introduce
   - Ensure all existing tests still pass
   - Commit with descriptive messages
${checkoffStep}. **Check off the milestone** — update the plan, changing \`- [ ]\` to \`- [x]\` for the completed milestone:
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
${inlineSection}
## Rules
- Implement only ONE milestone per cycle.
- Always lock files before editing (\`lock_files\`) and release when done (\`release_files\`).
- Use \`git add <specific files>\` — never \`git add -A\` or \`git add .\`${workflow.worktree_branch ? `
- **CRITICAL: You are on branch \`${workflow.worktree_branch}\`. Do NOT switch branches. Do NOT checkout main. All commits must go on this branch. Run \`git branch --show-current\` to verify before committing.**` : ''}
- If blocked, explain clearly in the worklog and set the "Next step" to describe what needs to happen.
- Call \`report_status\` regularly to update your progress.
- Call \`search_kb\` at the start for relevant prior knowledge.
- Call \`report_learnings\` near the end with anything useful you discovered.`;
}
