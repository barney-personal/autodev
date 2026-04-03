import { randomUUID } from 'crypto';
import { Sentry } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { nudgeQueue } from './WorkQueueManager.js';
import type { Job, Debate, DebateRole } from '../../shared/types.js';

const MAX_VERIFICATION_ROUNDS = 10;

/**
 * Called from AgentRunner.handleAgentExit after a job's status is finalized.
 * If the job belongs to a debate, checks whether the current round is complete
 * and either advances to the next round or finalizes the debate.
 */
export function onJobCompleted(job: Job): void {
  if (!job.debate_id) return;

  try {
    _onJobCompleted(job);
  } catch (err) {
    console.error(`[debate] error handling job completion for job ${job.id}:`, err);
    Sentry.captureException(err);
  }
}

// Track jobs we've already processed to prevent the double-exit race from
// triggering duplicate spawns. Using a Set is simpler than DB-level locking
// since all calls happen in the same Node.js process (single-threaded).
const _processedJobs = new Set<string>();

/** Clear module-level dedup state. Test-only — call in beforeEach to ensure per-test independence. */
export function _resetForTest(): void {
  _processedJobs.clear();
}

function _onJobCompleted(job: Job): void {
  // Guard against double-call from PID poll + PTY onExit race
  if (_processedJobs.has(job.id)) return;
  _processedJobs.add(job.id);
  // Clean up old entries periodically to avoid unbounded growth
  if (_processedJobs.size > 500) {
    const entries = [..._processedJobs];
    for (let i = 0; i < entries.length - 200; i++) _processedJobs.delete(entries[i]);
  }

  const debate = queries.getDebateById(job.debate_id!);
  if (!debate) return;

  // Phase: post-action job completed
  if (job.debate_role === 'post_action') {
    if (job.status === 'done') {
      if (debate.post_action_verification) {
        const agentId = getAgentIdForJob(job.id);
        const postActionResult = getAgentResultOrDiff(agentId);
        spawnVerificationReview(debate, postActionResult);
      } else {
        // No verification — this loop's flow is done
        maybeStartNextLoop(debate);
      }
    }
    return;
  }

  // Phase: verification review completed → check verdict, maybe spawn response
  if (job.debate_role === 'verification_review') {
    if (job.status === 'done') {
      const reviewAgentId = getAgentIdForJob(job.id);
      const reviewResult = reviewAgentId ? queries.getAgentResultText(reviewAgentId) : null;

      const verifierVerdict = parseVerifierVerdict(reviewResult);
      if (verifierVerdict?.verdict === 'no_issues') {
        console.log(`[debate ${debate.id}] verifier found no issues at verification round ${debate.verification_round} — loop ${debate.current_loop + 1} complete`);
        maybeStartNextLoop(debate);
        return;
      }

      // Has issues (or no structured verdict) → spawn implementor response
      const postActionAgentId = debate.post_action_job_id ? getAgentIdForJob(debate.post_action_job_id) : null;
      const postActionResult = getAgentResultOrDiff(postActionAgentId);
      spawnVerificationResponse(debate, reviewResult, postActionResult);
    }
    return;
  }

  // Phase: verification response completed → check verdict, maybe loop
  if (job.debate_role === 'verification_response') {
    if (job.status === 'done') {
      const responseAgentId = getAgentIdForJob(job.id);
      const responseResult = responseAgentId ? queries.getAgentResultText(responseAgentId) : null;

      const implementorVerdict = parseImplementorVerdict(responseResult);
      if (implementorVerdict?.verdict === 'disagrees') {
        console.log(`[debate ${debate.id}] implementor disagrees at verification round ${debate.verification_round} — loop ${debate.current_loop + 1} complete`);
        maybeStartNextLoop(debate);
        return;
      }

      // Safety cap on verification rounds
      if (debate.verification_round >= MAX_VERIFICATION_ROUNDS - 1) {
        console.log(`[debate ${debate.id}] max verification rounds (${MAX_VERIFICATION_ROUNDS}) reached — loop ${debate.current_loop + 1} complete`);
        maybeStartNextLoop(debate);
        return;
      }

      // Accepted → increment verification round and spawn next review
      const newVerifRound = debate.verification_round + 1;
      const updated = queries.updateDebate(debate.id, { verification_round: newVerifRound });
      if (!updated) return;
      spawnVerificationReview(updated, responseResult);
    }
    return;
  }

  // Debate round handling — only while debate is still running
  if (debate.status !== 'running') return;

  // If this job failed, mark the whole debate as failed
  if (job.status === 'failed' || job.status === 'cancelled') {
    const updated = queries.updateDebate(debate.id, { status: 'failed' });
    if (updated) {
      socket.emitDebateUpdate(updated);
      resolvePreDebateTerminal(updated);
      maybeSpawnPostAction(updated, null, null);
    }
    console.log(`[debate ${debate.id}] marked failed due to job ${job.id} (${job.status})`);
    return;
  }

  // Check if both sides of the current round are done (scoped to current loop)
  const roundJobs = queries.getJobsForDebateRound(debate.id, debate.current_loop, debate.current_round);
  const allDone = roundJobs.length === 2 && roundJobs.every(j => j.status === 'done');
  if (!allDone) return;

  // Extract results from both sides
  const claudeJob = roundJobs.find(j => j.debate_role === 'claude');
  const codexJob = roundJobs.find(j => j.debate_role === 'codex');
  if (!claudeJob || !codexJob) return;

  const claudeAgentId = getAgentIdForJob(claudeJob.id);
  const claudeResult = claudeAgentId ? queries.getAgentResultText(claudeAgentId) : null;
  const codexAgentId = getAgentIdForJob(codexJob.id);
  const codexResult = codexAgentId ? queries.getAgentResultText(codexAgentId) : null;

  // Check for consensus
  const claudeVerdict = parseVerdict(claudeResult);
  const codexVerdict = parseVerdict(codexResult);

  if (detectConsensus(claudeVerdict, codexVerdict)) {
    const summary = claudeVerdict?.summary || codexVerdict?.summary || 'Both sides agreed.';
    const updated = queries.updateDebate(debate.id, {
      status: 'consensus',
      consensus: JSON.stringify({ summary, round: debate.current_round }),
    });
    if (updated) {
      socket.emitDebateUpdate(updated);
      resolvePreDebateTerminal(updated);
      maybeSpawnPostAction(updated, claudeResult, codexResult);
    }
    console.log(`[debate ${debate.id}] consensus at round ${debate.current_round} (loop ${debate.current_loop + 1})`);
    return;
  }

  // Check if we've hit max rounds
  const nextRound = debate.current_round + 1;
  if (nextRound >= debate.max_rounds) {
    const updated = queries.updateDebate(debate.id, { status: 'disagreement' });
    if (updated) {
      socket.emitDebateUpdate(updated);
      resolvePreDebateTerminal(updated);
      maybeSpawnPostAction(updated, claudeResult, codexResult);
    }
    console.log(`[debate ${debate.id}] max rounds reached, disagreement (loop ${debate.current_loop + 1})`);
    return;
  }

  // Create next discussion round
  createDiscussionRound(debate, nextRound, claudeResult, codexResult);
}

function getAgentIdForJob(jobId: string): string | null {
  const agents = queries.getAgentsWithJobByJobId(jobId);
  return agents.length > 0 ? agents[0].id : null;
}

function getAgentResultOrDiff(agentId: string | null): string | null {
  if (!agentId) return null;
  const text = queries.getAgentResultText(agentId);
  if (text) return text;
  const agent = queries.getAgentById(agentId);
  if (agent?.diff) return `(Agent reached max turns without producing a summary. Here is the diff of changes made)\n\n\`\`\`diff\n${agent.diff}\n\`\`\``;
  return null;
}

// ─── Pre-debate terminalization ───────────────────────────────────────────────

/**
 * Shared terminal handler for all debate end states (consensus, disagreement,
 * failed, cancelled). Builds a summary, stores it on blocked jobs via
 * pre_debate_summary (not description), emits socket updates, and logs.
 *
 * Exported so the cancel API endpoint can call it too.
 */
export function resolvePreDebateTerminal(
  debate: Debate,
  summary?: string,
): void {
  const jobs = queries.getJobsByPreDebateId(debate.id);
  if (jobs.length === 0) return;

  const enrichment = summary ?? buildEnrichmentSummary(debate);

  for (const job of jobs) {
    queries.updateJobPreDebateSummary(job.id, enrichment);
    const updated = queries.getJobById(job.id);
    if (updated) socket.emitJobUpdate(updated);
  }

  console.log(`[debate ${debate.id}] unblocked ${jobs.length} pre-debate job(s) (${debate.status})`);
}

function buildEnrichmentSummary(debate: Debate): string {
  if (debate.status === 'consensus') {
    const summary = (() => {
      if (!debate.consensus) return 'Both sides agreed.';
      try { return (JSON.parse(debate.consensus) as { summary?: string }).summary ?? 'Both sides agreed.'; } catch { return 'Both sides agreed.'; }
    })();
    return `## Debate Consensus\n${summary}`;
  }

  // disagreement, failed, or cancelled
  const lastRoundJobs = queries.getJobsForDebateRound(debate.id, debate.current_loop, debate.current_round);
  const claudeJob = lastRoundJobs.find(j => j.debate_role === 'claude');
  const codexJob = lastRoundJobs.find(j => j.debate_role === 'codex');
  const claudeResult = claudeJob ? (() => { const aid = getAgentIdForJob(claudeJob.id); return aid ? queries.getAgentResultText(aid) : null; })() : null;
  const codexResult = codexJob ? (() => { const aid = getAgentIdForJob(codexJob.id); return aid ? queries.getAgentResultText(aid) : null; })() : null;

  const claudeSummary = claudeResult ? parseVerdict(claudeResult)?.summary ?? '(no summary)' : '(no result)';
  const codexSummary = codexResult ? parseVerdict(codexResult)?.summary ?? '(no summary)' : '(no result)';
  return `## Debate Result (${debate.status})\n**Claude:** ${claudeSummary}\n**Codex:** ${codexSummary}`;
}

// ─── Loop restart ─────────────────────────────────────────────────────────────

function maybeStartNextLoop(debate: Debate): void {
  if (debate.loop_count <= 1) return;

  // Re-read from DB to get the latest state — guards against the double-exit race
  // where two completion paths call this with the same stale debate object.
  const fresh = queries.getDebateById(debate.id);
  if (!fresh) return;

  // Only advance if the debate is still on the loop we expect.
  // If another path already advanced it, fresh.current_loop > debate.current_loop.
  if (fresh.current_loop !== debate.current_loop) {
    console.log(`[debate ${debate.id}] loop already advanced (expected ${debate.current_loop}, found ${fresh.current_loop}) — skipping duplicate`);
    return;
  }

  const nextLoop = fresh.current_loop + 1;
  if (nextLoop >= fresh.loop_count) {
    console.log(`[debate ${debate.id}] all ${fresh.loop_count} loops complete`);
    return;
  }

  console.log(`[debate ${debate.id}] starting loop ${nextLoop + 1} of ${fresh.loop_count}`);

  // Reset debate state for next loop
  const updated = queries.updateDebate(debate.id, {
    current_loop: nextLoop,
    current_round: 0,
    status: 'running',
    consensus: null,
    post_action_job_id: null,
    verification_review_job_id: null,
    verification_response_job_id: null,
    verification_round: 0,
  });
  if (!updated) return;

  socket.emitDebateUpdate(updated);
  spawnInitialRoundJobs(updated);
}

// ─── Round creation ───────────────────────────────────────────────────────────

function loopPrefix(debate: Debate): string {
  return debate.loop_count > 1 ? ` L${debate.current_loop + 1}` : '';
}

/**
 * Spawns the two initial round-0 jobs for a debate (or next loop iteration).
 * Exported so debates.ts API can call it too.
 */
export function spawnInitialRoundJobs(debate: Debate): [Job, Job] {
  const prefix = loopPrefix(debate);
  const initialPrompt = buildInitialPrompt(debate);

  const claudeJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate${prefix} R0] Claude`,
    description: initialPrompt,
    context: null,
    priority: 0,
    model: debate.claude_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: 0,
    debate_role: 'claude',
  });

  const codexJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate${prefix} R0] Codex`,
    description: initialPrompt,
    context: null,
    priority: 0,
    model: debate.codex_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: 0,
    debate_role: 'codex',
  });

  socket.emitJobNew(claudeJob);
  socket.emitJobNew(codexJob);
  nudgeQueue();

  console.log(`[debate ${debate.id}] spawned initial jobs (loop ${debate.current_loop + 1}): claude=${claudeJob.id.slice(0, 8)} codex=${codexJob.id.slice(0, 8)}`);
  return [claudeJob, codexJob];
}

function createDiscussionRound(
  debate: Debate,
  round: number,
  claudePrevResult: string | null,
  codexPrevResult: string | null,
): void {
  queries.updateDebate(debate.id, { current_round: round });

  const prefix = loopPrefix(debate);
  const claudePrompt = buildDiscussionPrompt(debate, 'claude', round, claudePrevResult, codexPrevResult);
  const codexPrompt = buildDiscussionPrompt(debate, 'codex', round, codexPrevResult, claudePrevResult);

  const claudeJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate${prefix} R${round}] Claude`,
    description: claudePrompt,
    context: null,
    priority: 0,
    model: debate.claude_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: round,
    debate_role: 'claude',
  });

  const codexJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate${prefix} R${round}] Codex`,
    description: codexPrompt,
    context: null,
    priority: 0,
    model: debate.codex_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: round,
    debate_role: 'codex',
  });

  socket.emitJobNew(claudeJob);
  socket.emitJobNew(codexJob);
  nudgeQueue();

  const updated = queries.getDebateById(debate.id);
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] created round ${round} jobs (loop ${debate.current_loop + 1}): claude=${claudeJob.id.slice(0, 8)} codex=${codexJob.id.slice(0, 8)}`);
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

export function buildInitialPrompt(debate: Debate): string {
  return `# Debate Task

You are participating in a structured debate. Analyze the following task thoroughly and provide your assessment.

## Task
${debate.task}

## Instructions
1. Analyze the task carefully and provide your assessment, recommendations, or solution.
2. Be thorough and specific in your analysis.
3. At the END of your response, you MUST include a consensus block in exactly this format:

\`\`\`consensus
{"verdict": "disagree", "summary": "Brief summary of your position"}
\`\`\`

For the first round, always use "disagree" as the verdict since you haven't seen the other side's analysis yet.
The summary should be a concise (1-2 sentence) description of your key position.`;
}

function buildDiscussionPrompt(
  debate: Debate,
  role: DebateRole,
  round: number,
  ownPrevResult: string | null,
  otherPrevResult: string | null,
): string {
  const otherSide = role === 'claude' ? 'Codex' : 'Claude';

  return `# Debate Task — Round ${round} Discussion

You are participating in a structured debate (round ${round} of max ${debate.max_rounds}).

## Original Task
${debate.task}

## Your Previous Analysis
${ownPrevResult ?? '(No previous analysis available)'}

## ${otherSide}'s Previous Analysis
${otherPrevResult ?? '(No analysis available from the other side)'}

## Instructions for This Round
1. Review both analyses carefully.
2. Identify points of agreement and disagreement.
3. Refine your position based on the other side's arguments — update if they made good points.
4. Propose specific resolutions for any remaining disagreements.
5. At the END of your response, you MUST include a consensus block:

\`\`\`consensus
{"verdict": "agree"|"disagree"|"partial", "summary": "Brief summary of your current position"}
\`\`\`

Use "agree" if you fully agree with the other side's analysis and your positions have converged.
Use "partial" if you agree on most points but have remaining minor differences.
Use "disagree" if there are significant unresolved differences.`;
}

// ─── Verdict parsing ──────────────────────────────────────────────────────────

interface Verdict {
  verdict: 'agree' | 'disagree' | 'partial';
  summary: string;
}

export function parseVerdict(resultText: string | null): Verdict | null {
  if (!resultText) return null;
  const pattern = /```consensus\s*\n?([\s\S]*?)\n?\s*```/;
  const match = resultText.match(pattern);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.verdict && typeof parsed.summary === 'string') {
      return { verdict: parsed.verdict as Verdict['verdict'], summary: parsed.summary };
    }
  } catch { /* malformed JSON */ }
  return null;
}

function detectConsensus(a: Verdict | null, b: Verdict | null): boolean {
  return a?.verdict === 'agree' && b?.verdict === 'agree';
}

interface VerifierVerdict {
  verdict: 'no_issues' | 'has_issues';
  summary: string;
  issues?: string[];
}

interface ImplementorVerdict {
  verdict: 'accepted' | 'disagrees';
  summary: string;
}

function parseVerifierVerdict(resultText: string | null): VerifierVerdict | null {
  if (!resultText) return null;
  const pattern = /```verification\s*\n?([\s\S]*?)\n?\s*```/;
  const match = resultText.match(pattern);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.verdict && typeof parsed.summary === 'string') return parsed as VerifierVerdict;
  } catch { /* malformed JSON */ }
  return null;
}

function parseImplementorVerdict(resultText: string | null): ImplementorVerdict | null {
  if (!resultText) return null;
  const pattern = /```verification_response\s*\n?([\s\S]*?)\n?\s*```/;
  const match = resultText.match(pattern);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.verdict && typeof parsed.summary === 'string') return parsed as ImplementorVerdict;
  } catch { /* malformed JSON */ }
  return null;
}

// ─── Post-action and verification spawners ───────────────────────────────────

function maybeSpawnPostAction(
  debate: Debate,
  claudeResult: string | null,
  codexResult: string | null,
): void {
  if (!debate.post_action_prompt || !debate.post_action_role) {
    // No post-action configured — this loop's flow is done
    maybeStartNextLoop(debate);
    return;
  }

  const prefix = loopPrefix(debate);
  const model = debate.post_action_role === 'claude' ? debate.claude_model : debate.codex_model;
  const prompt = buildPostActionPrompt(debate, claudeResult, codexResult);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Post-Debate${prefix}] ${debate.title.slice(0, 45)}`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: null,
    debate_role: 'post_action',
  });

  socket.emitJobNew(job);
  nudgeQueue();

  const updated = queries.updateDebate(debate.id, { post_action_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned post-action job ${job.id.slice(0, 8)} (loop ${debate.current_loop + 1}, model: ${model})`);
}

function spawnVerificationReview(debate: Debate, implementationResult: string | null): void {
  if (!debate.post_action_role) return;

  const reviewerRole: DebateRole = debate.post_action_role === 'claude' ? 'codex' : 'claude';
  const reviewerModel = reviewerRole === 'claude' ? debate.claude_model : debate.codex_model;
  const implementerLabel = debate.post_action_role === 'claude' ? 'Claude' : 'Codex';

  const prefix = loopPrefix(debate);
  const roundLabel = debate.verification_round > 0 ? ` V${debate.verification_round + 1}` : '';
  const prompt = buildVerificationReviewPrompt(debate, implementationResult, implementerLabel);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Verif Review${prefix}${roundLabel}] ${debate.title.slice(0, 30)}`,
    description: prompt,
    context: null,
    priority: 0,
    model: reviewerModel,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: null,
    debate_role: 'verification_review',
  });

  socket.emitJobNew(job);
  nudgeQueue();

  const updated = queries.updateDebate(debate.id, { verification_review_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned verification review (loop ${debate.current_loop + 1}, verif round ${debate.verification_round}): ${job.id.slice(0, 8)}`);
}

function spawnVerificationResponse(
  debate: Debate,
  reviewResult: string | null,
  implementationResult: string | null,
): void {
  if (!debate.post_action_role) return;

  const implementerModel = debate.post_action_role === 'claude' ? debate.claude_model : debate.codex_model;
  const reviewerLabel = debate.post_action_role === 'claude' ? 'Codex' : 'Claude';

  const prefix = loopPrefix(debate);
  const roundLabel = debate.verification_round > 0 ? ` V${debate.verification_round + 1}` : '';
  const prompt = buildVerificationResponsePrompt(debate, reviewResult, implementationResult, reviewerLabel);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Verif Response${prefix}${roundLabel}] ${debate.title.slice(0, 27)}`,
    description: prompt,
    context: null,
    priority: 0,
    model: implementerModel,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_loop: debate.current_loop,
    debate_round: null,
    debate_role: 'verification_response',
  });

  socket.emitJobNew(job);
  nudgeQueue();

  const updated = queries.updateDebate(debate.id, { verification_response_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned verification response (loop ${debate.current_loop + 1}, verif round ${debate.verification_round}): ${job.id.slice(0, 8)}`);
}

// ─── Prompt content ───────────────────────────────────────────────────────────

function buildVerificationReviewPrompt(
  debate: Debate,
  implementationResult: string | null,
  implementerLabel: string,
): string {
  const statusLabel =
    debate.status === 'consensus' ? 'Consensus reached' :
    debate.status === 'disagreement' ? 'Max rounds reached without full agreement' :
    'Debate ended';

  const consensusSummary = (() => {
    if (!debate.consensus) return null;
    try { return (JSON.parse(debate.consensus) as { summary?: string }).summary ?? null; } catch { return null; }
  })();

  const isSubsequentRound = debate.verification_round > 0;
  const roundSuffix = isSubsequentRound ? ` (Round ${debate.verification_round + 1})` : '';

  let prompt = `# Verification Review${roundSuffix}\n\n`;
  prompt += `Your role is to review the implementation done by ${implementerLabel}`;
  if (isSubsequentRound) prompt += ` after they addressed your previous feedback`;
  prompt += `.\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Debate Outcome\n${statusLabel}.\n`;
  if (consensusSummary) prompt += `**Summary:** ${consensusSummary}\n`;
  prompt += `\n`;
  prompt += `## Implementation by ${implementerLabel}\n`;
  prompt += implementationResult ?? '(No implementation output available)';
  prompt += `\n\n`;
  if (debate.post_action_prompt) {
    prompt += `## Implementation Instructions\n`;
    prompt += `The implementer was given the following instructions (including any test/verification steps):\n\n${debate.post_action_prompt}\n\n`;
  }
  prompt += `## Your Review\n`;
  prompt += `Please review the implementation above. Examine the actual code/files in the working directory. Run any relevant tests or checks specified in the implementation instructions above. Evaluate:\n`;
  prompt += `1. **Correctness** — does the implementation address the task properly? Run the tests to confirm.\n`;
  prompt += `2. **Completeness** — is anything missing or incomplete?\n`;
  prompt += `3. **Quality** — any improvements you would suggest?\n\n`;
  prompt += `Be specific and actionable. List any concrete issues found.\n\n`;
  prompt += `At the END of your response, include a structured verdict block:\n\n`;
  prompt += `\`\`\`verification\n{"verdict": "no_issues", "summary": "brief description"}\`\`\`\n\n`;
  prompt += `or\n\n`;
  prompt += `\`\`\`verification\n{"verdict": "has_issues", "summary": "brief description", "issues": ["issue 1", "issue 2"]}\`\`\`\n\n`;
  prompt += `Use **"no_issues"** if the implementation is satisfactory.\n`;
  prompt += `Use **"has_issues"** if there are specific problems or improvements needed.`;
  return prompt;
}

function buildVerificationResponsePrompt(
  debate: Debate,
  reviewResult: string | null,
  implementationResult: string | null,
  reviewerLabel: string,
): string {
  const isSubsequentRound = debate.verification_round > 0;
  const roundSuffix = isSubsequentRound ? ` (Round ${debate.verification_round + 1})` : '';

  let prompt = `# Implementation Review Response${roundSuffix}\n\n`;
  prompt += `You previously implemented a solution after a collaborative debate. ${reviewerLabel} has reviewed your work and provided feedback.\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Your Previous Implementation\n`;
  prompt += implementationResult ?? '(No implementation output available)';
  prompt += `\n\n`;
  prompt += `## ${reviewerLabel}'s Feedback\n`;
  prompt += reviewResult ?? '(No feedback available)';
  prompt += `\n\n`;
  prompt += `## Your Action\n`;
  prompt += `Review the feedback above carefully.\n`;
  prompt += `- If you **agree**: apply the changes to your implementation.\n`;
  prompt += `- If you **disagree**: explain clearly why the current implementation is correct.\n\n`;
  prompt += `At the END of your response, include a structured verdict block:\n\n`;
  prompt += `\`\`\`verification_response\n{"verdict": "accepted", "summary": "brief description of changes made"}\`\`\`\n\n`;
  prompt += `or\n\n`;
  prompt += `\`\`\`verification_response\n{"verdict": "disagrees", "summary": "brief explanation of why you disagree"}\`\`\`\n\n`;
  prompt += `Use **"accepted"** if you agree with the feedback and have applied changes.\n`;
  prompt += `Use **"disagrees"** only if you fundamentally disagree with the reviewer's assessment.`;
  return prompt;
}

function buildPostActionPrompt(
  debate: Debate,
  claudeResult: string | null,
  codexResult: string | null,
): string {
  const statusLabel =
    debate.status === 'consensus' ? 'Consensus reached' :
    debate.status === 'disagreement' ? 'Max rounds reached without full agreement' :
    'Debate ended';

  const consensusSummary = (() => {
    if (!debate.consensus) return null;
    try { return (JSON.parse(debate.consensus) as { summary?: string }).summary ?? null; } catch { return null; }
  })();

  let prompt = `# Post-Debate Action\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Debate Outcome\n${statusLabel}.\n`;
  if (consensusSummary) prompt += `**Summary:** ${consensusSummary}\n`;
  prompt += `\n`;
  if (claudeResult) prompt += `## Claude's Final Analysis\n${claudeResult}\n\n`;
  if (codexResult) prompt += `## Codex's Final Analysis\n${codexResult}\n\n`;
  prompt += `## Your Action\n${debate.post_action_prompt}`;
  return prompt;
}
