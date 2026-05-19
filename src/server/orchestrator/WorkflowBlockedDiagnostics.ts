/**
 * Blocked state detection, diagnostic file writing, recovery hints, and
 * write-note diagnostic analysis for the workflow engine.
 * Extracted from WorkflowManager.ts.
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import * as queries from '../db/queries.js';
import type { Job, Workflow } from '../../shared/types.js';

// ─── Write-Note Diagnostic ───────────────────────────────────────────────────

export type WriteNoteDiagnostic =
  | { status: 'never_called' }
  | { status: 'called_successfully' }
  | { status: 'called_but_failed'; failureSummary: string };

/**
 * Inspect agent NDJSON output for `write_note` tool calls and matching results.
 * Returns a classification of whether write_note was never called, called but
 * failed with an MCP error, or called and appeared to succeed.
 */
export function diagnoseWriteNoteInOutput(job: Job): WriteNoteDiagnostic {
  try {
    const agents = queries.getAgentsWithJobByJobId(job.id);
    if (agents.length === 0) return { status: 'never_called' };

    const writeNoteToolIds = new Set<string>();
    const errorResults: string[] = [];

    for (const agent of agents) {
      const output = queries.getAgentOutput(agent.id);

      for (const row of output) {
        if (row.event_type !== 'assistant') continue;
        try {
          const ev = JSON.parse(row.content);
          if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
          for (const block of ev.message.content) {
            if (
              block.type === 'tool_use' &&
              typeof block.name === 'string' &&
              (block.name === 'write_note' || block.name === 'mcp__orchestrator__write_note') &&
              typeof block.id === 'string'
            ) {
              writeNoteToolIds.add(block.id);
            }
          }
        } catch { /* skip malformed */ }
      }

      for (const row of output) {
        if (row.event_type !== 'user') continue;
        try {
          const ev = JSON.parse(row.content);
          if (ev.type !== 'user' || !Array.isArray(ev.message?.content)) continue;
          for (const block of ev.message.content) {
            if (
              block.type === 'tool_result' &&
              typeof block.tool_use_id === 'string' &&
              writeNoteToolIds.has(block.tool_use_id) &&
              block.is_error === true
            ) {
              const content = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content) && block.content[0]?.text)
                  ? String(block.content[0].text)
                  : JSON.stringify(block.content ?? '');
              errorResults.push(content.slice(0, 200));
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    if (writeNoteToolIds.size === 0) return { status: 'never_called' };
    if (errorResults.length > 0) return { status: 'called_but_failed', failureSummary: errorResults[0] };
    return { status: 'called_successfully' };
  } catch {
    return { status: 'never_called' };
  }
}

export function formatWriteNoteDiagnostic(diag: WriteNoteDiagnostic): string {
  switch (diag.status) {
    case 'never_called':
      return 'write_note was never called — the agent may have stopped before reaching the tool call. Focus on calling write_note to persist the plan.';
    case 'called_successfully':
      return 'write_note was called and did not error — the plan content may have been malformed or used the wrong key. Verify the note key and plan format.';
    case 'called_but_failed':
      return `write_note was called but returned an MCP error: "${diag.failureSummary}". Focus on resolving the MCP connectivity issue before writing the note.`;
  }
}

// ─── Blocked Diagnostic File Writing ────────────────────────────────────────

export const BLOCKED_LOG_DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data', 'blocked-diagnostics');

export function writeBlockedDiagnostic(workflow: Workflow): void {
  if (process.env.VITEST) return;
  mkdirSync(BLOCKED_LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${ts}_${workflow.id.slice(0, 8)}.md`;

  const jobs = queries.getJobsForWorkflow(workflow.id);
  const recentJobs = jobs.slice(-10);
  const failedJobs = jobs.filter((j: Job) => j.status === 'failed');
  const recentFailed = failedJobs.slice(-5);

  const LOG_DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data', 'agent-logs');
  const failedDetails = recentFailed.map((j: Job) => {
    const agents = queries.getAgentsWithJobByJobId(j.id);
    const agent = agents[0];

    let logTail = '';
    if (agent) {
      try {
        const logPath = path.join(LOG_DIR, `${agent.id}.ndjson`);
        const raw = readFileSync(logPath, 'utf8');
        const lines = raw.trim().split('\n').slice(-30);
        const relevant = lines.map(line => {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'error' || parsed.error) return `[ERROR] ${parsed.error ?? JSON.stringify(parsed)}`;
            if (parsed.type === 'assistant' && parsed.message?.content) {
              const texts = parsed.message.content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text);
              if (texts.length > 0) return texts.join('\n').slice(-500);
            }
            if (parsed.type === 'result' && parsed.result) return `[RESULT] ${JSON.stringify(parsed.result).slice(0, 300)}`;
            return null;
          } catch { return `[RAW] ${line.slice(0, 200)}`; }
        }).filter(Boolean);
        logTail = relevant.slice(-10).join('\n');
      } catch { /* log not available */ }
    }

    return {
      job_id: j.id.slice(0, 8),
      title: j.title,
      phase: j.workflow_phase,
      model: j.model,
      error: agent?.error_message ?? 'no agent error recorded',
      exit_code: agent?.exit_code,
      turns: agent?.num_turns,
      cost: agent?.cost_usd,
      agent_id: agent?.id?.slice(0, 8) ?? 'n/a',
      logTail,
    };
  });

  let planSnippet = '';
  try {
    const plan = queries.getNote(`workflow/${workflow.id}/plan`);
    if (plan) planSnippet = plan.value.slice(0, 3000);
  } catch { /* ignore */ }

  let worklogSnippet = '';
  try {
    const notes = queries.listNotes(`workflow/${workflow.id}/worklog`);
    if (notes.length > 0) {
      const latest = notes.sort((a, b) => b.updated_at - a.updated_at)[0];
      worklogSnippet = latest.value.slice(0, 2000);
    }
  } catch { /* ignore */ }

  let routingDecisionsBlock = '';
  try {
    const decisions = queries.getRouteDecisionsForWorkflow(workflow.id);
    if (decisions.length > 0) {
      const last5 = decisions.slice(-5);
      const rows = last5.map(r => {
        const d = r.decision;
        const reviewer = d.skipReview ? 'skipped' : (d.reviewerModel ?? '-');
        const rationale = (d.rationale ?? '').replace(/\s+/g, ' ').slice(0, 200);
        return `| ${r.cycle} | ${r.phase} | ${r.mode} | ${d.implementerModel || '-'} | ${reviewer} | ${d.confidence} | ${rationale} |`;
      }).join('\n');
      routingDecisionsBlock = `\n## Routing decisions (last 5 cycles)\n| Cycle | Phase | Mode | Implementer | Reviewer | Confidence | Rationale |\n|-------|-------|------|-------------|----------|------------|-----------|\n${rows}\n`;
    }
  } catch { /* ignore */ }

  let gitState = '';
  if (workflow.worktree_path) {
    try {
      const status = execSync('git status --short', { cwd: workflow.worktree_path, timeout: 5000 }).toString().trim();
      const lastCommit = execSync('git log --oneline -3', { cwd: workflow.worktree_path, timeout: 5000 }).toString().trim();
      gitState = `### Working tree status\n\`\`\`\n${status || '(clean)'}\n\`\`\`\n\n### Last 3 commits\n\`\`\`\n${lastCommit}\n\`\`\``;
    } catch { gitState = '(git state unavailable)'; }
  }

  const md = `# Workflow Blocked Diagnostic

## Summary
- **Title:** ${workflow.title}
- **ID:** ${workflow.id}
- **Blocked at:** ${new Date().toISOString()}
- **Reason:** ${workflow.blocked_reason ?? 'unknown'}
- **Phase:** ${workflow.current_phase}
- **Cycle:** ${workflow.current_cycle}/${workflow.max_cycles}
- **Milestones:** ${workflow.milestones_done}/${workflow.milestones_total}
- **Implementer model:** ${workflow.implementer_model}
- **Reviewer model:** ${workflow.reviewer_model}
- **Worktree:** ${workflow.worktree_path ?? 'none'} (branch: ${workflow.worktree_branch ?? 'none'})

## Job History (last 10)
| ID | Phase | Status | Model | Title |
|----|-------|--------|-------|-------|
${recentJobs.map((j: Job) => `| ${j.id.slice(0, 8)} | ${j.workflow_phase ?? '-'} | ${j.status} | ${j.model ?? '-'} | ${j.title} |`).join('\n')}

## Failed Jobs (last 5 with details)
${failedDetails.length === 0 ? 'No failed jobs.' : failedDetails.map(f => `### ${f.title}
- **Job ID:** ${f.job_id} | **Agent ID:** ${f.agent_id}
- **Phase:** ${f.phase} | **Model:** ${f.model}
- **Exit code:** ${f.exit_code ?? 'n/a'} | **Turns used:** ${f.turns ?? 'n/a'} | **Cost:** $${f.cost?.toFixed(2) ?? 'n/a'}
- **DB Error:**
\`\`\`
${f.error}
\`\`\`
- **Agent output (last lines):**
\`\`\`
${f.logTail || '(no log output available)'}
\`\`\`
`).join('\n')}

## Total Job Stats
- Total: ${jobs.length}
- Done: ${jobs.filter((j: Job) => j.status === 'done').length}
- Failed: ${failedJobs.length}
- Cancelled: ${jobs.filter((j: Job) => j.status === 'cancelled').length}
- Success rate: ${jobs.length > 0 ? Math.round(100 * jobs.filter((j: Job) => j.status === 'done').length / jobs.length) : 0}%

## Git State
${gitState || '(no worktree configured)'}
${routingDecisionsBlock}

## Latest Worklog Entry
\`\`\`
${worklogSnippet || '(no worklog found)'}
\`\`\`

## Plan (truncated)
\`\`\`
${planSnippet || '(no plan note found)'}
\`\`\`
`;

  writeFileSync(path.join(BLOCKED_LOG_DIR, filename), md, 'utf8');
  console.log(`[workflow] wrote blocked diagnostic: ${filename}`);
}
