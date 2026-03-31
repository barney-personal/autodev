// ─── Domain Types ───────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';
export type AgentStatus = 'starting' | 'running' | 'waiting_user' | 'done' | 'failed' | 'cancelled';
export type QuestionStatus = 'pending' | 'answered' | 'timeout';
export type DebateStatus = 'running' | 'consensus' | 'disagreement' | 'failed' | 'cancelled';
export type DebateRole = 'claude' | 'codex' | 'post_action' | 'verification_review' | 'verification_response';
export type RetryPolicy = 'none' | 'same' | 'analyze';
export type WarningType = 'stalled' | 'high_turns' | 'long_running';
export type ReviewStatus = 'pending_review' | 'approved' | 'needs_revision';
export type WorkflowStatus = 'running' | 'complete' | 'blocked' | 'failed' | 'cancelled';
export type WorkflowPhase = 'idle' | 'assess' | 'review' | 'implement';

export interface Job {
  id: string;
  title: string;
  description: string;
  context: string | null; // JSON string of extra k/v context
  status: JobStatus;
  priority: number;
  work_dir: string | null;
  max_turns: number;
  model: string | null;       // e.g. "claude-opus-4-6", null = auto-classify
  template_id: string | null; // FK → templates.id
  depends_on: string | null;  // JSON array of job IDs this job must wait for
  flagged: number;            // 0=not flagged, 1=flagged for review
  is_interactive: number;     // 0=batch, 1=interactive tmux session
  use_worktree: number;       // 0=normal, 1=create git worktree
  project_id: string | null;  // FK → projects.id
  debate_id: string | null;   // FK → debates.id
  debate_loop: number | null;  // which loop iteration this job belongs to (0-based)
  debate_round: number | null;
  debate_role: DebateRole | null;
  scheduled_at: number | null;
  repeat_interval_ms: number | null;
  retry_policy: RetryPolicy;
  max_retries: number;
  retry_count: number;
  original_job_id: string | null;
  completion_checks: string | null; // JSON array of check names
  review_config: string | null;         // JSON: ReviewConfig
  review_status: ReviewStatus | null;
  review_parent_job_id: string | null;  // for review jobs, links to parent
  created_by_agent_id: string | null;   // agent that created this job via create_job MCP tool
  pre_debate_id: string | null;         // FK → debates.id — job blocked until this debate finishes
  pre_debate_summary: string | null;    // debate outcome stored separately; composed at dispatch
  workflow_id: string | null;           // FK → workflows.id
  workflow_cycle: number | null;        // which cycle this job belongs to (0-based)
  workflow_phase: WorkflowPhase | null; // 'assess' | 'review' | 'implement'
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Debate {
  id: string;
  title: string;
  task: string;
  claude_model: string;
  codex_model: string;
  max_rounds: number;
  current_round: number;
  status: DebateStatus;
  consensus: string | null; // JSON summary when consensus reached
  project_id: string;
  work_dir: string | null;
  max_turns: number;
  template_id: string | null;
  post_action_prompt: string | null;  // instruction to run after debate concludes
  post_action_role: DebateRole | null; // which side's model runs the action
  post_action_job_id: string | null;  // FK → jobs.id once created
  post_action_verification: number;   // 0=off, 1=other model reviews post-action then implementer responds
  verification_review_job_id: string | null;   // FK → jobs.id for the latest review job
  verification_response_job_id: string | null; // FK → jobs.id for the latest response job
  verification_round: number;                  // current verification loop iteration (0-based)
  loop_count: number;    // total loops to run (1 = run once)
  current_loop: number;  // which debate loop we're on (0-based)
  created_at: number;
  updated_at: number;
}

export interface Workflow {
  id: string;
  title: string;
  task: string;
  work_dir: string | null;
  implementer_model: string;
  reviewer_model: string;
  max_cycles: number;
  current_cycle: number;
  current_phase: WorkflowPhase;
  status: WorkflowStatus;
  milestones_total: number;
  milestones_done: number;
  project_id: string | null;
  max_turns_assess: number;
  max_turns_review: number;
  max_turns_implement: number;
  template_id: string | null;
  use_worktree: number;
  worktree_path: string | null;
  worktree_branch: string | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface Agent {
  id: string;
  job_id: string;
  status: AgentStatus;
  pid: number | null;
  session_id: string | null;
  parent_agent_id: string | null;
  exit_code: number | null;
  error_message: string | null;
  status_message: string | null;
  output_read: number; // 0=unread, 1=read
  base_sha: string | null; // git SHA before agent started
  diff: string | null;     // git diff after agent completed
  cost_usd: number | null;    // total_cost_usd from result event
  duration_ms: number | null; // duration_ms from result event
  num_turns: number | null;   // num_turns from result event
  pending_wait_ids: string | null; // JSON array of job IDs being waited on (cleared when done)
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface ChildAgentSummary {
  id: string;
  status: AgentStatus;
  job_title: string;
  job_description: string;
}

export interface AgentWithJob extends Agent {
  job: Job;
  template_name: string | null;
  pending_question: Question | null;
  active_locks: FileLock[];
  child_agents: ChildAgentSummary[];
  warnings: AgentWarning[];
}

export interface Question {
  id: string;
  agent_id: string;
  question: string;
  answer: string | null;
  status: QuestionStatus;
  asked_at: number;
  answered_at: number | null;
  timeout_ms: number;
}

export interface FileLock {
  id: string;
  agent_id: string;
  file_path: string;
  reason: string | null;
  acquired_at: number;
  expires_at: number;
  released_at: number | null;
}

export interface AgentOutput {
  id: number;
  agent_id: string;
  seq: number;
  event_type: string;
  content: string; // Raw NDJSON line from claude stream
  created_at: number;
}

export interface AgentOutputSegment {
  agent_id: string;
  job_title: string;
  job_description: string;
  output: AgentOutput[];
  truncated?: boolean; // true when output was capped by a tail limit
}

// ─── Socket.io Event Payloads ────────────────────────────────────────────────

export interface QueueSnapshot {
  jobs: Job[];
  agents: AgentWithJob[];
  locks: FileLock[];
  templates: Template[];
  projects: Project[];
  batchTemplates: BatchTemplate[];
  debates: Debate[];
  workflows: Workflow[];
  discussions: Discussion[];
  proposals: Proposal[];
}

export interface ServerToClientEvents {
  'queue:snapshot': (payload: QueueSnapshot) => void;
  'agent:new': (payload: { agent: AgentWithJob }) => void;
  'agent:update': (payload: { agent: AgentWithJob }) => void;
  'agent:output': (payload: { agent_id: string; line: AgentOutput }) => void;
  'question:new': (payload: { question: Question }) => void;
  'question:answered': (payload: { question: Question }) => void;
  'lock:acquired': (payload: { lock: FileLock }) => void;
  'lock:released': (payload: { lock_id: string; file_path: string }) => void;
  'job:new': (payload: { job: Job }) => void;
  'job:update': (payload: { job: Job }) => void;
  'pty:data': (payload: { agent_id: string; data: string }) => void;
  'pty:closed': (payload: { agent_id: string }) => void;
  'pty:snapshot-refresh': (payload: { agent_id: string; snapshot: string }) => void;
  'debate:new': (payload: { debate: Debate }) => void;
  'debate:update': (payload: { debate: Debate }) => void;
  'workflow:new': (payload: { workflow: Workflow }) => void;
  'workflow:update': (payload: { workflow: Workflow }) => void;
  'warning:new': (payload: { warning: AgentWarning }) => void;
  'project:new': (payload: { project: Project }) => void;
  'eye:discussion:new': (payload: { discussion: Discussion; message: DiscussionMessage }) => void;
  'eye:discussion:message': (payload: { message: DiscussionMessage }) => void;
  'eye:discussion:update': (payload: { discussion: Discussion }) => void;
  'eye:proposal:new': (payload: { proposal: Proposal }) => void;
  'eye:proposal:update': (payload: { proposal: Proposal }) => void;
  'eye:proposal:message': (payload: { message: ProposalMessage }) => void;
  'eye:pr:new': (payload: { pr: Pr }) => void;
  'eye:pr-review:new': (payload: { review: PrReview }) => void;
  'eye:pr-review:update': (payload: { review: PrReview }) => void;
  'eye:pr-review:message': (payload: { message: PrReviewMessage }) => void;
}

export interface ClientToServerEvents {
  'request:snapshot': () => void;
  'pty:input': (payload: { agent_id: string; data: string }) => void;
  'pty:resize': (payload: { agent_id: string; cols: number; rows: number }) => void;
  'pty:resize-and-snapshot': (payload: { agent_id: string; cols: number; rows: number }) => void;
}

// ─── Claude stream-json event shapes ────────────────────────────────────────

export interface ClaudeStreamEvent {
  type: string;          // 'system' | 'assistant' | 'result' | 'error'
  subtype?: string;      // 'init' for system events; 'success' | 'error_during_execution' for result
  model?: string;        // present on system init events
  is_error?: boolean;    // present on result events
  result?: string;       // present on result events: the final output text or error message
  total_cost_usd?: number;  // present on result events
  duration_ms?: number;     // present on result events
  num_turns?: number;       // present on result events
  session_id?: string;
  message?: {
    model?: string;
    content: Array<{
      type: string;
      text?: string;      // for text blocks
      name?: string;      // for tool_use blocks
      id?: string;        // for tool_use blocks
      input?: unknown;    // for tool_use blocks
    }>;
    role?: string;
  };
  error?: {
    message: string;
    type?: string;
  };
}

// ─── Codex stream-json event shapes ──────────────────────────────────────────

export interface CodexStreamEvent {
  type: string;
  thread_id?: string;
  item?: {
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    id?: string;
    message?: string;
  };
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
  error?: {
    message: string;
  };
  message?: string;
}

/** Returns true for jobs that run with --print and exit naturally (no finish_job needed). */
export function isAutoExitJob(job: Pick<Job, 'debate_role' | 'workflow_phase'>): boolean {
  return !!(job.debate_role || job.workflow_phase);
}

export function isCodexModel(model: string | null): boolean {
  return model === 'codex' || (model != null && model.startsWith('codex-'));
}

/** Extract the underlying model name for the -m flag (e.g. 'codex-o3' → 'o3'). Returns null for plain 'codex'. */
export function codexModelName(model: string | null): string | null {
  if (model != null && model.startsWith('codex-')) return model.slice(6);
  return null;
}

// ─── API Request/Response shapes ─────────────────────────────────────────────

export interface CreateJobRequest {
  title?: string;
  description: string;
  context?: Record<string, string>;
  priority?: number;
  workDir?: string;
  maxTurns?: number;
  model?: string;
  templateId?: string;
  dependsOn?: string[]; // job IDs this job must wait for before running
  interactive?: boolean;
  useWorktree?: boolean;
  projectId?: string;
  repeatIntervalMs?: number;
  scheduledAt?: number;
  retryPolicy?: RetryPolicy;
  maxRetries?: number;
  completionChecks?: string[];
  reviewConfig?: ReviewConfig;
  debate?: boolean;
  debateClaudeModel?: string;
  debateCodexModel?: string;
  debateMaxRounds?: number;
}

export interface SearchResult {
  agent_id: string;
  job_id: string;
  job_title: string;
  agent_status: string;
  excerpt: string;
  seq: number;
  event_type: string;
}

export interface SubmitReplyRequest {
  answer: string;
}

// ─── Notes (shared scratchpad) ────────────────────────────────────────────────

export interface Note {
  key: string;
  value: string;
  agent_id: string | null;
  updated_at: number;
}

// ─── Templates ────────────────────────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  content: string;
  work_dir: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTemplateRequest {
  name: string;
  content: string;
  workDir?: string;
  model?: string;
}

export interface UpdateTemplateRequest {
  name?: string;
  content?: string;
  workDir?: string | null;
  model?: string | null;
}

// ─── Projects ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

// ─── Batch Templates ──────────────────────────────────────────────────────────

export interface BatchTemplate {
  id: string;
  name: string;
  items: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateBatchTemplateRequest {
  name: string;
  items: string[];
}

export interface UpdateBatchTemplateRequest {
  name?: string;
  items?: string[];
}

export interface RunBatchTemplateRequest {
  templateId?: string;
  model?: string;
  interactive?: boolean;
  useWorktree?: boolean;
  workDir?: string;
  maxTurns?: number;
  projectName?: string;
  debate?: boolean;
  claudeModel?: string;
  codexModel?: string;
  debateMaxRounds?: number;
  postActionPrompt?: string;
  postActionRole?: DebateRole;
  postActionVerification?: boolean;
}

export interface RunBatchTemplateResponse {
  project: Project;
  jobs: Job[];
  debates?: Debate[];
}

// ─── Debates ──────────────────────────────────────────────────────────────────

export interface CreateDebateRequest {
  title?: string;
  task: string;
  claudeModel: string;
  codexModel: string;
  maxRounds?: number;
  workDir?: string;
  maxTurns?: number;
  templateId?: string;
  postActionPrompt?: string;
  postActionRole?: DebateRole;
  postActionVerification?: boolean;
  loopCount?: number;
}

export interface CreateDebateResponse {
  debate: Debate;
  project: Project;
  jobs: Job[];
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export interface CreateWorkflowRequest {
  title?: string;
  task: string;
  workDir?: string;
  implementerModel?: string;
  reviewerModel?: string;
  maxCycles?: number;
  maxTurnsAssess?: number;
  maxTurnsReview?: number;
  maxTurnsImplement?: number;
  templateId?: string;
  useWorktree?: boolean;
  projectId?: string;
}

export interface CreateWorkflowResponse {
  workflow: Workflow;
  project: Project;
  jobs: Job[];
}

// ─── Agent Warnings (Feature 6) ──────────────────────────────────────────────

export interface AgentWarning {
  id: string;
  agent_id: string;
  type: WarningType;
  message: string;
  dismissed: number;
  created_at: number;
}

// ─── Worktrees (Feature 4) ──────────────────────────────────────────────────

export interface Worktree {
  id: string;
  agent_id: string;
  job_id: string;
  path: string;
  branch: string;
  created_at: number;
  cleaned_at: number | null;
}

// ─── Nudges (Feature 1) ─────────────────────────────────────────────────────

export interface Nudge {
  id: string;
  agent_id: string;
  message: string;
  delivered: number;
  created_at: number;
  delivered_at: number | null;
}

// ─── Knowledge Base (Feature 5) ──────────────────────────────────────────────

export interface KBEntry {
  id: string;
  title: string;
  content: string;
  tags: string | null;
  source: string | null;
  agent_id: string | null;
  project_id: string | null;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
}

// ─── Reviews (Feature 3) ────────────────────────────────────────────────────

export interface ReviewConfig {
  models: string[];
  auto: boolean;
}

export interface Review {
  id: string;
  parent_job_id: string;
  reviewer_job_id: string | null;
  model: string;
  verdict: string | null;
  summary: string | null;
  created_at: number;
  completed_at: number | null;
}

// ─── Template Model Stats (Feature 2) ────────────────────────────────────────

export interface TemplateModelStat {
  template_id: string | null;
  template_name: string | null;
  model: string | null;
  total: number;
  succeeded: number;
  success_rate: number;
  avg_cost: number | null;
  avg_duration_ms: number | null;
  avg_turns: number | null;
}

// ─── Eye Discussions ─────────────────────────────────────────────────────────

export type DiscussionStatus = 'open' | 'resolved' | 'stale';
export type DiscussionCategory = 'question' | 'observation' | 'alert';
export type DiscussionPriority = 'low' | 'medium' | 'high';

export interface Discussion {
  id: string;
  agent_id: string;
  topic: string;
  category: DiscussionCategory;
  priority: DiscussionPriority;
  context: string | null;
  status: DiscussionStatus;
  created_at: number;
  updated_at: number;
  needs_reply?: boolean;
}

export interface DiscussionMessage {
  id: string;
  discussion_id: string;
  role: 'eye' | 'user';
  content: string;
  requires_reply: boolean;
  created_at: number;
}

// ─── Eye Proposals ──────────────────────────────────────────────────────────

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'discussing' | 'in_progress' | 'done' | 'failed';
export type ProposalCategory = 'bug_fix' | 'product_improvement' | 'tech_debt' | 'security' | 'performance';
export type ProposalComplexity = 'trivial' | 'small' | 'medium' | 'large';

export interface Proposal {
  id: string;
  agent_id: string;
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
  estimated_complexity: ProposalComplexity;
  category: ProposalCategory;
  evidence: string | null;
  implementation_plan: string | null;
  status: ProposalStatus;
  execution_job_id: string | null;
  codex_confirmed: boolean | null;
  codex_confidence: number | null;
  codex_reasoning: string | null;
  created_at: number;
  updated_at: number;
  needs_reply?: boolean;
}

export interface ProposalMessage {
  id: string;
  proposal_id: string;
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

// ─── PRs ────────────────────────────────────────────────────────────────────

export interface Pr {
  id: string;
  url: string;
  title: string;
  description: string | null;
  proposal_id: string | null;
  status: 'draft' | 'open' | 'merged' | 'closed';
  created_at: number;
}

// ─── PR Reviews ──────────────────────────────────────────────────────────────

export interface PrReviewComment {
  file: string;
  line?: number;
  body: string;
  severity: 'info' | 'suggestion' | 'warning' | 'issue';
  codex_confirmed?: boolean;
}

export interface PrReviewMessage {
  id: string;
  review_id: string;
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

export interface PrReview {
  id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_author: string | null;
  repo: string;
  summary: string;
  comments: PrReviewComment[];
  status: 'draft' | 'submitted' | 'dismissed';
  github_review_id: string | null;
  needs_reply?: boolean;
  created_at: number;
  updated_at: number;
}

// ─── Eye Daily Summary ────────────────────────────────────────────────────────

export interface DailySummaryItem {
  timestamp: number;
  text: string;
}

export interface DailySummary {
  date: string; // YYYY-MM-DD
  items: DailySummaryItem[];
}
