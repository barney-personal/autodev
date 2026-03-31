import { z } from 'zod';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

// ─── start_discussion ─────────────────────────────────────────────────────────

export const startDiscussionSchema = z.object({
  topic: z.string().describe('Short title shown in the sidebar'),
  message: z.string().describe('First message in the discussion thread'),
  category: z.enum(['question', 'observation', 'alert']).optional().describe('Category of discussion (default: question)'),
  priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority level (default: medium)'),
  context: z.string().optional().describe('JSON blob with references (files, PRs, issues)'),
});

export async function startDiscussionHandler(agentId: string, input: z.infer<typeof startDiscussionSchema>): Promise<string> {
  const { topic, message, category = 'question', priority = 'medium', context } = input;

  const discId = randomUUID();
  const discussion = queries.insertDiscussion({
    id: discId,
    agent_id: agentId,
    topic,
    category,
    priority,
    context: context ?? null,
  });

  const msgId = randomUUID();
  const msg = queries.insertDiscussionMessage({
    id: msgId,
    discussion_id: discId,
    role: 'eye',
    content: message,
  });

  socket.emitDiscussionNew(discussion, msg);

  return JSON.stringify({ discussion_id: discId, topic, status: 'open' });
}

// ─── check_discussions ────────────────────────────────────────────────────────

export const checkDiscussionsSchema = z.object({
  discussion_ids: z.array(z.string()).optional().describe('Check specific discussion IDs'),
  unread_only: z.boolean().optional().describe('Only return discussions with new user replies'),
});

export async function checkDiscussionsHandler(agentId: string, input: z.infer<typeof checkDiscussionsSchema>): Promise<string> {
  const { discussion_ids, unread_only } = input;

  let discussions;
  if (unread_only) {
    discussions = queries.getDiscussionsWithNewUserReplies(agentId);
  } else if (discussion_ids?.length) {
    discussions = discussion_ids
      .map(id => queries.getDiscussionById(id))
      .filter((d): d is NonNullable<typeof d> => d !== null);
  } else {
    discussions = queries.listDiscussions('open');
  }

  const results = discussions.map(d => ({
    discussion_id: d.id,
    topic: d.topic,
    category: d.category,
    priority: d.priority,
    status: d.status,
    messages: queries.getDiscussionMessages(d.id).map(m => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
    has_new_reply: queries.getDiscussionMessages(d.id).at(-1)?.role === 'user',
  }));

  return JSON.stringify(results);
}

// ─── reply_discussion ─────────────────────────────────────────────────────────

export const replyDiscussionSchema = z.object({
  discussion_id: z.string().describe('Discussion ID to reply to'),
  message: z.string().describe('Reply message content'),
  resolve: z.boolean().optional().describe('Set to true to also mark the discussion as resolved'),
  requires_user_reply: z.boolean().optional().describe('Set to true if this reply is a question or request that needs a response from the user. Default: false (most replies are informational — acknowledgments, status updates, "I will look into it" — and do NOT need a user response).'),
});

export async function replyDiscussionHandler(agentId: string, input: z.infer<typeof replyDiscussionSchema>): Promise<string> {
  const { discussion_id, message, resolve, requires_user_reply } = input;

  const discussion = queries.getDiscussionById(discussion_id);
  if (!discussion) return JSON.stringify({ error: 'Discussion not found' });

  const msgId = randomUUID();
  const msg = queries.insertDiscussionMessage({
    id: msgId,
    discussion_id,
    role: 'eye',
    content: message,
    requires_reply: requires_user_reply === true,
  });
  socket.emitDiscussionMessage(msg);

  if (resolve) {
    queries.updateDiscussion(discussion_id, { status: 'resolved' });
    const updated = queries.getDiscussionById(discussion_id)!;
    socket.emitDiscussionUpdate(updated);
  }

  if (!resolve) {
    return JSON.stringify({
      ok: true,
      discussion_id,
      resolved: false,
      ACTION_REQUIRED: 'This discussion is still OPEN. The user is waiting for follow-up. You MUST investigate and act on their request in THIS cycle — do not call finish_job without addressing what they asked. Resolve the discussion once you have completed or made meaningful progress.',
    });
  }

  return JSON.stringify({ ok: true, discussion_id, resolved: true });
}

// ─── create_proposal ──────────────────────────────────────────────────────────

export const createProposalSchema = z.object({
  title: z.string().describe('Short title for the proposal'),
  summary: z.string().describe('2-3 sentence description'),
  rationale: z.string().describe('Why this is worth doing'),
  confidence: z.number().min(0).max(1).describe('Confidence score 0-1'),
  estimated_complexity: z.enum(['trivial', 'small', 'medium', 'large']).describe('Estimated effort'),
  category: z.enum(['bug_fix', 'product_improvement', 'tech_debt', 'security', 'performance']).describe('Category'),
  evidence: z.string().optional().describe('Links/references to code, logs, issues'),
  implementation_plan: z.string().optional().describe('How you would approach the fix'),
  codex_confirmed: z.boolean().describe('Whether Codex independently confirmed this finding (required — must run Codex verification before calling this)'),
  codex_confidence: z.number().min(0).max(1).describe('Codex confidence score 0-1 from its result JSON'),
  codex_reasoning: z.string().describe('Codex reasoning from its result JSON'),
});

export async function createProposalHandler(agentId: string, input: z.infer<typeof createProposalSchema>): Promise<string> {
  const propId = randomUUID();
  const { codex_confirmed, codex_confidence, codex_reasoning, ...rest } = input;
  const proposal = queries.insertProposal({
    id: propId,
    agent_id: agentId,
    ...rest,
    codex_confirmed,
    codex_confidence,
    codex_reasoning,
  });

  socket.emitProposalNew(proposal);

  return JSON.stringify({
    proposal_id: propId,
    title: proposal.title,
    status: proposal.status,
  });
}

// ─── check_proposals ──────────────────────────────────────────────────────────

export const checkProposalsSchema = z.object({
  proposal_ids: z.array(z.string()).optional().describe('Check specific proposal IDs'),
  status_filter: z.enum(['pending', 'approved', 'rejected', 'discussing', 'in_progress', 'done']).optional(),
});

export async function checkProposalsHandler(agentId: string, input: z.infer<typeof checkProposalsSchema>): Promise<string> {
  const { proposal_ids, status_filter } = input;

  let proposals;
  if (proposal_ids?.length) {
    proposals = proposal_ids
      .map(id => queries.getProposalById(id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
  } else if (status_filter) {
    proposals = queries.listProposals(status_filter);
  } else {
    proposals = queries.listProposals().filter(p => !['done', 'rejected'].includes(p.status)); // includes 'failed'
  }

  const results = proposals.map(p => ({
    proposal_id: p.id,
    title: p.title,
    status: p.status,
    confidence: p.confidence,
    category: p.category,
    execution_job_id: p.execution_job_id,
    messages: queries.getProposalMessages(p.id).map(m => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
    has_new_reply: queries.getProposalMessages(p.id).at(-1)?.role === 'user',
  }));

  return JSON.stringify(results);
}

// ─── update_proposal ──────────────────────────────────────────────────────────

export const updateProposalSchema = z.object({
  proposal_id: z.string().describe('Proposal ID to update'),
  status: z.enum(['in_progress', 'done', 'failed']).optional().describe('New status'),
  execution_job_id: z.string().optional().describe('Job ID of the worker executing this proposal'),
});

export async function updateProposalHandler(agentId: string, input: z.infer<typeof updateProposalSchema>): Promise<string> {
  const { proposal_id, status, execution_job_id } = input;

  const proposal = queries.getProposalById(proposal_id);
  if (!proposal) return JSON.stringify({ error: 'Proposal not found' });

  const updates: Parameters<typeof queries.updateProposal>[1] = {};
  if (status !== undefined) updates.status = status;
  if (execution_job_id !== undefined) updates.execution_job_id = execution_job_id;

  queries.updateProposal(proposal_id, updates);
  const updated = queries.getProposalById(proposal_id)!;
  socket.emitProposalUpdate(updated);

  return JSON.stringify({ ok: true, proposal_id, status: updated.status });
}

// ─── report_pr ────────────────────────────────────────────────────────────────

export const reportPrSchema = z.object({
  url: z.string().describe('GitHub PR URL'),
  title: z.string().describe('PR title'),
  description: z.string().optional().describe('Short description of what the PR does'),
  proposal_id: z.string().optional().describe('Proposal ID this PR implements'),
});

export async function reportPrHandler(agentId: string, input: z.infer<typeof reportPrSchema>): Promise<string> {
  const { url, title, description, proposal_id } = input;

  const id = randomUUID();
  const pr: import('../../../shared/types.js').Pr = { id, url, title, description: description ?? null, proposal_id: proposal_id ?? null, status: 'draft', created_at: Date.now() };
  queries.upsertNote(`pr:${id}`, JSON.stringify(pr), agentId);
  socket.emitPrNew(pr);

  return JSON.stringify({ ok: true, pr_id: id, url });
}

// ─── report_pr_review ─────────────────────────────────────────────────────

export const reportPrReviewSchema = z.object({
  pr_number: z.number().describe('GitHub PR number'),
  pr_url: z.string().describe('GitHub PR URL'),
  pr_title: z.string().describe('PR title'),
  pr_author: z.string().optional().describe('PR author username'),
  repo: z.string().describe('Repository name (e.g. "owner/repo")'),
  summary: z.string().describe('Overall review summary — what this PR does and Eye assessment'),
  comments: z.array(z.object({
    file: z.string().describe('File path'),
    line: z.number().optional().describe('Line number'),
    body: z.string().describe('Review comment'),
    severity: z.enum(['info', 'suggestion', 'warning', 'issue']).describe('Comment severity'),
    codex_confirmed: z.boolean().optional().describe('Whether Codex confirmed this finding'),
  })).describe('Individual review comments on specific files/lines'),
});

export async function reportPrReviewHandler(agentId: string, input: z.infer<typeof reportPrReviewSchema>): Promise<string> {
  const { pr_number, pr_url, pr_title, pr_author, repo, summary, comments } = input;
  const commentsJson = JSON.stringify(comments);

  // Try to post a pending (draft) GitHub review — not submitted, only visible to reviewer
  let github_review_id: string | null = null;
  try {
    const [owner, repoName] = repo.split('/');
    if (owner && repoName) {
      // Build inline comments for lines that have a line number
      const inlineComments = comments
        .filter(c => c.line != null)
        .map(c => ({
          path: c.file,
          line: c.line,
          body: `**[${c.severity}]** ${c.codex_confirmed ? '✓ Codex confirmed · ' : ''}${c.body}`,
        }));
      // Comments without a line number go into the review body
      const bodyComments = comments.filter(c => c.line == null);
      let fullBody = summary;
      if (bodyComments.length > 0) {
        fullBody += '\n\n---\n' + bodyComments.map(c =>
          `**[${c.severity}]** \`${c.file}\`${c.codex_confirmed ? ' ✓ Codex confirmed' : ''}\n${c.body}`
        ).join('\n\n');
      }
      const payload = JSON.stringify({ body: fullBody, comments: inlineComments });
      const result = execSync(
        `gh api --method POST /repos/${owner}/${repoName}/pulls/${pr_number}/reviews --input -`,
        { input: payload, encoding: 'utf-8', timeout: 30_000 }
      );
      const ghReview = JSON.parse(result);
      github_review_id = String(ghReview.id);
    }
  } catch (err: any) {
    console.warn('[report_pr_review] GitHub pending review failed:', err?.message ?? err);
  }

  const existing = queries.getPrReviewByPrNumber(pr_number, repo);
  if (existing) {
    queries.updatePrReview(existing.id, { summary, comments: commentsJson, github_review_id: github_review_id ?? existing.github_review_id });
    const updated = queries.getPrReviewById(existing.id)!;
    socket.emitPrReviewUpdate(updated);
    return JSON.stringify({ ok: true, review_id: existing.id, pr_number, github_review_id: updated.github_review_id });
  }

  const id = randomUUID();
  const review = queries.insertPrReview({
    id, pr_number, pr_url, pr_title,
    pr_author: pr_author ?? null, repo, summary,
    comments: commentsJson, github_review_id,
  });
  socket.emitPrReviewNew(review);
  return JSON.stringify({ ok: true, review_id: id, pr_number, github_review_id });
}

// ─── check_pr_reviews ─────────────────────────────────────────────────────────

export const checkPrReviewsSchema = z.object({
  unread_only: z.boolean().optional().describe('Only return reviews with new user replies (default: false)'),
  review_ids: z.array(z.string()).optional().describe('Check specific review IDs'),
});

export async function checkPrReviewsHandler(agentId: string, input: z.infer<typeof checkPrReviewsSchema>): Promise<string> {
  const { unread_only, review_ids } = input;

  let reviews: any[];
  if (review_ids?.length) {
    reviews = review_ids.map(id => queries.getPrReviewById(id)).filter(Boolean);
  } else if (unread_only) {
    reviews = queries.getPrReviewsWithNewUserReplies();
  } else {
    reviews = queries.listPrReviews().filter(r => r.status === 'draft');
  }

  const results = reviews.map(r => ({
    review_id: r.id,
    pr_number: r.pr_number,
    pr_title: r.pr_title,
    repo: r.repo,
    status: r.status,
    github_review_id: r.github_review_id,
    messages: queries.getPrReviewMessages(r.id).map((m: any) => ({
      role: m.role, content: m.content, created_at: m.created_at,
    })),
    has_new_reply: queries.getPrReviewMessages(r.id).at(-1)?.role === 'user',
  }));

  return JSON.stringify(results);
}

// ─── reply_pr_review ──────────────────────────────────────────────────────────

export const replyPrReviewSchema = z.object({
  review_id: z.string().describe('PR review ID to reply to'),
  message: z.string().describe('Reply message to the user about this review'),
  updated_comments: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    body: z.string(),
    severity: z.enum(['info', 'suggestion', 'warning', 'issue']),
    codex_confirmed: z.boolean().optional(),
  })).optional().describe('Updated comment list — replaces all comments if provided'),
});

export async function replyPrReviewHandler(agentId: string, input: z.infer<typeof replyPrReviewSchema>): Promise<string> {
  const { review_id, message, updated_comments } = input;

  const review = queries.getPrReviewById(review_id);
  if (!review) return JSON.stringify({ error: 'PR review not found' });

  const msg = queries.insertPrReviewMessage({ id: randomUUID(), review_id, role: 'eye', content: message });
  socket.emitPrReviewMessage(msg);

  if (updated_comments) {
    queries.updatePrReview(review_id, { comments: JSON.stringify(updated_comments) });
    const updated = queries.getPrReviewById(review_id)!;
    socket.emitPrReviewUpdate(updated);
  }

  return JSON.stringify({ ok: true, review_id });
}

// ─── update_daily_summary ─────────────────────────────────────────────────────

export const updateDailySummarySchema = z.object({
  items: z.array(z.string()).describe('Bullet-point items to add to today\'s summary'),
  replace: z.boolean().optional().describe('If true, replace all existing items for today (use for end-of-day cleanup to keep only the most important items)'),
});

export async function updateDailySummaryHandler(agentId: string, input: z.infer<typeof updateDailySummarySchema>): Promise<string> {
  const { items, replace } = input;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  const key = `summary:${date}`;

  let existing: { date: string; items: { timestamp: number; text: string }[] } = { date, items: [] };
  const note = queries.getNote(key);
  if (note?.value) {
    try { existing = JSON.parse(note.value); } catch { /* start fresh */ }
  }

  const timestamp = Date.now();
  const newItems = items.map(text => ({ timestamp, text }));
  const merged = replace ? newItems : [...existing.items, ...newItems];

  queries.upsertNote(key, JSON.stringify({ date, items: merged }), agentId);
  return JSON.stringify({ ok: true, date, total_items: merged.length });
}

// ─── reply_proposal ───────────────────────────────────────────────────────────

export const replyProposalSchema = z.object({
  proposal_id: z.string().describe('Proposal ID to reply to'),
  message: z.string().describe('Reply message content'),
  update_plan: z.string().optional().describe('Updated implementation plan based on feedback'),
});

export async function replyProposalHandler(agentId: string, input: z.infer<typeof replyProposalSchema>): Promise<string> {
  const { proposal_id, message, update_plan } = input;

  const proposal = queries.getProposalById(proposal_id);
  if (!proposal) return JSON.stringify({ error: 'Proposal not found' });

  const msgId = randomUUID();
  const msg = queries.insertProposalMessage({
    id: msgId,
    proposal_id,
    role: 'eye',
    content: message,
  });
  socket.emitProposalMessage(msg);

  if (update_plan) {
    queries.updateProposal(proposal_id, { implementation_plan: update_plan });
    const updated = queries.getProposalById(proposal_id)!;
    socket.emitProposalUpdate(updated);
  }

  const refreshed = queries.getProposalById(proposal_id)!;
  if (refreshed.status === 'approved') {
    return JSON.stringify({
      ok: true,
      proposal_id,
      status: refreshed.status,
      ACTION_REQUIRED: 'This proposal is APPROVED. You MUST execute it in this cycle — call update_proposal({proposal_id, status:"in_progress"}), spawn a worker job with create_job, link it with update_proposal({proposal_id, execution_job_id}), and wait_for_jobs until it completes. Do NOT call finish_job without executing.',
    });
  }
  if (refreshed.status === 'discussing') {
    return JSON.stringify({
      ok: true,
      proposal_id,
      status: refreshed.status,
      ACTION_REQUIRED: 'This proposal is still in DISCUSSING state. The user is expecting follow-up. You MUST either take concrete action on it this cycle or explicitly ask for their approval — do NOT call finish_job without making progress.',
    });
  }

  return JSON.stringify({ ok: true, proposal_id });
}
