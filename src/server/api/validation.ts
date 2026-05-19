/**
 * Zod validation schemas for API request bodies.
 */
import { z } from 'zod';
import { validateGitWorkDir } from '../shared/workDirValidation.js';

export const createJobSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(100_000).optional(),
  context: z.record(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  workDir: z.string().max(1000).optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
  stopMode: z.enum(['turns', 'budget', 'time', 'completion']).optional(),
  stopValue: z.number().min(0).optional(),
  model: z.string().max(200).optional().nullable(),
  templateId: z.string().uuid().optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
  interactive: z.boolean().optional(),
  useWorktree: z.boolean().optional(),
  projectId: z.string().uuid().optional().nullable(),
  repeatIntervalMs: z.number().int().min(1000).optional().nullable(),
  scheduledAt: z.number().int().optional().nullable(),
  retryPolicy: z.enum(['none', 'same', 'analyze']).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  completionChecks: z.array(z.string().max(500)).optional(),
  reviewConfig: z.object({ model: z.string().max(200).optional(), maxTurns: z.number().int().min(1).max(10_000).optional() }).optional(),
  debate: z.boolean().optional(),
  debateClaudeModel: z.string().max(200).optional(),
  debateCodexModel: z.string().max(200).optional(),
  debateMaxRounds: z.number().int().min(1).optional(),
}).refine(data => data.description || data.templateId, { message: 'description is required (or select a template)' });

export const updateJobTitleSchema = z.object({ title: z.string().min(1).max(200).refine(s => s.trim().length > 0, { message: 'title must not be empty or whitespace-only' }) });
export const updateJobInteractiveSchema = z.object({ interactive: z.boolean() });

export const createWorkflowSchema = z.object({
  title: z.string().max(200).optional(),
  task: z.string().min(1).max(100_000),
  workDir: z.string().max(1000).optional(),
  implementerModel: z.string().max(200).optional(),
  reviewerModel: z.string().max(200).optional(),
  maxCycles: z.number().int().min(1).optional(),
  maxTurnsAssess: z.number().int().min(1).max(10_000).optional(),
  maxTurnsReview: z.number().int().min(1).max(10_000).optional(),
  maxTurnsImplement: z.number().int().min(1).max(10_000).optional(),
  stopModeAssess: z.enum(['turns', 'budget', 'time', 'completion']).optional(),
  stopValueAssess: z.number().min(0).optional(),
  stopModeReview: z.enum(['turns', 'budget', 'time', 'completion']).optional(),
  stopValueReview: z.number().min(0).optional(),
  stopModeImplement: z.enum(['turns', 'budget', 'time', 'completion']).optional(),
  stopValueImplement: z.number().min(0).optional(),
  templateId: z.string().uuid().optional(),
  useWorktree: z.boolean().optional(),
  completionThreshold: z.number().min(0).max(1).optional(),
  startCommand: z.string().max(10_000).optional(),
  maxVerifyRetries: z.number().int().min(0).max(10).optional(),
}).superRefine((data, ctx) => {
  if (data.useWorktree !== false) {
    const result = validateGitWorkDir(data.workDir, { requireGit: true });
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workDir'], message: result.error });
    }
  }
});

export const resumeWorkflowSchema = z.object({
  phase: z.enum(['assess', 'review', 'implement', 'verify']).optional(),
  cycle: z.number().int().min(0).optional(),
  force: z.boolean().optional(),
});

export const createDebateSchema = z.object({
  title: z.string().max(200).optional(),
  task: z.string().min(1).max(100_000),
  claudeModel: z.string().min(1).max(200),
  codexModel: z.string().min(1).max(200),
  maxRounds: z.number().int().min(1).optional(),
  workDir: z.string().max(1000).optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
  templateId: z.string().uuid().optional(),
  postActionPrompt: z.string().max(10_000).optional(),
  postActionRole: z.enum(['claude', 'codex']).optional().nullable(),
  postActionVerification: z.boolean().optional(),
  loopCount: z.number().int().min(1).max(20).optional(),
});

export const agentReadAllSchema = z.object({ ids: z.array(z.string().uuid()).optional() });
export const agentRetrySchema = z.object({ interactive: z.boolean().optional() });
export const agentContinueSchema = z.object({
  message: z.string().min(1).max(100_000).refine(s => s.trim().length > 0, { message: 'message must not be empty or whitespace-only' }),
  interactive: z.boolean().optional(),
});

export const eyeStartSchema = z.object({
  repeatIntervalMs: z.number().int().min(1000).optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
  model: z.string().max(200).optional(),
  workDir: z.string().max(1000).optional(),
});

export const eyeConfigSchema = z.object({
  targets: z.array(z.object({ path: z.string().min(1).max(1000), context: z.string().max(5000).optional() })).optional(),
  linearApiKey: z.string().max(500).optional(),
  scriptsPath: z.string().max(1000).optional(),
  repoPath: z.string().max(1000).optional(),
  prompt: z.string().max(50_000).optional().nullable(),
  repeatIntervalMs: z.number().int().min(1000).optional(),
  addendum: z.string().max(50_000).optional(),
});

export const eyeDiscussionSchema = z.object({
  content: z.string().min(1).max(100_000).refine(s => s.trim().length > 0, { message: 'content must not be empty or whitespace-only' }),
});
export const eyeMessageSchema = z.object({
  content: z.string().min(1).max(100_000).refine(s => s.trim().length > 0, { message: 'content must not be empty or whitespace-only' }),
});
export const eyePrReviewDeleteSchema = z.object({ reason: z.string().max(10_000).optional() });

export function validateBody<T>(schema: z.ZodType<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data };
  const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).filter(Boolean);
  return { success: false, error: `Validation failed: ${messages.join('; ')}` };
}
