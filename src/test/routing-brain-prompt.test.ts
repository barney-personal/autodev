import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRoutingBrainContext,
  renderRoutingBrainPrompt,
  truncatePlan,
  extractCurrentMilestone,
  annotateModelMenu,
  deriveRepoIdentity,
} from '../server/orchestrator/RoutingBrainPrompt.js';
import type { Workflow } from '../shared/types.js';
import * as queries from '../server/db/queries.js';
import * as agentQueries from '../server/db/agentQueries.js';

const classifierState = vi.hoisted(() => {
  const rateLimitedModels = new Set<string>();
  const isModelRateLimited = vi.fn((model: string) => rateLimitedModels.has(model));
  return { rateLimitedModels, isModelRateLimited };
});

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  KNOWN_MODELS: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6[1m]',
    'claude-opus-4-7',
    'claude-opus-4-7[1m]',
    'codex-gpt-5.5',
  ],
  isModelRateLimited: classifierState.isModelRateLimited,
}));

beforeEach(() => {
  classifierState.rateLimitedModels.clear();
  classifierState.isModelRateLimited.mockClear();
});

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const mockWorkflow: Workflow = {
  id: 'test-workflow-123',
  title: 'Test Workflow',
  task: 'Test task description',
  work_dir: '/app/autodev',
  implementer_model: 'claude-opus-4-7[1m]',
  reviewer_model: 'codex-gpt-5.5',
  max_cycles: 5,
  current_cycle: 2,
  current_phase: 'implement',
  status: 'running',
  milestones_total: 5,
  milestones_done: 1,
  project_id: null,
  max_turns_assess: 50,
  max_turns_review: 20,
  max_turns_implement: 30,
  stop_mode_assess: 'turns',
  stop_value_assess: null,
  stop_mode_review: 'turns',
  stop_value_review: null,
  stop_mode_implement: 'turns',
  stop_value_implement: null,
  template_id: null,
  use_worktree: 1,
  worktree_path: '/app/.orchestrator-worktrees/autodev/wf-test-123',
  worktree_branch: 'workflow/test-branch',
  blocked_reason: null,
  pr_url: null,
  completion_threshold: 0.8,
  start_command: null,
  max_verify_retries: 3,
  created_at: Date.now(),
  updated_at: Date.now(),
};

const mockPlan = `# Plan

## Milestones

- [x] **M1: Setup base structure** [S]
  - Initialize project
  - Create initial files

- [ ] **M2: Add context builder** [M]
  - Collect signals from DB
  - Build \`RoutingBrainContext\` payload
  - Mentioned file: \`src/server/db/queries.ts\`
  - Mentioned test: \`src/test/routing-brain.test.ts\`

- [ ] **M3: Final milestone** [L]
  - This is the last milestone
  - Should not be skipped by reviewer`;

// ─── Unit Tests for Helper Functions ────────────────────────────────────────

describe('truncatePlan', () => {
  it('should return full plan when under max chars', () => {
    const plan = 'Short plan';
    const { text, truncated } = truncatePlan(plan, 100);
    expect(text).toBe(plan);
    expect(truncated).toBe(false);
  });

  it('should truncate and mark when over max chars', () => {
    const plan = 'A'.repeat(5000);
    const { text, truncated } = truncatePlan(plan, 3000);
    expect(text.length).toBe(3000);
    expect(truncated).toBe(true);
    expect(text.startsWith('...\n')).toBe(true);
    expect(text.slice(4)).toMatch(/^A+$/);
  });

  it('should prefix with ellipsis when truncated', () => {
    const plan = 'A'.repeat(5000);
    const { text } = truncatePlan(plan, 3000);
    expect(text.startsWith('...')).toBe(true);
  });
});

describe('extractCurrentMilestone', () => {
  it('should extract the first unchecked milestone', () => {
    const milestone = extractCurrentMilestone(mockPlan);
    expect(milestone.title).toBe('Add context builder');
    expect(milestone.complexityTag).toBe('M');
    expect(milestone.raw).toContain('Add context builder');
  });

  it('should extract body bullets', () => {
    const milestone = extractCurrentMilestone(mockPlan);
    expect(milestone.bodyBullets.length).toBeGreaterThan(0);
    expect(milestone.bodyBullets).toContain('Collect signals from DB');
  });

  it('should extract mentioned file paths', () => {
    const milestone = extractCurrentMilestone(mockPlan);
    expect(milestone.mentionedPaths).toContain('src/server/db/queries.ts');
  });

  it('should extract test file mentions', () => {
    const milestone = extractCurrentMilestone(mockPlan);
    expect(milestone.mentionedTestFiles).toContain('src/test/routing-brain.test.ts');
  });

  it('should return empty milestone when no unchecked exist', () => {
    const onlyChecked = '- [x] Done\n- [x] Also done';
    const milestone = extractCurrentMilestone(onlyChecked);
    expect(milestone.title).toBeNull();
    expect(milestone.bodyBullets.length).toBe(0);
  });

  it('should extract complexity tags [S], [M], [L]', () => {
    const planS = '- [ ] Title [S] description';
    const planM = '- [ ] Title [M] description';
    const planL = '- [ ] Title [L] description';

    expect(extractCurrentMilestone(planS).complexityTag).toBe('S');
    expect(extractCurrentMilestone(planM).complexityTag).toBe('M');
    expect(extractCurrentMilestone(planL).complexityTag).toBe('L');
  });
});

describe('annotateModelMenu', () => {
  it('should return a model menu with all known models', () => {
    const menu = annotateModelMenu();
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.some(m => m.id === 'claude-opus-4-7[1m]')).toBe(true);
    expect(menu.some(m => m.id === 'claude-sonnet-4-6[1m]')).toBe(true);
  });

  it('should mark rate-limited models', () => {
    classifierState.rateLimitedModels.add('claude-sonnet-4-6[1m]');
    classifierState.rateLimitedModels.add('claude-haiku-4-5-20251001');

    const menu = annotateModelMenu();

    expect(menu.every(m => typeof m.capability === 'string')).toBe(true);
    expect(menu.every(m => typeof m.cost === 'string')).toBe(true);
    expect(menu.every(m => typeof m.rateLimited === 'boolean')).toBe(true);
    expect(menu.find(m => m.id === 'claude-sonnet-4-6[1m]')?.rateLimited).toBe(true);
    expect(menu.find(m => m.id === 'claude-haiku-4-5')?.rateLimited).toBe(true);
    expect(menu.find(m => m.id === 'claude-opus-4-7')?.rateLimited).toBe(false);
  });
});

// ─── Integration Tests for Context Builder ──────────────────────────────────

describe('buildRoutingBrainContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Mock queries to avoid DB access in tests
    vi.spyOn(queries, 'getNote').mockReturnValue({ key: `workflow/${mockWorkflow.id}/plan`, value: mockPlan, updated_at: Date.now() });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([mockWorkflow]);
  });

  it('should build context from workflow', () => {
    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 2);

    expect(context.workflow.id).toBe(mockWorkflow.id);
    expect(context.workflow.title).toBe(mockWorkflow.title);
    expect(context.workflow.repoName).toBe('autodev');
    expect(context.phase).toBe('implement');
    expect(context.cycle).toBe(2);
  });

  it('should load plan from notes', () => {
    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 2);

    expect(context.workflow.planExcerpt).toContain('M2');
    expect(context.workflow.planTruncated).toBe(false);
  });

  it('should extract current milestone', () => {
    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 2);

    expect(context.milestone.title).toBe('Add context builder');
    expect(context.milestone.complexityTag).toBe('M');
  });

  it('should return model menu with annotations', () => {
    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 2);

    expect(context.models.length).toBeGreaterThan(0);
    expect(context.models.every(m => typeof m.rateLimited === 'boolean')).toBe(true);
  });
});

// ─── Snapshot Test for Prompt Rendering ──────────────────────────────────────

describe('renderRoutingBrainPrompt', () => {
  let context: ReturnType<typeof buildRoutingBrainContext>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(queries, 'getNote').mockReturnValue({ key: `workflow/${mockWorkflow.id}/plan`, value: mockPlan, updated_at: Date.now() });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([mockWorkflow]);

    context = buildRoutingBrainContext(mockWorkflow, 'implement', 2);
  });

  it('should render system prompt deterministically', () => {
    const rendered1 = renderRoutingBrainPrompt(context);
    const rendered2 = renderRoutingBrainPrompt(context);

    expect(rendered1.system).toBe(rendered2.system);
  });

  it('should include required sections in system prompt', () => {
    const { system } = renderRoutingBrainPrompt(context);

    expect(system).toContain('routing brain');
    expect(system).toContain('implementerModel');
    expect(system).toContain('skipReview');
    expect(system).toContain('reviewerModel');
    expect(system).toContain('confidence');
    expect(system).toContain('rationale');
  });

  it('should render user prompt with all 8 sections', () => {
    const { user } = renderRoutingBrainPrompt(context);

    // Section 1: Task
    expect(user).toContain('## 1. Task');
    expect(user).toContain('Workflow context');

    // Section 2: Available models
    expect(user).toContain('## 2. Available models');
    expect(user).toContain('claude-opus-4-7');

    // Section 3: Workflow context
    expect(user).toContain('## 3. Workflow context');
    expect(user).toContain('autodev');

    // Section 4: Current milestone
    expect(user).toContain('## 4. Current milestone');
    expect(user).toContain('Add context builder');

    // Section 5: Prior-cycle telemetry
    expect(user).toContain('## 5. Prior-cycle telemetry');

    // Section 6: Cross-workflow priors
    expect(user).toContain('## 6. Cross-workflow priors');

    // Section 7: Hard guardrails
    expect(user).toContain('## 7. Hard guardrails');

    // Section 8: Output
    expect(user).toContain('## 8. Output');
  });

  it('should mark guardrail constraints about final milestones', () => {
    const { user } = renderRoutingBrainPrompt(context);

    expect(user).toContain('final');
    expect(user).toContain('config.yaml');
    expect(user).toContain('package.json');
  });

  it('should include plan excerpt in user prompt', () => {
    const { user } = renderRoutingBrainPrompt(context);

    expect(user).toContain(mockPlan);
  });

  it('should snapshot match for fixed context', () => {
    const rendered = renderRoutingBrainPrompt(context);

    expect(rendered).toMatchSnapshot();
  });
});

// ─── Edge Cases and Robustness ─────────────────────────────────────────────

describe('routing-brain-prompt: edge cases', () => {
  it('should handle workflow with null work_dir', () => {
    const workflow = { ...mockWorkflow, work_dir: null };
    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([workflow]);

    const context = buildRoutingBrainContext(workflow, 'implement', 0);
    expect(context.workflow.repoName).toBeDefined();
  });

  it('should handle empty plan gracefully', () => {
    vi.spyOn(queries, 'getNote').mockReturnValue(null);
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([mockWorkflow]);

    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 0);
    expect(context.milestone.title).toBeNull();
    expect(context.workflow.planExcerpt).toBe('');
  });

  it('should handle very large plan with truncation', () => {
    const hugePlan = 'A'.repeat(10000) + mockPlan;
    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: hugePlan, updated_at: Date.now() });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([mockWorkflow]);

    const context = buildRoutingBrainContext(mockWorkflow, 'implement', 0);
    expect(context.workflow.planTruncated).toBe(true);
    expect(context.workflow.planExcerpt.length).toBeLessThanOrEqual(3100); // ~3000 + ellipsis buffer
  });

  it('should handle milestone with no complexity tag', () => {
    const planNoTag = '- [ ] M1: Setup (no tag)';
    const milestone = extractCurrentMilestone(planNoTag);
    expect(milestone.title).toBe('Setup (no tag)');
    expect(milestone.complexityTag).toBeNull();
  });

  it('should handle milestone with no body', () => {
    const planNoBody = '- [ ] M1: Title only';
    const milestone = extractCurrentMilestone(planNoBody);
    expect(milestone.title).toBe('Title only');
    expect(milestone.bodyBullets).toEqual([]);
  });
});

// ─── Tests for repo identity derivation and cross-workflow priors filtering ─

describe('deriveRepoIdentity', () => {
  it('should extract repo name from worktree path', () => {
    const workflow = {
      work_dir: '/app/other-repo',
      worktree_path: '/app/.orchestrator-worktrees/myrepo/wf-test-123',
    };
    const repoName = deriveRepoIdentity(workflow);
    expect(repoName).toBe('myrepo');
  });

  it('should extract repo name from work_dir basename when no worktree', () => {
    const workflow = {
      work_dir: '/app/autodev',
      worktree_path: null,
    };
    const repoName = deriveRepoIdentity(workflow);
    expect(repoName).toBe('autodev');
  });

  it('should return null when no work_dir or worktree_path', () => {
    const workflow = {
      work_dir: null,
      worktree_path: null,
    };
    const repoName = deriveRepoIdentity(workflow);
    expect(repoName).toBeNull();
  });

  it('should prefer worktree path over work_dir', () => {
    const workflow = {
      work_dir: '/app/wrong-repo',
      worktree_path: '/app/.orchestrator-worktrees/correct-repo/wf-test-123',
    };
    const repoName = deriveRepoIdentity(workflow);
    expect(repoName).toBe('correct-repo');
  });

  it('should handle windows-style paths in worktree', () => {
    const workflow = {
      work_dir: '/app/autodev',
      worktree_path: 'C:\\app\\.orchestrator-worktrees\\winrepo\\wf-test-123',
    };
    const repoName = deriveRepoIdentity(workflow);
    expect(repoName).toBe('winrepo');
  });
});

describe('collectCrossWorkflowPriors: repo filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include same-repo workflows', () => {
    const now = Date.now();
    const currentWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-1',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-1',
      project_id: 'project-1',
      created_at: now,
    };

    const sameRepoWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-2',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-2',
      project_id: 'project-1',
      created_at: now - 1000 * 60 * 10,
    };

    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([{
      id: 'same-repo-implement-job',
      workflow_id: sameRepoWorkflow.id,
      workflow_cycle: 2,
      workflow_phase: 'implement',
      title: 'Implement peer milestone [M]',
      status: 'done',
      model: 'claude-sonnet-4-6',
      max_turns: 30,
    } as any]);
    vi.spyOn(agentQueries, 'getAgentsForJobIds').mockReturnValue([{
      job_id: 'same-repo-implement-job',
      duration_ms: 42000,
      num_turns: 12,
      diff: 'diff --git a/src/foo.ts b/src/foo.ts',
    } as any]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([currentWorkflow, sameRepoWorkflow]);

    const context = buildRoutingBrainContext(currentWorkflow, 'implement', 1);

    expect(context.crossWorkflowPriors.repoName).toBe('autodev');
    expect(context.crossWorkflowPriors.sampleSize).toBe(1);
    expect(context.crossWorkflowPriors.meanImplementWallClockMsByComplexity).toEqual({ M: 42000 });
  });

  it('should ignore same-project workflows from different repos', () => {
    const now = Date.now();
    const currentWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-1',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-1',
      project_id: 'shared-project',
      created_at: now,
    };

    const differentRepoWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-2',
      work_dir: '/app/other-project',
      worktree_path: '/app/.orchestrator-worktrees/other-project/wf-2',
      project_id: 'shared-project',
      created_at: now - 1000 * 60 * 10,
    };

    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    const getJobsSpy = vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([{
      id: 'wrong-repo-implement-job',
      workflow_id: differentRepoWorkflow.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      title: 'Implement unrelated repo milestone [S]',
      status: 'done',
      model: 'claude-haiku-4-5',
      max_turns: 10,
    } as any]);
    vi.spyOn(agentQueries, 'getAgentsForJobIds').mockReturnValue([{
      job_id: 'wrong-repo-implement-job',
      duration_ms: 1000,
      num_turns: 1,
      diff: 'diff --git a/unrelated.ts b/unrelated.ts',
    } as any]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([currentWorkflow, differentRepoWorkflow]);

    const context = buildRoutingBrainContext(currentWorkflow, 'implement', 1);

    expect(context.crossWorkflowPriors.sampleSize).toBe(0);
    expect(getJobsSpy).not.toHaveBeenCalledWith(differentRepoWorkflow.id);
  });

  it('should ignore peer workflows with missing repo identity', () => {
    const currentWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-1',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-1',
      created_at: Date.now(),
    };

    const noIdentityWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-2',
      work_dir: null,
      worktree_path: null,
      created_at: Date.now() - 1000 * 60 * 10,
    };

    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([currentWorkflow, noIdentityWorkflow]);

    // Should not throw; should return safe defaults
    const context = buildRoutingBrainContext(currentWorkflow, 'implement', 1);

    expect(context.crossWorkflowPriors.sampleSize).toBe(0);
    expect(context.crossWorkflowPriors.reviewerNoOpRate).toBe(0);
    expect(Object.keys(context.crossWorkflowPriors.meanImplementWallClockMsByComplexity).length).toBe(0);
  });

  it('should degrade to empty priors when current workflow repo identity is missing', () => {
    const now = Date.now();
    const currentWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-1',
      work_dir: null,
      worktree_path: null,
      project_id: 'project-1',
      created_at: now,
    };

    const sameProjectPeer: Workflow = {
      ...mockWorkflow,
      id: 'workflow-2',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-2',
      project_id: 'project-1',
      created_at: now - 1000 * 60 * 10,
    };

    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    const getJobsSpy = vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([{
      id: 'same-project-implement-job',
      workflow_id: sameProjectPeer.id,
      workflow_cycle: 1,
      workflow_phase: 'implement',
      title: 'Implement milestone [M]',
      status: 'done',
      model: 'claude-sonnet-4-6',
      max_turns: 30,
    } as any]);
    vi.spyOn(agentQueries, 'getAgentsForJobIds').mockReturnValue([{
      job_id: 'same-project-implement-job',
      duration_ms: 42000,
      num_turns: 12,
      diff: 'diff --git a/src/foo.ts b/src/foo.ts',
    } as any]);
    vi.spyOn(queries, 'listWorkflows').mockReturnValue([currentWorkflow, sameProjectPeer]);

    const context = buildRoutingBrainContext(currentWorkflow, 'implement', 1);

    expect(context.crossWorkflowPriors.sampleSize).toBe(0);
    expect(context.crossWorkflowPriors.reviewerNoOpRate).toBe(0);
    expect(context.crossWorkflowPriors.meanImplementWallClockMsByComplexity).toEqual({});
    expect(getJobsSpy).not.toHaveBeenCalledWith(sameProjectPeer.id);
  });

  it('should handle listWorkflows query error gracefully', () => {
    const currentWorkflow: Workflow = {
      ...mockWorkflow,
      id: 'workflow-1',
      work_dir: '/app/autodev',
      worktree_path: '/app/.orchestrator-worktrees/autodev/wf-1',
      created_at: Date.now(),
    };

    vi.spyOn(queries, 'getNote').mockReturnValue({ key: '', value: '', updated_at: 0 });
    vi.spyOn(queries, 'getJobsForWorkflow').mockReturnValue([]);
    vi.spyOn(queries, 'listWorkflows').mockImplementation(() => {
      throw new Error('Database error');
    });

    // Should not throw; should return safe defaults
    const context = buildRoutingBrainContext(currentWorkflow, 'implement', 1);

    expect(context.crossWorkflowPriors.sampleSize).toBe(0);
    expect(context.crossWorkflowPriors.repoName).toBeDefined();
  });
});
